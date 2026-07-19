import assert from 'node:assert/strict';
import { applyKnowledgeSourceDecision, decideKnowledgeSource, shouldInterruptPendingContactMemory } from '../utils/knowledgeSource';
import { resolveReplyTo, storeSentMessageContext } from '../handlers/shared';
import type { BotContext } from '../types';
import { isMedicalContextMessage } from '../agents/conversationAgent';
import { buildWebSearchSystemPrompt } from '../agents/webSearchAgent';
import { selectExactIdentityCandidate, selectUsernameIdentityCandidate } from '../services/PersonIdentityService';
import type { PersonIdentityEntity } from '../entity/PersonIdentityEntity';
import { hasExplicitSupersedeSignal } from '../services/MemoryReconsolidationService';
import {
    hasUnsupportedSemanticAddition,
    isCompositeAssertion,
} from '../services/MemoryReconsolidationService';
import { identityMetadataFromMemoryTags } from '../utils/proactiveMemory';
import { postProcessPlan } from '../orchestration/planner';
import { isSilentInternalKnowledgePipeline } from '../orchestration/progressPolicy';
import { processMarkdownLinks } from '../utils';
import { isProactiveSourceQuestion } from '../utils/proactiveSourceQuestion';
import { areMemoryIdentityScopesCompatible } from '../utils/enhancedDomainMemory';
import { detectCurrentConversationTopic } from '../utils/conversationTopic';

assert.equal(isMedicalContextMessage('Можно ли сочетать эти лекарства?'), true);
assert.equal(isMedicalContextMessage('Появилась сыпь и отёк'), true);
assert.equal(isMedicalContextMessage('Какое расписание у выставки?'), false);

const webPrompt = buildWebSearchSystemPrompt();
assert.match(webPrompt, /любого запроса об актуальном внешнем мире/iu);
assert.match(webPrompt, /цены и наличие/iu);
assert.match(webPrompt, /транспорт, эфиры, релизы/iu);

const worldCup = decideKnowledgeSource('Что знаешь про текущий чемпионат мира по футболу? Есть занимательные факты?');
assert.equal(worldCup.source, 'external_current');
assert.equal(worldCup.requiresWeb, true);
assert.deepEqual(worldCup.requestedFacets, ['facts', 'current_state', 'schedule', 'results', 'sources']);

assert.equal(decideKnowledgeSource('Что ты помнишь обо мне?').source, 'personal');
assert.equal(decideKnowledgeSource('Расскажи про себя').source, 'assistant_self');
assert.equal(decideKnowledgeSource('Почему небо голубое?').source, 'stable_general');
assert.equal(decideKnowledgeSource('Какие сегодня результаты матчей?').source, 'external_current');
assert.equal(decideKnowledgeSource('Что мне сейчас делать с конфликтом на работе?').source, 'personal');
assert.equal(decideKnowledgeSource('Порекомендуй, как поговорить с женой').source, 'personal');
assert.equal(decideKnowledgeSource('Посоветуй ресторан рядом').source, 'external_current');
assert.equal(decideKnowledgeSource('Расскажи про чемпионат мира 2018').source, 'stable_general');
assert.equal(decideKnowledgeSource('Какие сейчас новости у компании моей жены?').source, 'external_current');
assert.equal(decideKnowledgeSource('Какая сегодня у меня погода?').source, 'external_current');
assert.equal(decideKnowledgeSource('Сколько сейчас стоит лекарство для моей мамы?').source, 'external_current');
assert.equal(decideKnowledgeSource('Что значат результаты моих анализов?').source, 'personal');
assert.equal(decideKnowledgeSource('Какие лекарства сейчас принимает моя мама?').source, 'personal');
assert.equal(decideKnowledgeSource('Какие заявки сейчас принимает новый сервис?').source, 'external_current');
assert.equal(decideKnowledgeSource('Какая сейчас должность у моего друга?').source, 'personal');
assert.equal(decideKnowledgeSource('Что ты помнишь про правила в моей семье?').source, 'personal');
assert.equal(decideKnowledgeSource('Какая последняя версия TypeScript?').source, 'external_current');
assert.equal(decideKnowledgeSource('Посоветуй ноутбук для разработки').source, 'external_current');
assert.equal(decideKnowledgeSource('Мой оператор сейчас работает?').source, 'external_current');
assert.equal(decideKnowledgeSource('Что выбрать: промолчать или поговорить с женой?').source, 'personal');
assert.equal(decideKnowledgeSource('Когда играет Спартак?').source, 'external_current');
assert.equal(decideKnowledgeSource('Когда следующий матч сборной?').source, 'external_current');
assert.equal(decideKnowledgeSource('Во сколько вылетает рейс?').source, 'external_current');
assert.equal(decideKnowledgeSource('Когда откроется выставка?').source, 'external_current');
assert.equal(decideKnowledgeSource('А кто играет?', undefined, 'Текущий международный турнир').source, 'external_current');
assert.equal(decideKnowledgeSource('Напомни к началу чемпионата мира').source, 'external_current');
assert.equal(shouldInterruptPendingContactMemory(decideKnowledgeSource('Узнай текущий курс валют'), false), true);
assert.equal(shouldInterruptPendingContactMemory(decideKnowledgeSource('Запомни личный факт'), false), false);
assert.equal(shouldInterruptPendingContactMemory(decideKnowledgeSource('Открой сайт'), true), true);
assert.equal(detectCurrentConversationTopic('Смотрю чемпионат мира по хоккею', 'Старая тема'), 'Чемпионат мира по хоккею');
assert.equal(detectCurrentConversationTopic('А что на ЧМ?', 'Чемпионат мира по футболу 2026'), 'Чемпионат мира по футболу 2026');
assert.equal(detectCurrentConversationTopic('А что на ЧМ?', 'Другая тема'), 'Чемпионат мира');

// Наличие синтетического контакта в rich-card не должно превращать внешний объект в человека.
assert.equal(decideKnowledgeSource('Что происходит на текущем чемпионате мира?', {
    messageId: 10,
    text: 'карточка тестового контакта',
    kind: 'memory_card',
    contactId: 900000001,
    contactName: 'Тестовый Контакт Альфа',
}).source, 'external_current');

const ctx = {
    message: {
        reply_to_message: {
            message_id: 77,
            from: { first_name: 'Эни' },
        },
    },
    session: {
        sentMessages: {},
        sentMessageContexts: {
            77: {
                messageId: 77,
                text: '🧠 1 факт · «Тестовый Контакт Альфа»',
                kind: 'memory_card',
                contactId: 900000001,
                contactName: 'Тестовый Контакт Альфа',
                memoryIds: ['memory-1'],
                createdAt: Date.now(),
            },
        },
    },
} as unknown as BotContext;
const reply = resolveReplyTo(ctx);
assert.equal(reply.replyToContent, '🧠 1 факт · «Тестовый Контакт Альфа»');
assert.equal(reply.replyContext?.contactId, 900000001);
assert.equal(reply.replyContext?.kind, 'memory_card');
assert.deepEqual(reply.replyContext?.memoryIds, ['memory-1']);

const voiceCtx = { session: { sentMessageContexts: {} } } as unknown as BotContext;
storeSentMessageContext(voiceCtx, 78, 'Голосовой ответ', { delivery: 'voice' });
storeSentMessageContext(voiceCtx, 78, 'Голосовой ответ', { kind: 'proactive', personId: 'synthetic-voice-person' });
assert.equal(voiceCtx.session.sentMessageContexts?.[78]?.delivery, 'voice');
assert.equal(voiceCtx.session.sentMessageContexts?.[78]?.kind, 'proactive');
assert.equal(voiceCtx.session.sentMessageContexts?.[78]?.personId, 'synthetic-voice-person');

const provisional = {
    id: 'synthetic-person-id',
    status: 'provisional',
    aliases: ['Тестовый Контакт Альфа'],
} as PersonIdentityEntity;
assert.equal(selectExactIdentityCandidate([provisional], false)?.id, 'synthetic-person-id');
assert.equal(selectExactIdentityCandidate([provisional], true)?.id, 'synthetic-person-id');
assert.equal(selectExactIdentityCandidate([provisional, { ...provisional, id: 'synthetic-person-id-2' }], false), undefined);
const detached = { ...provisional, detachedFromContacts: true } as PersonIdentityEntity;
assert.equal(selectExactIdentityCandidate([detached], false)?.id, 'synthetic-person-id');
assert.equal(selectExactIdentityCandidate([detached], true), undefined);
const olderUsernameIdentity = {
    ...provisional,
    id: 'synthetic-username-old',
    telegramContactId: undefined,
    lastMentionedAt: new Date('2026-01-01T00:00:00.000Z'),
} as PersonIdentityEntity;
const newerUsernameIdentity = {
    ...provisional,
    id: 'synthetic-username-new',
    telegramContactId: undefined,
    lastMentionedAt: new Date('2026-02-01T00:00:00.000Z'),
} as PersonIdentityEntity;
const wrongContactIdentity = {
    ...provisional,
    id: 'synthetic-username-wrong-contact',
    telegramContactId: '900000099',
    lastMentionedAt: new Date('2026-03-01T00:00:00.000Z'),
} as PersonIdentityEntity;
assert.equal(
    selectUsernameIdentityCandidate([olderUsernameIdentity, wrongContactIdentity, newerUsernameIdentity], '900000001')?.id,
    'synthetic-username-new',
);

assert.equal(hasExplicitSupersedeSignal('Расскажи подробнее об этом факте'), false);
assert.equal(hasExplicitSupersedeSignal('Это неверно, теперь всё иначе'), true);
assert.equal(isCompositeAssertion('Контакт — друг, а также коллега'), true);
assert.equal(isCompositeAssertion('Контакт — близкий друг пользователя, работает вместе с ним'), true);
assert.equal(isCompositeAssertion('Контакт — близкий друг пользователя, ведёт с ним проект'), true);
assert.equal(isCompositeAssertion('Контакт — жена пользователя, воспитывает ребёнка'), true);
assert.equal(isCompositeAssertion('Контакт женат, воспитывает ребёнка'), true);
assert.equal(isCompositeAssertion('Контакт работает с другом пользователя'), false);
assert.equal(isCompositeAssertion('Контакт любит кофе, омлет и балет'), false);
assert.equal(hasUnsupportedSemanticAddition('Мы познакомились через общего знакомого', 'Сначала мы познакомились через общего знакомого'), true);
assert.equal(hasUnsupportedSemanticAddition('Он смотрит матч', 'Он тревожится, поэтому смотрит матч'), true);

const currentDecision = decideKnowledgeSource('Что происходит на текущем турнире?');
const reminderClassification = {
    intent: 'НАПОМИНАНИЕ',
    confidenceLevel: 'ВЫСОКИЙ',
    details: { reminderAction: 'create' },
};
const routedReminder = applyKnowledgeSourceDecision(reminderClassification, currentDecision);
assert.equal(routedReminder.classification.intent, 'НАПОМИНАНИЕ');
assert.equal(routedReminder.primaryIntentOverridden, false);
assert.equal(routedReminder.classification.details.knowledgeSource, 'external_current');
const reminderWithExternalNouns = decideKnowledgeSource('Напомни сегодня купить лекарство');
assert.equal(reminderWithExternalNouns.source, 'personal');
assert.equal(
    applyKnowledgeSourceDecision(reminderClassification, reminderWithExternalNouns).classification.intent,
    'НАПОМИНАНИЕ',
);
const reminderWithLookup = decideKnowledgeSource('Напомни через час найти актуальное расписание матчей');
assert.equal(reminderWithLookup.source, 'external_current');
const reminderAtExternalEvent = decideKnowledgeSource('Напомни к началу следующего матча сборной');
assert.equal(reminderAtExternalEvent.source, 'external_current');
assert.equal(reminderAtExternalEvent.requiresWeb, true);
assert.deepEqual(postProcessPlan({ steps: [{ agentId: 'reminder' }] }, {
    intent: 'НАПОМИНАНИЕ',
    details: { knowledgeSource: 'external_current' },
}).steps.map(step => step.agentId), ['webSearch', 'reminder']);

const compositePlan = postProcessPlan({
    steps: [{ agentId: 'resolveContact' }, { agentId: 'sendMessage' }],
}, {
    intent: 'ОТПРАВКА_СООБЩЕНИЯ',
    subIntents: [{ intent: 'ВЕБ_ПОИСК' }],
    details: { knowledgeSource: 'external_current' },
});
assert.deepEqual(compositePlan.steps.map(step => step.agentId), ['resolveContact', 'webSearch', 'sendMessage']);
const prematureConversationPlan = postProcessPlan({
    steps: [{ agentId: 'conversation' }, { agentId: 'sendMessage' }, { agentId: 'webSearch' }],
}, {
    intent: 'ОТПРАВКА_СООБЩЕНИЯ',
    details: { knowledgeSource: 'external_current' },
});
assert.deepEqual(prematureConversationPlan.steps.map(step => step.agentId), ['webSearch', 'sendMessage']);
assert.deepEqual(postProcessPlan({ steps: [{ agentId: 'health' }] }, {
    intent: 'ЗДОРОВЬЕ',
    details: { knowledgeSource: 'external_current' },
}).steps.map(step => step.agentId), ['webSearch', 'health']);
assert.equal(isSilentInternalKnowledgePipeline([{ agentId: 'webSearch' }, { agentId: 'conversation' }]), true);
assert.equal(isSilentInternalKnowledgePipeline([{ agentId: 'webSearch' }, { agentId: 'sendMessage' }]), false);

assert.deepEqual(identityMetadataFromMemoryTags([
    'contact_id:900000002',
    'contact_name:Тестовый Контакт Бета',
    'person_id:synthetic-person-beta',
]), {
    contactId: 900000002,
    contactName: 'Тестовый Контакт Бета',
    personId: 'synthetic-person-beta',
});

assert.equal(areMemoryIdentityScopesCompatible(
    ['subject:contact', 'person_id:synthetic-a', 'contact_name:Контакт Альфа'],
    ['subject:contact', 'person_id:synthetic-b', 'contact_name:Контакт Альфа'],
), false);
assert.equal(areMemoryIdentityScopesCompatible(
    ['subject:contact', 'person_id:synthetic-a'],
    ['subject:contact', 'person_id:synthetic-a'],
), true);
assert.equal(areMemoryIdentityScopesCompatible(['subject:unknown'], ['subject:user']), false);

assert.equal(isProactiveSourceQuestion('Почему это опасно?'), false);
assert.equal(isProactiveSourceQuestion('Объясни, почему небо голубое'), false);
assert.equal(isProactiveSourceQuestion('Откуда ты это взяла?'), true);

assert.equal(
    processMarkdownLinks('[регистрация](https://example.test/form?id=42&utm_source=bot&slot=evening)'),
    'https://example.test/form?id=42&slot=evening',
);

console.log('context and knowledge routing checks passed');
