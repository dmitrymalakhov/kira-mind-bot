import assert from 'node:assert/strict';
import { test, TestContext } from 'node:test';
import { Bot } from 'grammy';
import { config } from '../config';
import { BotApiBackend } from '../api/backend';
import type { BotContext, SessionData } from '../types';
import { TypeORMSessionStorage } from '../services/SessionStorage';
import * as sessions from '../services/SessionStorage';
import * as history from '../utils/history';
import * as completion from '../ai/chatCompletion';
import * as memory from '../utils/agentMemoryContext';
import * as conversation from '../agents/conversationAgent';
import * as reconsolidation from '../services/MemoryReconsolidationService';
import { ChatGroupRepository } from '../services/ChatGroupRepository';
import { DialogueJobRepository } from '../services/DialogueJobRepository';
import { registerDialogueLifecycle } from '../services/dialogueJobs';
import { registerTextMessageHandler } from '../handlers/textMessages';
import * as shared from '../handlers/shared';
import { llmCache } from '../utils/llmCache';
import { PgWorkoutStore } from '../services/workouts/store';
import { WorkoutService } from '../services/workouts/service';
import { getActiveBotProfile } from '../utils/botIdentity';
import { MemoryWorkoutStore, registered, syncInput, evt } from './helpers/workouts';
import { createKiraToolRegistry, runKiraRuntime } from '../orchestration/runtime/kernel';
import { availableRuntimeTools, needsRuntimeTools } from '../orchestration/runtime/authorization';
import type { KiraRuntimeInput, ToolContext } from '../orchestration/runtime/types';

const owner = 739502;
function fixture(t: TestContext, channel: 'app' | 'telegram') {
    const old = { owner: config.allowedUserId, mode: process.env.KIRA_ORCHESTRATION_MODE, decisions: process.env.KIRA_DECISIONS_ENABLED, fast: process.env.KIRA_FAST_DIALOGUE_ENABLED };
    config.allowedUserId = owner; process.env.KIRA_ORCHESTRATION_MODE = 'skills'; delete process.env.KIRA_DECISIONS_ENABLED; process.env.KIRA_FAST_DIALOGUE_ENABLED = 'false';
    t.after(() => {
        config.allowedUserId = old.owner;
        for (const [key, value] of [['KIRA_ORCHESTRATION_MODE', old.mode], ['KIRA_DECISIONS_ENABLED', old.decisions], ['KIRA_FAST_DIALOGUE_ENABLED', old.fast]]) {
            if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
        }
    });
    const store = new MemoryWorkoutStore(), service = new WorkoutService(store, { profile: getActiveBotProfile(), ownerId: owner });
    t.mock.method(PgWorkoutStore.prototype, 'transaction', function(scope: any, work: any) { return store.transaction(scope, work); });
    const rows = new Map<string, SessionData>();
    t.mock.method(TypeORMSessionStorage.prototype, 'read', async (key: string) => structuredClone(rows.get(key)));
    t.mock.method(TypeORMSessionStorage.prototype, 'write', async (key: string, value: SessionData) => { rows.set(key, structuredClone(value)); });
    t.mock.method(sessions, 'persistAgentRuntime', async () => {});
    t.mock.method(llmCache, 'get', () => undefined);
    t.mock.method(history, 'addToHistory', async (ctx: BotContext, role: string, content: string) => { ctx.session.messageHistory.unshift({ role, content, timestamp: new Date() }); });
    t.mock.method(reconsolidation, 'reconsolidateAfterResponse', async () => {});
    t.mock.method(DialogueJobRepository, 'beginTurn', async () => {});
    t.mock.method(ChatGroupRepository, 'findAll', async () => []);
    t.mock.method(memory, 'fetchAgentMemoryContext', async () => ({ domain: 'personal', context: '', recalledMemories: [] }));
    let access = 'write', planning: (request: any) => any = () => ({ finish: true });
    const classifier = t.mock.method(completion, 'createJsonChatCompletionForTask', async (task: string, request: any) => {
        if (task === 'runtimePlanning') return planning(JSON.parse(request.messages[1].content));
        assert.equal(task, 'intentClassification');
        return { intent: access === 'none' ? 'РАЗГОВОР' : 'ЗДОРОВЬЕ', confidenceLevel: 'ВЫСОКИЙ', details: { workoutAccess: access, memoryNeed: 'none', memoryTask: 'none' }, fastReply: { mode: 'route' } };
    });
    t.mock.method(conversation, 'conversationAgent', async (...args: any[]) => {
        const context = args[6].context;
        return { responseText: context.includes('activeDurationMs') ? 'По сохранённым результатам тренировка завершена; активное время — 60 секунд.' : 'Продолжай тренировку.', skipOptionalFollowups: true };
    });
    const bot = new Bot<BotContext>('1234567890:abcdefghijklmnopqrstuvwxyzABCDE', { botInfo: { id: 1234567890, is_bot: true, first_name: 'Synthetic', username: 'synthetic_bot' } as any });
    let updateId = 8000; const delivered: string[] = [];
    bot.api.config.use(async (_previous, method, payload: any) => {
        assert.equal(channel, 'telegram', 'app workout must not send Telegram messages');
        if (method === 'sendMessage') {
            delivered.push(payload.text); return { ok: true, result: { message_id: ++updateId, date: 0, chat: { id: owner, type: 'private' }, text: payload.text } } as any;
        }
        assert.equal(method, 'sendChatAction'); return { ok: true, result: true } as any;
    });
    if (channel === 'telegram') {
        t.mock.method(shared, 'shouldRunProactiveHint', () => false);
        bot.use(async (ctx, next) => {
            const key = String(ctx.chat!.id); ctx.sessionStorageKey = key;
            ctx.session = structuredClone(rows.get(key)) ?? { messageHistory: [], reminders: [], domains: {}, dialogueSummary: '', lastSummarizedIndex: -1 } as SessionData;
            await next(); rows.set(key, structuredClone(ctx.session));
        });
        registerDialogueLifecycle(bot); registerTextMessageHandler(bot, { immediate: true });
    }
    async function send(text: string) {
        if (channel === 'app') {
            const backend = new BotApiBackend(bot, { token: 'synthetic-workout-mobile-token-at-least-32', ownerId: owner, host: '127.0.0.1', port: 0 },
                { read: async () => ({ preset: 'gpt-lean', revision: 'synthetic' }) } as any);
            return (await backend.message(text)).messages.map(m => m.text ?? '').join('\n');
        }
        const start = delivered.length;
        await bot.handleUpdate({ update_id: ++updateId, message: { message_id: updateId, date: Math.floor(Date.now() / 1000),
            from: { id: owner, is_bot: false, first_name: 'Synthetic' }, chat: { id: owner, type: 'private', first_name: 'Synthetic' }, text } });
        return delivered.slice(start).join('\n');
    }
    return { service, store, rows, send, classifier, setAccess: (value: string) => { access = value; }, setPlanning: (value: typeof planning) => { planning = value; } };
}

for (const channel of ['app', 'telegram'] as const) test(channel + ': real text handlers and processMessage queue a command, accept device completion and read stored results', async t => {
    const f = fixture(t, channel), d = await registered(f.service), input = syncInput(d);
    await f.service.syncWorkout(input);
    f.setPlanning(({ observations }) => !observations.some((o: any) => o.tool === 'workouts.context') ? { calls: [{ id: 'context', tool: 'workouts.context', args: {} }] }
        : !observations.some((o: any) => o.tool === 'workouts.command') ? { calls: [{ id: 'finish', tool: 'workouts.command', args: { action: 'finish' } }] } : { finish: true });
    const pending = await f.send('Кира, заверши мою текущую тренировку');
    assert.match(pending, /Ожидаю подтверждения/);
    assert.doesNotMatch(pending, /тренировка завершена/i);
    assert.equal((await f.service.detail(input.workoutId)).workout.state, 'running');
    const binding = { deviceId: d.id, bindingId: d.bindingId }, command = (await f.service.pollCommands(binding)).commands[0];
    await f.service.claimCommand(command.id, binding);
    const finished = evt(2, 'finished', 60000, {}, command.id);
    await f.service.syncWorkout({ ...input, events: [finished] });
    await f.service.commandResult(command.id, { ...binding, status: 'applied', eventId: finished.eventId, seq: 2 });
    f.setAccess('read');
    f.setPlanning(({ observations }) => observations.some((o: any) => o.tool === 'workouts.get') ? { finish: true }
        : { calls: [{ id: 'results', tool: 'workouts.get', args: { id: input.workoutId } }] });
    assert.match(await f.send('Покажи результат завершённой тренировки'), /60 секунд/);
    assert.equal((await f.service.history({})).workouts.length, 1);
    assert.equal(f.classifier.mock.calls.filter(call => call.arguments[0] === 'intentClassification').length, 2);
});

test('workout reads force structured tools; read access cannot authorize commands, and tools remain private', async t => {
    const f = fixture(t, 'app'), registry = createKiraToolRegistry();
    const input: KiraRuntimeInput = { ctx: { from: { id: owner }, chat: { id: owner, type: 'private' },
        session: { messageHistory: [], reminders: [], domains: {}, dialogueSummary: '', lastSummarizedIndex: -1 } } as any,
        message: 'Какой был пульс последней тренировки?', isForwarded: false, forwardFrom: '', messageHistory: [],
        classification: { intent: 'РАЗГОВОР', confidenceLevel: 'ВЫСОКИЙ', details: { workoutAccess: 'read', memoryTask: 'none', memoryNeed: 'none' } } };
    assert.equal(needsRuntimeTools(input), true);
    const context: ToolContext = { ...input, runId: 'synthetic-workout', signal: new AbortController().signal, memoryContext: '', observations: [] };
    assert.ok(!availableRuntimeTools(registry.available(context), context).some(tool => tool.name === 'workouts.command'));
    const group = { ...context, ctx: { ...context.ctx, chat: { id: -739502, type: 'group' } } as any };
    assert.equal((await registry.execute('workouts.context', {}, group)).status, 'failed');
    const other = { ...context, ctx: { ...context.ctx, from: { id: owner + 1 } } as any };
    assert.equal((await registry.execute('workouts.history', {}, other)).status, 'failed');
    const result = await runKiraRuntime(input, { persist: async () => {}, decide: async () => ({ finish: true }), respond: async () => ({ responseText: 'Нет синхронизированных данных.' }) });
    assert.match(result.responseText, /Нет синхронизированных/);
});

test('app: a requested personal training plan reaches structured storage through the real message entry', async t => {
    const f = fixture(t, 'app');
    f.setPlanning(({ observations }) => observations.some((o: any) => o.tool === 'workouts.savePlan') ? { finish: true } : {
        calls: [{ id: 'plan', tool: 'workouts.savePlan', args: { title: 'Синтетическая домашняя тренировка', activityType: 'strength', kind: 'plan',
            steps: [{ title: 'Разминка', durationMs: 300000 }, { title: 'Синтетическое упражнение', sets: 3, repetitions: 8, restMs: 90000 }] } }],
    });
    const reply = await f.send('Подготовь для меня домашнюю тренировку без оборудования');
    assert.match(reply, /План.*сохранён/);
    const plans = (await f.service.plans()).plans;
    assert.equal(plans.length, 1);
    assert.equal(plans[0].steps.length, 2);
    assert.equal(f.classifier.mock.calls.filter(call => call.arguments[0] === 'intentClassification').length, 1);
});

