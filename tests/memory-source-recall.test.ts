import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BotContext, MemoryEntry, SearchResult } from '../types';
import type { MemoryQueryPlan } from '../types/memoryRecallTypes';
import { QdrantVectorService } from '../services/QdrantVectorService';
import { snapshotMemorySources } from '../utils/derivedMemoryFreshness';
import { getMultiQueryMemoryContextDetailed } from '../utils/multiQueryMemory';
import { runKiraRuntime } from '../orchestration/runtime/kernel';
import * as vector from '../services/VectorServiceFactory';
import * as identities from '../services/PersonIdentityService';
import * as completion from '../ai/chatCompletion';
import * as group from '../services/groupChatFeatureSettings';

const owner = '900000101';
const fact = (id: string, extra: Partial<MemoryEntry> = {}): MemoryEntry => ({ id, domain: 'work', botId: '', userId: owner, timestamp: new Date(),
    content: 'Пользователь разрабатывает учебный симулятор.', subject: 'user', tags: ['subject:user'], predicate: 'develops', object: 'учебный симулятор',
    confidence: .9, importance: .8, status: 'active', ...extra });
const summary = (id: string, sources: MemoryEntry[], extra: Partial<MemoryEntry> = {}): MemoryEntry => fact(id, {
    content: '[ГЛАВА ПАМЯТИ: Учебная разработка]\nУСТАРЕВШИЙ ПЕРЕСКАЗ', memoryKind: 'chapter', tags: ['memory-chapter', 'subject:user'],
    extractionMethod: 'consolidation', sourceMemoryIds: sources.map(source => source.id), sourceMemorySnapshots: snapshotMemorySources(sources), ...extra,
});
const plan: MemoryQueryPlan = { answerQueries: ['учебная разработка'], contextQueries: [], requestKind: 'specific', references: [] };
const ctx = (channel = 'telegram'): BotContext => ({ from: { id: Number(owner) }, chat: { id: Number(owner), type: 'private' },
    sessionStorageKey: channel === 'api' ? `api:${owner}` : owner, session: { messageHistory: [] } } as any);

/** The indexed top-k contains a summary; its primary evidence is only accessible by source ID. */
function storage(parents: MemoryEntry[], sources: MemoryEntry[], direct: MemoryEntry[] = []) {
    const rows = new Map([...parents, ...sources, ...direct].map(source => [source.id, source]));
    const counts = { embedding: 0, search: 0, scroll: 0, retrieve: 0 };
    const failedDomains = new Set<string>();
    const point = (source: MemoryEntry) => ({ id: source.id, score: source.id.startsWith('direct') ? .73 : .95,
        payload: JSON.parse(JSON.stringify(source)) });
    const service: any = new QdrantVectorService({
        search: async (collection: string) => {
            counts.search++;
            return [...parents, ...direct].filter(source => collection.endsWith('_' + source.domain)).map(point);
        },
        scroll: async () => { counts.scroll++; return { points: [] }; },
        retrieve: async (collection: string, args: any) => {
            counts.retrieve++;
            if ([...failedDomains].some(domain => collection.endsWith('_' + domain))) throw Error('synthetic source unavailable');
            return args.ids.map((id: string) => rows.get(id)).filter((source: MemoryEntry | undefined) => source && collection.endsWith('_' + source.domain)).map(point);
        },
    } as any);
    for (const source of rows.values()) source.botId = service.botId;
    service.embed = async () => { counts.embedding++; return [1, 0]; };
    service.ensureCollectionCompatibility = async () => 'exists';
    service.ensureMemoryTextIndex = async () => true;
    const domainSearch = service.searchAllDomains.bind(service), lexicalSearch = service.searchLexicalAllDomains.bind(service);
    let sourceHints = true;
    service.searchAllDomains = (query: string, user: string, limit: number, options: any) => domainSearch(query, user, limit,
        sourceHints ? options : { ...options, onStaleDerivedSources: undefined });
    service.searchLexicalAllDomains = (query: string, user: string, limit: number, options: any) => lexicalSearch(query, user, limit,
        sourceHints ? options : { ...options, onStaleDerivedSources: undefined });
    return { service: service as QdrantVectorService, rows, counts, failedDomains, hints: (enabled: boolean) => { sourceHints = enabled; },
        resetCounts: () => { for (const key of Object.keys(counts) as Array<keyof typeof counts>) counts[key] = 0; } };
}

test('shared recall recovers current evidence behind a rejected summary without additional source or embedding requests', async t => {
    const old = fact('source');
    const store = storage([summary('chapter', [old])], [{ ...old, content: 'Пользователь разрабатывает учебный спектрометр.', object: 'учебный спектрометр' }]);
    t.mock.method(vector, 'getVectorService', () => store.service);
    const read = () => getMultiQueryMemoryContextDetailed(ctx(), 'Вспомни учебную разработку', 'light', { queryPlan: plan, trackAccess: false, explain: true });
    store.hints(false);
    const before = await read(); const beforeCounts = { ...store.counts };
    assert.deepEqual(before.recalledMemories, []); assert.equal(before.recall?.state, 'empty');
    store.hints(true); store.resetCounts();
    const after = await read();
    assert.deepEqual(after.recalledMemories.map(source => source.id), ['source']);
    assert.match(after.context, /учебный спектрометр/); assert.doesNotMatch(after.context, /УСТАРЕВШИЙ ПЕРЕСКАЗ/);
    assert.equal(after.recall?.state, 'found'); assert.ok(after.recalledMemories[0].recallSources?.includes('chapter'));
    assert.deepEqual(store.counts, beforeCounts, 'the entire recall reuses source verification reads');
});

test('nested sources are expanded to primary evidence, not another stale model or chapter', async t => {
    const old = fact('source');
    const chapter = summary('chapter', [old]);
    const model = summary('model', [chapter], { memoryKind: 'trait', tags: ['memory-schema', 'subject:user'], predicate: 'user_schema:work' });
    const store = storage([model], [chapter, { ...old, negated: true, content: 'Пользователь не разрабатывает учебный симулятор.' }]);
    t.mock.method(vector, 'getVectorService', () => store.service);
    const memory = await getMultiQueryMemoryContextDetailed(ctx(), 'Вспомни учебную разработку', 'light', { queryPlan: plan, trackAccess: false });
    assert.deepEqual(memory.recalledMemories.map(source => source.id), ['source']);
    assert.equal(memory.recalledMemories[0].negated, true); assert.doesNotMatch(memory.context, /УСТАРЕВШИЙ ПЕРЕСКАЗ/);
    assert.equal(store.counts.retrieve, store.counts.embedding * 2, 'one batched read at each dependency level per branch');
});

test('parent and source limits apply after source identity filtering', async t => {
    const wrong = Array.from({ length: 12 }, (_, i) => fact(`wrong-${i}`, { subject: 'contact', tags: ['subject:contact', 'person_id:synthetic-other'] }));
    const old = fact('answer');
    const parents = [...Array.from({ length: 5 }, (_, i) => summary(`wrong-parent-${i}`, [wrong[i]])), summary('useful-parent', [...wrong, old])];
    const store = storage(parents, [...wrong.map(source => ({ ...source, content: 'Чужой контакт обсуждал другую тему.' })), { ...old, object: 'учебный спектрометр', content: 'Пользователь разрабатывает учебный спектрометр.' }]);
    t.mock.method(vector, 'getVectorService', () => store.service);
    const memory = await getMultiQueryMemoryContextDetailed(ctx(), 'Вспомни учебную разработку', 'light', { queryPlan: plan, trackAccess: false });
    assert.deepEqual(memory.recalledMemories.map(source => source.id), ['answer']);
    assert.doesNotMatch(memory.context, /Чужой контакт|УСТАРЕВШИЙ ПЕРЕСКАЗ/);
});

test('named-person scope rejects other people before the eight-source limit', async t => {
    const subject = { subject: 'contact' as const, tags: ['subject:contact', 'person_id:synthetic-miron'], content: 'Мирон Примеров разрабатывает учебный симулятор.' };
    const wrong = Array.from({ length: 10 }, (_, i) => fact(`other-${i}`, { subject: 'contact', tags: ['subject:contact', 'person_id:synthetic-other'] }));
    const old = fact('answer', subject);
    const parent = summary('chapter', [...wrong, old], { subject: 'contact', tags: ['memory-chapter', 'subject:contact', 'person_id:synthetic-miron'] });
    const store = storage([parent], [...wrong, { ...old, content: 'Мирон Примеров разрабатывает учебный спектрометр.', object: 'учебный спектрометр' }]);
    t.mock.method(vector, 'getVectorService', () => store.service);
    t.mock.method(identities, 'findPersonIdentitiesForRecall', async () => [{ id: 'synthetic-miron', displayName: 'Мирон Примеров' }] as any);
    const memory = await getMultiQueryMemoryContextDetailed(ctx(), 'Что разрабатывает Мирон Примеров?', 'light', { trackAccess: false,
        queryPlan: { ...plan, references: [{ kind: 'person', from: 'named', mention: 'Мирон Примеров', relationPath: [] }] } });
    assert.deepEqual(memory.recalledMemories.map(source => source.id), ['answer']); assert.equal(memory.recalledMemories[0].subject, 'contact');
    assert.match(memory.context, /Мирон Примеров разрабатывает учебный спектрометр/);
});

test('foreign, missing and terminal evidence cannot reappear through a rejected summary', async t => {
    const old = fact('source');
    for (const patch of [{ userId: '900000102' }, { botId: 'other-namespace' }, { status: 'superseded' }, { status: 'expired' }, { expiresAt: new Date('2020-01-01') },
        { subject: 'bot', tags: ['subject:bot'] }, { subject: 'system', tags: ['subject:system'] }, { subject: 'unknown', tags: ['subject:unknown'] }, { deleted: true }]) {
        const store = storage([summary('chapter', [old])], [JSON.parse(JSON.stringify(old))]);
        Object.assign(store.rows.get(old.id)!, patch);
        if ('deleted' in patch) store.rows.delete(old.id);
        t.mock.method(vector, 'getVectorService', () => store.service);
        const memory = await getMultiQueryMemoryContextDetailed(ctx(), 'Вспомни учебную разработку', 'light', { queryPlan: plan, trackAccess: false });
        assert.deepEqual(memory.recalledMemories, [], JSON.stringify(patch)); assert.doesNotMatch(memory.context, /УСТАРЕВШИЙ ПЕРЕСКАЗ/);
        t.mock.restoreAll();
    }
});

test('fresh, legacy, malformed and archived summaries do not supply stale-source hints', async () => {
    const source = fact('source');
    for (const patch of [{}, { sourceMemorySnapshots: undefined }, { sourceMemorySnapshots: [] }, { status: 'superseded' as const }]) {
        const store = storage([summary('chapter', [source], patch)], [JSON.parse(JSON.stringify(source))]);
        let hints = 0;
        await store.service.searchAllDomains('учебная разработка', owner, 5, { onStaleDerivedSources: () => { hints++; } });
        assert.equal(hints, 0);
    }
});

test('cycles and an over-deep dependency path cannot bypass the freshness boundary through source recovery', async () => {
    const source = fact('source');
    const a = summary('cycle-a', [source]), b = summary('cycle-b', [source]);
    a.sourceMemoryIds = [b.id]; a.sourceMemorySnapshots = snapshotMemorySources([b]);
    b.sourceMemoryIds = [a.id]; b.sourceMemorySnapshots = snapshotMemorySources([a]);
    const cyclic = storage([a], [b]);
    let hints = 0;
    assert.deepEqual(await cyclic.service.searchAllDomains('учебная разработка', owner, 5, { onStaleDerivedSources: () => { hints++; } }), []);
    assert.equal(hints, 0);
    const chain = [source];
    for (let i = 0; i < 6; i++) chain.push(summary(`depth-${i}`, [chain.at(-1)!]));
    const deep = storage([chain.at(-1)!], chain.slice(0, -1));
    assert.deepEqual(await deep.service.searchAllDomains('учебная разработка', owner, 5, { onStaleDerivedSources: () => { hints++; } }), []);
    assert.equal(hints, 0);
});

test('current historical primary evidence preserves completion, negation and validity dates', async t => {
    const old = fact('source');
    const current = { ...old, content: 'Раньше пользователь не разрабатывал учебный симулятор.', negated: true, status: 'done' as const,
        validFrom: new Date('2020-01-01'), validTo: new Date('2021-01-01') };
    const store = storage([summary('chapter', [old])], [current]);
    t.mock.method(vector, 'getVectorService', () => store.service);
    const memory = await getMultiQueryMemoryContextDetailed(ctx(), 'Что было раньше с учебным проектом?', 'light', { queryPlan: plan, trackAccess: false });
    assert.equal(memory.recalledMemories[0]?.negated, true); assert.equal(memory.recalledMemories[0]?.status, 'done');
    assert.match(memory.context, /2020-01-01/); assert.match(memory.context, /2021-01-01/);
});

test('a source hint cannot resolve an ambiguous named person', async t => {
    const old = fact('source');
    const store = storage([summary('chapter', [old])], [{ ...old, content: 'Пользователь разрабатывает учебный спектрометр.' }]);
    t.mock.method(vector, 'getVectorService', () => store.service);
    t.mock.method(identities, 'findPersonIdentitiesForRecall', async () => [
        { id: 'synthetic-a', displayName: 'Мирон Примеров' }, { id: 'synthetic-b', displayName: 'Мирон Примеров' },
    ] as any);
    const memory = await getMultiQueryMemoryContextDetailed(ctx(), 'Что разрабатывает Мирон Примеров?', 'light', { trackAccess: false,
        queryPlan: { ...plan, references: [{ kind: 'person', from: 'named', mention: 'Мирон Примеров', relationPath: [] }] } });
    assert.equal(memory.recall?.state, 'ambiguous'); assert.equal(store.counts.search, 0); assert.deepEqual(memory.recalledMemories, []);
    assert.notEqual(memory.recall?.identityVerified, true);
});

test('the next turn reads the updated source again and a new person does not inherit the old source hints', async t => {
    const old = fact('source');
    const store = storage([summary('chapter', [old])], [{ ...old, content: 'Пользователь разрабатывает учебный спектрометр.' }]);
    t.mock.method(vector, 'getVectorService', () => store.service);
    const context = ctx();
    const first = await getMultiQueryMemoryContextDetailed(context, 'Вспомни учебную разработку', 'light', { queryPlan: plan, trackAccess: false });
    assert.match(first.context, /учебный спектрометр/);
    store.rows.set(old.id, { ...store.rows.get(old.id)!, content: 'Пользователь разрабатывает учебный датчик.', object: 'учебный датчик' });
    const second = await getMultiQueryMemoryContextDetailed(context, 'А что теперь с этой разработкой?', 'light', { trackAccess: false,
        queryPlan: { ...plan, references: [{ kind: 'topic', from: 'focus', mention: 'этой', relationPath: [] }] } });
    assert.match(second.context, /учебный датчик/); assert.doesNotMatch(second.context, /учебный спектрометр/);
    t.mock.method(identities, 'findPersonIdentitiesForRecall', async () => [{ id: 'synthetic-other', displayName: 'Лада Учебная' }] as any);
    const changed = await getMultiQueryMemoryContextDetailed(context, 'А что разрабатывает Лада Учебная?', 'light', { trackAccess: false,
        queryPlan: { ...plan, references: [{ kind: 'person', from: 'named', mention: 'Лада Учебная', relationPath: [] }] } });
    assert.deepEqual(changed.recalledMemories, []); assert.doesNotMatch(changed.context, /учебный датчик/);
});

test('independent current evidence survives another source failure and retains partial coverage', async t => {
    const old = fact('answer'), failed = fact('failed', { domain: 'health' });
    const store = storage([summary('chapter', [old, failed])], [{ ...old, content: 'Пользователь разрабатывает учебный спектрометр.' }, failed]);
    store.failedDomains.add('health'); t.mock.method(vector, 'getVectorService', () => store.service);
    const memory = await getMultiQueryMemoryContextDetailed(ctx(), 'Вспомни учебную разработку', 'light', { queryPlan: plan, trackAccess: false });
    assert.equal(memory.recall?.state, 'partial'); assert.deepEqual(memory.recalledMemories.map(source => source.id), ['answer']);
    assert.match(memory.context, /учебный спектрометр/); assert.doesNotMatch(memory.context, /УСТАРЕВШИЙ ПЕРЕСКАЗ/);
});

test('source association never changes raw dense scores or replaces an already found direct candidate', async t => {
    const old = fact('direct-source');
    const current = { ...old, content: 'Пользователь разрабатывает учебный спектрометр.' };
    const store = storage([summary('chapter', [old])], [current], [current]);
    assert.equal((await store.service.searchAllDomains('учебная разработка', owner))[0].score, .73);
    const hints: SearchResult[] = [];
    const dense = await store.service.searchAllDomains('учебная разработка', owner, 5, { onStaleDerivedSources: (_parent, sources) => hints.push(...sources) });
    assert.deepEqual(dense.map(source => [source.id, source.score]), [['direct-source', .73]]);
    assert.equal(hints[0].score, 0, 'an ID read has no semantic score');
    t.mock.method(vector, 'getVectorService', () => store.service);
    const memory = await getMultiQueryMemoryContextDetailed(ctx(), 'Вспомни учебную разработку', 'light', { queryPlan: plan, trackAccess: false });
    assert.equal(memory.recalledMemories[0].scoreDetails?.semanticScore, .73);
    assert.ok(memory.recalledMemories[0].recallSources?.includes('direct'));
});

test('the request keeps no more than four source groups and eight primary candidates per group', async t => {
    const old = Array.from({ length: 50 }, (_, i) => fact(`source-${i}`, { content: `Учебная разработка ${i}.` }));
    const parents = Array.from({ length: 5 }, (_, i) => summary(`chapter-${i}`, old.slice(i * 10, (i + 1) * 10)));
    const store = storage(parents, old.map(source => ({ ...source, content: source.content + ' Текущее состояние.' })));
    t.mock.method(vector, 'getVectorService', () => store.service);
    const memory = await getMultiQueryMemoryContextDetailed(ctx(), 'Вспомни учебную разработку', 'light', { queryPlan: plan, explain: true, trackAccess: false });
    assert.equal(memory.retrievalTrace?.candidates, 32);
    assert.ok(memory.recalledMemories.length <= 5);
});

test('the source recovery survives JSON/restart and reaches kernel synthesis in Telegram and API', async t => {
    const old = fact('source'); const parent = summary('chapter', [old]);
    t.mock.method(group, 'isGroupChatContextEnabled', async () => false);
    t.mock.method(completion, 'createChatCompletionForTask', async (_task: any, request: any) => {
        assert.match(JSON.stringify(request.messages), /учебный спектрометр/);
        assert.doesNotMatch(JSON.stringify(request.messages), /УСТАРЕВШИЙ ПЕРЕСКАЗ/);
        return { choices: [{ message: { content: 'Ты разрабатываешь учебный спектрометр.' } }] } as any;
    });
    for (const channel of ['telegram', 'api']) {
        const current = { ...old, content: 'Пользователь разрабатывает учебный спектрометр.', object: 'учебный спектрометр' };
        const store = storage(JSON.parse(JSON.stringify([parent])), JSON.parse(JSON.stringify([current])));
        t.mock.method(vector, 'getVectorService', () => store.service);
        const context = ctx(channel), question = 'Вспомни учебную разработку';
        const memory = await getMultiQueryMemoryContextDetailed(context, question, 'light', { queryPlan: plan, trackAccess: false });
        const answer = await runKiraRuntime({ ctx: context, message: question, messageHistory: [], isForwarded: false, forwardFrom: '',
            classification: { intent: 'РАЗГОВОР', confidenceLevel: 'ВЫСОКИЙ', details: { memoryTask: 'lookup', memoryNeed: 'light' } },
            enrichedContextFromMemory: memory.context, memoryRecall: memory.recall });
        assert.match(answer.responseText, /учебный спектрометр/); assert.doesNotMatch(answer.responseText, /УСТАРЕВШИЙ ПЕРЕСКАЗ/);
    }
});
