import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MemoryEntry } from '../types';
import * as vector from '../services/VectorServiceFactory';
import * as completion from '../ai/chatCompletion';
import { replaceDerivedMemories } from '../services/derivedMemoryReplacement';
import { runMemoryConsolidationForUser } from '../services/MemoryConsolidationService';
import { runMemorySchemaConsolidationForUser } from '../services/MemorySchemaConsolidationService';
import { runMemorySleepCycleForUser } from '../services/MemorySleepCycleService';
import { reconsolidateAfterResponse } from '../services/MemoryReconsolidationService';
import { QdrantVectorService } from '../services/QdrantVectorService';
import { compressOldMemories, saveMemory } from '../utils/enhancedDomainMemory';
import { formatMemoryRerankCandidate } from '../utils/memoryRanking';
import { canDeduplicateMemoryAssertions } from '../utils/memoryAssertion';
import { detectEmotionalTag } from '../utils/emotionalTagger';
import { snapshotMemorySources } from '../utils/derivedMemoryFreshness';

const owner = '900000041';
const memory = (id: string, extra: Partial<MemoryEntry> = {}): MemoryEntry => ({
    id, content: 'Пользователь изучает тестовую астрономию.', domain: 'work', botId: 'synthetic', userId: owner,
    timestamp: new Date(), importance: .7, confidence: .9, subject: 'user', tags: ['subject:user'], status: 'active', ...extra,
});
const response = (value: unknown) => ({ choices: [{ message: { content: JSON.stringify(value) } }] } as any);

test('replacement never deletes the old generation on a partial or unacknowledged save', async () => {
    for (const fail of ['throw', 'empty']) {
        const calls: string[] = [];
        const service = {
            saveMemory: async () => { calls.push('save'); if (calls.length === 2) { if (fail === 'throw') throw Error('synthetic failure'); return ''; } return 'new'; },
            deleteMemory: async (id: string) => { calls.push(`delete:${id}`); },
        };
        await assert.rejects(replaceDerivedMemories(service, [memory('old')], [memory('a'), memory('b')]));
        assert.deepEqual(calls, ['save', 'save']);
    }
});

test('replacement deletes only the captured snapshot after all saves and counts successful deletes', async () => {
    const calls: string[] = [];
    const service = {
        saveMemory: async () => { calls.push('save'); return 'new'; },
        deleteMemory: async (id: string) => { calls.push(`delete:${id}`); if (id === 'failed') throw Error('synthetic failure'); },
    };
    assert.deepEqual(await replaceDerivedMemories(service, [memory('old'), memory('old'), memory('failed')], [memory('a'), memory('b')]), { created: 2, replaced: 1 });
    assert.deepEqual(calls, ['save', 'save', 'delete:old', 'delete:failed']);
    assert.deepEqual(await replaceDerivedMemories(service, [memory('old')], []), { created: 0, replaced: 0 });
    assert.equal(calls.length, 4);
});

for (const kind of ['chapter', 'schema'] as const) {
    test(`${kind} consolidation preserves the old generation on write failure and rejects fabricated source IDs`, async t => {
        const calls: string[] = [];
        const source = memory('source');
        let sourceIds: string[] = ['invented-id'];
        const result = () => kind === 'chapter'
            ? { chapters: [{ title: 'Тестовая глава', summary: 'Тестовая сводка', sourceIds }] }
            : { schemas: [{ title: 'Тестовая модель', summary: 'Тестовая сводка', guidance: 'Учитывать тестовый интерес', sourceIds, domains: ['work'] }] };
        t.mock.method(vector, 'getVectorService', () => ({
            getRecentMemories: async () => [source, memory('superseded', { status: 'superseded' })],
            getMemoriesByTag: async () => [memory('old', { tags: ['chapter_key:work:rolling-180d'] })],
            saveMemory: async () => { calls.push('save'); throw Error('synthetic write failure'); },
            deleteMemory: async () => { calls.push('delete'); },
        } as any));
        t.mock.method(completion, 'createChatCompletionForTask', async (_task: any, request: any) => {
            assert.ok(!request.messages[1].content.includes('id=superseded'));
            return response(result());
        });
        const run = () => kind === 'chapter'
            ? runMemoryConsolidationForUser(owner, { domain: 'work', minFacts: 1 })
            : runMemorySchemaConsolidationForUser(owner, { domain: 'work', minSources: 1 });
        assert.equal((await run()).created, 0);
        assert.deepEqual(calls, []);
        sourceIds = ['source'];
        await assert.rejects(run(), /synthetic write failure/);
        assert.deepEqual(calls, ['save']);
    });
}

test('both sleep indices preserve the previous index when saving fails', async t => {
    const writes: string[] = [], deletes: string[] = [];
    const sources = Array.from({ length: 3 }, (_, i) => memory(`source-${i}`, { memoryKind: 'goal', status: 'planned', confidence: .5 }));
    t.mock.method(vector, 'getVectorService', () => ({
        getRecentMemories: async () => sources,
        getMemoriesByTag: async (_owner: string, tag: string) => [memory(`old-${tag}`)],
        saveMemory: async (value: MemoryEntry) => { writes.push(value.predicate!); throw Error('synthetic failure'); },
        deleteMemory: async (id: string) => { deletes.push(id); },
    } as any));
    t.mock.method(completion, 'createChatCompletionForTask', async () => response({ summary: 'Тестовый индекс' }));
    const result = await runMemorySleepCycleForUser(owner);
    assert.deepEqual(writes, ['open_loop_index', 'memory_uncertainty_index']);
    assert.deepEqual(deletes, []);
    assert.equal(result.openLoopIndexCreated, false);
    assert.equal(result.uncertaintyIndexCreated, false);
});

test('compression preserves primary facts and records its bounded source pool as a derived chapter', async t => {
    const saved: MemoryEntry[] = [], deleted: string[] = [];
    const sources = Array.from({ length: 6 }, (_, i) => memory(`source-${i}`));
    t.mock.method(vector, 'getVectorService', () => ({
        getMemoriesForCompression: async () => [...sources, memory('bot', { subject: 'bot' }), memory('obsolete', { status: 'superseded' })],
        saveMemory: async (value: MemoryEntry) => { saved.push(value); return 'summary'; },
        deleteMemory: async (id: string) => { deleted.push(id); },
    } as any));
    t.mock.method(completion, 'createChatCompletionForTask', async (_task: any, request: any) => {
        assert.match(request.messages[1].content, /Факты \(6 штук/);
        return response({ summaries: ['Тестовое обобщение интересов.'] });
    });
    const result = await compressOldMemories({ from: { id: Number(owner) } } as any, 'work');
    assert.deepEqual(result, { compressed: 1, deleted: 0, sourceCount: 6 });
    assert.deepEqual(deleted, []);
    assert.equal(saved[0].memoryKind, 'chapter');
    assert.equal(saved[0].subject, 'user');
    assert.equal(saved[0].extractionMethod, 'compression');
    assert.deepEqual(saved[0].sourceMemoryIds, sources.map(source => source.id));
    assert.deepEqual(saved[0].sourceMemorySnapshots, snapshotMemorySources(sources));
    assert.ok(!saved[0].isAnchor);
});

test('a timed-out reconsolidation cannot resume writing when its model finally returns', async t => {
    let finish!: (value: any) => void;
    let reads = 0, writes = 0;
    t.mock.method(completion, 'createChatCompletionForTask', () => new Promise(resolve => { finish = resolve; }));
    t.mock.method(vector, 'getVectorService', () => ({
        fetchMemoryById: async () => { reads++; return memory('source'); },
        updateMemory: async () => { writes++; },
    } as any));
    const pending = reconsolidateAfterResponse({ from: { id: Number(owner) }, chat: { type: 'private' } } as any,
        'Да, я действительно изучаю тестовую астрономию.', 'Помню твой интерес.', [{ ...memory('source'), score: .9 }]);
    await pending;
    finish(response({ decisions: [{ index: 0, action: 'confirm' }] }));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(reads, 0); assert.equal(writes, 0);
});

test('confirmation cannot silently rewrite assertion metadata or revive a superseded fact', async t => {
    const source = memory('source', { predicate: 'studies', object: 'астрономию', negated: true, status: 'planned' });
    const patches: MemoryEntry[] = [];
    const owners: string[] = [];
    t.mock.method(completion, 'createChatCompletionForTask', async () => response({ decisions: [{
        index: 0, action: 'confirm', confirmationEvidence: 'Да, это именно так и было.', predicate: 'works_at', object: 'выдуманная работа', status: 'done',
    }] }));
    t.mock.method(vector, 'getVectorService', () => ({
        fetchMemoryById: async (_id: string, _domain: string, userId: string) => { owners.push(userId); return source; },
        updateMemory: async (_id: string, _domain: string, patch: MemoryEntry) => { patches.push(patch); },
    } as any));
    const run = () => reconsolidateAfterResponse({ from: { id: Number(owner) }, chat: { type: 'private' } } as any,
        'Да, это именно так и было.', 'Помню.', [{ ...source, score: .9 }]);
    await run();
    assert.equal(patches[0].predicate, 'studies'); assert.equal(patches[0].object, 'астрономию');
    assert.equal(patches[0].status, 'planned'); assert.equal(patches[0].negated, true);
    source.status = 'superseded';
    await run();
    assert.equal(patches.length, 1); assert.deepEqual(owners, [owner, owner]);
});

test('direct graph reads enforce the owner and namespace even for a known memory ID', async () => {
    const record = memory('source', { relatedIds: [{ id: 'target', domain: 'work' }] });
    const service: any = new QdrantVectorService({ retrieve: async () => [{ id: record.id, payload: record }] } as any);
    record.botId = service.botId;
    assert.ok(await service.fetchMemoryById('source', 'work', owner));
    assert.equal((await service.getRelatedFacts('source', 'work', owner)).length, 1);
    for (const change of [() => { record.userId = 'other-owner'; }, () => { record.userId = owner; record.botId = 'other-namespace'; }]) {
        change();
        assert.equal(await service.fetchMemoryById('source', 'work', owner), null);
        assert.deepEqual(await service.getRelatedFacts('source', 'work', owner), []);
    }
});

test('known-domain reinforcement performs one payload write without any collection search', async () => {
    let reads = 0;
    const writes: string[] = [];
    const service = new QdrantVectorService({
        retrieve: async () => { reads++; return []; },
        setPayload: async (collection: string) => { writes.push(collection); },
    } as any);
    await service.updateImportance('source', .8, 'work');
    assert.equal(reads, 0); assert.equal(writes.length, 1); assert.ok(writes[0].endsWith('_work'));
});

test('metadata-only updates preserve the vector and content changes re-embed exactly once', async () => {
    const source = memory('source');
    let embeddings = 0, upserts = 0;
    const payloads: any[] = [];
    const service: any = new QdrantVectorService({
        retrieve: async () => [{ id: source.id, payload: source }],
        overwritePayload: async (_collection: string, options: any) => { payloads.push(options); },
        upsert: async () => { upserts++; },
    } as any);
    service.ensureCollectionCompatibility = async () => 'exists';
    service.embed = async () => { embeddings++; return [1, 0]; };
    source.botId = service.botId;
    await service.updateMemory('source', 'work', { ...source, status: 'unknown', confidence: .5, negated: true });
    assert.equal(embeddings, 0); assert.equal(upserts, 0); assert.equal(payloads.length, 1);
    assert.equal(payloads[0].wait, true); assert.equal(payloads[0].payload.status, 'unknown');
    assert.equal(payloads[0].payload.negated, true);
    await service.updateMemory('source', 'work', { ...source, content: 'Новое содержание атомарного факта.' });
    assert.equal(embeddings, 1); assert.equal(upserts, 1); assert.equal(payloads.length, 1);
});

test('semantic caches distinguish long facts that share the same prefix', async t => {
    let calls = 0;
    t.mock.method(completion, 'createChatCompletionForTask', async () => response(++calls === 1
        ? { valence: 1, arousal: 1 } : { valence: 0, arousal: 0 }));
    const prefix = 'Синтетический контекст кеша. '.repeat(8);
    assert.equal((await detectEmotionalTag(prefix + 'Большая радость.'))?.isFlashbulb, true);
    assert.equal((await detectEmotionalTag(prefix + 'Нейтральная заметка.'))?.isFlashbulb, false);
    assert.equal(calls, 2);
});

test('reranker representation keeps subject, negative, planned and historical meaning within its budget', () => {
    const text = formatMemoryRerankCandidate(memory('source', { content: 'Тестовый текст. '.repeat(200), subject: 'contact',
        tags: ['contact_id:900000042'], status: 'planned', negated: true, predicate: 'works_at',
        validFrom: new Date('2020-01-01'), validTo: new Date('2021-01-01'),
    }), 0, 'тестовый');
    assert.ok(text.length <= 900);
    for (const fragment of ['"subject":"contact"', 'contact_id:900000042', '"negated":true', '"status":"planned"', '2020-01-01', '2021-01-01']) assert.ok(text.includes(fragment), fragment);
});

test('updating one assertion never expires unrelated facts in a legacy composite row', async t => {
    const old = memory('legacy-family-and-plan', { domain: 'family', predicate: 'family', content: 'У пользователя есть дочь Вера Учебная; поездка на учебный слёт запланирована на завтра.' });
    const saved: MemoryEntry[] = [], patches: unknown[] = [];
    let comparisons = 0;
    t.mock.method(vector, 'getVectorService', () => ({
        searchMemories: async () => [{ ...old, score: .999 }], searchAllDomains: async () => [{ ...old, score: .999 }],
        saveMemory: async (value: MemoryEntry) => { saved.push(value); return 'new-plan'; },
        updateMemory: async (...args: unknown[]) => { patches.push(args); },
    } as any));
    t.mock.method(completion, 'createChatCompletionForTask', async (_task: any, request: any) => {
        if (request.messages[1].content.startsWith('Два факта')) comparisons++;
        return response({ verdict: 'updates', state_change: true });
    });
    assert.equal(await saveMemory({ from: { id: Number(owner) }, session: {} } as any, 'family', 'Поездка на учебный слёт отменена.', .2, [], false,
        { subject: 'user', predicate: 'family', status: 'active' }), true);
    assert.equal(saved.length, 1); assert.equal(patches.length, 0); assert.equal(comparisons, 0);
    assert.equal(old.expiresAt, undefined); assert.ok(old.content.includes('Вера Учебная'));
});

test('a composite incoming fact cannot deduplicate or supersede an atomic fact', async t => {
    const old = memory('old-atomic-plan', { content: 'Поездка на учебный слёт запланирована.', predicate: 'trip' });
    const saved: MemoryEntry[] = [], patches: unknown[] = [];
    let comparisons = 0;
    t.mock.method(vector, 'getVectorService', () => ({
        searchMemories: async () => [{ ...old, score: .999 }], searchAllDomains: async () => [{ ...old, score: .999 }],
        saveMemory: async (value: MemoryEntry) => { saved.push(value); return 'new-composite'; },
        updateMemory: async (...args: unknown[]) => { patches.push(args); },
    } as any));
    t.mock.method(completion, 'createChatCompletionForTask', async (_task: any, request: any) => {
        if (request.messages[1].content.startsWith('Два факта')) comparisons++;
        return response({ verdict: 'updates', state_change: true });
    });
    assert.equal(await saveMemory({ from: { id: Number(owner) }, session: {} } as any, 'work',
        'Поездка на учебный слёт отменена; пользователь любит горы.', .2, [], false, { subject: 'user', predicate: 'trip' }), true);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(saved.length, 1); assert.equal(patches.length, 0); assert.equal(comparisons, 0);
});

test('one temporary clause cannot set an expiry for a composite memory', async t => {
    const saved: MemoryEntry[] = [];
    let expiryCalls = 0;
    t.mock.method(vector, 'getVectorService', () => ({
        searchMemories: async () => [], searchAllDomains: async () => [],
        saveMemory: async (value: MemoryEntry) => { saved.push(value); return `saved-${saved.length}`; },
    } as any));
    t.mock.method(completion, 'createChatCompletionForTask', async (task: string) => {
        if (task === 'memoryExtraction') { expiryCalls++; return response({ temporal: true, days: 1 }); }
        return response({ state_change: false });
    });
    for (const content of [
        'У пользователя есть сын Данил Учебный; завтра поездка на учебный слёт.',
        'Пользователь работает инженером и живёт в Учебногорске, завтра встреча.',
        'Пользователь любит горы; на выходных собирается поехать на слёт.',
    ]) assert.equal(await saveMemory({ from: { id: Number(owner) }, session: {} } as any, 'general', content, .2), true);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(expiryCalls, 0);
    assert.equal(saved.length, 3);
    assert.ok(saved.every(value => value.expiresAt === undefined));
});

test('temporary atomic plans retain valid expiry but malformed or negative model durations cannot expire them', async t => {
    const saved: MemoryEntry[] = [];
    let duration: unknown;
    t.mock.method(vector, 'getVectorService', () => ({
        searchMemories: async () => [], searchAllDomains: async () => [],
        saveMemory: async (value: MemoryEntry) => { saved.push(value); return `saved-${saved.length}`; },
    } as any));
    t.mock.method(completion, 'createChatCompletionForTask', async (task: string) =>
        response(task === 'memoryExtraction' ? duration : { state_change: false }));
    for (duration of [
        { temporal: true, days: -1 }, { temporal: true, days: 0 }, { temporal: true, days: '3' },
        { temporal: true, days: null }, { temporal: 'true', days: 3 }, { temporal: false, days: 3 },
        { temporal: true, days: 1e300 }, { temporal: true },
    ]) {
        assert.equal(await saveMemory({ from: { id: Number(owner) }, session: {} } as any, 'general',
            `Экзамен на следующей неделе, учебный поток ${saved.length}.`, .2), true);
        assert.equal(saved.at(-1)!.expiresAt, undefined);
    }
    for (const days of [3, .5]) {
        duration = { temporal: true, days };
        const before = Date.now();
        assert.equal(await saveMemory({ from: { id: Number(owner) }, session: {} } as any, 'general',
            `Встреча завтра, учебный поток ${saved.length}.`, .2), true);
        const expiry = new Date(saved.at(-1)!.expiresAt!).getTime();
        assert.ok(expiry >= before + days * 86_400_000 && expiry <= Date.now() + days * 86_400_000);
    }
    await new Promise(resolve => setImmediate(resolve));
});

test('background planning updates preserve independent facts and the old atomic assertion as history', async t => {
    const atomic = memory('old-plan', { content: 'Пользователь планирует поездку на учебный слёт.', predicate: 'trip',
        object: 'учебный слёт', status: 'planned' });
    const candidates = [atomic,
        memory('composite', { content: 'Дочь пользователя — Вера Учебная; запланирована поездка на слёт.', predicate: 'trip' }),
        memory('different-predicate', { content: 'Пользователь планирует обследование перед поездкой.', predicate: 'checkup' }),
        memory('different-subject', { content: 'Тестовый знакомый планирует поездку на слёт.', subject: 'contact', predicate: 'trip' }),
        memory('different-person', { content: 'Тестовый знакомый планирует поездку на слёт.', predicate: 'trip', tags: ['person_id:synthetic-other-person'] }),
    ].map(value => ({ ...value, score: .62 }));
    const saved: MemoryEntry[] = [], patches: Array<{ id: string; patch: MemoryEntry }> = [];
    let comparisons = 0;
    let failSave = false;
    t.mock.method(vector, 'getVectorService', () => ({
        searchMemories: async () => [], searchAllDomains: async () => candidates,
        saveMemory: async (value: MemoryEntry) => { if (failSave) throw Error('synthetic failed save'); saved.push(value); return 'completed-trip'; },
        updateMemory: async (id: string, _domain: string, patch: MemoryEntry) => { patches.push({ id, patch }); },
    } as any));
    t.mock.method(completion, 'createChatCompletionForTask', async (_task: any, request: any) => {
        if (request.messages[1].content.startsWith('Два факта')) { comparisons++; return response({ verdict: 'updates', mergedContent: 'Вымышленное утверждение, не подтверждённое источником.' }); }
        return response({ state_change: true, planning: true });
    });
    const run = (content: string) => saveMemory({ from: { id: Number(owner) }, session: {} } as any, 'general', content, .2,
        [], false, { subject: 'user', predicate: 'trip', status: 'done' });
    assert.equal(await run('Поездка на учебный слёт завершена.'), true);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(saved.length, 1); assert.equal(comparisons, 1); assert.equal(patches.length, 1);
    assert.equal(patches[0].id, atomic.id); assert.equal(patches[0].patch.content, atomic.content);
    assert.equal(patches[0].patch.timestamp, atomic.timestamp); assert.equal(patches[0].patch.status, 'superseded');
    assert.ok(new Date(patches[0].patch.expiresAt!).getTime() <= Date.now());
    assert.equal(patches[0].patch.userId, owner);
    failSave = true;
    assert.equal(await run('Повторная учебная поездка завершена.'), false);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(patches.length, 1, 'a failed new save never closes an old plan');
});

test('high vector similarity cannot merge different predicates, objects, polarity, status or time', async t => {
    const base = { subject: 'user' as const, predicate: 'studies', object: 'astronomy', negated: false, status: 'active' as const };
    assert.equal(canDeduplicateMemoryAssertions(base, { ...base, object: ' Astronomy ' }), true);
    const changes: Array<Partial<MemoryEntry>> = [
        { predicate: 'teaches' }, { object: 'biology' }, { negated: true }, { status: 'planned' },
        { validFrom: new Date('2020-01-01') },
    ];
    const saved: MemoryEntry[] = [], patches: MemoryEntry[] = [];
    let existing = memory('old');
    let comparisons = 0;
    t.mock.method(vector, 'getVectorService', () => ({
        searchMemories: async () => [{ ...existing, score: .999 }],
        searchAllDomains: async () => [{ ...existing, score: .999 }],
        saveMemory: async (value: MemoryEntry) => { saved.push(value); return `new-${saved.length}`; },
        updateMemory: async (_id: string, _domain: string, value: MemoryEntry) => { patches.push(value); },
    } as any));
    t.mock.method(completion, 'createChatCompletionForTask', async (_task: any, request: any) => {
        if (request.messages[1].content.startsWith('Два факта')) comparisons++;
        return response({ verdict: 'complements', state_change: false });
    });
    for (let i = 0; i < changes.length; i++) {
        existing = memory('old', { ...base, ...changes[i], content: `Тестовый интерес с кодом ${i}.` });
        const incoming = { ...base, validFrom: new Date('2021-01-01') };
        assert.equal(canDeduplicateMemoryAssertions(incoming, existing), false);
        assert.equal(await saveMemory({ from: { id: Number(owner) }, session: {} } as any, 'work', `Тестовый интерес с кодом ${i}, уточнение.`, .2, [], false, incoming), true);
    }
    assert.equal(saved.length, changes.length);
    assert.equal(patches.length, 0, 'a distinct assertion is not rewritten as a confirmation');
    assert.equal(comparisons, 4, 'different predicates bypass contradiction; high-cosine changes still reach it');
});
