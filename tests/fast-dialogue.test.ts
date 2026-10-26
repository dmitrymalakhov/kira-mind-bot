import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { Bot } from 'grammy';
import { config } from '../config';
import { processMessage, type MessageClassification } from '../orchestrator';
import { canUseFastDialogue, tryFastDialogueResult } from '../orchestration/fastDialogue';
import { executeDialogueJob, publicDialogueJob, registerDialogueLifecycle } from '../services/dialogueJobs';
import { DialogueJobRepository } from '../services/DialogueJobRepository';
import type { DialogueJob } from '../types/dialogueJobTypes';
import * as completion from '../ai/chatCompletion';
import * as memory from '../utils/agentMemoryContext';
import * as conversation from '../agents/conversationAgent';
import * as session from '../services/SessionStorage';
import * as features from '../services/backgroundFeatureService';
import * as preset from '../services/aiRuntimeConfigService';
import { ChatGroupRepository } from '../services/ChatGroupRepository';
import { addToHistory } from '../utils/history';
import { factAnalysisManager } from '../utils/factAnalysisTimer';
import * as extraction from '../utils/enhancedFactExtraction';
import * as summarizer from '../services/dialogueSummarizer';
import { ToolRegistry, objectSchema } from '../orchestration/runtime/registry';
import { runKiraRuntime } from '../orchestration/runtime/kernel';
import type { BotContext } from '../types';
import { BotApiBackend } from '../api/backend';

const OWNER = 740001;
const classification = (): MessageClassification => ({ intent: 'РАЗГОВОР', confidenceLevel: 'ВЫСОКИЙ',
    details: { memoryNeed: 'none', responseComplexity: 'routine', relationshipRole: null },
    fastReply: { mode: 'answer', answer: 'Рекурсия — решение задачи через более простой случай той же задачи.' } });
const ctx = () => ({ from: { id: OWNER }, chat: { id: OWNER, type: 'private' }, update: { update_id: 567 }, message: { message_id: 567 },
    dialogueTurnId: 'turn-synthetic', session: { messageHistory: [], reminders: [], domains: {}, dialogueSummary: '', lastSummarizedIndex: -1 } } as unknown as BotContext);
function environment(t: TestContext) {
    const oldOwner = config.allowedUserId; config.allowedUserId = OWNER;
    const mode = process.env.KIRA_ORCHESTRATION_MODE; process.env.KIRA_ORCHESTRATION_MODE = 'skills';
    const fast = process.env.KIRA_FAST_DIALOGUE_ENABLED; process.env.KIRA_FAST_DIALOGUE_ENABLED = 'true';
    t.after(() => { config.allowedUserId = oldOwner;
        if (mode === undefined) delete process.env.KIRA_ORCHESTRATION_MODE; else process.env.KIRA_ORCHESTRATION_MODE = mode;
        if (fast === undefined) delete process.env.KIRA_FAST_DIALOGUE_ENABLED; else process.env.KIRA_FAST_DIALOGUE_ENABLED = fast;
    });
}
function foreground(t: TestContext, value = classification()) {
    environment(t);
    t.mock.method(ChatGroupRepository, 'findAll', async () => []);
    const recall = t.mock.method(memory, 'fetchAgentMemoryContext', async () => ({ domain: 'personal', context: '', recalledMemories: [] }));
    const answer = t.mock.method(conversation, 'conversationAgent', async () => ({ responseText: 'Полный синхронный ответ.' }));
    const ai = t.mock.method(completion, 'createJsonChatCompletionForTask', async (task: string) => {
        assert.equal(task, 'fastDialogue'); return value as any;
    });
    t.mock.method(preset, 'getActiveAiPresetName', async () => 'gpt-balanced');
    return { ai, recall, answer };
}

test('self-contained question returns the answer in the routing call, without memory or a second model', async t => {
    const calls = foreground(t);
    const stage = t.mock.method(DialogueJobRepository, 'stage', async () => { throw new Error('No background work needed'); });
    const result = await processMessage(ctx(), 'Объясни рекурсию', false, '', [], undefined, { fastDialogue: true });
    assert.match(result.responseText, /Рекурсия/); assert.equal(result.fastResponse, true);
    assert.equal(result.skipOptionalFollowups, true); assert.equal(result.dialogueJobId, undefined);
    assert.equal(calls.ai.mock.callCount(), 1); assert.equal(calls.recall.mock.callCount(), 0); assert.equal(calls.answer.mock.callCount(), 0); assert.equal(stage.mock.callCount(), 0);
});

test('greeting also uses exactly one compact fast call', async t => {
    const value = classification(); value.fastReply!.answer = 'Привет!';
    const calls = foreground(t, value);
    const result = await processMessage(ctx(), 'Привет', false, '', [], undefined, { fastDialogue: true });
    assert.equal(result.responseText, 'Привет!'); assert.equal(calls.ai.mock.callCount(), 1); assert.equal(calls.answer.mock.callCount(), 0);
});

test('presence checks never ask a classifier, memory or a background worker, even after a complex topic', async t => {
    const calls = foreground(t);
    const stage = t.mock.method(DialogueJobRepository, 'stage', async () => { throw new Error('No background work for a presence check'); });
    const result = await processMessage(ctx(), 'Ты тут?', false, '', [], undefined,
        { fastDialogue: true, turn: { userText: 'Ты тут?', currentTopic: 'Сложный синтетический анализ памяти' } });
    assert.equal(result.responseText, 'Да, я тут. Что у тебя?');
    assert.equal(result.fastResponse, true); assert.equal(result.dialogueJobId, undefined);
    assert.equal(calls.ai.mock.callCount(), 0); assert.equal(calls.recall.mock.callCount(), 0);
    assert.equal(calls.answer.mock.callCount(), 0); assert.equal(stage.mock.callCount(), 0);
});

test('an erroneous defer or memory signal cannot turn an exact greeting into background research', async t => {
    const value = classification(); value.details.memoryNeed = 'full'; value.details.knowledgeSource = 'personal'; value.fastReply = { mode: 'defer' };
    const calls = foreground(t, value);
    const stage = t.mock.method(DialogueJobRepository, 'stage', async () => { throw new Error('No deep review for a greeting'); });
    const result = await processMessage(ctx(), 'Привет!', false, '', [], undefined, { fastDialogue: true });
    assert.equal(result.responseText, 'Привет! Как ты?'); assert.equal(result.dialogueJobId, undefined);
    assert.equal(calls.ai.mock.callCount(), 1); assert.equal(calls.recall.mock.callCount(), 0); assert.equal(stage.mock.callCount(), 0);
});

test('personal evidence overrides a confident draft; a durable job exists before acknowledging work', async t => {
    const calls = foreground(t);
    t.mock.method(features, 'getBackgroundFeaturePreference', async () => true);
    let saved: any;
    t.mock.method(DialogueJobRepository, 'stage', async (values: any) => { saved = values; return { id: 'job-a', status: 'staged' } as DialogueJob; });
    const result = await tryFastDialogueResult(ctx(), { userText: 'Что мы решили про синтетическую поездку?' }, classification(),
        { source: 'personal', requiresWeb: false, requestedFacets: [], reason: 'personal' }, []);
    assert.ok(result); assert.equal(result.dialogueJobId, 'job-a'); assert.doesNotMatch(result.responseText, /Рекурсия/);
    assert.equal(saved.input.initialAnswer, ''); assert.equal(saved.input.required, true);
    assert.equal(saved.input.classification.details.memoryNeed, 'full'); assert.equal(saved.input.classification.details.responseComplexity, 'complex');
    assert.equal(saved.channel, String(OWNER)); assert.equal(saved.turnId, 'turn-synthetic'); assert.equal(calls.recall.mock.callCount(), 0);
});

test('complex questions return an acknowledgement; disabled queue falls back to the full answer', async t => {
    const value = classification(); value.details.responseComplexity = 'complex'; value.fastReply = { mode: 'defer' };
    const calls = foreground(t, value);
    t.mock.method(features, 'getBackgroundFeaturePreference', async () => false);
    const result = await processMessage(ctx(), 'Объясни рекурсию по шагам', false, '', [], undefined, { fastDialogue: true });
    assert.equal(result.responseText, 'Полный синхронный ответ.'); assert.equal(calls.recall.mock.callCount(), 1); assert.equal(calls.ai.mock.callCount(), 1);
});

test('a storage failure cannot return a promise of background work', async t => {
    foreground(t);
    t.mock.method(features, 'getBackgroundFeaturePreference', async () => true);
    t.mock.method(DialogueJobRepository, 'stage', async () => { throw new Error('storage unavailable'); });
    const value = classification(); value.fastReply = { mode: 'defer' };
    const result = await tryFastDialogueResult(ctx(), { userText: 'Сложный вопрос' }, value,
        { source: 'stable_general', requiresWeb: false, requestedFacets: [], reason: '' }, []);
    assert.equal(result, undefined);
});

test('budget gate suppresses optional review without slowing down the substantive answer', async t => {
    foreground(t);
    t.mock.method(features, 'isBackgroundFeatureEnabled', async () => false);
    const stage = t.mock.method(DialogueJobRepository, 'stage', async () => { throw new Error('No optional paid work'); });
    const value = classification(); value.fastReply!.mode = 'review';
    const result = await tryFastDialogueResult(ctx(), { userText: 'Объясни рекурсию' }, value,
        { source: 'stable_general', requiresWeb: false, requestedFacets: [], reason: '' }, []);
    assert.match(result!.responseText, /Рекурсия/); assert.equal(result!.dialogueJobId, undefined); assert.equal(stage.mock.callCount(), 0);
});

test('existing API clients still receive a complete synchronous answer without polling support', async t => {
    const value = classification(); value.fastReply = { mode: 'defer' }; value.details.responseComplexity = 'complex';
    const calls = foreground(t, value); const context = ctx(); context.sessionStorageKey = `api:${OWNER}`;
    const stage = t.mock.method(DialogueJobRepository, 'stage', async () => { throw new Error('No client opt-in'); });
    const result = await processMessage(context, 'Объясни рекурсию подробно', false, '', [], undefined, { fastDialogue: true });
    assert.equal(result.responseText, 'Полный синхронный ответ.'); assert.equal(calls.ai.mock.callCount(), 1); assert.equal(stage.mock.callCount(), 0);
});

test('forwarded/reply/confirmation turns and mutations cannot escape through a fast draft', async t => {
    environment(t);
    const value = ctx();
    assert.equal(canUseFastDialogue(value, { userText: 'Объясни', replyContext: { messageId: 1, text: 'Контекст', kind: 'plain' } }), false);
    value.session.pendingContactMemory = { createdAt: Date.now() } as any;
    assert.equal(canUseFastDialogue(value, { userText: 'Да' }), false);
    delete value.session.pendingContactMemory;
    assert.equal(canUseFastDialogue(value, { userText: 'Запомни, что мой любимый цвет синий' }), false);
    for (const intent of ['ОТПРАВКА_СООБЩЕНИЯ', 'НАПОМИНАНИЕ', 'БРАУЗЕР_ЗАДАЧА'] as const) {
        assert.equal(await tryFastDialogueResult(value, { userText: 'Сделай действие' }, { ...classification(), intent },
            { source: 'stable_general', requiresWeb: false, requestedFacets: [], reason: '' }, []), undefined);
    }
});

test('fast history records source text but never waits on extraction or summarization', async t => {
    const value = ctx();
    value.session.messageHistory = Array.from({ length: 18 }, (_, i) => ({ role: 'user', content: `Синтетическая реплика ${i}`, timestamp: new Date() }));
    const extract = t.mock.method(extraction, 'quickFactCheck', async () => { throw new Error('Unexpected blocking inference'); });
    const summarize = t.mock.method(summarizer, 'updateDialogueContext', async () => { throw new Error('Unexpected summary'); });
    const scheduled = t.mock.method(factAnalysisManager, 'scheduleAnalysis', () => {});
    await addToHistory(value, 'user', 'Объясни рекурсию', { deferAnalysis: true });
    await addToHistory(value, 'bot', 'Короткий ответ', { deferAnalysis: true });
    assert.equal(value.session.messageHistory[1].content, 'Объясни рекурсию'); assert.equal(value.session.messageHistory.length, 20);
    assert.equal(extract.mock.callCount(), 0); assert.equal(summarize.mock.callCount(), 0); assert.equal(scheduled.mock.callCount(), 1);
});

function job(required = false): DialogueJob {
    return { id: '73db1bab-d826-4550-8001-1d1c0b735fa2', profile: 'SyntheticBot', channel: String(OWNER), turnId: 'turn-synthetic', userId: OWNER, chatId: OWNER,
        input: { message: 'Объясни рекурсию', initialAnswer: required ? '' : 'Короткий ответ', required, classification: classification(), history: [], preset: 'gpt-balanced' },
        status: 'running', phase: required ? 'deep' : 'review', attempts: 1, lease: 'lease-synthetic', lockedAt: new Date(), announced: required,
        createdAt: new Date(), updatedAt: new Date(), expiresAt: new Date(Date.now() + 60_000) };
}
function worker(t: TestContext, value: DialogueJob) {
    environment(t);
    let stored = structuredClone(value);
    const sent: Array<{ text: string; notice: boolean }> = [];
    const repository = { ...DialogueJobRepository,
        isActive: async () => ['running', 'delivering'].includes(stored.status) && stored.lease === value.lease,
        update: async (_value: DialogueJob, patch: any) => {
            if (!['running', 'delivering'].includes(stored.status) || stored.lease !== value.lease) return false;
            Object.assign(stored, structuredClone(patch)); return true;
        },
    };
    return { repository, enabled: async () => true,
        review: async () => ({ needed: true, memoryNeed: 'full' as const, web: false }),
        deepen: async () => 'Углублённый ответ с новым выводом.',
        addition: async () => ({ material: true, answer: 'Полезное дополнение.' }),
        deliver: async (_job: DialogueJob, text: string, notice: boolean) => { sent.push({ text, notice }); },
        sent, stored: () => stored, replace: (next: DialogueJob) => { stored = next; },
    };
}

test('deep answer reuses prepared memory without paying for an unnecessary tool-planning loop', async t => {
    const value = job(true); const deps = worker(t, value);
    value.input.classification.details.responseComplexity = 'complex';
    value.input.classification.details.memoryNeed = 'full';
    const recall = t.mock.method(memory, 'fetchAgentMemoryContext', async () => ({ domain: 'personal', context: 'Синтетическое свидетельство из памяти', recalledMemories: [] }));
    const planner = t.mock.method(completion, 'createJsonChatCompletionForTask', async () => { throw new Error('Unnecessary planning inference'); });
    const answer = t.mock.method(conversation, 'conversationAgent', async (...args: any[]) => {
        assert.match(args[6].context, /Синтетическое свидетельство/);
        assert.equal(args[6].allowSideEffects, false);
        assert.equal(args[6].allowSelfEvolution, false);
        return { responseText: 'Синтетический полный ответ.' };
    });
    await executeDialogueJob({} as any, value, { ...deps, deepen: undefined });
    assert.equal(deps.stored().status, 'ready');
    assert.equal(deps.stored().resultText, 'Синтетический полный ответ.');
    assert.equal(recall.mock.callCount(), 1);
    assert.equal(answer.mock.callCount(), 1);
    assert.equal(planner.mock.callCount(), 0);
});

test('review is silent when deeper work would add no value', async t => {
    const value = job(); const deps = worker(t, value);
    deps.review = async () => ({ needed: false, memoryNeed: 'full', web: false });
    deps.deepen = async () => { throw new Error('Must not run'); };
    await executeDialogueJob({} as any, value, deps);
    assert.equal(deps.stored().status, 'completed'); assert.equal(deps.sent.length, 0); assert.equal(deps.stored().resultText, null);
});

test('useful review announces work before computing, persists result before delivering, and recovers delivery independently', async t => {
    const value = job(); const deps = worker(t, value);
    deps.deepen = async () => { assert.equal(deps.sent[0].notice, true); assert.equal(deps.stored().phase, 'deep'); assert.equal(deps.stored().input.classification.details.memoryNeed, 'full'); return 'Ответ из памяти.'; };
    await executeDialogueJob({} as any, value, deps);
    assert.equal(deps.stored().status, 'ready'); assert.equal(deps.stored().resultText, 'Полезное дополнение.'); assert.equal(deps.sent.length, 1);
    const delivery = { ...deps.stored(), status: 'delivering' as const }; deps.replace(delivery);
    await executeDialogueJob({} as any, delivery, deps);
    assert.equal(deps.stored().status, 'completed'); assert.equal(deps.sent.length, 2); assert.equal(deps.sent[1].notice, false);
});

test('new turn or cancellation during computation discards the result and cannot revive a superseded job', async t => {
    const value = job(true); const deps = worker(t, value);
    deps.deepen = async () => { deps.replace({ ...deps.stored(), status: 'superseded', lease: null }); return 'Уже устаревший ответ.'; };
    await executeDialogueJob({} as any, value, deps);
    assert.equal(deps.stored().status, 'superseded'); assert.equal(deps.stored().resultText, undefined); assert.equal(deps.sent.length, 0);
});

test('budget changes stop optional work while explicit user questions remain runnable', async t => {
    for (const required of [false, true]) {
        const value = job(required); const deps = worker(t, value); deps.enabled = async () => false;
        await executeDialogueJob({} as any, value, deps);
        assert.equal(deps.stored().status, required ? 'ready' : 'cancelled');
    }
});

test('delivery errors are unknown and are not converted into a retry', async t => {
    const value = job(true); value.status = 'delivering'; value.resultText = 'Ответ.';
    const deps = worker(t, value); deps.deliver = async () => { throw new Error('Connection lost after send'); };
    await executeDialogueJob({} as any, value, deps);
    assert.equal(deps.stored().status, 'unknown'); assert.equal(deps.stored().error, 'delivery_unknown');
});

test('optional deep answers that merely repeat the first answer are not sent', async t => {
    const value = job(); const deps = worker(t, value); deps.addition = async () => ({ material: false, answer: '' });
    await executeDialogueJob({} as any, value, deps);
    assert.equal(deps.stored().status, 'completed'); assert.equal(deps.stored().resultText, null); assert.equal(deps.sent.filter(item => !item.notice).length, 0);
});

test('API delivery stays in API history and result polling; no Telegram call is made', async t => {
    const value = job(true); value.channel = `api:${OWNER}`; value.status = 'delivering'; value.resultText = 'Ответ приложения.';
    const deps = worker(t, value); const append = t.mock.method(session, 'appendPersistedHistory', async (channel: number | string) => { assert.equal(channel, `api:${OWNER}`); });
    await executeDialogueJob({ api: { sendMessage: async () => { throw new Error('Must not leak to Telegram'); } } } as any, value,
        { repository: deps.repository, enabled: deps.enabled });
    assert.equal(deps.stored().status, 'completed'); assert.equal(append.mock.callCount(), 1);
    assert.equal('input' in publicDialogueJob(deps.stored()), false); assert.equal('userId' in publicDialogueJob(deps.stored()), false);
});

test('read-only background mode denies mutations even if the model or direct registry call requests them', async t => {
    environment(t); const value = ctx(); let mutations = 0;
    const registry = new ToolRegistry([{ name: 'memory.forget', skill: 'people-and-memory', effect: 'state', ownerOnly: true,
        description: '', inputSchema: objectSchema({}), execute: async () => { mutations++; return { status: 'ok', summary: 'Deleted' }; } }], () => true);
    const input = { ctx: value, message: 'Забудь факт', classification: classification(), messageHistory: [], isForwarded: false, forwardFrom: '', readOnly: true };
    const direct = await registry.execute('memory.forget', {}, { ...input, runId: 'run', signal: new AbortController().signal, memoryContext: '', observations: [] });
    assert.equal(direct.status, 'failed'); assert.equal(mutations, 0);
    let rounds = 0;
    await runKiraRuntime(input, { registry, forceLoop: true, persist: async () => {}, respond: async () => ({ responseText: 'Изменения запрещены.' }),
        decide: async ({ tools }) => { assert.equal(tools.length, 0); return rounds++ < 2 ? { calls: [{ id: `mutation${rounds}`, tool: 'memory.forget', args: {} }] } : { finish: true }; } });
    assert.equal(mutations, 0);
});

test('new-message lifecycle uses channel scope and an old cancel command cannot touch another channel', async t => {
    environment(t);
    const bot = new Bot<BotContext>('1234567890:abcdefghijklmnopqrstuvwxyzABCDE', { botInfo: { id: 1, is_bot: true, first_name: 'Test' } as any });
    registerDialogueLifecycle(bot);
    const begins: string[] = []; const cancels: string[] = [];
    t.mock.method(DialogueJobRepository, 'beginTurn', async (channel: string) => { begins.push(channel); });
    t.mock.method(DialogueJobRepository, 'cancel', async (channel: string) => { cancels.push(channel); return true; });
    const value = ctx(); value.sessionStorageKey = `api:${OWNER}`;
    (value.message as any).text = 'Новая реплика'; value.reply = (async () => ({})) as any;
    await bot.middleware()(value, async () => {});
    assert.deepEqual(begins, [`api:${OWNER}`]); assert.equal(value.dialogueTurnId, 'tg:567');
    (value.message as any).text = '/cancel_deep';
    await bot.middleware()(value, async () => {});
    assert.deepEqual(cancels, [`api:${OWNER}`]);
});

test('real API text handler delivers the fast response, flushes history and only then activates its captured job', async t => {
    const value = classification(); value.fastReply = { mode: 'defer' }; value.details.responseComplexity = 'complex';
    const calls = foreground(t, value);
    t.mock.method(features, 'getBackgroundFeaturePreference', async () => true);
    t.mock.method(factAnalysisManager, 'scheduleAnalysis', () => {});
    t.mock.method(DialogueJobRepository, 'beginTurn', async () => {});
    let staged: DialogueJob | undefined; let saved = false;
    t.mock.method(session.TypeORMSessionStorage.prototype, 'read', async () => undefined);
    t.mock.method(session.TypeORMSessionStorage.prototype, 'write', async (_key: string, data: any) => {
        if (data.messageHistory.some((item: any) => item.role === 'bot' && /вернусь/iu.test(item.content))) saved = true;
    });
    t.mock.method(DialogueJobRepository, 'stage', async (values: any) => {
        assert.equal(values.channel, `api:${OWNER}`); assert.equal(values.input.preset, 'gpt-balanced');
        staged = { ...job(true), ...values, status: 'staged' }; return staged;
    });
    t.mock.method(DialogueJobRepository, 'activate', async (id: string, channel: string) => {
        assert.equal(id, staged!.id); assert.equal(channel, `api:${OWNER}`); assert.equal(saved, true); staged!.status = 'queued';
    });
    t.mock.method(DialogueJobRepository, 'find', async () => staged);
    const bot = new Bot<BotContext>('1234567890:abcdefghijklmnopqrstuvwxyzABCDE', { botInfo: { id: 1, is_bot: true, first_name: 'Test', username: 'synthetic_bot' } as any });
    bot.api.config.use(async () => { throw new Error('No Telegram delivery'); });
    const backend = new BotApiBackend(bot, { ownerId: OWNER, token: 'synthetic-test-token-at-least-thirty-two-characters', host: '127.0.0.1', port: 3200 });
    const response = await backend.message('Объясни рекурсию подробно', { deferredDialogue: true });
    assert.equal(response.backgroundJob!.status, 'queued'); assert.equal(response.backgroundJob!.required, true);
    assert.ok(response.messages.some(item => /вернусь/iu.test(item.text || '')));
    assert.equal(calls.ai.mock.callCount(), 1); assert.equal(calls.recall.mock.callCount(), 0); assert.equal(calls.answer.mock.callCount(), 0);
});
