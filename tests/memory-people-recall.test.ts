import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BotContext, SearchResult } from '../types';
import type { MemoryQueryPlan } from '../types/memoryRecallTypes';
import * as identity from '../services/PersonIdentityService';
import * as vector from '../services/VectorServiceFactory';
import * as ai from '../ai/chatCompletion';
import { AppDataSource } from '../data-source';
import { QdrantVectorService } from '../services/QdrantVectorService';
import { parseMemoryQueryPlan, validMemoryFocus } from '../utils/memoryQueryPlan';
import { recallMemoryPeople, formatMemoryPeople } from '../utils/memoryPeopleRecall';
import { getMultiQueryMemoryContextDetailed } from '../utils/multiQueryMemory';

const owner = '740893';
const people = [
    { id: 'synthetic-lada', displayName: 'Лада Тестовая', telegramContactId: '555123', aliases: [] },
    { id: 'synthetic-miron', displayName: 'Мирон Примеров', telegramContactId: '555124', aliases: [] },
    { id: 'synthetic-ella', displayName: 'Элла Примерная', telegramContactId: '555125', aliases: [] },
];
const context = (): BotContext => ({ from: { id: Number(owner) }, chat: { id: Number(owner), type: 'private' }, session: { messageHistory: [] } } as any);
const plan = (): MemoryQueryPlan => ({ answerQueries: ['рабочие собеседники'], contextQueries: [], domains: ['work'], requestKind: 'people_list',
    peopleQuery: { basis: 'both', relations: [{ type: 'works_with', direction: 'either' }] },
    references: [{ kind: 'person', mention: 'я', from: 'owner', relationPath: [] }] });
function fact(id: string, index = 0, patch: Partial<SearchResult> = {}): SearchResult {
    const person = people[index];
    return { id, content: 'Обсуждает тестовую рабочую задачу.', domain: 'work', timestamp: new Date('2026-01-01'), score: .9, importance: .7,
        confidence: .95, memoryKind: 'fact', subject: 'contact', status: 'active', tags: [`person_id:${person.id}`, `contact_id:${person.telegramContactId}`],
        sourceMessageIds: [`tg:${person.telegramContactId}:100`], ...patch };
}
function edge(id: string, subject: string, object: string, type = 'works_with', patch: Partial<SearchResult> = {}): SearchResult {
    return fact(id, 0, { subject: 'user', sourceMessageIds: [], tags: ['person_relation', `relation_type:${type}`,
        subject === 'user' ? 'relation_subject:user' : `relation_subject_person_id:${subject}`,
        object === 'user' ? 'relation_object:user' : `relation_object_person_id:${object}`], ...patch });
}
const service = (records: SearchResult[]) => ({ getPeopleMemories: async (userId: string, domains: string[], _limit: number, options: any) => {
    assert.equal(userId, owner); assert.deepEqual(domains, ['work']); return records.filter(options.acceptCandidate);
} } as any);

test('semantic plan accepts highlight and a directed people collection with a validated owner root', () => {
    const list = parseMemoryQueryPlan(JSON.stringify(plan()), 'С кем я общаюсь?')!;
    assert.equal(list.requestKind, 'people_list'); assert.equal(list.peopleQuery?.relations[0].type, 'works_with');
    const value = plan(); value.peopleQuery!.relations = [{ type: 'parent_of', direction: 'out' }, { type: 'parent_of', direction: 'either' }];
    const directed = parseMemoryQueryPlan(JSON.stringify(value), 'С кем я общаюсь?')!;
    assert.equal(directed.peopleQuery?.relations.length, 1); assert.equal(directed.peopleQuery?.relations[0].direction, 'out');
    assert.equal(parseMemoryQueryPlan(JSON.stringify({ answerQueries: ['факт'], requestKind: 'highlight' }), 'Расскажи интересный факт')?.requestKind, 'highlight');
});

test('people collection combines saved relationships and direct topic conversations without inventing employment', async t => {
    t.mock.method(identity, 'listPersonIdentitiesForRecall', async () => [...people, { ...people[0], id: 'synthetic-lada-old' }] as any);
    const records = [fact('direct'), fact('duplicate'), edge('saved-link', 'user', 'synthetic-miron'),
        fact('other-chat', 2, { sourceMessageIds: ['tg:999999:100'] }), fact('no-source', 2, { sourceMessageIds: [] }),
        fact('malformed-source', 2, { sourceMessageIds: ['tg:555125:100x'] }),
        fact('wrong-domain', 2, { domain: 'hobbies' }),
        fact('bot', 2, { subject: 'bot' }), fact('negated', 2, { negated: true })];
    const result = await recallMemoryPeople(service(records), owner, plan());
    assert.equal(result.totalFound, 2); assert.equal(result.entries[0].person.displayName, people[1].displayName);
    assert.equal(result.entries.find(e => e.person.contactId === '555123')?.person.personIds.length, 2);
    assert.equal(result.entries.find(e => e.person.contactId === '555123')?.evidence[0].basis, 'communication');
    const formatted = formatMemoryPeople(result);
    assert.match(formatted.context, /Переписка не доказывает/); assert.equal(formatted.included.length, 2);
    assert.ok(!formatted.context.includes(people[2].displayName));
});

test('directed relation collections preserve direction, confidence, dates and negation', async t => {
    t.mock.method(identity, 'listPersonIdentitiesForRecall', async () => people as any);
    const records = [edge('child', 'user', 'synthetic-lada', 'parent_of'), edge('parent', 'synthetic-miron', 'user', 'parent_of'),
        edge('bad', 'user', 'synthetic-ella', 'parent_of', { negated: true }), edge('old', 'user', 'synthetic-ella', 'parent_of', { validTo: new Date('2020-01-01') }),
        edge('weak', 'user', 'synthetic-ella', 'parent_of', { confidence: .6 })];
    const value = plan(); value.peopleQuery = { basis: 'relationships', relations: [{ type: 'parent_of', direction: 'out' }] };
    assert.deepEqual((await recallMemoryPeople(service(records), owner, value)).entries.map(e => e.person.personIds[0]), ['synthetic-lada']);
    value.peopleQuery.relations[0].direction = 'in';
    assert.deepEqual((await recallMemoryPeople(service(records), owner, value)).entries.map(e => e.person.personIds[0]), ['synthetic-miron']);
    const inverse = [edge('inverse', 'user', 'synthetic-miron', 'child_of')];
    assert.deepEqual((await recallMemoryPeople(service(inverse), owner, value)).entries.map(e => e.person.personIds[0]), ['synthetic-miron']);
});

test('typed relationships are read across domains while a conversation keeps its requested topic', async t => {
    t.mock.method(identity, 'listPersonIdentitiesForRecall', async () => people as any);
    const saved = edge('cross-domain-link', 'user', 'synthetic-miron', 'works_with', { domain: 'family' });
    const svc = { getMemoriesByTags: async (_owner: string, tags: string[], _limit: number, options: any) => {
        assert.ok(tags.includes('relation_type:works_with')); return [saved].filter(options.acceptCandidate);
    } } as any;
    const value = plan(); value.peopleQuery!.basis = 'relationships';
    assert.equal((await recallMemoryPeople(svc, owner, value)).entries[0]?.person.displayName, people[1].displayName);
});

test('named-root collections and negative group IDs cannot become owner professional contacts', async t => {
    const directory = t.mock.method(identity, 'listPersonIdentitiesForRecall', async () => [{ ...people[0], telegramContactId: '-555123' }] as any);
    const value = plan(); value.references = [{ kind: 'person', mention: 'Лада', from: 'named', relationPath: [] }];
    assert.equal((await recallMemoryPeople(service([]), owner, value)).entries.length, 0); assert.equal(directory.mock.callCount(), 0);
    assert.equal((await recallMemoryPeople(service([fact('group', 0, { tags: ['person_id:synthetic-lada', 'contact_id:-555123'], sourceMessageIds: ['tg:-555123:100'] })]), owner, plan())).entries.length, 0);
});

test('many topic correspondents survive a large first contact pool with bounded scoped paging', async t => {
    const directory = Array.from({ length: 41 }, (_, i) => ({ id: `synthetic-person-${i}`, displayName: `Синтетический Контакт ${i}`, telegramContactId: String(556000 + i), aliases: [] }));
    t.mock.method(identity, 'listPersonIdentitiesForRecall', async () => directory as any);
    const calls: any[] = [];
    const svc = new QdrantVectorService({ scroll: async (collection: string, args: any) => {
        calls.push(args); assert.ok(collection.endsWith('_work'));
        const start = Number(args.offset ?? 0), end = Math.min(540, start + args.limit);
        return { points: Array.from({ length: end - start }, (_, i) => { const index = start + i, person = directory[index < 500 ? 0 : index - 499];
            return { id: `point-${index}`, payload: fact(`point-${index}`, 0, { tags: [`person_id:${person.id}`, `contact_id:${person.telegramContactId}`], sourceMessageIds: [`tg:${person.telegramContactId}:${index + 1}`] }) };
        }), next_page_offset: end < 540 ? end : null };
    } } as any);
    const result = await recallMemoryPeople(svc, owner, plan());
    assert.equal(result.entries.length, 41); assert.ok(calls.some(c => c.offset >= 500));
    for (const call of calls) { assert.ok(call.filter.must.some((c: any) => c.key === 'userId' && c.match.value === owner)); assert.ok(call.filter.must.some((c: any) => c.key === 'botId')); }
    const formatted = formatMemoryPeople(result); assert.ok(formatted.context.length <= 6500); assert.equal(formatted.included.length, 41);
    for (const person of directory) assert.ok(formatted.context.includes(person.displayName));
});

test('people inventory integrates without embeddings or models and stores a topic rather than four arbitrary people', async t => {
    t.mock.method(identity, 'listPersonIdentitiesForRecall', async () => people as any);
    t.mock.method(vector, 'getVectorService', () => service([fact('direct'), fact('second', 1)]));
    const inference = t.mock.method(ai, 'createChatCompletionForTask', async () => { throw Error('No model needed after the plan'); });
    const ctx = context(); const result = await getMultiQueryMemoryContextDetailed(ctx, 'С кем я общаюсь по работе?', 'full', { queryPlan: plan(), trackAccess: false, explain: true });
    assert.equal(result.retrievalTrace?.reranker?.status, 'people_collection'); assert.equal(result.recalledMemories.length, 2);
    assert.deepEqual(validMemoryFocus(ctx)?.people, []); assert.equal(inference.mock.callCount(), 0);
    const group = await getMultiQueryMemoryContextDetailed({ ...ctx, chat: { ...ctx.chat, type: 'group' } } as any, 'С кем я общаюсь?', 'full', { queryPlan: plan() });
    assert.equal(group.context, '');
});

test('interesting fact reads a reliable profile candidate even without literal query words', async t => {
    t.mock.method(identity, 'findPersonIdentitiesForRecall', async () => [people[1]] as any);
    const records = [fact('good', 1, { content: 'Увлекается синтетическими головоломками.', domain: 'hobbies', memoryKind: 'preference' }),
        fact('weak', 1, { tags: ['person_id:synthetic-miron', 'contact_id:555124', 'needs-caution'] }), fact('planned', 1, { status: 'planned' }), fact('negative', 1, { negated: true })];
    t.mock.method(vector, 'getVectorService', () => ({ getMemoriesByTags: async () => records, searchAllDomains: async () => { throw Error('No embedding needed'); } } as any));
    const inference = t.mock.method(ai, 'createChatCompletionForTask', async () => { throw Error('No literal reranker for a highlight'); });
    const result = await getMultiQueryMemoryContextDetailed(context(), 'Расскажи интересный факт про Примерова Мирона', 'full', { queryPlan: {
        answerQueries: ['интересный факт'], contextQueries: [], requestKind: 'highlight', references: [{ kind: 'person', mention: 'Примерова Мирона', from: 'named', relationPath: [] }],
    }, trackAccess: false, explain: true });
    assert.equal(result.retrievalTrace?.reranker?.status, 'person_highlight'); assert.deepEqual(result.recalledMemories.map(m => m.id), ['good']);
    assert.match(result.context, /головоломками/); assert.equal(inference.mock.callCount(), 0);
});

test('read-only directory always applies profile and owner filters and a bounded limit', async t => {
    const descriptor = Object.getOwnPropertyDescriptor(AppDataSource, 'isInitialized');
    Object.defineProperty(AppDataSource, 'isInitialized', { configurable: true, value: true });
    t.after(() => { if (descriptor) Object.defineProperty(AppDataSource, 'isInitialized', descriptor); });
    let scoped = false;
    const builder = { where(sql: string, params: any) { scoped = sql.includes('person.profile') && sql.includes('person.ownerUserId') && params.ownerUserId === owner; return this; },
        orderBy() { return this; }, take(limit: number) { assert.equal(limit, 201); return this; }, async getMany() { return []; } };
    t.mock.method(AppDataSource, 'getRepository', () => ({ createQueryBuilder: () => builder } as any));
    await identity.listPersonIdentitiesForRecall(owner); assert.equal(scoped, true);
});
