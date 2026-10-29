import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { config } from '../config';
import { processMessage, type MessageClassification } from '../orchestrator';
import { createKiraToolRegistry, runKiraRuntime, continueQuestionRuntime } from '../orchestration/runtime/kernel';
import { needsRuntimeTools, isDialogueReadTool } from '../orchestration/runtime/authorization';
import { requiresTelegramProfile } from '../utils/telegramProfileRequest';
import type { KiraRuntimeInput, ToolContext } from '../orchestration/runtime/types';
import * as completion from '../ai/chatCompletion';
import * as profiles from '../services/telegramProfileService';
import * as memory from '../utils/agentMemoryContext';
import * as conversation from '../agents/conversationAgent';
import * as session from '../services/SessionStorage';
import { DialogueJobRepository } from '../services/DialogueJobRepository';
import { ChatGroupRepository } from '../services/ChatGroupRepository';
import * as group from '../services/groupChatFeatureSettings';
import * as self from '../utils/kiraSelfMemory';
import * as residence from '../services/kiraResidenceService';

function input(): KiraRuntimeInput {
    return { ctx: { from: { id: 101 }, chat: { id: 101, type: 'private' }, session: { messageHistory: [], reminders: [], domains: {}, dialogueSummary: '', lastSummarizedIndex: -1 } } as any,
        message: 'Подскажи телефон Мирона Тестового', messageHistory: [], isForwarded: false, forwardFrom: '', enrichedContextFromMemory: '',
        classification: { intent: 'РАЗГОВОР', confidenceLevel: 'ВЫСОКИЙ', details: { telegramProfile: true, contactQuery: 'Мирон Тестовый', memoryNeed: 'none', memoryTask: 'none', responseComplexity: 'routine' } } };
}
function environment(t: TestContext) {
    const oldOwner = config.allowedUserId, oldMode = process.env.KIRA_ORCHESTRATION_MODE, oldDecisions = process.env.KIRA_DECISIONS_ENABLED;
    config.allowedUserId = 101; process.env.KIRA_ORCHESTRATION_MODE = 'skills'; delete process.env.KIRA_DECISIONS_ENABLED;
    t.after(() => { config.allowedUserId = oldOwner;
        if (oldMode === undefined) delete process.env.KIRA_ORCHESTRATION_MODE; else process.env.KIRA_ORCHESTRATION_MODE = oldMode;
        if (oldDecisions === undefined) delete process.env.KIRA_DECISIONS_ENABLED; else process.env.KIRA_DECISIONS_ENABLED = oldDecisions;
    });
}
const found: profiles.TelegramProfileLookup = { state: 'found', source: 'telegram_profile', summary: 'Телефон из Telegram: +12025550123.',
    checkedAt: '2026-01-01T10:00:00.000Z', profile: { id: 81001, firstName: 'Мирон', lastName: 'Тестовый', phone: '+12025550123', phoneStatus: 'available' } };

test('profile requests reach tools despite an empty memory lookup; ordinary recall keeps the short path', () => {
    const value = input(); value.classification.details.memoryTask = 'lookup';
    assert.equal(needsRuntimeTools(value), true);
    delete value.classification.details.telegramProfile;
    assert.equal(needsRuntimeTools(value), false);
    value.classification.subIntents = [{ intent: 'РАЗГОВОР', details: { telegramProfile: true } }];
    assert.equal(requiresTelegramProfile(value.classification), true); assert.equal(needsRuntimeTools(value), true);
});

test('a known target gets its live profile before synthesis without another planning call', async t => {
    environment(t); const value = input();
    const lookup = t.mock.method(profiles, 'lookupTelegramProfile', async (query: string) => { assert.equal(query, 'Мирон Тестовый'); return found; });
    const result = await runKiraRuntime(value, { persist: async () => {}, decide: async () => { throw Error('No planning needed for a known target'); },
        respond: async (_input, context) => { assert.match(context, /telegram_profile/); assert.match(context, /12025550123/); return { responseText: 'Телефон Мирона: +12025550123.' }; } });
    assert.match(result.responseText, /12025550123/); assert.equal(lookup.mock.callCount(), 1);
    assert.deepEqual(value.ctx.session.agentRuntime?.toolNames, ['contacts.getProfile']);
    assert.equal(value.ctx.session.agentRuntime?.receipts.length, 0);
});

test('an ambiguous profile returns one clarification without an unrelated portrait or synthesis', async t => {
    environment(t); const value = input();
    t.mock.method(profiles, 'lookupTelegramProfile', async () => ({ state: 'ambiguous', source: 'telegram_profile', summary: 'Какой Мирон: @synthetic_one или @synthetic_two?', candidates: [] }));
    const result = await runKiraRuntime(value, { persist: async () => {}, respond: async () => { throw Error('No biography instead of clarification'); } });
    assert.equal(result.operationStatus, 'needs_input'); assert.equal(result.responseText, 'Какой Мирон: @synthetic_one или @synthetic_two?');
    assert.equal(value.ctx.session.agentRuntime?.parameterCall?.tool, 'contacts.getProfile');
});

test('role-based profile requests use prepared identity evidence and retain the profile lookup task', async t => {
    environment(t); const value = input();
    value.message = 'Какой номер у моего брата?'; delete value.classification.details.contactQuery;
    value.classification.details.relationshipRole = 'брат'; value.classification.details.memoryTask = 'lookup';
    value.enrichedContextFromMemory = 'Проверенная сохранённая связь: брат — Мирон Тестовый.';
    value.memoryRecall = { state: 'found', requestKind: 'identity', identityVerified: true, subjects: [{ name: 'Мирон Тестовый', owner: false }], evidenceCount: 1, domains: [] };
    t.mock.method(profiles, 'lookupTelegramProfile', async () => found);
    const result = await runKiraRuntime(value, { persist: async () => {}, decide: async ({ context }) => {
        assert.match(context.memoryContext, /брат — Мирон Тестовый/);
        return context.observations.some(o => o.tool === 'contacts.getProfile') ? { finish: true } : { calls: [{ id: 'profile', tool: 'contacts.getProfile', args: { query: 'Мирон Тестовый', fields: ['phone'] } }] };
    }, respond: async (_value, context) => { assert.match(context, /12025550123/); return { responseText: 'Номер брата: +12025550123.' }; } });
    assert.match(result.responseText, /12025550123/);
});

test('answering a profile clarification resumes the original lookup with the selected username', async t => {
    environment(t); const value = input(); const queries: string[] = [];
    t.mock.method(profiles, 'lookupTelegramProfile', async (query: string) => {
        queries.push(query);
        return query === '@synthetic_one' ? found : { state: 'ambiguous', source: 'telegram_profile', summary: 'Уточни @username человека.', candidates: [] };
    });
    await runKiraRuntime(value, { persist: async () => {} });
    assert.equal(value.ctx.session.agentRuntime?.status, 'waiting');
    const result = await continueQuestionRuntime(value.ctx, '@synthetic_one', { persist: async () => {}, decide: async () => ({ finish: true }),
        respond: async (_input, context) => { assert.match(context, /12025550123/); return { responseText: 'Номер: +12025550123.' }; } });
    assert.equal(result?.operationStatus, 'ok'); assert.match(result!.responseText, /12025550123/);
    assert.deepEqual(queries, ['Мирон Тестовый', '@synthetic_one']);
});

test('a short confirmation selects the single persisted candidate after session serialization', async t => {
    environment(t); const value = input(); const queries: string[] = [];
    t.mock.method(profiles, 'lookupTelegramProfile', async (query: string, _fields: unknown, expectedId?: number) => {
        queries.push(query);
        if (queries.length === 1) return { state: 'ambiguous', source: 'telegram_profile', summary: 'Найден похожий Мирон Тестовый (@synthetic_one). Это нужный человек?',
            candidates: [{ id: 81001, firstName: 'Мирон', lastName: 'Тестовый', username: 'synthetic_one' }] };
        assert.equal(query, '@synthetic_one'); assert.equal(expectedId, 81001); return found;
    });
    await runKiraRuntime(value, { persist: async () => {} });
    value.ctx.session.agentRuntime = JSON.parse(JSON.stringify(value.ctx.session.agentRuntime));
    const result = await continueQuestionRuntime(value.ctx, 'Да, это он', { persist: async () => {}, decide: async () => ({ finish: true }),
        respond: async (_input, context) => { assert.match(context, /12025550123/); return { responseText: 'Номер: +12025550123.' }; } });
    assert.equal(result?.operationStatus, 'ok'); assert.deepEqual(queries, ['Мирон Тестовый', '@synthetic_one']);
});

test('yes cannot select between multiple candidates or a rejected candidate', async t => {
    environment(t); const value = input();
    const lookup = t.mock.method(profiles, 'lookupTelegramProfile', async () => ({ state: 'ambiguous', source: 'telegram_profile', summary: 'Выбери нужного человека.',
        candidates: [{ id: 81001, firstName: 'Мирон', username: 'synthetic_one' }, { id: 81002, firstName: 'Мирон', username: 'synthetic_two' }] }));
    await runKiraRuntime(value, { persist: async () => {} });
    const waiting = await continueQuestionRuntime(value.ctx, 'да', { persist: async () => {} });
    assert.equal(waiting?.operationStatus, 'needs_input'); assert.equal(lookup.mock.callCount(), 1); assert.match(waiting!.responseText, /несколько/);
    const rejected = await continueQuestionRuntime(value.ctx, 'нет это не он', { persist: async () => {} });
    assert.equal(rejected?.operationStatus, 'needs_input'); assert.equal(lookup.mock.callCount(), 1);
    assert.deepEqual((value.ctx.session.agentRuntime!.observations!.find(o => o.tool === 'contacts.getProfile')!.data as any).candidates, []);
});

test('profile read is allowed in a read-only job but denied to other users and group chats', async t => {
    environment(t); const value = input(), registry = createKiraToolRegistry();
    const context: ToolContext = { ...value, readOnly: true, runId: 'synthetic', signal: new AbortController().signal, memoryContext: '', observations: [] };
    const lookup = t.mock.method(profiles, 'lookupTelegramProfile', async () => found);
    assert.equal(isDialogueReadTool(registry.get('contacts.getProfile')!), true);
    assert.equal((await registry.execute('contacts.getProfile', { query: 'Мирон Тестовый' }, context)).status, 'ok');
    const outsider = { ...context, ctx: { ...context.ctx, from: { id: 102 } } as any };
    const group = { ...context, ctx: { ...context.ctx, chat: { id: -101, type: 'group' } } as any };
    for (const denied of [outsider, group]) {
        assert.equal((await registry.execute('contacts.getProfile', { query: 'Мирон Тестовый' }, denied)).status, 'failed');
        assert.ok(!registry.available(denied).some(tool => tool.name === 'contacts.getProfile'));
    }
    assert.equal(lookup.mock.callCount(), 1);
    assert.equal((await registry.execute('contacts.getProfile', { query: 'Мирон Тестовый', userId: 102 }, context)).status, 'failed');
});

test('real conversation synthesis returns profile evidence instead of an identity-only answer or exhausted recall', async t => {
    environment(t); const value = input(); value.classification.details.memoryTask = 'lookup';
    value.memoryRecall = { state: 'found', requestKind: 'identity', identityVerified: true, subjects: [{ name: 'Мирон Тестовый', owner: false }],
        evidenceCount: 1, domains: [], noNewEvidenceInPool: true, freshEvidenceCount: 0 };
    t.mock.method(profiles, 'lookupTelegramProfile', async () => found);
    t.mock.method(group, 'isGroupChatContextEnabled', async () => false);
    const selfRead = t.mock.method(self, 'getKiraSelfMemoryState', async () => { throw Error('No self biography for contact details'); });
    const residenceRead = t.mock.method(residence, 'getKiraResidence', async () => { throw Error('No residence for contact details'); });
    const answer = t.mock.method(completion, 'createChatCompletionForTask', async (_task: string, request: any) => {
        const prompt = request.messages[1].content;
        assert.match(prompt, /12025550123/); assert.match(prompt, /свежие поля профиля/);
        assert.doesNotMatch(prompt, /Поиск завершён: в текущей ограниченной выборке нет новых/);
        return { choices: [{ message: { content: 'Телефон Мирона: +12025550123.' } }] } as any;
    });
    const result = await runKiraRuntime(value, { persist: async () => {} });
    assert.match(result.responseText, /12025550123/); assert.equal(answer.mock.callCount(), 1);
    assert.equal(selfRead.mock.callCount(), 0); assert.equal(residenceRead.mock.callCount(), 0);
});

test('real intake keeps the same task after an earlier refusal, name correction and pronoun follow-up', async t => {
    environment(t); t.mock.method(ChatGroupRepository, 'findAll', async () => []); t.mock.method(session, 'persistAgentRuntime', async () => {});
    t.mock.method(memory, 'fetchAgentMemoryContext', async () => ({ domain: 'personal', context: 'В памяти номер не найден.', recalledMemories: [] }));
    const lookup = t.mock.method(profiles, 'lookupTelegramProfile', async (query: string) => { assert.equal(query, 'Мирон Тестовый'); return found; });
    const stage = t.mock.method(DialogueJobRepository, 'stage', async () => { throw Error('Profile must not become a deferred memory job'); });
    const model = t.mock.method(completion, 'createJsonChatCompletionForTask', async (task: string, request: any) => {
        assert.equal(task, 'fastDialogue'); assert.match(request.messages[0].content, /telegramProfile=true/);
        assert.match(request.messages[1].content, /Мирон Тестовый/);
        return { ...input().classification, fastReply: { mode: 'answer', answer: 'Не знаю номер из памяти.' } } as MessageClassification;
    });
    t.mock.method(conversation, 'conversationAgent', async (...args: any[]) => {
        assert.match(args[6].context, /12025550123/); assert.equal(args[6].allowSideEffects, false);
        return { responseText: 'Телефон Мирона: +12025550123.' };
    });
    const history = [{ role: 'user' as const, content: 'Подскажи телефон Мирона Тестовского', timestamp: new Date(1) },
        { role: 'bot' as const, content: 'В памяти номер не найден.', timestamp: new Date(2) }, { role: 'user' as const, content: 'Мирон Тестовый', timestamp: new Date(3) }];
    for (const message of ['Мирон Тестовый', 'Я ищу его номер']) {
        const value = input(); value.ctx.dialogueTurnId = `synthetic-${message}`;
        const result = await processMessage(value.ctx, message, false, '', history, undefined, { fastDialogue: true });
        assert.match(result.responseText, /12025550123/); assert.notEqual(result.fastResponse, true);
    }
    assert.equal(lookup.mock.callCount(), 2); assert.equal(model.mock.callCount(), 2); assert.equal(stage.mock.callCount(), 0);
});
