import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BotContext, MemoryEntry } from '../types';
import type { MemoryQueryPlan } from '../types/memoryRecallTypes';
import { filterCurrentDerivedMemories, snapshotMemorySources } from '../utils/derivedMemoryFreshness';
import { QdrantVectorService } from '../services/QdrantVectorService';
import { runMemoryConsolidationForUser } from '../services/MemoryConsolidationService';
import { runMemorySchemaConsolidationForUser } from '../services/MemorySchemaConsolidationService';
import { runMemorySleepCycleForUser } from '../services/MemorySleepCycleService';
import { getMultiQueryMemoryContextDetailed } from '../utils/multiQueryMemory';
import { runKiraRuntime } from '../orchestration/runtime/kernel';
import * as vector from '../services/VectorServiceFactory';
import * as ai from '../ai/chatCompletion';
import * as group from '../services/groupChatFeatureSettings';

const owner = '900000071';
const fact = (id: string, extra: Partial<MemoryEntry> = {}): MemoryEntry => ({
    id, domain: 'work', botId: 'synthetic', userId: owner, timestamp: new Date(),
    content: 'Пользователь разрабатывает учебный компилятор.', subject: 'user', predicate: 'develops', object: 'учебный компилятор',
    tags: ['subject:user'], confidence: .9, importance: .8, status: 'active', ...extra,
});
const derived = (id: string, sources: MemoryEntry[], extra: Partial<MemoryEntry> = {}) => fact(id, {
    content: '[ГЛАВА ПАМЯТИ: Учебная работа]\nПользователь разрабатывает учебный компилятор.',
    memoryKind: 'chapter', tags: ['memory-chapter', 'subject:user'], extractionMethod: 'consolidation',
    sourceMemoryIds: sources.map(source => source.id), sourceMemorySnapshots: snapshotMemorySources(sources), ...extra,
});
const response = (value: unknown) => ({ choices: [{ message: { content: JSON.stringify(value) } }] } as any);

function storage() {
    const records = new Map<string, MemoryEntry>();
    const sourceReads: Array<{ collection: string; ids: string[] }> = [];
    const matches = (record: MemoryEntry, condition: any): boolean => {
        if (condition.should) return condition.should.some((item: any) => matches(record, item));
        const value = (record as any)[condition.key];
        if (condition.match?.value !== undefined) return Array.isArray(value) ? value.includes(condition.match.value) : value === condition.match.value;
        if (condition.match?.any) return condition.match.any.some((item: string) => Array.isArray(value) ? value.includes(item) : value === item);
        if (condition.match?.text) return String(value).toLowerCase().includes(condition.match.text.toLowerCase());
        if (condition.range) return value !== undefined && (!condition.range.lt || new Date(value).getTime() < new Date(condition.range.lt).getTime());
        return true;
    };
    const candidates = (collection: string, args: any) => [...records.values()].filter(record => collection.endsWith('_' + record.domain) &&
        (args.filter?.must ?? []).every((condition: any) => matches(record, condition)) &&
        !(args.filter?.must_not ?? []).some((condition: any) => matches(record, condition)));
    const point = (record: MemoryEntry) => ({ id: record.id, score: .95, payload: JSON.parse(JSON.stringify(record)) });
    const service: any = new QdrantVectorService({
        retrieve: async (collection: string, args: any) => {
            sourceReads.push({ collection, ids: args.ids });
            return [...records.values()].filter(record => collection.endsWith('_' + record.domain) && args.ids.includes(record.id)).map(point);
        },
        scroll: async (collection: string, args: any) => {
            const all = candidates(collection, args);
            if (args.order_by) all.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
            const start = Number(args.offset ?? 0), end = start + args.limit;
            return { points: all.slice(start, end).map(point), next_page_offset: end < all.length ? end : undefined };
        },
        search: async (collection: string, args: any) => candidates(collection, args).slice(0, args.limit).map(point),
        upsert: async (_collection: string, args: any) => { for (const value of args.points) records.set(value.id, { ...value.payload, id: value.id }); },
        overwritePayload: async (_collection: string, args: any) => { for (const id of args.points) records.set(id, { ...args.payload, id }); },
        delete: async (_collection: string, args: any) => { for (const id of args.points) records.delete(id); },
    } as any);
    service.embed = async () => [1, 0];
    service.ensureCollectionCompatibility = async () => 'exists';
    service.ensureMemoryTimestampIndex = async () => undefined;
    service.ensureMemoryTextIndex = async () => true;
    const add = (record: MemoryEntry) => { const value = { ...record, botId: service.botId }; records.set(record.id, value); return value; };
    return { service: service as QdrantVectorService, records, add, sourceReads };
}

test('snapshots ignore reinforcement but detect assertion, identity, status and temporal changes across JSON round-trips', async () => {
    const source = fact('source', { validFrom: new Date('2020-01-01'), validTo: new Date('2021-01-01') });
    const chapter = derived('chapter', [source]);
    const check = (current: MemoryEntry) => filterCurrentDerivedMemories([chapter], async () => [JSON.parse(JSON.stringify(current))]);
    assert.equal((await check({ ...source, importance: 1, confidence: 1, retrievalCount: 500, lastRetrievedAt: new Date() })).length, 1);
    for (const patch of [
        { content: 'Пользователь завершил учебный компилятор.' }, { object: 'учебный симулятор' }, { predicate: 'completed' },
        { negated: true }, { subject: 'contact' as const }, { tags: ['subject:user', 'person_id:other'] },
        { status: 'done' as const }, { status: 'superseded' as const }, { validTo: new Date('2022-01-01') },
        { expiresAt: new Date('2020-01-01') },
    ]) assert.deepEqual(await check({ ...source, ...patch }), [], JSON.stringify(patch));
});

test('missing, unreadable, malformed and nested stale dependencies cannot suppress independent primary evidence', async () => {
    const source = fact('source');
    const chapter = derived('chapter', [source]);
    const schema = derived('schema', [chapter], { tags: ['memory-schema', 'subject:user'] });
    for (const read of [async () => [], async () => { throw Error('synthetic unavailable'); }]) {
        assert.deepEqual((await filterCurrentDerivedMemories([source, chapter, schema], read)).map(record => record.id), ['source']);
    }
    const pool = [source, chapter];
    const read = async (refs: any[]) => pool.filter(record => refs.some(ref => ref.id === record.id && ref.domain === record.domain));
    assert.equal((await filterCurrentDerivedMemories([schema], read)).length, 1);
    source.negated = true;
    assert.deepEqual(await filterCurrentDerivedMemories([schema], read), []);
    for (const sourceMemorySnapshots of [[], null, [{ id: source.id }], [{ ...chapter.sourceMemorySnapshots![0], domain: 'family' }]]) {
        assert.deepEqual(await filterCurrentDerivedMemories([{ ...chapter, sourceMemorySnapshots } as any], read), []);
    }
    const legacy = { ...chapter, sourceMemorySnapshots: undefined };
    assert.deepEqual((await filterCurrentDerivedMemories([legacy], async () => { throw Error('Legacy is not retroactively versioned'); })).map(record => record.id), ['chapter']);
    const cycleA = derived('cycle-a', [source]), cycleB = derived('cycle-b', [source]);
    cycleA.sourceMemoryIds = [cycleB.id]; cycleA.sourceMemorySnapshots = snapshotMemorySources([cycleB]);
    cycleB.sourceMemoryIds = [cycleA.id]; cycleB.sourceMemorySnapshots = snapshotMemorySources([cycleA]);
    assert.deepEqual(await filterCurrentDerivedMemories([cycleA], async () => [cycleA, cycleB]), []);
});

test('dependency reads deduplicate shared sources and have a hard scan budget', async () => {
    const sources = Array.from({ length: 520 }, (_, i) => fact(`source-${i}`));
    const chapters = sources.map((source, i) => derived(`chapter-${i}`, [source]));
    let reads = 0;
    const result = await filterCurrentDerivedMemories([...chapters, derived('shared', [sources[0]])], async refs => {
        reads += refs.length;
        return sources.filter(source => refs.some(ref => ref.id === source.id));
    });
    assert.equal(reads, 512); assert.equal(result.length, 513);
    let deep = fact('root'); const chain = [deep];
    for (let i = 0; i < 6; i++) { deep = derived(`depth-${i}`, [deep]); chain.push(deep); }
    reads = 0;
    assert.deepEqual(await filterCurrentDerivedMemories([deep], async refs => {
        reads++; return chain.filter(source => refs.some(ref => ref.id === source.id));
    }), []);
    assert.equal(reads, 4);
});

test('all conversational storage entry points hide stale summaries and the raw audit preserves them', async () => {
    const { service, add, sourceReads } = storage();
    const source = add(fact('source'));
    const chapter = add(derived('chapter', [source], { isAnchor: true, sourceEpisodeId: 'synthetic-episode' }));
    source.negated = true;
    const calls = [
        () => service.searchMemories('учебный компилятор', owner, { domain: 'work' }),
        () => service.searchAllDomains('учебный компилятор', owner),
        () => service.searchLexicalAllDomains('учебный компилятор', owner),
        () => service.getAnchorMemories(owner), () => service.fetchMemoriesByIds(owner, ['chapter']),
        () => service.getMemoriesBySourceEpisodeId(owner, 'synthetic-episode'),
        () => service.getMemoriesByTag(owner, 'memory-chapter'), () => service.getOwnerMemories(owner, ['work']),
        () => service.getMemoriesByTags(owner, ['memory-chapter']), () => service.getRecentMemories(owner, 5),
        () => service.getMemoriesForCompression(owner, 'work', 0),
    ];
    for (const call of calls) assert.ok(!(await call()).some(record => record.id === chapter.id));
    assert.equal(await service.fetchMemoryById(chapter.id, 'work', owner), null);
    assert.match(await service.getDomainContext(owner, 'work', 'учебный компилятор'), /учебный компилятор/);
    assert.ok((await service.getAllMemories(owner)).some(record => record.id === chapter.id));
    assert.ok((await service.getMemoriesByTag(owner, 'memory-chapter', { includeStaleDerived: true })).some(record => record.id === chapter.id));
    assert.ok(sourceReads.every(read => read.ids.length <= 512));
});

test('a current summary validates known domains in batches and enforces source owner and namespace', async () => {
    const { service, add, sourceReads, records } = storage();
    const sources = [add(fact('source-a')), add(fact('source-b'))];
    add(derived('chapter', sources));
    assert.ok(await service.fetchMemoryById('chapter', 'work', owner));
    assert.equal(sourceReads.length, 2, 'one chapter read and one batched source read');
    assert.deepEqual(sourceReads[1].ids, ['source-a', 'source-b']);
    for (const patch of [{ userId: '900000072' }, { botId: 'other-namespace' }]) {
        records.set('source-a', { ...sources[0], ...patch });
        assert.equal(await service.fetchMemoryById('chapter', 'work', owner), null);
    }
    records.delete('source-a');
    assert.equal(await service.fetchMemoryById('chapter', 'work', owner), null);
});

test('scoped pagination continues beyond stale summaries to fill the accepted evidence pool', async () => {
    const { service, add } = storage();
    const source = fact('source');
    for (let i = 0; i < 4; i++) add(derived(`stale-${i}`, [source]));
    add({ ...source, negated: true });
    const result = await service.getOwnerMemories(owner, ['work'], 1);
    assert.deepEqual(result.map(record => record.id), ['source']);
});

for (const kind of ['chapter', 'schema', 'sleep'] as const) test(`${kind} synthesis persists versions of exactly its cited sources`, async t => {
    const sources = Array.from({ length: 3 }, (_, i) => fact(`source-${i}`, { memoryKind: 'goal', status: 'planned', confidence: .5 }));
    const expected = snapshotMemorySources(sources);
    const saved: MemoryEntry[] = [];
    t.mock.method(vector, 'getVectorService', () => ({
        getRecentMemories: async () => sources, getMemoriesByTag: async () => [],
        saveMemory: async (memory: MemoryEntry) => { saved.push(memory); return `saved-${saved.length}`; },
        deleteMemory: async () => undefined,
    } as any));
    t.mock.method(ai, 'createChatCompletionForTask', async () => response(kind === 'chapter'
        ? { chapters: [{ title: 'Учебный проект', summary: 'Разработка компилятора.', sourceIds: ['source-1'] }] }
        : kind === 'schema' ? { schemas: [{ title: 'Учебная разработка', summary: 'Предпочитает создавать инструменты.', guidance: 'Учитывать интерес.', sourceIds: ['source-1'], domains: ['work'] }] }
            : { summary: 'Открыта разработка учебного компилятора.' }));
    if (kind === 'chapter') await runMemoryConsolidationForUser(owner, { domain: 'work', minFacts: 1 });
    else if (kind === 'schema') await runMemorySchemaConsolidationForUser(owner, { domain: 'work', minSources: 1 });
    else await runMemorySleepCycleForUser(owner);
    assert.equal(saved.length, kind === 'sleep' ? 2 : 1);
    for (const memory of saved) assert.deepEqual(memory.sourceMemorySnapshots, kind === 'sleep' ? expected : [expected[1]]);
});

test('sleep indices use the acknowledged source state after their own temporal softening', async t => {
    const { service, add } = storage();
    for (let i = 0; i < 3; i++) add(fact(`old-plan-${i}`, { memoryKind: 'goal', status: 'planned',
        timestamp: new Date(Date.now() - 90 * 86_400_000), tags: ['subject:user', 'temporal_scope:future_plan'] }));
    t.mock.method(vector, 'getVectorService', () => service);
    t.mock.method(ai, 'createChatCompletionForTask', async () => response({ summary: 'Уточнить состояние учебной разработки.' }));
    const result = await runMemorySleepCycleForUser(owner);
    assert.equal(result.staleFactsSoftened, 3);
    assert.equal(result.openLoopIndexCreated, true); assert.equal(result.uncertaintyIndexCreated, true);
    for (const tag of ['sleep_open_loop_index', 'sleep_uncertainty_index']) {
        assert.equal((await service.getMemoriesByTag(owner, tag)).length, 1, 'a just-created index must remain usable');
    }
});

test('a source corrected during synthesis invalidates the result; the next rebuild replaces the stale generation', async t => {
    const { service, add, records } = storage();
    const source = add(fact('source'));
    t.mock.method(vector, 'getVectorService', () => service);
    let changed = false;
    t.mock.method(ai, 'createChatCompletionForTask', async () => {
        if (!changed) {
            records.set(source.id, { ...source, content: 'Пользователь разрабатывает учебный симулятор.', object: 'учебный симулятор' });
            changed = true;
            return response({ chapters: [{ title: 'Учебная работа', summary: 'Разработка учебного компилятора.', sourceIds: [source.id] }] });
        }
        return response({ chapters: [{ title: 'Учебная работа', summary: 'Разработка учебного симулятора.', sourceIds: [source.id] }] });
    });
    await runMemoryConsolidationForUser(owner, { domain: 'work', minFacts: 1 });
    assert.equal((await service.getMemoriesByTag(owner, 'memory-chapter')).length, 0);
    assert.equal((await service.getMemoriesByTag(owner, 'memory-chapter', { includeStaleDerived: true })).length, 1);
    const rebuilt = await runMemoryConsolidationForUser(owner, { domain: 'work', minFacts: 1 });
    assert.deepEqual([rebuilt.created, rebuilt.replaced], [1, 1]);
    const chapters = await service.getMemoriesByTag(owner, 'memory-chapter');
    assert.equal(chapters.length, 1); assert.match(chapters[0].content, /симулятора/);
    assert.equal((await service.getAllMemories(owner)).filter(record => record.memoryKind === 'chapter').length, 1);
});

test('source correction survives service restart and reaches shared recall and kernel synthesis without the old summary', async t => {
    const { service, add, records } = storage();
    const source = add(fact('source'));
    const chapterId = await service.saveMemory(derived('new-chapter', [source], { isAnchor: true }));
    assert.equal((await service.fetchMemoryById(chapterId, 'work', owner))?.sourceMemorySnapshots?.length, 1);
    const corrected = { ...source, content: 'Пользователь разрабатывает учебный симулятор.', object: 'учебный симулятор' };
    await service.updateMemory('source', 'work', corrected, { userCorrection: { userId: owner, sourceText: 'Я разрабатываю учебный симулятор.', sourceMessageIds: ['synthetic:correction'] } });
    // New service and JSON payloads prove this does not rely on an in-process invalidation cache.
    const restarted = storage();
    for (const record of records.values()) restarted.add(JSON.parse(JSON.stringify(record)));
    t.mock.method(vector, 'getVectorService', () => restarted.service);
    t.mock.method(group, 'isGroupChatContextEnabled', async () => false);
    t.mock.method(ai, 'createChatCompletionForTask', async (_task: any, request: any) => {
        assert.doesNotMatch(JSON.stringify(request.messages), /ГЛАВА ПАМЯТИ: Учебная работа/);
        return { choices: [{ message: { content: 'Ты разрабатываешь учебный симулятор.' } }] } as any;
    });
    for (const channel of ['telegram', 'api']) for (const requestKind of ['overview', 'specific'] as const) {
        const context = { from: { id: Number(owner) }, chat: { id: Number(owner), type: 'private' },
            sessionStorageKey: channel === 'api' ? `api:${owner}` : owner, session: { messageHistory: [] } } as any as BotContext;
        const queryPlan: MemoryQueryPlan = { requestKind, answerQueries: ['учебная разработка'], contextQueries: [], domains: ['work'],
            references: [{ kind: 'person', from: 'owner', mention: 'я', relationPath: [] }] };
        const question = 'Что я разрабатываю?';
        const memory = await getMultiQueryMemoryContextDetailed(context, question, 'full', { queryPlan, trackAccess: false });
        assert.match(memory.context, /учебный симулятор/);
        assert.doesNotMatch(memory.context, /ГЛАВА ПАМЯТИ: Учебная работа/);
        assert.deepEqual(memory.recalledMemories.map(record => record.content), [corrected.content]);
        const result = await runKiraRuntime({ ctx: context, message: question, messageHistory: [], isForwarded: false, forwardFrom: '',
            classification: { intent: 'РАЗГОВОР', confidenceLevel: 'ВЫСОКИЙ', details: { memoryTask: 'lookup', memoryNeed: 'full' } },
            enrichedContextFromMemory: memory.context, memoryRecall: memory.recall });
        assert.match(result.responseText, /учебный симулятор/);
        assert.doesNotMatch(result.responseText, /учебный компилятор/);
    }
});
