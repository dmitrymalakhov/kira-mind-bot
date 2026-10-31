import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BotContext, MemoryEntry } from '../types';
import type { MemoryQueryPlan, MemoryRecallSummary } from '../types/memoryRecallTypes';
import { QdrantVectorService } from '../services/QdrantVectorService';
import { applyMemoryReadCoverage, collectMemoryReads, observeMemoryRead, readMemoryOr } from '../utils/memoryReadCoverage';
import { getMultiQueryMemoryContextDetailed } from '../utils/multiQueryMemory';
import { fetchAgentMemoryContext } from '../utils/agentMemoryContext';
import { recallOwnerRelationship } from '../utils/personalRelationshipRecall';
import { buildMemoryAnswerPrompt, confirmedMemoryIdentityAnswer } from '../utils/memoryAnswer';
import { saveMemoryFocus, validMemoryFocus } from '../utils/memoryQueryPlan';
import { runKiraRuntime } from '../orchestration/runtime/kernel';
import { snapshotMemorySources } from '../utils/derivedMemoryFreshness';
import * as vector from '../services/VectorServiceFactory';
import * as ai from '../ai/chatCompletion';
import * as group from '../services/groupChatFeatureSettings';

const owner = '900000081';
const fact = (id: string, domain = 'work'): MemoryEntry => ({ id, domain, botId: '', userId: owner, timestamp: new Date(),
    content: 'Пользователь разрабатывает учебный симулятор.', importance: .8, confidence: .9, tags: ['subject:user'], subject: 'user', status: 'active' });
const context = (channel = 'telegram'): BotContext => ({ from: { id: Number(owner) }, chat: { id: Number(owner), type: 'private' },
    sessionStorageKey: channel === 'api' ? `api:${owner}` : owner, session: { messageHistory: [] } } as any);
const plan = (extra: Partial<MemoryQueryPlan> = {}): MemoryQueryPlan => ({ answerQueries: ['учебный симулятор'], contextQueries: [], requestKind: 'specific',
    references: [{ kind: 'person', from: 'owner', mention: 'я', relationPath: [] }], ...extra });
const unavailable = new Error('SYNTHETIC_SECRET: backend unavailable');

function backend(records: MemoryEntry[], fail: (method: string, domain: string, args: any) => boolean = () => false) {
    let requests = 0;
    const read = async (method: string, collection: string, args: any) => {
        requests++;
        const domain = collection.split('_').at(-1)!;
        if (fail(method, domain, args)) throw unavailable;
        const available = records.filter(record => record.domain === domain && record.userId === owner &&
            (method !== 'retrieve' || args.ids.includes(record.id)) &&
            (args.filter?.must ?? []).every((item: any) => item.key !== 'isAnchor' || record.isAnchor));
        return available.map(record => ({ id: record.id, score: .95, payload: JSON.parse(JSON.stringify(record)) }));
    };
    const service: any = new QdrantVectorService({
        search: (collection: string, args: any) => read('search', collection, args),
        retrieve: (collection: string, args: any) => read('retrieve', collection, args),
        scroll: async (collection: string, args: any) => ({ points: await read('scroll', collection, args) }),
    } as any);
    service.embed = async () => [1, 0];
    service.ensureCollectionCompatibility = async () => 'exists';
    service.ensureMemoryTextIndex = async () => true;
    service.ensureMemoryTimestampIndex = async () => undefined;
    for (const record of records) record.botId = service.botId;
    return { service: service as QdrantVectorService, requests: () => requests };
}

test('availability is request-local, nested coverage merges once, and fallback never serializes the error', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const failed = collectMemoryReads(async () => {
        const nested = await collectMemoryReads(() => readMemoryOr(() => observeMemoryRead(async () => { await gate; throw unavailable; }), []));
        return nested.coverage;
    });
    const healthy = await collectMemoryReads(async () => { release(); return observeMemoryRead(async () => []); });
    const result = await failed;
    assert.deepEqual(result.coverage, { status: 'unavailable', succeeded: 0, failed: 1 });
    assert.deepEqual(result.value, result.coverage);
    assert.deepEqual(healthy.coverage, { status: 'available', succeeded: 1, failed: 0 });
    assert.equal((await collectMemoryReads(async () => [])).coverage, undefined);
    assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_SECRET/);
});

test('a detached read finishing after its turn does not affect the next turn', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let finish!: Promise<unknown>;
    const closed = await collectMemoryReads(async () => {
        finish = observeMemoryRead(async () => { await gate; throw unavailable; }).catch(() => undefined);
        return [];
    });
    const next = await collectMemoryReads(async () => { release(); await finish; return observeMemoryRead(async () => []); });
    assert.equal(closed.coverage, undefined);
    assert.deepEqual(next.coverage, { status: 'available', succeeded: 1, failed: 0 });
});

test('empty, partial and unavailable reads produce different shared recall results', async t => {
    for (const mode of ['empty', 'partial', 'unavailable'] as const) {
        const store = backend(mode === 'partial' ? [fact('answer')] : [], (_method, domain) => mode === 'unavailable' || mode === 'partial' && domain === 'travel');
        t.mock.method(vector, 'getVectorService', () => store.service);
        const memory = await getMultiQueryMemoryContextDetailed(context(), 'Что я разрабатываю?', 'light', { queryPlan: plan(), trackAccess: false });
        assert.equal(memory.recall?.state, mode);
        assert.equal(memory.recall?.readCoverage?.status, mode === 'empty' ? 'available' : mode);
        if (mode === 'partial') {
            assert.match(memory.context, /учебный симулятор/); assert.equal(memory.recalledMemories[0].id, 'answer');
        } else assert.deepEqual(memory.recalledMemories, []);
        if (mode === 'unavailable') assert.match(memory.context, /не удалось прочитать память/);
        assert.doesNotMatch(JSON.stringify(memory), /SYNTHETIC_SECRET/);
        t.mock.restoreAll();
    }
});

test('a scoped overview keeps records read before the next page failed', async t => {
    const store = backend([fact('answer')]);
    (store.service as any).client.scroll = async (collection: string, args: any) => {
        if (!collection.endsWith('_work')) return { points: [] };
        if (args.offset) throw unavailable;
        return { points: [{ id: 'answer', payload: { ...fact('answer'), botId: (store.service as any).botId } }], next_page_offset: 'next' };
    };
    t.mock.method(vector, 'getVectorService', () => store.service);
    const memory = await getMultiQueryMemoryContextDetailed(context(), 'Что помнишь про мою работу?', 'full', { queryPlan: plan({ requestKind: 'overview', domains: ['work'] }), trackAccess: false });
    assert.equal(memory.recall?.state, 'partial');
    assert.match(memory.context, /учебный симулятор/);
    assert.equal(memory.recalledMemories[0].id, 'answer');
    assert.ok(memory.recall!.readCoverage!.succeeded > 0); assert.ok(memory.recall!.readCoverage!.failed > 0);
});

test('lexical failure preserves dense evidence and does not masquerade as a complete search', async t => {
    const store = backend([fact('answer')], method => method === 'scroll');
    t.mock.method(vector, 'getVectorService', () => store.service);
    const memory = await getMultiQueryMemoryContextDetailed(context(), 'Вспомни учебную разработку', 'light', { queryPlan: plan({ references: [] }), trackAccess: false });
    assert.equal(memory.recall?.state, 'partial'); assert.match(memory.context, /учебный симулятор/);
    assert.equal(memory.recalledMemories[0].id, 'answer');
});

test('a failed derived-source read excludes the summary and reports the search failure', async t => {
    const source = fact('source');
    const chapter = { ...fact('chapter'), content: '[ГЛАВА ПАМЯТИ: Учебная разработка]\nУСТАРЕВШАЯ СВОДКА', memoryKind: 'chapter',
        sourceMemoryIds: [source.id], sourceMemorySnapshots: snapshotMemorySources([source]) } as MemoryEntry;
    const store = backend([chapter], method => method === 'retrieve');
    t.mock.method(vector, 'getVectorService', () => store.service);
    const memory = await getMultiQueryMemoryContextDetailed(context(), 'Что я разрабатываю?', 'light', { queryPlan: plan(), trackAccess: false });
    assert.equal(memory.recall?.state, 'partial'); assert.deepEqual(memory.recalledMemories, []);
    assert.doesNotMatch(memory.context, /УСТАРЕВШАЯ СВОДКА/);
    assert.match(memory.context, /часть источников памяти не удалось прочитать/);
});

test('an unavailable identity registry asks for no redundant name clarification', async t => {
    t.mock.method(vector, 'getVectorService', () => backend([]).service);
    const memory = await getMultiQueryMemoryContextDetailed(context(), 'Что помнишь о Марине Синтетической?', 'full', { trackAccess: false,
        queryPlan: plan({ requestKind: 'overview', references: [{ kind: 'person', from: 'named', mention: 'Марине Синтетической', relationPath: [] }] }) });
    assert.equal(memory.recall?.state, 'unavailable');
    assert.match(memory.context, /не удалось прочитать память/); assert.doesNotMatch(memory.context, /уточни имя/iu);
});

test('a domain failure does not discard anchors already loaded from a different domain', async () => {
    const source = { ...fact('anchor'), isAnchor: true };
    const store = backend([source], (_method, domain) => domain === 'travel');
    const result = await collectMemoryReads(() => store.service.getAnchorMemories(owner));
    assert.equal(result.coverage?.status, 'partial'); assert.deepEqual(result.value.map(record => record.id), ['anchor']);
});

test('incomplete relation lookup cannot confirm a unique person or take the deterministic name shortcut', async t => {
    const edge: MemoryEntry = { ...fact('spouse', 'family'), content: 'Пользователь состоит в браке с Ладой Учебной.',
        tags: ['subject:user', 'person_relation', 'relation_type:spouse_of', 'relation_subject:user',
            'relation_object_person_id:synthetic-partner', 'relation_object_name:Лада Учебная'] };
    const store = backend([edge], (_method, domain) => domain === 'work');
    const relationship = await recallOwnerRelationship(store.service, owner, 'Как зовут мою супругу?');
    assert.equal(relationship.complete, false); assert.equal(relationship.person, undefined); assert.equal(relationship.unavailable, true);
    assert.doesNotMatch(relationship.context, /с одним person_id/);
    t.mock.method(vector, 'getVectorService', () => store.service);
    const memory = await getMultiQueryMemoryContextDetailed(context(), 'Как зовут мою супругу?', 'full', {
        queryPlan: plan({ requestKind: 'identity', answerQueries: ['состоит в браке'], references: [{ kind: 'person', from: 'owner', mention: 'мою супругу', relationPath: [{ type: 'spouse_of', direction: 'either' }] }] }), trackAccess: false,
    });
    assert.notEqual(memory.recall?.identityVerified, true);
    assert.equal(confirmedMemoryIdentityAnswer(memory.recall), undefined);
});

test('proven ambiguity remains ambiguity even when another relation source is unavailable', async t => {
    const edges = ['Лада Учебная', 'Элла Синтетическая'].map((name, i): MemoryEntry => ({ ...fact(`edge-${i}`, 'family'),
        content: `Пользователь состоит в браке с ${name}.`, tags: ['subject:user', 'person_relation', 'relation_type:spouse_of',
            'relation_subject:user', `relation_object_person_id:synthetic-${i}`, `relation_object_name:${name}`] }));
    const store = backend(edges, (_method, domain) => domain === 'work');
    t.mock.method(vector, 'getVectorService', () => store.service);
    const memory = await getMultiQueryMemoryContextDetailed(context(), 'Как зовут мою супругу?', 'full', { trackAccess: false,
        queryPlan: plan({ requestKind: 'identity', references: [{ kind: 'person', from: 'owner', mention: 'мою супругу', relationPath: [{ type: 'spouse_of', direction: 'either' }] }] }) });
    assert.equal(memory.recall?.state, 'ambiguous'); assert.equal(memory.recall?.readCoverage?.status, 'partial');
    assert.notEqual(memory.recall?.identityVerified, true); assert.match(memory.context, /неоднозначен/);
});

test('an outage on a continuation does not exhaust evidence or erase the established focus', async t => {
    const store = backend([], () => true);
    t.mock.method(vector, 'getVectorService', () => store.service);
    const ctx = context();
    saveMemoryFocus(ctx, [{ owner: true, personIds: ['user'], displayName: 'владелец', evidenceIds: [] }], 'Работа', ['previous'], Date.now(), plan({ requestKind: 'overview', domains: ['work'] }));
    const previous = JSON.parse(JSON.stringify(ctx.session.memoryRecallFocus));
    const memory = await getMultiQueryMemoryContextDetailed(ctx, 'А что ещё?', 'full', { queryPlan: plan({ requestKind: 'overview', references: [{ kind: 'topic', from: 'focus', mention: 'ещё', relationPath: [] }] }), trackAccess: false });
    assert.equal(memory.recall?.state, 'unavailable'); assert.notEqual(memory.recall?.noNewEvidenceInPool, true);
    assert.doesNotMatch(memory.context, /новых сведений.*нет|новых людей.*не найдено/iu);
    assert.deepEqual(JSON.parse(JSON.stringify(validMemoryFocus(ctx))), previous);
});

test('availability reaches the real foreground helper and kernel prompt in Telegram and API channels', async t => {
    const store = backend([fact('answer')], (_method, domain) => domain === 'travel');
    t.mock.method(vector, 'getVectorService', () => store.service);
    t.mock.method(group, 'isGroupChatContextEnabled', async () => false);
    t.mock.method(ai, 'createChatCompletionForTask', async (_task: string, request: any) => {
        if (request.messages[0].content.startsWith('Ты составляешь структурированный план RAG-поиска')) return { choices: [{ message: { content: JSON.stringify(plan({ requestKind: 'overview',
            references: [{ kind: 'topic', from: 'focus', mention: 'ещё', relationPath: [] }] })) } }] } as any;
        assert.match(JSON.stringify(request.messages), /partial/);
        assert.match(JSON.stringify(request.messages), /учебный симулятор/);
        assert.doesNotMatch(JSON.stringify(request.messages), /SYNTHETIC_SECRET/);
        return { choices: [{ message: { content: 'Ты разрабатываешь учебный симулятор. Часть памяти сейчас недоступна, поэтому поиск неполный.' } }] } as any;
    });
    // Query generation is separately controlled; no canned routing decision is needed for source availability.
    for (const channel of ['telegram', 'api']) {
        const ctx = context(channel);
        saveMemoryFocus(ctx, [{ owner: true, personIds: ['user'], displayName: 'владелец', evidenceIds: [] }], 'Учебная разработка', ['previous'], Date.now(), plan({ requestKind: 'overview' }));
        const memory = await fetchAgentMemoryContext(ctx, 'А что ещё?', { memoryNeed: 'full', includeTodayImportance: false, trackAccess: false });
        assert.equal(memory.recall?.state, 'partial');
        const answer = await runKiraRuntime({ ctx, message: 'А что ещё?', messageHistory: [], isForwarded: false, forwardFrom: '',
            classification: { intent: 'РАЗГОВОР', confidenceLevel: 'ВЫСОКИЙ', details: { memoryTask: 'lookup', memoryNeed: 'full' } },
            enrichedContextFromMemory: memory.context, memoryRecall: memory.recall });
        assert.match(answer.responseText, /учебный симулятор/); assert.match(answer.responseText, /поиск неполный/);
        assert.equal((memory.context.match(/Поиск выполнен частично/g) ?? []).length, 1);
    }
});

test('prompt and identity guards do not treat a serialized incomplete result as an exhausted pool or a verified identity', () => {
    const summary: MemoryRecallSummary = { state: 'found', requestKind: 'identity', identityVerified: true, evidenceCount: 1,
        subjects: [{ name: 'Лада Учебная', owner: false }], domains: [], noNewEvidenceInPool: true, freshEvidenceCount: 0,
        readCoverage: { status: 'partial', succeeded: 1, failed: 1 } };
    assert.equal(confirmedMemoryIdentityAnswer(JSON.parse(JSON.stringify(summary))), undefined);
    const prompt = buildMemoryAnswerPrompt({ question: 'А что ещё?', dateTime: 'synthetic', context: 'НАЙДЕННОЕ СВИДЕТЕЛЬСТВО', summary, history: [] });
    assert.match(prompt, /НАЙДЕННОЕ СВИДЕТЕЛЬСТВО/); assert.doesNotMatch(prompt, /Поиск завершён:.*нет новых/);
    const applied = applyMemoryReadCoverage({ context: 'НАЙДЕННОЕ СВИДЕТЕЛЬСТВО', recall: summary }, summary.readCoverage);
    assert.equal(applied.recall.state, 'partial'); assert.notEqual(applied.recall.noNewEvidenceInPool, true);
});

test('an unrelated programming error is not swallowed as an unavailable memory source', async t => {
    t.mock.method(vector, 'getVectorService', () => { throw new Error('synthetic unexpected bug'); });
    await assert.rejects(getMultiQueryMemoryContextDetailed(context(), 'Что я разрабатываю?', 'light', { queryPlan: plan() }), /synthetic unexpected bug/);
});
