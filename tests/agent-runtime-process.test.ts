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

function ctx() {
    return { from: { id: 101 }, chat: { id: 101, type: 'private' }, update: { update_id: 11001 },
        session: { reminders: [], messageHistory: [], domains: {}, dialogueSummary: '', lastSummarizedIndex: -1 } } as any;
}

describe('new engine through the real message entry point', () => {
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
            assert.equal(task, 'complexReasoning');
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
});
