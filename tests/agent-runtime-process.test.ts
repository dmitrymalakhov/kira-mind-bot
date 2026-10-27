import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { processMessage } from '../orchestrator';
import { config } from '../config';
import * as completion from '../ai/chatCompletion';
import * as conversation from '../agents/conversationAgent';
import * as search from '../agents/webSearchAgent';
import * as memory from '../utils/agentMemoryContext';
import * as session from '../services/SessionStorage';
import * as planner from '../orchestration/planner';
import * as executor from '../orchestration/executor';
import { ChatGroupRepository } from '../services/ChatGroupRepository';
import { reminderService } from '../services/ReminderService';
import * as kernel from '../orchestration/runtime/kernel';
import { browserConfirmationKey } from '../orchestration/runtime/confirmation';
import * as relationship from '../utils/resolveRelationshipFromMemory';
import * as contactLookup from '../utils/contactMemoryLookup';

function ctx() {
    return { from: { id: 101 }, chat: { id: 101, type: 'private' }, update: { update_id: 11001 },
        session: { reminders: [], messageHistory: [], domains: {}, dialogueSummary: '', lastSummarizedIndex: -1 } } as any;
}

describe('new engine through the real message entry point', () => {
    test('classifier abstention is not a second intent that diverts personal recall into clarification', async t => {
        const mode = process.env.KIRA_ORCHESTRATION_MODE; process.env.KIRA_ORCHESTRATION_MODE = 'skills';
        const decisions = process.env.KIRA_DECISIONS_ENABLED; delete process.env.KIRA_DECISIONS_ENABLED;
        t.mock.method(ChatGroupRepository, 'findAll', async () => []);
        t.mock.method(memory, 'fetchAgentMemoryContext', async () => ({ domain: 'personal', context: 'Синтетический профиль профессиональных навыков.',
            recall: { state: 'found', requestKind: 'overview', subjects: [{ name: 'владелец', owner: true }], domains: ['work'], evidenceCount: 2 } } as any));
        t.mock.method(completion, 'createJsonChatCompletionForTask', async () => ({ intent: 'РАЗГОВОР', confidenceLevel: 'СРЕДНИЙ',
            intentScores: [{ intent: 'РАЗГОВОР', score: .57 }, { intent: 'НЕОПРЕДЕЛЕНО', score: .43 }], details: { memoryTask: 'lookup', memoryNeed: 'full' } }) as any);
        const run = t.mock.method(kernel, 'runKiraRuntime', async (input: any) => {
            assert.equal(input.classification.intent, 'РАЗГОВОР'); assert.equal(input.classification.clarificationQuestion, undefined);
            assert.equal(input.memoryRecall.evidenceCount, 2); return { responseText: 'Ты разрабатываешь учебные симуляторы.' };
        });
        try { await processMessage(ctx(), 'Что ты помнишь о моей профессии?'); assert.equal(run.mock.callCount(), 1); }
        finally { if (mode === undefined) delete process.env.KIRA_ORCHESTRATION_MODE; else process.env.KIRA_ORCHESTRATION_MODE = mode;
            if (decisions === undefined) delete process.env.KIRA_DECISIONS_ENABLED; else process.env.KIRA_DECISIONS_ENABLED = decisions; }
    });

    test('a real competing action still requires clarification for an ambiguous request', async t => {
        const mode = process.env.KIRA_ORCHESTRATION_MODE; process.env.KIRA_ORCHESTRATION_MODE = 'skills';
        const decisions = process.env.KIRA_DECISIONS_ENABLED; delete process.env.KIRA_DECISIONS_ENABLED;
        t.mock.method(ChatGroupRepository, 'findAll', async () => []);
        t.mock.method(memory, 'fetchAgentMemoryContext', async () => ({ domain: 'personal', context: '' }));
        t.mock.method(completion, 'createJsonChatCompletionForTask', async () => ({ intent: 'РАЗГОВОР', confidenceLevel: 'СРЕДНИЙ',
            intentScores: [{ intent: 'РАЗГОВОР', score: .52 }, { intent: 'НАПОМИНАНИЕ', score: .48 }], details: { memoryNeed: 'none' } }) as any);
        const run = t.mock.method(kernel, 'runKiraRuntime', async (input: any) => {
            assert.equal(input.classification.intent, 'НЕОПРЕДЕЛЕНО'); assert.ok(input.classification.clarificationQuestion); return { responseText: 'Уточни действие.' };
        });
        try { await processMessage(ctx(), 'Надо бы потом вспомнить об учебном семинаре'); assert.equal(run.mock.callCount(), 1); }
        finally { if (mode === undefined) delete process.env.KIRA_ORCHESTRATION_MODE; else process.env.KIRA_ORCHESTRATION_MODE = mode;
            if (decisions === undefined) delete process.env.KIRA_DECISIONS_ENABLED; else process.env.KIRA_DECISIONS_ENABLED = decisions; }
    });

    test('canonical personal recall is not overwritten by the legacy role-to-name resolver', async t => {
        const oldMode = process.env.KIRA_ORCHESTRATION_MODE; process.env.KIRA_ORCHESTRATION_MODE = 'skills';
        const oldDecisions = process.env.KIRA_DECISIONS_ENABLED; delete process.env.KIRA_DECISIONS_ENABLED;
        const oldOwner = config.allowedUserId; config.allowedUserId = 101;
        t.mock.method(ChatGroupRepository, 'findAll', async () => []);
        const recall = t.mock.method(memory, 'fetchAgentMemoryContext', async () => ({ domain: 'personal', context: 'Синтетическое свидетельство совместной работы.', recalledMemories: [] }));
        const legacy = t.mock.method(relationship, 'resolveRelationshipFromMemory', async () => { throw Error('Duplicate resolver'); });
        const legacyLookup = t.mock.method(contactLookup, 'maybeStartContactMemoryLookup', async () => { throw Error('Legacy topic interception'); });
        t.mock.method(completion, 'createJsonChatCompletionForTask', async (task: string) => {
            assert.equal(task, 'intentClassification');
            return { intent: 'РАЗГОВОР', confidenceLevel: 'ВЫСОКИЙ', details: { memoryNeed: 'full', memoryTask: 'lookup', relationshipRole: 'Мирон Тестовый', responseComplexity: 'routine' } } as any;
        });
        t.mock.method(kernel, 'runKiraRuntime', async (input: any) => {
            assert.match(input.enrichedContextFromMemory, /Синтетическое свидетельство/);
            return { responseText: 'Синтетический ответ.' };
        });
        try {
            await processMessage(ctx(), 'Что нас связывает с Мироном Тестовым?');
            assert.equal(recall.mock.callCount(), 1); assert.equal(legacy.mock.callCount(), 0); assert.equal(legacyLookup.mock.callCount(), 0);
        } finally {
            if (oldMode === undefined) delete process.env.KIRA_ORCHESTRATION_MODE; else process.env.KIRA_ORCHESTRATION_MODE = oldMode;
            if (oldDecisions === undefined) delete process.env.KIRA_DECISIONS_ENABLED; else process.env.KIRA_DECISIONS_ENABLED = oldDecisions;
            config.allowedUserId = oldOwner;
        }
    });
    test('classifies once, searches, creates a reminder and returns one combined answer', async t => {
        const oldMode = process.env.KIRA_ORCHESTRATION_MODE; process.env.KIRA_ORCHESTRATION_MODE = 'skills';
        const oldDecisions = process.env.KIRA_DECISIONS_ENABLED; delete process.env.KIRA_DECISIONS_ENABLED;
        const oldOwner = config.allowedUserId; config.allowedUserId = 101;
        t.mock.method(ChatGroupRepository, 'findAll', async () => []);
        const recall = t.mock.method(memory, 'fetchAgentMemoryContext', async () => ({ domain: 'personal', context: '', recalledMemories: [] }));
        t.mock.method(session, 'persistAgentRuntime', async () => {});
        const oldPlanner = t.mock.method(planner, 'createPlan', async () => { throw new Error('Legacy planner must not run'); });
        const oldExecutor = t.mock.method(executor, 'executePlan', async () => { throw new Error('Legacy executor must not run'); });
        const searches = t.mock.method(search, 'performWebSearch', async () => ({ success: true, results: 'Синтетическое событие в субботу: https://example.test/event' }));
        const saves = t.mock.method(reminderService, 'createReminder', async (_ctx: unknown, details: any) => ({ ...details, chatId: 101 }));
        const answer = t.mock.method(conversation, 'conversationAgent', async (...args: any[]) => {
            assert.match(args[6].context, /example\.test\/event/);
            return { responseText: 'Нашла синтетическое событие: https://example.test/event' };
        });
        let rounds = 0; let classifications = 0;
        t.mock.method(completion, 'createJsonChatCompletionForTask', async (task: string) => {
            if (task === 'intentClassification') { classifications++; return {
                intent: 'ВЕБ_ПОИСК', confidenceLevel: 'ВЫСОКИЙ', details: { memoryNeed: 'none', relationshipRole: null, responseComplexity: 'routine' }, subIntents: [{ intent: 'НАПОМИНАНИЕ' }],
            } as any; }
            assert.equal(task, 'runtimePlanning');
            return [
                { calls: [{ id: 'search', tool: 'web.search', args: { query: 'Синтетические события в субботу' } }] },
                { calls: [{ id: 'remind', tool: 'reminders.create', args: { text: 'Выбрать синтетическое событие', dueAt: '2099-01-01T10:00:00+03:00' } }] },
                { finish: true },
            ][rounds++] as any;
        });
        const value = ctx();
        try {
            const result = await processMessage(value, 'Найди свежую афишу на субботу и напомни завтра выбрать событие');
            assert.equal(classifications, 1); assert.equal(searches.mock.callCount(), 1); assert.equal(saves.mock.callCount(), 1); assert.equal(answer.mock.callCount(), 1);
            assert.equal(recall.mock.callCount(), 1); assert.equal(oldPlanner.mock.callCount(), 0); assert.equal(oldExecutor.mock.callCount(), 0);
            assert.equal(result.remindersPersisted, true); assert.match(result.responseText, /example\.test/); assert.match(result.responseText, /Выбрать синтетическое событие/);
            assert.deepEqual(value.session.agentRuntime.toolNames, ['web.search', 'reminders.create']);
            assert.equal(value.session.agentRuntime.status, 'completed');
        } finally {
            config.allowedUserId = oldOwner;
            if (oldMode === undefined) delete process.env.KIRA_ORCHESTRATION_MODE; else process.env.KIRA_ORCHESTRATION_MODE = oldMode;
            if (oldDecisions === undefined) delete process.env.KIRA_DECISIONS_ENABLED; else process.env.KIRA_DECISIONS_ENABLED = oldDecisions;
        }
    });

    test('preserves the greeting fast path without routing or planning calls', async t => {
        const oldMode = process.env.KIRA_ORCHESTRATION_MODE; process.env.KIRA_ORCHESTRATION_MODE = 'skills';
        t.mock.method(ChatGroupRepository, 'findAll', async () => []);
        t.mock.method(memory, 'fetchAgentMemoryContext', async () => ({ domain: 'personal', context: '', recalledMemories: [] }));
        t.mock.method(conversation, 'conversationAgent', async () => ({ responseText: 'Привет!' }));
        const ai = t.mock.method(completion, 'createJsonChatCompletionForTask', async () => { throw new Error('Unexpected extra inference'); });
        try { assert.equal((await processMessage(ctx(), 'Привет')).responseText, 'Привет!'); assert.equal(ai.mock.callCount(), 0); }
        finally { if (oldMode === undefined) delete process.env.KIRA_ORCHESTRATION_MODE; else process.env.KIRA_ORCHESTRATION_MODE = oldMode; }
    });

    test('a new reminder is not classified as an answer to the paused browser', async t => {
        const mode = process.env.KIRA_ORCHESTRATION_MODE; process.env.KIRA_ORCHESTRATION_MODE = 'skills';
        t.mock.method(ChatGroupRepository, 'findAll', async () => []);
        t.mock.method(memory, 'fetchAgentMemoryContext', async () => ({ domain: 'personal', context: '', recalledMemories: [] }));
        t.mock.method(completion, 'createJsonChatCompletionForTask', async () => ({ intent: 'НАПОМИНАНИЕ', confidenceLevel: 'ВЫСОКИЙ', details: {} }) as any);
        let message = 'Напомни завтра проверить синтетический отчёт';
        const run = t.mock.method(kernel, 'runKiraRuntime', async (input: any) => { assert.equal(input.classification.intent, 'НАПОМИНАНИЕ'); assert.equal(input.message, message); return { responseText: 'Напоминание сохранено', operationStatus: 'ok' }; });
        const value = ctx(); value.session.pendingBrowserTask = { sessionId: 'browser-a', originalTask: 'Старая задача', question: 'Какой вариант?', expiresAt: Date.now() + 60_000 };
        try { for (message of ['Напомни завтра проверить синтетический отчёт', 'Можешь завтра напомнить проверить синтетический отчёт?']) await processMessage(value, message); assert.equal(run.mock.callCount(), 2); assert.equal(value.session.pendingBrowserTask.sessionId, 'browser-a'); }
        finally { if (mode === undefined) delete process.env.KIRA_ORCHESTRATION_MODE; else process.env.KIRA_ORCHESTRATION_MODE = mode; }
    });

    test('a new successful browser task cannot complete an unrelated waiting delegation', async t => {
        const mode = process.env.KIRA_ORCHESTRATION_MODE; process.env.KIRA_ORCHESTRATION_MODE = 'skills';
        t.mock.method(ChatGroupRepository, 'findAll', async () => []);
        t.mock.method(memory, 'fetchAgentMemoryContext', async () => ({ domain: 'personal', context: '', recalledMemories: [] }));
        t.mock.method(completion, 'createJsonChatCompletionForTask', async () => ({ intent: 'БРАУЗЕР_ЗАДАЧА', confidenceLevel: 'ВЫСОКИЙ', details: {} }) as any);
        t.mock.method(kernel, 'runKiraRuntime', async () => ({ responseText: 'Сайт прочитан', operationStatus: 'ok' }));
        const resumed = t.mock.method(kernel, 'continueConfirmedRuntime', async () => undefined);
        const value = ctx(); value.session.agentRuntime = { status: 'waiting', goal: 'Изучи переписку и напомни проверить', observations: [{ id: 'study', tool: 'agents.start', status: 'needs_input' }], pendingCalls: [{ id: 'next' }] };
        try { await processMessage(value, 'Открой сайт https://example.test'); assert.equal(resumed.mock.callCount(), 0); }
        finally { if (mode === undefined) delete process.env.KIRA_ORCHESTRATION_MODE; else process.env.KIRA_ORCHESTRATION_MODE = mode; }
    });

    test('browser completion finds the matching archived parent without overwriting the current waiting goal', async t => {
        const mode = process.env.KIRA_ORCHESTRATION_MODE; process.env.KIRA_ORCHESTRATION_MODE = 'skills';
        t.mock.method(ChatGroupRepository, 'findAll', async () => []);
        t.mock.method(memory, 'fetchAgentMemoryContext', async () => ({ domain: 'personal', context: '', recalledMemories: [] }));
        t.mock.method(completion, 'createJsonChatCompletionForTask', async () => ({ intent: 'БРАУЗЕР_ЗАДАЧА', confidenceLevel: 'ВЫСОКИЙ', details: {} }) as any);
        const value = ctx(); value.session.pendingBrowserTask = { sessionId: 'browser-a', originalTask: 'Старая задача', expiresAt: Date.now() + 60_000 };
        value.session.agentRuntime = { runId: 'other-goal', status: 'waiting' };
        value.session.agentRuntimePending = [{ status: 'waiting', backgroundRun: true, ledgerKey: 'task:101:synthetic-browser', observations: [{ id: 'browser', tool: 'agents.start', status: 'needs_input', confirmationKey: browserConfirmationKey('browser-a') }] }];
        t.mock.method(kernel, 'runKiraRuntime', async (input: any) => { assert.equal(input.ctx.agentRuntimeStorageKey, 'task:101:synthetic-browser'); assert.equal(input.recurringTaskRun, true); value.session.pendingBrowserTask = undefined; return { responseText: 'Сайт прочитан', operationStatus: 'ok' }; });
        const resumed = t.mock.method(kernel, 'continueConfirmedRuntime', async (...[current, _tools, _summary, _deps, key]: Parameters<typeof kernel.continueConfirmedRuntime>) => { assert.equal(key, browserConfirmationKey('browser-a')); assert.equal(current.session.agentRuntime?.runId, 'other-goal'); return undefined; });
        try { await processMessage(value, 'Продолжи задачу в браузере через Playwright.\nbrowserSessionId: browser-a\nОтвет пользователя: Да'); assert.equal(resumed.mock.callCount(), 1); }
        finally { if (mode === undefined) delete process.env.KIRA_ORCHESTRATION_MODE; else process.env.KIRA_ORCHESTRATION_MODE = mode; }
    });

    test('browser cancellation, failure and uncertainty never resume queued writes', async t => {
        const mode = process.env.KIRA_ORCHESTRATION_MODE; process.env.KIRA_ORCHESTRATION_MODE = 'skills';
        t.mock.method(ChatGroupRepository, 'findAll', async () => []);
        t.mock.method(memory, 'fetchAgentMemoryContext', async () => ({ domain: 'personal', context: '', recalledMemories: [] }));
        t.mock.method(session, 'persistAgentRuntime', async () => {});
        t.mock.method(completion, 'createJsonChatCompletionForTask', async () => ({ intent: 'БРАУЗЕР_ЗАДАЧА', confidenceLevel: 'ВЫСОКИЙ', details: {} }) as any);
        let status: 'ok' | 'failed' | 'unknown' = 'ok';
        t.mock.method(kernel, 'runKiraRuntime', async (input: any) => { input.ctx.session.pendingBrowserTask = undefined; return { responseText: 'Браузер завершил работу', operationStatus: status }; });
        const resumed = t.mock.method(kernel, 'continueConfirmedRuntime', async () => undefined);
        try {
            for (status of ['ok', 'failed', 'unknown'] as const) {
                const value = ctx(); value.session.pendingBrowserTask = { sessionId: 'browser-a', originalTask: 'Старая задача', expiresAt: Date.now() + 60_000 };
                value.session.agentRuntime = { runId: 'browser-goal', status: 'waiting', receipts: [{ key: 'browser-receipt', tool: 'agents.start', status: 'needs_input' }], agents: [], pendingCalls: [{ id: 'write' }], observations: [{ id: 'browser', tool: 'agents.start', status: 'needs_input', confirmationKey: browserConfirmationKey('browser-a') }] };
                const result = await processMessage(value, status === 'ok' ? 'отмена' : 'Продолжи задачу в браузере через Playwright.\nbrowserSessionId: browser-a\nОтвет пользователя: Да');
                assert.equal(value.session.agentRuntime.status, 'failed'); assert.deepEqual(value.session.agentRuntime.pendingCalls, []);
                assert.equal(result.operationStatus, status === 'unknown' ? 'unknown' : 'failed');
                assert.equal(value.session.agentRuntime.receipts[0].status, status === 'unknown' ? 'unknown' : 'failed');
            }
            assert.equal(resumed.mock.callCount(), 0);
        } finally { if (mode === undefined) delete process.env.KIRA_ORCHESTRATION_MODE; else process.env.KIRA_ORCHESTRATION_MODE = mode; }
    });
});
