import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BotContext, SearchResult } from '../types';
import type { MemoryQueryPlan } from '../types/memoryRecallTypes';
import { config } from '../config';
import { readOwnerRecallSupplement, formatOwnerSourcedEvidence, storedExtractionQuote } from '../utils/ownerRecallEvidence';
import { isOwnerRecallEvidence } from '../utils/contactMemory';
import { isEligibleForUserSynthesis } from '../utils/userSynthesisFilter';
import { getMultiQueryMemoryContextDetailed } from '../utils/multiQueryMemory';
import * as vector from '../services/VectorServiceFactory';
import * as identity from '../services/PersonIdentityService';

const owner = '740893';
const plan = (): MemoryQueryPlan => ({ answerQueries: ['руководитель начальник пользователя'], contextQueries: [], domains: ['work'], requestKind: 'people_list',
    peopleQuery: { basis: 'relationships', relations: [{ type: 'manager_of', direction: 'in' }] },
    references: [{ kind: 'person', mention: 'мои', from: 'owner', relationPath: [] }] });
const fact = (id: string, patch: Partial<SearchResult> = {}): SearchResult => ({ id, content: 'Руководитель пользователя — Мирон Учебный.', subject: 'user',
    domain: 'work', memoryKind: 'fact', status: 'active', confidence: .95, importance: .7, score: 1, timestamp: new Date('2026-01-01'), tags: ['subject:user', 'source_contact:Тестовый Собеседник'],
    sourceContext: 'Фоновая рефлексия чата.\nОпора извлечения: Я: Я подчиняюсь Мирону Учебному.\nВременная привязка: scope=stable_fact', ...patch });
const service = (records: SearchResult[]) => ({ getOwnerMemories: async (user: string, domains: string[], _limit: number, options: any) => {
    assert.equal(user, owner); return records.filter(record => domains.includes(record.domain) && options.acceptCandidate(record));
}, getMemoriesByTags: async () => [], getMemoriesByTag: async () => [] } as any);

test('source evidence retains speaker attribution and cannot enter owner synthesis or establish a canonical identity', async () => {
    const record = fact('manager');
    assert.equal(isOwnerRecallEvidence(record), false); assert.equal(isEligibleForUserSynthesis(record), false);
    const result = await readOwnerRecallSupplement(service([record]), owner, plan(), 'Кто мои руководители?');
    assert.deepEqual(result.direct, []); assert.deepEqual(result.sourced.map(item => item.id), ['manager']);
    const packed = formatOwnerSourcedEvidence(result.sourced);
    assert.match(packed.context, /attribution=supported/); assert.match(packed.context, /Я: Я подчиняюсь Мирону/);
    assert.doesNotMatch(packed.context, /scope=stable_fact/); assert.match(packed.context, /не подтверждённый профиль/);
});

test('opposite speakers, forwards, missing quotes, conflicting subjects and archived evidence stay excluded', async () => {
    const bad = [fact('contact-self', { sourceContext: 'Опора извлечения: Тестовый Собеседник: Я подчиняюсь Мирону Учебному.' }),
        fact('forward', { sourceContext: 'Опора извлечения: Я (переслал сообщение от Тестового Собеседника): Я подчиняюсь Мирону.' }),
        fact('no-quote', { sourceContext: 'Чат называется Руководители.' }), fact('bot', { subject: 'bot' }),
        fact('conflict', { tags: ['subject:contact', 'source_contact:Тестовый Собеседник'] }),
        fact('expired', { expiresAt: new Date('2020-01-01') }), fact('superseded', { status: 'superseded' }),
        fact('derived', { memoryKind: 'chapter' }), fact('weak', { confidence: .3 }),
        fact('unresolved', { sourceContext: 'Опора извлечения: В этом сообщении упоминается руководитель.' })];
    assert.deepEqual(await readOwnerRecallSupplement(service(bad), owner, plan(), 'Кто мои руководители?'), { direct: [], sourced: [] });
});

test('unlabelled extraction remains explicitly unresolved and requires the exact authenticated owner name as a reading cue', async t => {
    const previous = config.ownerName; config.ownerName = 'Семён Примеров'; t.after(() => { config.ownerName = previous; });
    const quote = 'В этом разговоре руководителем назван Мирон Учебный.';
    const good = fact('named-owner', { content: 'Руководитель Семён Примеров — Мирон Учебный.', sourceContext: 'Опора извлечения: ' + quote });
    const unrelated = fact('other-owner', { content: 'Руководитель другого человека — Мирон Учебный.', sourceContext: 'Опора извлечения: ' + quote });
    const forward = { ...good, id: 'named-forward', sourceContext: 'Опора извлечения: Я (переслала сообщение от Тестового Собеседника): Я подчиняюсь Мирону.' };
    const bot = { ...good, id: 'named-bot', sourceContext: 'Опора извлечения: Ассистент: Семён Примеров подчиняется Мирону.' };
    const result = await readOwnerRecallSupplement(service([good, unrelated, forward, bot]), owner, plan(), 'Кто мои руководители?');
    assert.deepEqual(result.sourced.map(item => item.id), ['named-owner']);
    assert.match(formatOwnerSourcedEvidence(result.sourced).context, /attribution=unknown/);
    assert.equal(isOwnerRecallEvidence(good), false);
});

test('legacy general facts handle inflections and owner-name stem collisions while excluding unrelated and contact facts', async t => {
    const previous = config.ownerName; config.ownerName = 'Семён Примеров'; t.after(() => { config.ownerName = previous; });
    const familyPlan: MemoryQueryPlan = { ...plan(), domains: ['family'], answerQueries: ['Сведения о семье пользователя и его родственниках'] };
    const records = [fact('family', { domain: 'general', content: 'Дочь владельца — Вера Учебная.', tags: ['subject:user', 'семья'], sourceContext: undefined }),
        fact('unrelated', { domain: 'general', content: 'Пользователь собирает модели телескопов.', tags: ['subject:user'], sourceContext: undefined }),
        fact('other-family', { domain: 'general', subject: 'contact', tags: ['subject:contact', 'семья'] })];
    const result = await readOwnerRecallSupplement(service(records), owner, familyPlan, 'Напомни мою семью');
    assert.deepEqual(result.direct.map(item => item.id), ['family']); assert.deepEqual(result.sourced, []);
    const work = await readOwnerRecallSupplement(service(records), owner, plan(), 'Кто мои руководители на работе?');
    assert.deepEqual(work.direct, [], 'the shared word «пользователь» cannot make a family fact relevant to management');
});

for (const kind of ['people_list', 'overview', 'identity'] as const) test(`${kind} reaches sourced management evidence without a canonical edge or promoting a person focus`, async t => {
    t.mock.method(vector, 'getVectorService', () => service([fact('manager')]));
    t.mock.method(identity, 'listPersonIdentitiesForRecall', async () => []);
    const ctx = { from: { id: Number(owner) }, chat: { id: Number(owner), type: 'private' }, session: { messageHistory: [] } } as any as BotContext;
    const query = { ...plan(), requestKind: kind };
    if (kind === 'identity') query.references = [{ kind: 'person', mention: 'мои руководители', from: 'owner', relationPath: [{ type: 'manager_of', direction: 'in' }] }];
    const result = await getMultiQueryMemoryContextDetailed(ctx, 'Кто мои руководители?', 'full', { queryPlan: query, trackAccess: false });
    assert.equal(result.recall?.state, 'found'); assert.equal(result.recall?.identityVerified, undefined);
    assert.deepEqual(result.recalledMemories.map(item => item.id), ['manager']);
    assert.match(result.context, /Опора: Я: Я подчиняюсь Мирону Учебному/); assert.ok(result.context.length <= 6500);
    assert.ok(!ctx.session.memoryRecallFocus?.people.some(person => !person.owner));
});

test('a quote is packed whole, and technical source headers never become speaker evidence', () => {
    assert.equal(storedExtractionQuote(fact('title-only', { sourceContext: 'Чат Я: Я подчиняюсь Мирону.' })), undefined);
    const long = fact('long', { sourceContext: 'Опора извлечения: Я: ' + 'длинная цитата '.repeat(150) });
    const packed = formatOwnerSourcedEvidence([long], 900);
    assert.equal(packed.context, ''); assert.deepEqual(packed.included, []);
});
