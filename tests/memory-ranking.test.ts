import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BotContext, SearchResult } from '../types';
import { PREDEFINED_DOMAINS } from '../constants/domains';
import { QdrantVectorService } from '../services/QdrantVectorService';
import * as vector from '../services/VectorServiceFactory';
import * as completion from '../ai/chatCompletion';
import { getMultiQueryMemoryContextDetailed, formatLayeredMemoryContext, generateMemoryQueries } from '../utils/multiQueryMemory';
import { memoryContentExcerpt, memoryRerankCacheKey, parseMemoryRerankOrder } from '../utils/memoryRanking';
import { isMemoryEntryAllowedForContactScope } from '../utils/contactMemory';

const owner = 'synthetic-owner';
const date = new Date('2026-01-01');
const fact = (id: string, content: string, extra: Partial<SearchResult> = {}): SearchResult => ({
    id, content, score: .8, tags: [], importance: .7, confidence: .9, timestamp: date, domain: 'work', ...extra,
});
const point = (record: SearchResult) => ({ id: record.id, score: record.score, payload: { ...record, userId: owner } });

test('an existing text index works without schema-write permission and readiness is cached', async () => {
    let reads = 0, writes = 0;
    const service: any = new QdrantVectorService({ getCollection: async () => {
        reads++; return { payload_schema: { content: { data_type: 'text' } } };
    }, createPayloadIndex: async () => { writes++; throw Error('Read-only role'); } } as any);
    assert.equal(await service.ensureMemoryTextIndex('synthetic_memories_work'), true);
    assert.equal(await service.ensureMemoryTextIndex('synthetic_memories_work'), true);
    assert.equal(reads, 1); assert.equal(writes, 0);
});

test('text index creation remains available when metadata cannot be read', async () => {
    let writes = 0;
    const service: any = new QdrantVectorService({ getCollection: async () => { throw Error('Metadata unavailable'); },
        createPayloadIndex: async () => { writes++; return { status: 'completed' }; } } as any);
    assert.equal(await service.ensureMemoryTextIndex('synthetic_memories_work'), true); assert.equal(writes, 1);
});

test('bounded lexical AND pool rescues a precise fact behind sixty common-word hits', async () => {
    const calls: any[] = [];
    const noise = Array.from({ length: 80 }, (_, i) => point(fact(`noise-${i}`, 'Обсуждали синий конверт.')));
    const answer = point(fact('answer', 'Синий блокнот лежит в сейфе.'));
    const service: any = new QdrantVectorService({ scroll: async (collection: string, args: any) => {
        calls.push(args);
        if (!collection.endsWith('_' + PREDEFINED_DOMAINS.WORK)) return { points: [] };
        return { points: args.filter.min_should ? noise.slice(0, args.limit) : [answer] };
    } } as any);
    service.ensureCollectionCompatibility = async () => 'exists';
    service.ensureMemoryTextIndex = async () => true;
    const results = await service.searchLexicalAllDomains('синий блокнот', owner, 5);
    assert.equal(results[0].id, 'answer');
    assert.equal(calls.length, Object.values(PREDEFINED_DOMAINS).length * 2);
    for (const call of calls) {
        assert.ok(call.limit <= 60);
        assert.ok(call.filter.must.some((c: any) => c.key === 'botId'));
        assert.ok(call.filter.must.some((c: any) => c.key === 'userId' && c.match.value === owner));
        assert.ok(call.filter.must_not.some((c: any) => c.key === 'expiresAt'));
    }
});

test('contact filtering precedes global dense top-k and raw relevance precedes age/popularity', async () => {
    const wrong = Array.from({ length: 40 }, (_, i) => fact(`other-${i}`, '[Чужой Тестовый] работает в другом месте.', { score: .99, tags: ['contact_id:999999'] }));
    const old = fact('old-direct', 'Пользователь работает в «Синтетическом Маяке».', { score: .9, timestamp: new Date('2010-01-01'), importance: .1 });
    const recent = fact('recent-noise', 'Пользователь обсуждает работу.', { score: .7, timestamp: new Date(), importance: 1, retrievalCount: 100 });
    const service: any = new QdrantVectorService({ search: async (collection: string, args: any) =>
        collection.endsWith('_' + PREDEFINED_DOMAINS.WORK) ? [...wrong, old, recent].slice(0, args.limit).map(point) : [] } as any);
    service.embed = async () => [0];
    const results = await service.searchAllDomains('работа', owner, 15, {
        relevanceOnly: true, acceptCandidate: (candidate: SearchResult) => isMemoryEntryAllowedForContactScope(candidate, null),
    });
    assert.deepEqual(results.map((c: SearchResult) => c.id), ['old-direct', 'recent-noise']);
    assert.equal(results[0].score, .9, 'cosine is not changed by conversational selection');
});

test('reranker output validation distinguishes abstention from malformed and unseen numbers', () => {
    assert.deepEqual(parseMemoryRerankOrder('NONE', 30), []);
    assert.deepEqual(parseMemoryRerankOrder('3, 1, 3', 3), [2, 0]);
    for (const value of ['', '1foo', '1.5', '0,1', '31', '1, 99', 'Ответ: 1', '1\n2']) assert.equal(parseMemoryRerankOrder(value, 30), null, value);
});

test('owner memory document headings are not contact names, while mixed and contact evidence stays isolated', () => {
    for (const content of ['[ГЛАВА ПАМЯТИ: Тестовая работа]\nОписание.', '[МОДЕЛЬ ПАМЯТИ: Тестовая привычка]\nОписание.', '[ИНДЕКС СОМНЕНИЙ ПАМЯТИ]\nОписание.']) {
        assert.equal(isMemoryEntryAllowedForContactScope({ content, subject: 'user', tags: ['subject:user'] }, null), true);
        for (const memory of [
            { content, subject: 'system', tags: [] },
            { content, subject: 'user', tags: ['source_contact:Чужой Тестовый'] },
            { content, subject: 'user', tags: ['contact_id:999999'] },
            { content, subject: 'user', tags: ['subject:contact'] },
            { content, tags: [] },
        ]) assert.equal(isMemoryEntryAllowedForContactScope(memory, null), false);
    }
});

test('reranker cache includes owner, content, limit and long query suffix', () => {
    const base = 'x'.repeat(160);
    const first = memoryRerankCacheKey('owner-a', base + ' синий', [fact('same', 'old')], 5);
    for (const key of [
        memoryRerankCacheKey('owner-b', base + ' синий', [fact('same', 'old')], 5),
        memoryRerankCacheKey('owner-a', base + ' красный', [fact('same', 'old')], 5),
        memoryRerankCacheKey('owner-a', base + ' синий', [fact('same', 'new')], 5),
        memoryRerankCacheKey('owner-a', base + ' синий', [fact('same', 'old')], 2),
    ]) assert.notEqual(key, first);
    assert.ok(!first.includes('синий'));
});

test('context budget preserves reranker priority across layers and bounds long episodes', () => {
    const direct = { ...fact('direct', 'Супруга пользователя — Лада Тестовая.', { memoryKind: 'relationship' }), _finalScore: .6 };
    const irrelevant = { ...fact('core-noise', 'Описание проекта. '.repeat(200), { memoryKind: 'fact' }), _finalScore: .99 };
    const packed = formatLayeredMemoryContext([direct, irrelevant], 200, 'супруга');
    assert.equal(packed.includedMemories[0]?.id, 'direct');
    assert.match(packed.context, /Лада Тестовая/);
    assert.ok(Math.ceil(packed.context.length / 3.5) <= 200);
    const long = { ...fact('episode', 'Фон. '.repeat(400) + 'Синий блокнот лежит в сейфе. ' + 'Фон. '.repeat(400)), _finalScore: .9 };
    const bounded = formatLayeredMemoryContext([long], 500, 'синий блокнот');
    assert.match(bounded.context, /Синий блокнот лежит в сейфе/);
    assert.match(bounded.context, /фрагмент/);
    assert.ok(Math.ceil(bounded.context.length / 3.5) <= 500);
    assert.ok(memoryContentExcerpt(long.content, 'синий блокнот', 300).length <= 300);
});

test('query generation failure does not invent unrelated topics', async t => {
    t.mock.method(completion, 'createChatCompletionForTask', async () => { throw new Error('synthetic outage'); });
    const result = await generateMemoryQueries('Где лежит тестовый зелёный конверт?');
    assert.ok(result.answerQueries.some(query => query.includes('конверт')));
    assert.deepEqual(result.contextQueries, []);
    assert.ok(!result.answerQueries.some(query => /поездка|даты события/.test(query)));
});

test('shared retrieval honours reranker abstention and disables reinforcement in read-only analysis', async t => {
    let writes = 0;
    let rankCalls = 0;
    const candidates = Array.from({ length: 5 }, (_, i) => fact(`candidate-${i}`, `Синтетический факт о блокноте ${i}.`));
    t.mock.method(vector, 'getVectorService', () => ({
        getAnchorMemories: async () => [], getMemoriesByTag: async () => [],
        searchAllDomains: async () => candidates, searchLexicalAllDomains: async () => [],
        getRelatedFacts: async () => [],
        updateImportance: async () => { writes++; }, updateMemoryAccess: async () => { writes++; },
    } as any));
    t.mock.method(completion, 'createChatCompletionForTask', async (_task: any, request: any) => {
        const ranking = request.messages[0].content.startsWith('Ты ранжируешь');
        if (ranking) rankCalls++;
        return { choices: [{ message: { content: ranking ? 'NONE' : 'ANSWER:\nтестовый блокнот\nCONTEXT:\n' } }] } as any;
    });
    const ctx = { from: { id: 741991 }, chat: { type: 'private' }, session: {} } as BotContext;
    const result = await getMultiQueryMemoryContextDetailed(ctx, 'Что помнишь про синтетический блокнот?', 'full', { explain: true, trackAccess: false });
    assert.equal(rankCalls, 1);
    assert.equal(result.retrievalTrace?.reranker?.status, 'abstained');
    assert.deepEqual(result.recalledMemories, []);
    assert.equal(writes, 0);
    assert.ok(!result.context.includes('Синтетический факт'));
});

test('a selected direct fact keeps reranker priority and read-only recall never reinforces it', async t => {
    let writes = 0;
    const candidates = Array.from({ length: 5 }, (_, i) => fact(`rank-priority-${i}`, `Тестовый блокнот: вариант ${i}.`, { score: .9 - i * .04 }));
    t.mock.method(vector, 'getVectorService', () => ({
        getAnchorMemories: async () => [], getMemoriesByTag: async () => [],
        searchAllDomains: async () => candidates, searchLexicalAllDomains: async () => [], getRelatedFacts: async () => [],
        updateImportance: async () => { writes++; }, updateMemoryAccess: async () => { writes++; },
    } as any));
    t.mock.method(completion, 'createChatCompletionForTask', async (_task: any, request: any) => ({ choices: [{ message: {
        content: request.messages[0].content.startsWith('Ты ранжируешь') ? '5,1' : 'ANSWER:\nтестовый блокнот приоритет\nCONTEXT:\n',
    } }] } as any));
    const ctx = { from: { id: 741992 }, chat: { type: 'private' }, session: {} } as BotContext;
    const result = await getMultiQueryMemoryContextDetailed(ctx, 'Вспомни тестовый блокнот с приоритетом?', 'full', { trackAccess: false });
    assert.equal(result.recalledMemories[0]?.id, 'rank-priority-4');
    assert.equal(writes, 0, 'a nonempty selection must not mutate access, importance or cues');
    assert.ok(result.context.indexOf('вариант 4') < result.context.indexOf('вариант 0'));
});
