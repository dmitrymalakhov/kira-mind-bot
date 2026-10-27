import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Bot } from 'grammy';
import type { BotContext, SessionData } from '../types';
import type { RecurringTask } from '../types/recurringTaskTypes';
import type { RuntimeSessionState } from '../orchestration/runtime/types';
import { executeRecurringTask } from '../services/recurringTaskScheduler';
import { RecurringTaskRepository } from '../services/RecurringTaskRepository';
import * as persistence from '../services/SessionStorage';
import { AppDataSource } from '../data-source';
import * as orchestrator from '../orchestrator';
import { runKiraRuntime, continueQuestionRuntime } from '../orchestration/runtime/kernel';

const token = '1234567890:abcdefghijklmnopqrstuvwxyzABCDE';
function session(): SessionData { return { reminders: [], messageHistory: [], dialogueSummary: '', lastSummarizedIndex: -1, domains: {} }; }
function state(id: string): RuntimeSessionState { return { version: 1, runId: id, status: 'waiting', goal: 'Синтетическая задача', startedAt: Date.now(), updatedAt: Date.now(), receipts: [], agents: [], skills: [], toolNames: [] }; }
function task(): RecurringTask { return { id: 'synthetic-task', profile: 'KiraMindBot', chatId: 101, userId: 101, chatType: 'private', title: 'Синтетическая проверка', prompt: 'Проверь синтетические события', schedule: { type: 'interval', intervalMinutes: 60, anchorDate: '2099-01-01' }, timezone: 'Europe/Moscow', status: 'active', nextRunAt: new Date('2099-01-01T00:00:00Z'), createdAt: new Date(), updatedAt: new Date(), consecutiveFailures: 0, runCount: 0 }; }
function bot(calls: string[]) {
    const value = new Bot<BotContext>(token, { botInfo: { id: 1234567890, is_bot: true, first_name: 'Synthetic', username: 'synthetic_bot' } as any });
    value.api.config.use(async (_previous, method) => { calls.push(method); return { ok: true, result: { message_id: calls.length, date: 1, chat: { id: 101, type: 'private' } } } as any; });
    return value;
}
function repo() {
    const rows = new Map<string, any>();
    return { rows, findOne: async ({ where }: any) => rows.get(where.key) ?? null, upsert: async (row: any) => { rows.set(row.key, JSON.parse(JSON.stringify(row))); } };
}

test('background write-ahead and domain persistence cannot overwrite the interactive session', async t => {
    const database = repo(); t.mock.method(AppDataSource, 'getRepository', (() => database) as any);
    const storage = new persistence.TypeORMSessionStorage(true);
    const interactive = session(); interactive.agentRuntime = state('interactive'); await storage.write('101', interactive);
    const background = session(); background.agentRuntime = state('background');
    const ctx = { chat: { id: 101, type: 'private' }, from: { id: 101 }, session: background, agentRuntimeStorageKey: 'task:101:synthetic-task' } as any;
    await persistence.persistAgentRuntime(ctx); await persistence.persistSessionNow(ctx);
    assert.equal((await storage.read('101'))?.agentRuntime?.runId, 'interactive');
    assert.equal((await storage.read(ctx.agentRuntimeStorageKey))?.agentRuntime?.runId, 'background');
    // A task-ledger write must not replace the per-channel delta snapshot used by the next middleware flush.
    const resumed = { ...session(), ...await storage.read('101') };
    resumed.agentRuntime = { ...state('confirmed-continuation'), status: 'completed' };
    await persistence.persistAgentRuntime({ ...ctx, session: resumed });
    await storage.write('101', resumed);
    assert.equal((await storage.read('101'))?.agentRuntime?.runId, 'confirmed-continuation');
});

test('scheduler respects typed failures, pauses unknown/waiting outcomes immediately and retains partial artifacts', async t => {
    const active = state('interactive'); const oldRun = state('previous-task-run'); const calls: string[] = [];
    const savedImages: string[] = [];
    t.mock.method(persistence, 'appendPersistedHistory', async (...[_id, _role, text, options]: Parameters<typeof persistence.appendPersistedHistory>) => { assert.equal(options?.kind, 'image'); savedImages.push(text); });
    const savedContexts = t.mock.method(persistence, 'appendPersistedSentMessageContext', async () => {});
    t.mock.method(persistence.TypeORMSessionStorage.prototype, 'read', async (key: string) => ({ ...session(), agentRuntime: key.startsWith('task:') ? oldRun : active, pendingBrowserTask: { originalTask: 'Активный интерактивный браузер' } } as any));
    t.mock.method(persistence, 'mergePersistedBackgroundContinuation', async () => {});
    const complete = t.mock.method(RecurringTaskRepository, 'completeRun', async () => undefined as any);
    const failed = t.mock.method(RecurringTaskRepository, 'failRun', async () => undefined as any);
    let status: 'failed' | 'unknown' | 'needs_input' = 'failed';
    const processing = t.mock.method(orchestrator, 'processMessage', async (ctx: any) => {
        assert.equal(ctx.agentRuntimeStorageKey, 'task:101:synthetic-task'); assert.equal(ctx.session.agentRuntime.runId, oldRun.runId);
        assert.equal(ctx.agentRuntimeRequestKey, 'synthetic-task:2099-01-01T00:00:00.000Z'); assert.equal(ctx.session.pendingBrowserTask, undefined);
        assert.equal(ctx.sessionStorageKey, undefined);
        return { responseText: 'Часть синтетической задачи не завершена', operationStatus: status, artifacts: [{ kind: 'image' as const, url: 'https://example.test/one.png' }, { kind: 'image' as const, url: 'https://example.test/two.png' }] };
    });
    for (status of ['failed', 'unknown', 'needs_input'] as const) await executeRecurringTask(bot(calls), task());
    assert.equal(processing.mock.callCount(), 3); assert.equal(complete.mock.callCount(), 0); assert.equal(failed.mock.callCount(), 3);
    assert.deepEqual(failed.mock.calls.map(call => call.arguments[1]!.pauseAfterFailure), [false, true, true]);
    assert.equal(calls.filter(method => method === 'sendPhoto').length, 6);
    assert.equal(savedImages.length, 6);
    assert.equal(savedContexts.mock.callCount(), 6);
});

test('successful scheduled compound output delivers every artifact before acknowledging completion', async t => {
    const calls: string[] = [];
    t.mock.method(persistence.TypeORMSessionStorage.prototype, 'read', async () => undefined);
    t.mock.method(persistence, 'mergePersistedBackgroundContinuation', async () => {});
    t.mock.method(persistence, 'appendPersistedHistory', async () => {}); t.mock.method(persistence, 'appendPersistedSentMessageContext', async () => {});
    t.mock.method(orchestrator, 'processMessage', async () => ({ responseText: 'Два синтетических изображения', operationStatus: 'ok', artifacts: [{ kind: 'image', url: 'https://example.test/one.png' }, { kind: 'image', url: 'https://example.test/two.png' }] }));
    const complete = t.mock.method(RecurringTaskRepository, 'completeRun', async () => { assert.equal(calls.filter(method => method === 'sendPhoto').length, 2); return undefined as any; });
    const failed = t.mock.method(RecurringTaskRepository, 'failRun', async () => undefined as any);
    await executeRecurringTask(bot(calls), task()); assert.equal(complete.mock.callCount(), 1); assert.equal(failed.mock.callCount(), 0);
});

test('background waiting state merges without replacing active interaction and a reply selects the matching goal', async t => {
    const database = repo(); t.mock.method(AppDataSource, 'getRepository', (() => database) as any);
    const storage = new persistence.TypeORMSessionStorage(true); const interactive = session(); interactive.agentRuntime = state('interactive');
    await storage.write('101', interactive);
    const background = session(); background.agentRuntime = { ...state('background'), question: 'Какой город для фоновой задачи?', ledgerKey: 'task:101:synthetic-task', backgroundRun: true, classification: { intent: 'ВЕБ_ПОИСК', confidenceLevel: 'ВЫСОКИЙ', details: {} }, observations: [{ id: 'q', tool: 'kernel.question', status: 'needs_input', summary: 'Какой город для фоновой задачи?' }] };
    await persistence.mergePersistedBackgroundContinuation(101, background, Date.now());
    const restored = await storage.read('101'); assert.equal(restored?.agentRuntime?.runId, 'interactive'); assert.equal(restored?.agentRuntimePending?.[0].runId, 'background');
    const ctx = { chat: { id: 101, type: 'private' }, from: { id: 101 }, session: { ...session(), ...restored } } as any;
    let persistedLedger: string | undefined;
    const result = await continueQuestionRuntime(ctx, 'Казань', { decide: async ({ context }) => { assert.equal(context.recurringTaskRun, true); return { finish: true }; }, persist: async context => { persistedLedger = context.ctx.agentRuntimeStorageKey; }, respond: async () => ({ responseText: 'Ответ с городом' }) }, 'Какой город для фоновой задачи?');
    assert.equal(result?.operationStatus, 'ok'); assert.equal(persistedLedger, 'task:101:synthetic-task'); assert.equal(ctx.session.agentRuntimePending[0].runId, 'interactive');
});

test('redelivery of the same scheduled run cannot repeat an uncertain mutation', async () => {
    const value = session(); value.agentRuntime = { ...state('unknown-task-run'), status: 'failed', requestKey: 'synthetic-task:2099-01-01T00:00:00.000Z', receipts: [{ key: 'synthetic-key', tool: 'reminders.create', status: 'unknown' }] };
    const ctx = { chat: { id: 101, type: 'private' }, from: { id: 101 }, session: value, agentRuntimeStorageKey: 'task:101:synthetic-task', agentRuntimeRequestKey: value.agentRuntime.requestKey } as any;
    const result = await runKiraRuntime({ ctx, message: 'Напомни синтетическую задачу', classification: { intent: 'НАПОМИНАНИЕ', confidenceLevel: 'ВЫСОКИЙ', details: {} }, isForwarded: false, forwardFrom: '', messageHistory: [], recurringTaskRun: true }, { forceLoop: true, decide: async () => { throw new Error('The controller must not replay an uncertain mutation'); }, persist: async () => {} });
    assert.equal(result.operationStatus, 'unknown');
});

test('background identity clarification is persisted with its runtime and cannot replace an active clarification', async t => {
    const database = repo(); t.mock.method(AppDataSource, 'getRepository', (() => database) as any);
    const storage = new persistence.TypeORMSessionStorage(true); const owner = session();
    await storage.write('101', owner);
    const background = session(); background.agentRuntime = state('background');
    background.pendingContactMemory = { confirmationId: 'background-fact', createdAt: Date.now(), candidateIds: [202] } as any;
    await persistence.mergePersistedBackgroundContinuation(101, background, Date.now());
    assert.equal((await storage.read('101'))?.pendingContactMemory?.confirmationId, 'background-fact');
    const other = { ...background, pendingContactMemory: { ...background.pendingContactMemory!, confirmationId: 'other-fact' } };
    await assert.rejects(persistence.mergePersistedBackgroundContinuation(101, other, Date.now()), persistence.BackgroundContinuationConflictError);
    assert.equal((await storage.read('101'))?.pendingContactMemory?.confirmationId, 'background-fact');
});

test('a background clarification conflict pauses immediately and still delivers partial artifacts', async t => {
    t.mock.method(persistence, 'appendPersistedHistory', async () => {});
    t.mock.method(persistence, 'appendPersistedSentMessageContext', async () => {});
    const calls: string[] = [];
    t.mock.method(persistence.TypeORMSessionStorage.prototype, 'read', async () => undefined);
    t.mock.method(orchestrator, 'processMessage', async () => ({ responseText: 'Часть работы готова', operationStatus: 'needs_input', artifacts: [{ kind: 'image', url: 'https://example.test/partial.png' }] }));
    t.mock.method(persistence, 'mergePersistedBackgroundContinuation', async () => { throw new persistence.BackgroundContinuationConflictError(); });
    const failed = t.mock.method(RecurringTaskRepository, 'failRun', async (...[_id, run]: Parameters<typeof RecurringTaskRepository.failRun>) => { assert.equal(run.pauseAfterFailure, true); assert.match(run.error, /другое уточнение/); return undefined as any; });
    const complete = t.mock.method(RecurringTaskRepository, 'completeRun', async () => undefined as any);
    await executeRecurringTask(bot(calls), task());
    assert.equal(failed.mock.callCount(), 1); assert.equal(complete.mock.callCount(), 0); assert.equal(calls.filter(method => method === 'sendPhoto').length, 1);
});
