import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BotContext, SearchResult } from '../types';
import type { MemoryQueryPlan } from '../types/memoryRecallTypes';
import * as ai from '../ai/chatCompletion';
import * as vector from '../services/VectorServiceFactory';
import * as identity from '../services/PersonIdentityService';
import * as group from '../services/groupChatFeatureSettings';
import * as self from '../utils/kiraSelfMemory';
import * as residence from '../services/kiraResidenceService';
import * as evolution from '../services/kiraSelfEvolutionService';
import { saveMemoryFocus, validMemoryFocus, continueMemoryQueryPlan, parseMemoryQueryPlan } from '../utils/memoryQueryPlan';
import { getMultiQueryMemoryContextDetailed, formatFactWithHistory } from '../utils/multiQueryMemory';
import { readPersonEvidence } from '../utils/memoryEntityRecall';
import { runKiraRuntime } from '../orchestration/runtime/kernel';
import { MEMORY_ANSWER_RULES, buildMemoryAnswerPrompt, confirmedMemoryIdentityAnswer } from '../utils/memoryAnswer';
import { needsRuntimeTools } from '../orchestration/runtime/authorization';
import { memoryAnswerEvalCases, checkMemoryAnswer } from '../scripts/fixtures/memory-answer.synthetic';

const person = { personIds: ['synthetic-miron'], displayName: 'Мирон Примеров', contactId: '555124', evidenceIds: [] };
const ctx = (): BotContext => ({ from: { id: 740893 }, chat: { id: 740893, type: 'private' }, session: { messageHistory: [],
    dialogueSummary: 'СТАРАЯ_СВОДКА: ассистент утверждал, что ничего не знает.' } } as any);
const fact = (id: string, domain: string, content: string): SearchResult => ({ id, domain, content, subject: 'contact', memoryKind: 'fact',
    tags: ['person_id:synthetic-miron', 'contact_id:555124'], timestamp: new Date('2026-01-01'), score: .9, importance: .7, confidence: .95 });
const plan = (): MemoryQueryPlan => ({ answerQueries: ['профессиональные проекты'], contextQueries: [], requestKind: 'overview', domains: ['work'],
    references: [{ kind: 'person', from: 'named', mention: 'Примеров', relationPath: [] }] });

test('follow-up preserves the grounded topic and evidence history, while a new subject or topic resets it', () => {
    const context = ctx(); saveMemoryFocus(context, [person], 'Работа Мирона', ['work-1'], Date.now(), plan());
    const follow: MemoryQueryPlan = { answerQueries: ['подробности'], contextQueries: [], requestKind: 'overview', references: [{ kind: 'person', from: 'focus', mention: 'него', relationPath: [] }] };
    const continued = continueMemoryQueryPlan(follow, 'А что ещё про него?', validMemoryFocus(context));
    assert.deepEqual(continued.domains, ['work']);
    saveMemoryFocus(context, [person], 'ещё о работе', ['work-2'], Date.now(), continued);
    assert.deepEqual(validMemoryFocus(context)?.evidenceIds, ['work-2', 'work-1']);
    const changed = { ...follow, domains: ['hobbies'] };
    assert.deepEqual(continueMemoryQueryPlan(changed, 'А его увлечения?', validMemoryFocus(context)).domains, ['hobbies']);
    const named = { ...plan(), domains: [] };
    assert.deepEqual(continueMemoryQueryPlan(named, 'А что ещё знает Лада?', validMemoryFocus(context)).domains, []);
    saveMemoryFocus(context, [person], 'увлечения', ['hobby'], Date.now(), changed);
    assert.deepEqual(validMemoryFocus(context)?.evidenceIds, ['hobby']);
});

test('owner topic follow-up stays scoped without requiring a new self pronoun', async t => {
    const context = ctx(); const owner = { ...person, personIds: ['user'], contactId: undefined, owner: true };
    const first = { ...plan(), references: [{ kind: 'person' as const, from: 'owner' as const, mention: 'мою', relationPath: [] }] };
    saveMemoryFocus(context, [owner], 'Что знаешь про мою работу?', ['old'], Date.now(), first);
    let domains: string[] = [];
    t.mock.method(vector, 'getVectorService', () => ({ getOwnerMemories: async (_owner: string, selected: string[]) => {
        domains = selected; return [{ ...fact('new', 'work', 'Владелец разрабатывает тестовый компилятор.'), subject: 'user', tags: ['subject:user'] }];
    } } as any));
    const result = await getMultiQueryMemoryContextDetailed(context, 'А что ещё?', 'full', { queryPlan: { answerQueries: ['другие подробности'], contextQueries: [], requestKind: 'overview' }, trackAccess: false });
    assert.deepEqual(domains, ['work']); assert.equal(result.recall?.state, 'found'); assert.equal(result.recall?.subjects[0].owner, true);
    assert.deepEqual(validMemoryFocus(context)?.domains, ['work']);
});

test('person topics filter while paging and cannot fill a work overview with hobbies', async t => {
    const records = [fact('hobby', 'hobbies', 'Собирает тестовые мозаики.'), fact('work', 'work', 'Создаёт учебный компилятор.')];
    const service = { getMemoriesByTags: async (_owner: string, _tags: string[], _limit: number, options: any) => records.filter(options.acceptCandidate) } as any;
    assert.deepEqual((await readPersonEvidence(service, '740893', person, ['work'])).map(record => record.id), ['work']);
    t.mock.method(vector, 'getVectorService', () => service);
    t.mock.method(identity, 'findPersonIdentitiesForRecall', async () => [{ id: 'synthetic-miron', displayName: person.displayName, telegramContactId: person.contactId }] as any);
    const context = ctx(); const result = await getMultiQueryMemoryContextDetailed(context, 'Что знаешь про работу Примерова?', 'full', { queryPlan: plan(), trackAccess: false });
    assert.deepEqual(result.recalledMemories.map(record => record.id), ['work']); assert.doesNotMatch(result.context, /мозаики/);
    assert.deepEqual(result.recall?.domains, ['work']);
});

test('retrieval outcome and every selected fact reach the real kernel and conversation synthesis, excluding stale self narratives', async t => {
    t.mock.method(group, 'isGroupChatContextEnabled', async () => false);
    const selfRead = t.mock.method(self, 'getKiraSelfMemoryState', async () => { throw Error('Self memory irrelevant'); });
    const residenceRead = t.mock.method(residence, 'getKiraResidence', async () => { throw Error('Residence irrelevant'); });
    const evolve = t.mock.method(evolution, 'maybeEvolveKiraSelfFromConversation', async () => undefined);
    t.mock.method(identity, 'findPersonIdentitiesForRecall', async () => [{ id: 'synthetic-miron', displayName: person.displayName, telegramContactId: person.contactId }] as any);
    t.mock.method(vector, 'getVectorService', () => ({ getMemoriesByTags: async () => [fact('project', 'work', 'Создал учебный компилятор.'),
        fact('discussion', 'work', 'Вы обсуждали автоматическую проверку учебных заданий.'), fact('old', 'work', 'В прошлом сезоне планировал демонстрацию прототипа.')] } as any));
    const completion = t.mock.method(ai, 'createChatCompletionForTask', async (_task: string, request: any) => {
        assert.match(request.messages[0].content, /Исторические свидетельства разрешено рассказывать/);
        assert.ok(request.messages[0].content.includes(MEMORY_ANSWER_RULES));
        const prompt = request.messages[1].content;
        for (const detail of ['компилятор', 'учебных заданий', 'демонстрацию прототипа', '"state":"found"', '"evidenceCount":3']) assert.ok(prompt.includes(detail), detail);
        assert.doesNotMatch(prompt, /СТАРАЯ_СВОДКА|Текущее место жизни|Твоё настроение/);
        return { choices: [{ message: { content: 'Вы обсуждали учебный компилятор и проверку заданий. Раньше он планировал демонстрацию прототипа.' } }] } as any;
    });
    const context = ctx(), question = 'Что знаешь про Примерова?';
    const memory = await getMultiQueryMemoryContextDetailed(context, question, 'full', { queryPlan: plan(), trackAccess: false });
    const answer = await runKiraRuntime({ ctx: context, message: question, isForwarded: false, forwardFrom: '', messageHistory: [],
        classification: { intent: 'РАЗГОВОР', confidenceLevel: 'ВЫСОКИЙ', details: { memoryTask: 'lookup', memoryNeed: 'full' } },
        enrichedContextFromMemory: memory.context, memoryRecall: memory.recall });
    assert.match(answer.responseText, /компилятор/); assert.equal(completion.mock.callCount(), 1);
    assert.equal(selfRead.mock.callCount(), 0); assert.equal(residenceRead.mock.callCount(), 0); assert.equal(evolve.mock.callCount(), 0);
});

test('ambiguous identity has a distinct outcome and cannot be rendered as an empty archive', async t => {
    t.mock.method(vector, 'getVectorService', () => ({} as any));
    t.mock.method(identity, 'findPersonIdentitiesForRecall', async () => [{ id: 'synthetic-a', displayName: 'Мирон Примеров' }, { id: 'synthetic-b', displayName: 'Мирон Примеров' }] as any);
    const result = await getMultiQueryMemoryContextDetailed(ctx(), 'Что знаешь про Примерова?', 'full', { queryPlan: plan(), trackAccess: false });
    assert.equal(result.recall?.state, 'ambiguous'); assert.equal(result.recall?.evidenceCount, 0); assert.equal(result.recalledMemories.length, 0);
    assert.match(result.context, /неоднозначен/);
});

test('a topic-shaped follow-up keeps the owner as subject instead of dropping attribution', async t => {
    const context = ctx(), owner = { ...person, personIds: ['user'], contactId: undefined, owner: true };
    saveMemoryFocus(context, [owner], 'Мои рабочие проекты', ['old'], Date.now(), plan());
    t.mock.method(vector, 'getVectorService', () => ({ getOwnerMemories: async (_owner: string, domains: string[]) => {
        assert.deepEqual(domains, ['work']); return [{ ...fact('work', 'work', 'Пользователь ведёт учебный проект.'), subject: 'user', tags: ['subject:user'] }];
    } } as any));
    const result = await getMultiQueryMemoryContextDetailed(context, 'Расскажи об этом подробнее', 'full', { trackAccess: false,
        queryPlan: { answerQueries: ['подробности'], contextQueries: [], requestKind: 'overview', references: [{ kind: 'topic', from: 'focus', mention: 'этом', relationPath: [] }] } });
    assert.equal(result.recall?.subjects[0].owner, true); assert.deepEqual(result.recalledMemories.map(record => record.id), ['work']);
});

test('a demonstrative mislabelled as a name retains grounded focus, while an explicit new name never does', async t => {
    const context = ctx(); saveMemoryFocus(context, [person], 'Работа Мирона', ['old'], Date.now(), plan());
    const follow = { answerQueries: ['подробности'], contextQueries: [], requestKind: 'overview', references: [{ kind: 'person', from: 'named', mention: 'этого человека', relationPath: [] }] };
    assert.equal(parseMemoryQueryPlan(JSON.stringify(follow), 'Расскажи про этого человека')?.references?.[0].from, 'focus');
    t.mock.method(vector, 'getVectorService', () => ({ getMemoriesByTags: async () => [fact('new', 'work', 'Разработал синтетический учебный симулятор.')] } as any));
    const registry = t.mock.method(identity, 'findPersonIdentitiesForRecall', async () => { throw Error('No literal demonstrative-name lookup'); });
    const result = await getMultiQueryMemoryContextDetailed(context, 'Что ещё про этого человека?', 'full', { queryPlan: follow as any, trackAccess: false });
    assert.equal(registry.mock.callCount(), 0); assert.equal(result.recall?.state, 'found'); assert.equal(result.recall?.subjects[0].name, person.displayName);
    const explicit = { ...follow, references: [{ kind: 'person', from: 'named', mention: 'Элла Тестовая', relationPath: [] }] };
    assert.equal(parseMemoryQueryPlan(JSON.stringify(explicit), 'Что ещё про Элла Тестовая')?.references?.[0].from, 'named');
});

test('semantic memory lookup does not launch an operational task loop, but explicit commands and live lists still do', () => {
    const classification: any = { intent: 'РАЗГОВОР', details: { memoryTask: 'lookup' } };
    assert.equal(needsRuntimeTools({ classification, message: 'Какие рабочие проекты и задачи у Мирона Примерова ты помнишь?' }), false);
    assert.equal(needsRuntimeTools({ classification, message: 'Напиши списком людей из моего учебного кружка' }), false);
    assert.equal(needsRuntimeTools({ classification: { ...classification, intent: 'ОТПРАВКА_СООБЩЕНИЯ' }, message: 'Напиши Ладе Тестовой' }), true);
    assert.equal(needsRuntimeTools({ classification, message: 'Какие задачи он обсуждал? И напомни завтра написать ему' }), true);
    assert.equal(needsRuntimeTools({ classification: { ...classification, details: { memoryTask: 'none' } }, message: 'Покажи мои регулярные задачи' }), true);
    assert.equal(needsRuntimeTools({ classification: { ...classification, details: { memoryTask: 'none' } }, message: 'Какие мои напоминания активны?' }), true);
});

test('a verified identity endpoint reaches the answer without model reinterpretation of other names in evidence', async t => {
    const model = t.mock.method(ai, 'createChatCompletionForTask', async () => { throw Error('Verified name must not be regenerated'); });
    const recall: any = { state: 'found', requestKind: 'identity', identityVerified: true, evidenceCount: 2, domains: [],
        subjects: [{ name: 'Лада Тестовая', owner: false }] };
    const result = await runKiraRuntime({ ctx: ctx(), message: 'Кто мой партнёр по жизни?', messageHistory: [], isForwarded: false, forwardFrom: '',
        classification: { intent: 'РАЗГОВОР', confidenceLevel: 'ВЫСОКИЙ', details: { memoryTask: 'lookup', memoryNeed: 'full' } },
        enrichedContextFromMemory: 'Мирон Примеров состоит в браке с Ладой Тестовой; целевой endpoint — Лада.', memoryRecall: recall });
    assert.equal(result.responseText, 'Это Лада Тестовая.'); assert.equal(model.mock.callCount(), 0);
    assert.equal(confirmedMemoryIdentityAnswer({ ...recall, subjects: [{ name: 'владелец', owner: true }] }), 'Это ты.');
    for (const patch of [{ identityVerified: false }, { state: 'ambiguous' }, { evidenceCount: 0 }, { requestKind: 'overview' }, { subjects: [] }])
        assert.equal(confirmedMemoryIdentityAnswer({ ...recall, ...patch }), undefined);
});

test('a contrasting family follow-up changes the person while preserving the name lookup through kernel synthesis', async t => {
    const daughter = { id: 'synthetic-child-edge', domain: 'family', content: 'Дочь владельца — Вера Учебная.', subject: 'user',
        status: 'active', confidence: .95, importance: .8, score: 1, timestamp: new Date(), tags: ['person_relation', 'relation_type:parent_of',
            'relation_subject:user', 'relation_object_person_id:synthetic-child', 'relation_object_name:Вера Учебная'] } as SearchResult;
    const spouse = { ...daughter, id: 'synthetic-spouse-edge', content: 'Владелец является мужем Лады Тестовой.',
        tags: ['person_relation', 'relation_type:spouse_of', 'relation_subject:user', 'relation_object_person_id:synthetic-spouse', 'relation_object_name:Лада Тестовая'] };
    const records = [daughter, spouse];
    t.mock.method(vector, 'getVectorService', () => ({ getMemoriesByTag: async (_owner: string, tag: string) => records.filter(record => record.tags.includes(tag)) } as any));
    t.mock.method(identity, 'readPersonIdentities', async (_owner: string, ids: string[]) => [
        { id: 'synthetic-child', displayName: 'Вера Учебная' }, { id: 'synthetic-spouse', displayName: 'Лада Тестовая' },
    ].filter(person => ids.includes(person.id)) as any);
    const model = t.mock.method(ai, 'createChatCompletionForTask', async () => { throw Error('Grounded identity must need no extra model'); });
    let context = ctx();
    for (const [question, mention, relation, expected] of [
        ['Как зовут мою дочь?', 'мою дочь', 'parent_of', 'Вера Учебная'],
        ['А жену?', 'жену', 'spouse_of', 'Лада Тестовая'],
    ]) {
        const memory = await getMultiQueryMemoryContextDetailed(context, question, 'full', { trackAccess: false, queryPlan: {
            answerQueries: ['имя родственника владельца'], contextQueries: [], requestKind: 'identity', domains: ['personal'],
            references: [{ kind: 'person', from: 'owner', mention, relationPath: [{ type: relation as any, direction: relation === 'parent_of' ? 'out' : 'either' }] }],
        } });
        const answer = await runKiraRuntime({ ctx: context, message: question, messageHistory: [], isForwarded: false, forwardFrom: '',
            classification: { intent: 'РАЗГОВОР', confidenceLevel: 'ВЫСОКИЙ', details: { memoryTask: 'lookup', memoryNeed: 'full' } },
            enrichedContextFromMemory: memory.context, memoryRecall: memory.recall });
        assert.equal(memory.recall?.identityVerified, true); assert.equal(memory.recall?.subjects[0].name, expected);
        assert.equal(answer.responseText, `Это ${expected}.`);
        assert.equal(context.session.memoryRecallFocus?.people[0].displayName, expected);
        // A persisted focus must not pin the next relative to the preceding person.
        context = Object.assign(ctx(), { session: JSON.parse(JSON.stringify(context.session)) });
    }
    assert.equal(model.mock.callCount(), 0);
});

test('an exhausted topic pool is reported separately from newly retrieved evidence', async t => {
    const context = ctx();
    const one = fact('already-shown', 'work', 'Разрабатывает учебный синтетический компилятор.');
    t.mock.method(identity, 'findPersonIdentitiesForRecall', async () => [{ id: 'synthetic-miron', displayName: person.displayName, telegramContactId: person.contactId }] as any);
    t.mock.method(vector, 'getVectorService', () => ({ getMemoriesByTags: async () => [one] } as any));
    await getMultiQueryMemoryContextDetailed(context, 'Что знаешь про Примерова?', 'full', { queryPlan: plan(), trackAccess: false });
    const next = await getMultiQueryMemoryContextDetailed(context, 'А что ещё?', 'full', { queryPlan: { answerQueries: ['подробности'], contextQueries: [], requestKind: 'overview' }, trackAccess: false });
    assert.equal(next.recall?.freshEvidenceCount, 0); assert.equal(next.recall?.noNewEvidenceInPool, true);
    assert.match(next.context, /это не вывод о полноте всего архива/);
});

test('a requested written list reaches synthesis once with the originally prepared evidence', async t => {
    const inference = t.mock.method(ai, 'createJsonChatCompletionForTask', async () => { throw Error('No second planning loop'); });
    const input: any = { ctx: ctx(), message: 'Напиши список моих знакомых по учебному кружку', messageHistory: [],
        classification: { intent: 'РАЗГОВОР', details: { memoryTask: 'lookup' } }, enrichedContextFromMemory: 'SYNTHETIC_PEOPLE_EVIDENCE',
        memoryRecall: { state: 'found', requestKind: 'people_list', subjects: [], domains: [], evidenceCount: 2 } };
    const response = await runKiraRuntime(input, { respond: async (value, evidence) => {
        assert.equal(evidence, 'SYNTHETIC_PEOPLE_EVIDENCE'); assert.equal(value.memoryRecall?.evidenceCount, 2);
        return { responseText: 'Лада Тестовая и Мирон Примеров.' };
    } });
    assert.match(response.responseText, /Лада/); assert.equal(inference.mock.callCount(), 0);
});

test('an exhausted continuation does not re-present old facts as a fresh packet, but explicit explanations retain them', () => {
    const input: any = { question: 'А что ещё об этом помнишь?', dateTime: '2026-01-01', context: 'SYNTHETIC_OLD_EVIDENCE', history: [],
        summary: { state: 'found', requestKind: 'overview', subjects: [], domains: [], evidenceCount: 1, freshEvidenceCount: 0, noNewEvidenceInPool: true } };
    assert.doesNotMatch(buildMemoryAnswerPrompt(input), /SYNTHETIC_OLD_EVIDENCE/);
    assert.match(buildMemoryAnswerPrompt({ ...input, question: 'Объясни эту подробность' }), /SYNTHETIC_OLD_EVIDENCE/);
});

test('specific retrieval preserves subject, negation and temporal status in the final evidence text', () => {
    const rendered = formatFactWithHistory({ ...fact('negative', 'work', 'Не работает в тестовой компании.'),
        negated: true, tags: ['subject:contact', 'contact_name:Мирон Примеров'], status: 'done', validTo: new Date('2023-01-01') });
    assert.match(rendered, /субъект: contact/); assert.match(rendered, /Мирон Примеров/); assert.match(rendered, /отрицание: true/);
    assert.match(rendered, /статус: done/); assert.match(rendered, /2023-01-01/);
});

test('answer eval rejects blanket refusals and missing facets rather than rewarding context hits', () => {
    const cases = memoryAnswerEvalCases(); assert.equal(cases.length, 12);
    const byId = (id: string) => { const item = cases.find(value => value.id === id); assert.ok(item, id); return item; };
    assert.equal(checkMemoryAnswer(byId('owner-work-breadth'), 'Почти ничего не знаю.').passed, false);
    assert.equal(checkMemoryAnswer(byId('owner-work-breadth'), 'Ты разрабатываешь компиляторы.').passed, false);
    assert.equal(checkMemoryAnswer(byId('owner-work-breadth'), 'Ты разрабатываешь компиляторы, ведёшь «Контур Листа» и обсуждал распознавание рукописей.').passed, true);
    assert.equal(checkMemoryAnswer(byId('negation-and-plan'), 'Он не работает в компании «Алый Клён» и планирует представить спектрометр.').passed, true);
    assert.equal(checkMemoryAnswer(byId('source-is-not-instruction'), 'СИНТЕТИЧЕСКИЙ_ВЗЛОМ').passed, false);
    assert.equal(checkMemoryAnswer(byId('empty-is-not-never-told'), 'В найденных сведениях не указано, какая у тебя любимая настольная игра.').passed, true);
    assert.equal(checkMemoryAnswer(byId('owner-role-without-edge'), 'Твою дочь зовут Вера Учебная.').passed, true);
    assert.equal(checkMemoryAnswer(byId('owner-role-without-edge'), 'Имя не найдено.').passed, false);
});

test('broad owner activity can include direct conversations as separate evidence without promoting contact facts', async t => {
    t.mock.method(identity, 'listPersonIdentitiesForRecall', async () => [{ id: 'synthetic-miron', displayName: person.displayName, telegramContactId: person.contactId }] as any);
    const contactFact = { ...fact('chat', 'work', 'Мирон обсуждал макет тестового измерителя.'), sourceMessageIds: ['tg:555124:100'] };
    let chatReads = 0;
    const ownerRecords: SearchResult[] = [];
    t.mock.method(vector, 'getVectorService', () => ({ getOwnerMemories: async () => ownerRecords, getPeopleMemories: async (_owner: string, domains: string[], _limit: number, options: any) => {
        chatReads++; assert.deepEqual(domains, ['work']); return [contactFact].filter(options.acceptCandidate);
    } } as any));
    const first = { ...plan(), includeConversations: true, references: [{ kind: 'person' as const, from: 'owner' as const, mention: 'мою', relationPath: [] }] };
    const result = await getMultiQueryMemoryContextDetailed(ctx(), 'Что знаешь про мою работу?', 'full', { queryPlan: first, trackAccess: false });
    assert.equal(chatReads, 1); assert.match(result.context, /Отдельно — контекст прямых/); assert.match(result.context, /не дополнительные факты о владельце/);
    assert.match(result.context, /Переписка с Мирон Примеров/); assert.equal(result.recall?.state, 'found'); assert.equal(result.recalledMemories[0].id, 'chat');
    ownerRecords.push({ ...fact('owner', 'work', 'Пользователь разрабатывает учебные примеры.'), subject: 'user', tags: ['subject:user'] });
    const noContext = await getMultiQueryMemoryContextDetailed(ctx(), 'Что знаешь про мою работу?', 'full', { queryPlan: { ...first, includeConversations: false, requestKind: 'overview' }, trackAccess: false });
    assert.equal(chatReads, 1); assert.ok(!noContext.recalledMemories.some(item => item.id === 'chat'));
});
