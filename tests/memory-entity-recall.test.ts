import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BotContext, SearchResult } from '../types';
import type { MemoryPerson, MemoryQueryPlan } from '../types/memoryRecallTypes';
import { parseMemoryQueryPlan, memoryQueryHistory, memoryQueryCacheKey, validMemoryFocus, saveMemoryFocus } from '../utils/memoryQueryPlan';
import { followMemoryRelations, personRecallScope, readPersonEvidence, resolveMemoryQueryEntities, resolveNamedMemoryPerson, selectPersonEvidence, selectRelationshipEvidence, formatPersonOverview } from '../utils/memoryEntityRecall';
import { isMemoryEntryAllowedForContactScope } from '../utils/contactMemory';
import { getMultiQueryMemoryContextDetailed } from '../utils/multiQueryMemory';
import { fetchAgentMemoryContext } from '../utils/agentMemoryContext';
import * as vector from '../services/VectorServiceFactory';
import * as identity from '../services/PersonIdentityService';
import * as ai from '../ai/chatCompletion';
import * as today from '../utils/todayImportance';
import { QdrantVectorService } from '../services/QdrantVectorService';
import { AppDataSource } from '../data-source';
import { isOwnerRecallEvidence, recallPersonNameMatches } from '../utils/contactMemory';
import { maybeStartContactMemoryLookup, handlePendingContactLookupText } from '../utils/contactMemoryLookup';

const owner = '740893';
const person: MemoryPerson = { personIds: ['synthetic-lada'], displayName: 'Лада Тестовая', contactId: '555123', evidenceIds: ['saved-link'] };
const context = (): BotContext => ({ from: { id: Number(owner) }, chat: { id: Number(owner), type: 'private' }, session: { messageHistory: [] } } as unknown as BotContext);
function record(id: string, content: string, patch: Partial<SearchResult> = {}): SearchResult {
    return { id, content, domain: 'family', tags: ['person_id:synthetic-lada', 'contact_id:555123', 'contact_name:Лада Тестовая'], subject: 'contact', status: 'active',
        confidence: .95, importance: .7, timestamp: new Date('2026-01-01'), score: .8, memoryKind: 'fact', ...patch };
}
function relation(id: string, type: string, subject: string, object: string, name: string): SearchResult {
    return record(id, `${name}: сохранённая связь.`, { tags: ['person_relation', `relation_type:${type}`,
        subject === 'user' ? 'relation_subject:user' : `relation_subject_person_id:${subject}`,
        object === 'user' ? 'relation_object:user' : `relation_object_person_id:${object}`,
        object === 'user' ? `relation_subject_name:${name}` : `relation_object_name:${name}`], subject: subject === 'user' ? 'user' : 'contact' });
}
const service = (records: SearchResult[]) => ({ getMemoriesByTag: async (userId: string, tag: string) => {
    assert.equal(userId, owner); return records.filter(item => item.tags.includes(tag));
} } as any);
const focusPlan = (mention = 'неё'): MemoryQueryPlan => ({ answerQueries: ['личные сведения'], contextQueries: [], requestKind: 'overview',
    references: [{ kind: 'person', mention, from: 'focus', relationPath: [] }] });

test('semantic plan accepts role synonyms and rejects invented spans, IDs and invalid directed paths', () => {
    const question = 'Как зовут мою вторую половинку?';
    const plan = parseMemoryQueryPlan(JSON.stringify({ answerQueries: ['супруга'], requestKind: 'identity', references: [
        { kind: 'person', mention: 'мою вторую половинку', from: 'owner', relationPath: [{ type: 'spouse_of', direction: 'either' }] },
        { kind: 'person', mention: 'несуществующий фрагмент', from: 'named', relationPath: [] },
        { kind: 'person', mention: 'мою вторую половинку', from: 'owner', relationPath: [{ type: 'parent_of', direction: 'either' }] },
    ] }), question);
    assert.equal(plan?.references?.length, 1);
    assert.equal(plan?.references?.[0].relationPath[0].type, 'spouse_of');
    const botClaim = parseMemoryQueryPlan(JSON.stringify({ answerQueries: ['супруга'], references: [
        { kind: 'person', mention: 'моя жена', from: 'owner', relationPath: [{ type: 'spouse_of', direction: 'either' }] },
    ] }), 'Что про неё известно?', [{ role: 'bot', content: 'моя жена' }]);
    assert.equal(botClaim?.references?.length, 0);
    const topic = parseMemoryQueryPlan(JSON.stringify({ answerQueries: ['проект'], references: [{ kind: 'topic', mention: 'мой проект', from: 'owner', relationPath: [] }] }), 'Что известно про мой проект?');
    assert.equal(topic?.references?.[0].kind, 'topic');
});

test('explicit self references bind owner topics and validate domains without accepting bot claims or other people', () => {
    const plan = parseMemoryQueryPlan(JSON.stringify({ answerQueries: ['увлечения пользователя'], requestKind: 'overview', domains: ['hobbies', 'hobbies', 'not-a-domain'], references: [
        { kind: 'person', mention: 'моих', from: 'owner', relationPath: [] },
    ] }), 'Что известно о моих увлечениях?')!;
    assert.equal(plan.references?.[0].from, 'owner'); assert.deepEqual(plan.domains, ['hobbies']);
    const falseOwner = parseMemoryQueryPlan(JSON.stringify({ answerQueries: ['факты'], references: [
        { kind: 'person', mention: 'Ладе', from: 'owner', relationPath: [] },
        { kind: 'person', mention: 'мой', from: 'owner', relationPath: [] },
    ] }), 'Что известно о Ладе?', [{ role: 'bot', content: 'мой профиль' }]);
    assert.deepEqual(falseOwner?.references, []);
});

test('an explicit owner reference overrides the previous person without looking up a person named my hobbies', async t => {
    const ctx = context(); saveMemoryFocus(ctx, [person], 'Предыдущий собеседник', ['saved-link']);
    const lookup = t.mock.method(identity, 'findPersonIdentitiesForRecall', async () => { throw Error('Owner is authenticated context'); });
    const result = await resolveMemoryQueryEntities(ctx, 'Расскажи о моих увлечениях', { answerQueries: ['увлечения пользователя'], contextQueries: [],
        references: [{ kind: 'person', mention: 'моих', from: 'owner', relationPath: [] }] }, service([]));
    assert.equal(result.people[0]?.owner, true); assert.deepEqual(result.people[0]?.personIds, ['user']);
    assert.equal(result.people[0]?.contactId, undefined); assert.equal(lookup.mock.callCount(), 0);
    assert.equal(result.unresolved, false);
});

test('owner facts exclude contact, bot, mixed-chat and conflicting person evidence', () => {
    assert.equal(isOwnerRecallEvidence({ subject: 'user', tags: ['subject:user'] }), true);
    for (const input of [
        { subject: 'contact', tags: ['subject:user'] }, { subject: 'bot', tags: [] }, { subject: 'unknown', tags: [] },
        { subject: 'user', tags: ['source_contact:synthetic'] }, { subject: 'user', tags: ['source_chat:synthetic'] },
        { subject: 'user', tags: ['contact_id:555123'] }, { subject: 'user', tags: ['person_id:synthetic-lada'] },
        { subject: 'user', tags: ['evidence_subject:bot'] }, { subject: undefined, tags: [] },
    ]) assert.equal(isOwnerRecallEvidence(input), false, JSON.stringify(input));
});

test('legacy contact lookup cannot consume first-person topics or a new self question during clarification', async () => {
    for (const question of ['Что ты знаешь об моих увлечениях?', 'Расскажи о моих планах', 'Что известно о моей работе?']) {
        const ctx = context();
        assert.equal(await maybeStartContactMemoryLookup(ctx, question), null);
        ctx.session.pendingContactLookup = { contactName: 'Тестовый', originalMessage: 'Кто такой Тестовый?', candidateIds: [], createdAt: Date.now() };
        assert.equal(await handlePendingContactLookupText(ctx, question), null);
        assert.equal(ctx.session.pendingContactLookup, undefined);
    }
});

test('owner topic overview reads authenticated subject evidence and addresses the user in the second person', async t => {
    const ctx = context(); saveMemoryFocus(ctx, [person], 'Предыдущий человек', ['saved-link']);
    const own = record('own-hobby', 'Увлекается тестовыми головоломками.', { subject: 'user', tags: ['subject:user'], domain: 'hobbies' });
    t.mock.method(vector, 'getVectorService', () => ({ getOwnerMemories: async (userId: string, domains: string[], limit: number) => {
        assert.equal(userId, owner); assert.deepEqual(domains, ['hobbies']); assert.equal(limit, 300);
        return [own, record('foreign-hobby', 'Чужое увлечение.', { domain: 'hobbies' })];
    }, searchAllDomains: async () => { throw Error('No embeddings for a topic overview'); } } as any));
    const plan: MemoryQueryPlan = { answerQueries: ['хобби увлечения интересы пользователя'], contextQueries: [], domains: ['hobbies'], requestKind: 'overview',
        references: [{ kind: 'person', mention: 'моих', from: 'owner', relationPath: [] }] };
    const result = await getMultiQueryMemoryContextDetailed(ctx, 'Что ты знаешь о моих увлечениях?', 'full', { queryPlan: plan, trackAccess: false });
    assert.deepEqual(result.recalledMemories.map(item => item.id), ['own-hobby']);
    assert.match(result.context, /ты\/твои\/о тебе/); assert.ok(!result.context.includes('Чужое увлечение'));
    assert.equal(validMemoryFocus(ctx)?.people[0]?.owner, true);
});

test('owner topic pool paginates only validated domains with owner, namespace and subject filters', async () => {
    const calls: any[] = [];
    const svc: any = new QdrantVectorService({ scroll: async (collection: string, args: any) => {
        calls.push({ collection, args }); const start = Number(args.offset ?? 0), end = Math.min(75, start + args.limit);
        return { points: Array.from({ length: end - start }, (_, i) => ({ id: `own-${start + i}`, payload: { ...record(`own-${start + i}`, 'Тестовый факт.'), subject: 'user', tags: ['subject:user'] } })), next_page_offset: end < 75 ? end : null };
    } } as any);
    assert.equal((await svc.getOwnerMemories(owner, ['hobbies'], 300)).length, 75);
    assert.equal((await svc.getOwnerMemories(owner, ['../../foreign'], 300)).length, 0);
    assert.equal(calls.length, 2);
    for (const { collection, args } of calls) {
        assert.ok(collection.endsWith('_hobbies')); assert.ok(args.limit <= 50);
        assert.ok(args.filter.must.some((c: any) => c.key === 'userId' && c.match.value === owner));
        assert.ok(args.filter.must.some((c: any) => c.key === 'botId'));
        assert.ok(args.filter.must.some((c: any) => c.should?.some((s: any) => s.key === 'subject' && s.match.value === 'user')));
        assert.ok(args.filter.must_not.some((c: any) => c.key === 'expiresAt'));
    }
});

test('owner overview keeps topical relevance even when the planner does not narrow domains', () => {
    const self: MemoryPerson = { personIds: ['user'], displayName: 'текущий пользователь', owner: true, evidenceIds: [] };
    const noise = Array.from({ length: 60 }, (_, i) => record(`a-${i}`, 'Работает над тестовым проектом.', { domain: 'work' }));
    const goal = record('z-plan', 'Планирует пройти тестовый курс.', { domain: 'education', memoryKind: 'goal' });
    const selected = selectPersonEvidence([...noise, goal], self, 'планирует курс', true, 8, new Set(), true);
    assert.equal(selected[0].id, goal.id);
});

test('a unique inflected surname resolves for recall while homonyms remain ambiguous', async t => {
    const first = { id: 'synthetic-miron', displayName: 'Мирон Примеров', aliases: [], telegramContactId: '555126' };
    let candidates = [first];
    t.mock.method(identity, 'findPersonIdentitiesForRecall', async (userId: string) => { assert.equal(userId, owner); return candidates as any; });
    assert.equal(recallPersonNameMatches(first.displayName, 'примерова'), true);
    assert.equal(recallPersonNameMatches(first.displayName, 'другая'), false);
    assert.equal((await resolveNamedMemoryPerson(owner, 'примерова')).person?.displayName, first.displayName);
    candidates = [first, { ...first, id: 'synthetic-other', displayName: 'Лев Примеров', telegramContactId: '555127' }];
    const ambiguous = await resolveNamedMemoryPerson(owner, 'примерова');
    assert.equal(ambiguous.ambiguous, true); assert.equal(ambiguous.person, undefined);
});

test('partial-name registry lookup checks stored aliases within profile and owner scope', async t => {
    const descriptor = Object.getOwnPropertyDescriptor(AppDataSource, 'isInitialized');
    Object.defineProperty(AppDataSource, 'isInitialized', { configurable: true, value: true });
    t.after(() => { if (descriptor) Object.defineProperty(AppDataSource, 'isInitialized', descriptor); });
    const conditions: string[] = []; let scoped = false, queries = 0;
    const builder = { where(sql: string, params: any) { scoped = sql.includes('person.profile') && sql.includes('person.ownerUserId') && params.ownerUserId === owner; return this; },
        clone() { return this; }, andWhere(sql: string) { conditions.push(sql); return this; }, take(limit: number) { assert.equal(limit, 12); return this; },
        async getMany() { return ++queries === 1 ? [] : [{ id: 'synthetic-miron' }]; } };
    t.mock.method(AppDataSource, 'getRepository', () => ({ createQueryBuilder: () => builder } as any));
    assert.equal((await identity.findPersonIdentitiesForRecall(owner, 'Примерова')).length, 1);
    assert.equal(scoped, true); assert.ok(conditions.some(sql => sql.startsWith('(') && sql.includes('person.aliases') && sql.includes('LIKE')));
});

test('a saturated partial-name candidate page cannot establish a unique identity from its first plausible result', async t => {
    t.mock.method(identity, 'findPersonIdentitiesForRecall', async () => Array.from({ length: 12 }, (_, i) => ({
        id: `synthetic-${i}`, displayName: i ? `Несвязанный Вариант${i}` : 'Мирон Примеров', aliases: [],
    })) as any);
    assert.equal((await resolveNamedMemoryPerson(owner, 'Примерова')).ambiguous, true);
});

test('owner topic reads continue beyond rejected raw pages before applying the eligible-record limit', async () => {
    const self: MemoryPerson = { personIds: ['user'], displayName: 'текущий пользователь', owner: true, evidenceIds: [] };
    const calls: any[] = [];
    const svc = new QdrantVectorService({ scroll: async (collection: string, args: any) => {
        calls.push(args); assert.ok(collection.endsWith('_work'));
        const start = Number(args.offset ?? 0), end = Math.min(310, start + args.limit);
        return { points: Array.from({ length: end - start }, (_, i) => {
            const index = start + i; return { id: `evidence-${index}`, payload: record(`evidence-${index}`, 'Синтетическая рабочая запись.', {
                subject: 'user', domain: 'work', tags: index < 300 ? ['subject:user', 'source_contact:Синтетический источник'] : ['subject:user'],
            }) };
        }), next_page_offset: end < 310 ? end : null };
    } } as any);
    const result = await readPersonEvidence(svc, owner, self, ['work']);
    assert.equal(result.length, 10); assert.ok(calls.some(args => args.offset >= 300));
    assert.ok(result.every(isOwnerRecallEvidence));
});

test('filtered recall has a finite scan budget even if every page contains rejected evidence', async () => {
    let calls = 0;
    const svc = new QdrantVectorService({ scroll: async (_collection: string, args: any) => {
        calls++; const start = Number(args.offset ?? 0);
        return { points: Array.from({ length: args.limit }, (_, i) => ({ id: `bad-${start + i}`, payload: record(`bad-${start + i}`, 'Неподходящая запись.') })), next_page_offset: start + args.limit };
    } } as any);
    assert.equal((await svc.getOwnerMemories(owner, ['work'], 1, { acceptCandidate: () => false })).length, 0);
    assert.equal(calls, 40);
});

test('owner topic overview preserves different fact predicates instead of treating a whole domain as one facet', () => {
    const self: MemoryPerson = { personIds: ['user'], displayName: 'текущий пользователь', owner: true, evidenceIds: [] };
    const records = ['profession', 'employer', 'skill'].flatMap(predicate => Array.from({ length: 3 }, (_, i) =>
        record(`${predicate}-${i}`, 'Синтетическое рабочее сведение.', { domain: 'work', predicate })));
    const tasks = Array.from({ length: 20 }, (_, i) => record(`task-${i}`, 'Планирует тестовую задачу.', { domain: 'work', memoryKind: 'open_loop' }));
    const result = selectPersonEvidence([...records, ...tasks], self, 'работа', true, 12, new Set(), true);
    assert.equal(result.filter(r => r.memoryKind === 'fact').length, 9);
    assert.equal(new Set(result.filter(r => r.memoryKind === 'fact').map(r => r.predicate)).size, 3);
});

test('foreground and deferred history both retain the preceding answer; cache uses full context', () => {
    const ctx = context();
    const prior = { role: 'bot' as const, content: 'Сохранённый человек — Лада Тестовая.', timestamp: new Date() };
    ctx.session.messageHistory = [{ role: 'user', content: 'Что про неё знаешь?', timestamp: new Date() }, prior];
    assert.equal(memoryQueryHistory(ctx, 'Что про неё знаешь?').at(-1)?.content, prior.content);
    ctx.session.messageHistory = [prior];
    assert.equal(memoryQueryHistory(ctx, 'Что про неё знаешь?').at(-1)?.content, prior.content);
    const prefix = 'x'.repeat(220);
    assert.notEqual(memoryQueryCacheKey(prefix + 'A', []), memoryQueryCacheKey(prefix + 'B', []));
    assert.notEqual(memoryQueryCacheKey('он', [{ role: 'bot', content: prefix + 'A' }]), memoryQueryCacheKey('он', [{ role: 'bot', content: prefix + 'B' }]));
});

test('grounded focus is owner/channel/expiry scoped and does not set mutation identity', () => {
    const ctx = context(); saveMemoryFocus(ctx, [person], 'Тестовый вопрос', ['saved-link']);
    assert.equal(validMemoryFocus(ctx)?.people[0].displayName, person.displayName);
    assert.equal(ctx.session.activePersonContext, undefined);
    assert.equal(validMemoryFocus({ ...ctx, sessionStorageKey: 'api:740893' } as BotContext), undefined);
    assert.equal(validMemoryFocus({ ...ctx, from: { id: 740894 } } as BotContext), undefined);
    assert.equal(validMemoryFocus(ctx, Date.now() + 31 * 60_000), undefined);
});

test('semantic synonyms traverse saved edges; unknown relations cannot invent a person', async t => {
    t.mock.method(identity, 'readPersonIdentities', async () => []);
    const saved = relation('spouse', 'spouse_of', 'user', 'synthetic-lada', 'Лада Тестовая');
    const result = await followMemoryRelations(service([saved]), owner, undefined, [{ type: 'spouse_of', direction: 'either' }]);
    assert.equal(result.person?.displayName, 'Лада Тестовая');
    assert.equal(result.memories[0].id, 'spouse');
    const alternative = await followMemoryRelations(service([saved]), owner, undefined, [{ type: 'partner_of', direction: 'either', alternatives: ['spouse_of'] }]);
    assert.equal(alternative.person?.displayName, 'Лада Тестовая');
    const subtype = await followMemoryRelations(service([saved]), owner, undefined, [{ type: 'partner_of', direction: 'either' }]);
    assert.equal(subtype.person?.displayName, 'Лада Тестовая');
    assert.equal((await followMemoryRelations(service([]), owner, undefined, [{ type: 'spouse_of', direction: 'either' }])).person, undefined);
});

test('nested relations follow the named intermediate person rather than the owner spouse', async t => {
    t.mock.method(identity, 'readPersonIdentities', async () => []);
    const records = [relation('own-spouse', 'spouse_of', 'user', 'synthetic-own', 'Собственная Тестовая'),
        relation('friend', 'friend_of', 'user', 'synthetic-friend', 'Мирон Тестовый'),
        relation('friend-spouse', 'spouse_of', 'synthetic-friend', 'synthetic-other', 'Элла Тестовая')];
    const result = await followMemoryRelations(service(records), owner, undefined, [{ type: 'friend_of', direction: 'either' }, { type: 'spouse_of', direction: 'either' }]);
    assert.equal(result.person?.displayName, 'Элла Тестовая');
    assert.deepEqual(result.memories.map(memory => memory.id), ['friend', 'friend-spouse']);
});

test('directed parent/child and inverse stored predicates retain direction; multiple endpoints stay ambiguous', async t => {
    t.mock.method(identity, 'readPersonIdentities', async () => []);
    const records = [relation('parent', 'child_of', 'user', 'synthetic-parent', 'Родитель Тестовый'), relation('child', 'parent_of', 'user', 'synthetic-child', 'Ребёнок Тестовый')];
    const parent = await followMemoryRelations(service(records), owner, undefined, [{ type: 'parent_of', direction: 'in' }]);
    const child = await followMemoryRelations(service(records), owner, undefined, [{ type: 'parent_of', direction: 'out' }]);
    assert.equal(parent.person?.displayName, 'Родитель Тестовый'); assert.equal(child.person?.displayName, 'Ребёнок Тестовый');
    const ambiguous = await followMemoryRelations(service([...records, relation('other-parent', 'child_of', 'user', 'synthetic-other-parent', 'Другой Тестовый')]), owner, undefined, [{ type: 'parent_of', direction: 'in' }]);
    assert.equal(ambiguous.ambiguous, true); assert.equal(ambiguous.person, undefined);
});

test('strict person scope rejects unrelated owner facts, name collisions and bot assertions', () => {
    const scope = personRecallScope(person);
    assert.equal(isMemoryEntryAllowedForContactScope(record('one', 'Любит улун.'), scope), true);
    for (const item of [record('other', 'Другой человек.', { tags: ['person_id:synthetic-other', 'contact_name:Лада Тестовая'] }),
        record('wrong-id', 'Соседний контакт.', { tags: ['contact_id:555124', 'person_id:synthetic-lada'] }),
        record('owner', 'Владелец работает над проектом.', { subject: 'user', tags: [] }),
        record('bot', 'Утверждение бота.', { subject: 'system' })]) assert.equal(isMemoryEntryAllowedForContactScope(item, scope), false, item.id);
});

test('registry lookup preserves ambiguity and never merges two people just by name', async t => {
    const first = { id: 'synthetic-a', displayName: 'Необычная Тестовая', aliases: ['Необычная Тестовая'] } as any;
    t.mock.method(identity, 'findPersonIdentitiesForRecall', async (user: string) => { assert.equal(user, owner); return [first, { ...first, id: 'synthetic-b' }]; });
    const result = await resolveNamedMemoryPerson(owner, 'Необычная Тестовая');
    assert.equal(result.ambiguous, true); assert.equal(result.person, undefined);
});

test('legacy dialogue without a focus recovers a stored identity from history, not facts claimed by the bot', async t => {
    const ctx = context(); ctx.session.messageHistory = [{ role: 'bot', content: 'Речь шла о Ладе Тестовой.', timestamp: new Date() }];
    t.mock.method(identity, 'findMentionedPeopleForRecall', async (user: string, text: string) => {
        assert.equal(user, owner); assert.match(text, /Ладе Тестовой/);
        return [{ id: 'synthetic-lada', displayName: 'Лада Тестовая', aliases: [], telegramContactId: '555123' }] as any;
    });
    const result = await resolveMemoryQueryEntities(ctx, 'Что ты про неё знаешь?', focusPlan(), service([]));
    assert.equal(result.people[0]?.contactId, '555123');
    assert.deepEqual(result.memories, [], 'history only selects a search subject; it contributes no facts');
});

test('full-name history lookup keeps punctuation boundaries and owner/profile restrictions', async t => {
    const descriptor = Object.getOwnPropertyDescriptor(AppDataSource, 'isInitialized');
    Object.defineProperty(AppDataSource, 'isInitialized', { configurable: true, value: true });
    t.after(() => { if (descriptor) Object.defineProperty(AppDataSource, 'isInitialized', descriptor); });
    let scoped = false, text = '';
    const builder = { where(sql: string, params: any) { scoped = sql.includes('person.ownerUserId') && sql.includes('person.profile') && params.ownerUserId === owner; return this; },
        andWhere(_sql: string, params: any) { text = params.context; return this; }, take(limit: number) { assert.equal(limit, 12); return this; },
        async getMany() { return scoped && text.includes(' лада тестовая ') ? [{ id: 'synthetic-lada' }] : []; } };
    t.mock.method(AppDataSource, 'getRepository', () => ({ createQueryBuilder: () => builder } as any));
    const result = await identity.findMentionedPeopleForRecall(owner, 'Сохранённый человек — Лада Тестовая.');
    assert.equal(result.length, 1); assert.equal(scoped, true);
});

test('a singular pronoun cannot choose one of several grounded people', async () => {
    const ctx = context(); saveMemoryFocus(ctx, [person, { ...person, personIds: ['synthetic-other'], contactId: '555124' }], 'Сравнение людей', ['saved-link']);
    const result = await resolveMemoryQueryEntities(ctx, 'Что ты про неё помнишь?', { answerQueries: ['подробности'], contextQueries: [] }, service([]));
    assert.equal(result.ambiguous, true); assert.deepEqual(result.people, []);
});

test('the current structured reply overrides a previous search focus for a pronoun', async t => {
    const ctx = context(); saveMemoryFocus(ctx, [person], 'Предыдущий человек', ['saved-link']);
    t.mock.method(identity, 'readPersonIdentities', async (user: string, ids: string[]) => {
        assert.equal(user, owner); assert.deepEqual(ids, ['synthetic-ella']);
        return [{ id: 'synthetic-ella', displayName: 'Элла Примерная', telegramContactId: '555124' }] as any;
    });
    const result = await resolveMemoryQueryEntities(ctx, 'Что про неё известно?', focusPlan(), service([]), { personId: 'synthetic-ella' });
    assert.equal(result.people[0]?.displayName, 'Элла Примерная');
    assert.equal(result.people[0]?.contactId, '555124');
});

test('a comparison cannot silently omit an unresolved person', async t => {
    t.mock.method(identity, 'findPersonIdentitiesForRecall', async (_owner: string, mention: string) => mention === 'Лада Тестовая'
        ? [{ id: 'synthetic-lada', displayName: 'Лада Тестовая', aliases: [], telegramContactId: '555123' }] as any : []);
    const result = await resolveMemoryQueryEntities(context(), 'Сравни Ладу и Эллу', { answerQueries: ['сравнение'], contextQueries: [], references: [
        { kind: 'person', mention: 'Лада Тестовая', from: 'named', relationPath: [] }, { kind: 'person', mention: 'Элла Примерная', from: 'named', relationPath: [] },
    ] }, service([]));
    assert.equal(result.people.length, 1); assert.equal(result.unresolved, true);
});

test('explicit topic change does not inherit the previous person, while topic followups reuse the search query', async () => {
    const ctx = context(); saveMemoryFocus(ctx, [person], 'Лада Тестовая', ['saved-link']);
    const changed = await resolveMemoryQueryEntities(ctx, 'А что про проект Север?', { answerQueries: ['проект Север'], contextQueries: [], standaloneQuery: 'Что известно о проекте Север?',
        references: [{ kind: 'topic', mention: 'проект Север', from: 'named', relationPath: [] }] }, service([]));
    assert.deepEqual(changed.people, []); assert.equal(changed.requestedPerson, false);
    saveMemoryFocus(ctx, [], 'проект Север', ['saved-project']);
    const continued = await resolveMemoryQueryEntities(ctx, 'А какой у него срок?', { answerQueries: ['срок'], contextQueries: [] }, service([]));
    assert.match(continued.query, /проект Север/); assert.deepEqual(continued.people, []);
    const structured = await resolveMemoryQueryEntities(ctx, 'А какой у него срок?', { answerQueries: ['срок'], contextQueries: [], standaloneQuery: 'Какой срок?',
        references: [{ kind: 'topic', mention: 'него', from: 'focus', relationPath: [] }] }, service([]));
    assert.match(structured.query, /проект Север/);
});

test('person overview reads diverse stored facts without dense search or a second model', async t => {
    const ctx = context(); saveMemoryFocus(ctx, [person], 'Кто мой близкий человек?', ['saved-link']);
    const records = [record('tea', '[Лада Тестовая] Любит молочный улун.', { memoryKind: 'preference' }),
        record('hobby', '[Лада Тестовая] Увлекается акварелью.', { domain: 'hobbies', memoryKind: 'preference' }),
        record('boundary', '[Лада Тестовая] Предпочитает договариваться о встречах заранее.', { memoryKind: 'boundary' }),
        record('bad', 'Чужая запись.', { tags: ['contact_id:555124'] }), record('old', 'Устаревшая запись.', { status: 'superseded' })];
    t.mock.method(vector, 'getVectorService', () => ({ ...service(records), getMemoriesByTags: async () => records,
        searchAllDomains: async () => { throw Error('No dense search needed for a person overview'); },
        getAnchorMemories: async () => { throw Error('Unrelated owner facts must not enter the profile'); },
    } as any));
    let calls = 0;
    t.mock.method(ai, 'createChatCompletionForTask', async () => { calls++; return { choices: [{ message: { content: JSON.stringify(focusPlan()) } }] } as any; });
    t.mock.method(today, 'buildTodayImportanceContext', async () => '');
    const result = await fetchAgentMemoryContext(ctx, 'Что ты про неё знаешь?', { memoryNeed: 'none' });
    assert.equal(calls, 1);
    for (const fragment of ['улун', 'акварель', 'заранее']) assert.ok(result.context.includes(fragment), fragment);
    assert.ok(!result.context.includes('Чужая запись')); assert.ok(!result.context.includes('Устаревшая запись'));
    assert.equal(result.recalledMemories?.length, 3);
    assert.equal(validMemoryFocus(ctx)?.people[0].contactId, '555123');
});

test('profile breadth cannot be consumed entirely by repeated project facts', () => {
    const work = Array.from({ length: 80 }, (_, index) => record(`work-${index}`, 'Работает над тестовым проектом.', { domain: 'work' }));
    const tea = record('tea', 'Любит улун.', { memoryKind: 'preference' });
    const result = selectPersonEvidence([...work, tea], person, 'Что известно?', true, 10);
    assert.ok(result.some(item => item.id === 'tea'));
    const expanded = selectPersonEvidence([...work, tea], person, 'Расскажи ещё', true, 10, new Set(result.map(item => item.id)));
    assert.ok(expanded.some(item => !result.includes(item)), 'a continuation must surface additional records');
});

test('specific questions use the grounded person in hybrid search and reranking', async t => {
    const ctx = context(); saveMemoryFocus(ctx, [person], 'Лада Тестовая', ['saved-link']);
    const plan: MemoryQueryPlan = { answerQueries: ['предпочтения напитки'], contextQueries: [], requestKind: 'specific', standaloneQuery: 'Выдуманное имя: напитки',
        references: [{ kind: 'person', mention: 'она', from: 'focus', relationPath: [] }] };
    const records = Array.from({ length: 5 }, (_, index) => record(`drink-${index}`, `[Лада Тестовая] Напитки: вариант ${index}.`));
    t.mock.method(vector, 'getVectorService', () => ({ ...service(records), getMemoriesByTags: async () => records, getAnchorMemories: async () => [],
        searchAllDomains: async (query: string) => { assert.ok(!query.includes('Выдуманное имя')); return records; }, searchLexicalAllDomains: async () => [], getRelatedFacts: async () => [],
    } as any));
    t.mock.method(ai, 'createChatCompletionForTask', async (_task: any, request: any) => {
        assert.match(request.messages[1].content, /Лада Тестовая/); assert.ok(!request.messages[1].content.includes('Выдуманное имя'));
        return { choices: [{ message: { content: '1' } }] } as any;
    });
    const result = await getMultiQueryMemoryContextDetailed(ctx, 'Что она предпочитает пить?', 'full', { queryPlan: plan, trackAccess: false });
    assert.equal(result.recalledMemories.length, 1);
});

test('relationship lookup retains the named person instead of traversing to their colleagues', async t => {
    const question = 'Что нас связывает с Мироном Тестовым?';
    const plan = parseMemoryQueryPlan(JSON.stringify({ answerQueries: ['история взаимодействий и общие дела'], requestKind: 'relationship', references: [
        { kind: 'person', mention: 'Мироном Тестовым', from: 'named', relationPath: [] },
    ] }), question)!;
    assert.equal(plan.requestKind, 'relationship');
    t.mock.method(identity, 'findPersonIdentitiesForRecall', async () => [
        { id: 'synthetic-miron', displayName: 'Мирон Тестовый', aliases: [], telegramContactId: '555125' },
    ] as any);
    let traversals = 0;
    const result = await resolveMemoryQueryEntities(context(), question, plan, { getMemoriesByTag: async () => { traversals++; return []; } } as any);
    assert.equal(result.people[0]?.displayName, 'Мирон Тестовый');
    assert.equal(result.unresolved, false); assert.equal(traversals, 0);
});

test('person evidence reads both edge endpoints even when the fact belongs to the other participant', async () => {
    const pair = relation('owner-pair', 'works_with', 'user', 'synthetic-lada', 'Лада Тестовая');
    const reverse = relation('reverse-pair', 'coworker_of', 'synthetic-lada', 'user', 'Лада Тестовая');
    reverse.tags.push('contact_id:555124'); // storage attribution is not the relation's other endpoint
    const other = relation('other-pair', 'works_with', 'user', 'synthetic-other', 'Элла Примерная');
    const records = [pair, reverse, other, record('personal', 'Предпочитает улун.')];
    const result = await readPersonEvidence(service(records), owner, person);
    assert.deepEqual(new Set(result.map(item => item.id)), new Set(['owner-pair', 'reverse-pair', 'personal']));
});

test('interaction selection preserves direct pair evidence and topical facts without accepting other identities', () => {
    const pair = relation('pair', 'works_with', 'user', 'synthetic-lada', 'Лада Тестовая');
    const aiTopic = record('topic', 'Обсуждает архитектуру AI и нейросети.', { domain: 'work', memoryKind: 'event' });
    const unrelated = Array.from({ length: 70 }, (_, i) => record(`tea-${i}`, 'Любит разные сорта чая.', { domain: 'hobbies' }));
    const bad = record('wrong-person', 'Совместная работа и AI.', { tags: ['contact_id:555124'] });
    const result = selectRelationshipEvidence([...unrelated, bad, aiTopic, pair], person, 'совместная работа темы обсуждений AI', 8);
    assert.equal(result[0].id, 'pair'); assert.ok(result.includes(aiTopic)); assert.ok(!result.includes(bad));
    const formatted = formatPersonOverview([{ person, records: result }], 6500, true);
    assert.match(formatted.context, /pair=queried/); assert.match(formatted.context, /pair=context/);
    assert.match(formatted.context, /не доказывают отношения/);
});

test('an unavailable supplementary edge lookup cannot discard the primary person facts', async () => {
    const fact = record('primary', 'Синтетическое предпочтение.');
    const result = await readPersonEvidence({ getMemoriesByTags: async (_owner: string, tags: string[]) => {
        if (tags.some(tag => tag.startsWith('relation_'))) throw Error('Supplementary lookup unavailable');
        return [fact];
    } } as any, owner, person);
    assert.deepEqual(result.map(item => item.id), ['primary']);
});

test('a relationship between two named people is not replaced by their separate owner relationships', () => {
    const peer: MemoryPerson = { ...person, personIds: ['synthetic-ella'], displayName: 'Элла Примерная', contactId: '555124' };
    const ownerEdge = relation('owner-edge', 'friend_of', 'user', 'synthetic-lada', 'Лада Тестовая');
    const pair = relation('named-pair', 'works_with', 'synthetic-lada', 'synthetic-ella', 'Элла Примерная');
    const selected = selectRelationshipEvidence([ownerEdge, pair], person, 'общие дела', 2, new Set(), [peer]);
    assert.equal(selected[0].id, 'named-pair');
    const formatted = formatPersonOverview([{ person, records: selected }, { person: peer, records: [pair] }], 6500, true);
    assert.equal(formatted.included.filter(item => item.id === pair.id).length, 1);
    assert.match(formatted.context, /named-pair;.*pair=queried/);
    assert.match(formatted.context, /owner-edge;.*pair=context/);
});

test('relationship recall uses the existing planner once and reads evidence without embeddings or reranking', async t => {
    const ctx = context(); saveMemoryFocus(ctx, [person], 'Обсуждаемый человек', ['saved-link']);
    const plan: MemoryQueryPlan = { answerQueries: ['история совместных дел', 'темы обсуждений'], contextQueries: [], requestKind: 'relationship',
        references: [{ kind: 'person', mention: 'ней', from: 'focus', relationPath: [] }] };
    const records = [relation('pair', 'works_with', 'user', 'synthetic-lada', 'Лада Тестовая'),
        record('topics', 'Обсуждает с владельцем тестовый проект AI.', { domain: 'work', memoryKind: 'event' }),
        record('planned', 'Планирует совместную встречу.', { domain: 'work', memoryKind: 'event', status: 'planned', negated: true })];
    t.mock.method(vector, 'getVectorService', () => ({ ...service(records), searchAllDomains: async () => { throw Error('Unexpected embeddings'); } } as any));
    let calls = 0;
    t.mock.method(ai, 'createChatCompletionForTask', async (_task: any, request: any) => {
        calls++; assert.match(request.messages[1].content, /Путь только УСТАНАВЛИВАЕТ/);
        return { choices: [{ message: { content: JSON.stringify(plan) } }] } as any;
    });
    const result = await getMultiQueryMemoryContextDetailed(ctx, 'Что нас с ней связывает?', 'full', { trackAccess: false, explain: true });
    assert.equal(calls, 1); assert.equal(result.retrievalTrace?.reranker?.status, 'relationship_overview');
    assert.equal(result.recalledMemories.length, 3); assert.match(result.context, /status=planned/); assert.match(result.context, /negated=true/);
});

test('identity pool paginates beyond fifty facts, deduplicates tags and preserves owner filters', async () => {
    const calls: any[] = [];
    const service: any = new QdrantVectorService({ scroll: async (collection: string, args: any) => {
        calls.push(args);
        if (!collection.endsWith('_family')) return { points: [] };
        const start = Number(args.offset ?? 0), end = Math.min(125, start + args.limit);
        return { points: Array.from({ length: end - start }, (_, index) => ({ id: `record-${start + index}`, payload: record(`record-${start + index}`, 'Тестовый факт.') })), next_page_offset: end < 125 ? end : null };
    } } as any);
    const result = await service.getMemoriesByTags(owner, ['person_id:synthetic-lada', 'contact_id:555123'], 300);
    assert.equal(result.length, 125);
    assert.ok(calls.some(call => call.offset === 50));
    for (const call of calls) {
        assert.ok(call.filter.must.some((condition: any) => condition.key === 'userId' && condition.match.value === owner));
        assert.ok(call.filter.must.some((condition: any) => condition.key === 'botId'));
        assert.ok(call.filter.must_not.some((condition: any) => condition.key === 'expiresAt'));
        assert.ok(call.limit <= 50);
    }
});
