import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { Bot } from 'grammy';
import { runKiraRuntime, continueQuestionRuntime, continueConfirmedRuntime, cancelRuntimeContinuation, hasCompoundActionRequest, hasRuntimeQuestionAnswer, createKiraToolRegistry } from '../orchestration/runtime/kernel';
import { ToolRegistry, objectSchema } from '../orchestration/runtime/registry';
import { memoryConfirmationKey } from '../orchestration/runtime/confirmation';
import type { KiraRuntimeInput, RuntimeSessionState, ToolDefinition, ToolContext } from '../orchestration/runtime/types';
import { config } from '../config';
import * as persistence from '../services/SessionStorage';
import * as reminders from '../agents/reminderAgent';
import { reminderService } from '../services/ReminderService';
import { ReminderRegistry } from '../stores/ReminderRegistry';
import * as orchestrator from '../orchestrator';
import * as history from '../utils/history';
import * as reconsolidation from '../services/MemoryReconsolidationService';
import * as vector from '../services/VectorServiceFactory';
import { deleteMemoryById } from '../utils/enhancedDomainMemory';
import { BotApiBackend } from '../api/backend';
import type { BotContext } from '../types';
import * as reading from '../agents/readMessagesAgent';
import * as completion from '../ai/chatCompletion';
import { mapsAgent } from '../agents/googleMapsAgent';
import { GoogleMapsService } from '../services/googleMaps';
import { studyChatAndSaveFacts } from '../utils/studyChatPipeline';
import * as fetchChat from '../agents/fetchChatMessagesAgent';
import * as contactMemory from '../utils/contactMemory';
import * as kernel from '../orchestration/runtime/kernel';
import { registerCallback } from '../callbacks';

const originalMode = process.env.KIRA_ORCHESTRATION_MODE;
process.env.KIRA_ORCHESTRATION_MODE = 'skills';
after(() => { if (originalMode === undefined) delete process.env.KIRA_ORCHESTRATION_MODE; else process.env.KIRA_ORCHESTRATION_MODE = originalMode; });

function input(): KiraRuntimeInput {
    return { ctx: { from: { id: 101 }, chat: { id: 101, type: 'private' }, session: { reminders: [], messageHistory: [], domains: {}, dialogueSummary: '', lastSummarizedIndex: -1 } } as any,
        message: 'Синтетическая задача', isForwarded: false, forwardFrom: '', messageHistory: [], enrichedContextFromMemory: '', classification: { intent: 'ВЕБ_ПОИСК', confidenceLevel: 'ВЫСОКИЙ', details: {} } };
}
function context(value = input()): ToolContext { return { ...value, runId: 'audit-run', signal: new AbortController().signal, observations: [], memoryContext: '' }; }
function tool(name: string, effect: ToolDefinition['effect'], execute: ToolDefinition['execute'], skill = 'web-research'): ToolDefinition {
    return { name, effect, execute, skill, ownerOnly: false, description: name, inputSchema: objectSchema({}) };
}
const persist = async () => {};
const respond = async () => ({ responseText: 'Общий итог' });
function pending(id: string, key: string): RuntimeSessionState {
    return { version: 1, runId: id, status: 'waiting', goal: 'Забудь факт и напомни проверить', classification: input().classification, startedAt: Date.now(), updatedAt: Date.now(), agents: [], toolNames: [], skills: [], receipts: [],
        observations: [{ id: 'confirmation', tool: 'memory.forget', status: 'needs_input', summary: id, confirmationKey: key }], pendingCalls: [{ id: 'next', tool: 'test.next', args: {}, dependsOn: ['confirmation'] }] };
}

test('compound detection covers maintenance, files and conversation without splitting a shopping list', () => {
    for (const text of ['Создай напоминание и удали старое', 'Найди афишу и пришли картинку', 'Изучи себя и включи экономию', 'Покажи отчёт; экспортируй дневник', 'Найди расписание и расскажи про место']) assert.equal(hasCompoundActionRequest(text), true, text);
    assert.equal(hasCompoundActionRequest('Напомни купить хлеб и молоко'), false);
});

test('a reminder as the primary intent still returns the second task search result', async () => {
    const value = input(); value.message = 'Напомни завтра выбрать событие и найди афишу'; value.classification.intent = 'НАПОМИНАНИЕ'; value.classification.subIntents = [{ intent: 'ВЕБ_ПОИСК' }];
    let round = 0; let responses = 0;
    const registry = new ToolRegistry([
        tool('web.search', 'read', async () => ({ status: 'ok', summary: 'Афиша https://example.test/event', context: 'Афиша https://example.test/event' })),
        tool('test.remind', 'state', async () => ({ status: 'ok', summary: 'Напоминание сохранено', result: { responseText: 'Напоминание сохранено' } }), 'reminders'),
    ], () => true);
    const result = await runKiraRuntime(value, { registry, persist, decide: async () => round++ === 0 ? { calls: [{ id: 'search', tool: 'web.search', args: {} }, { id: 'remind', tool: 'test.remind', args: {} }] } : { finish: true },
        respond: async (_, memory) => { responses++; assert.match(memory, /example\.test/); return { responseText: 'Нашла афишу https://example.test/event' }; } });
    assert.equal(responses, 1); assert.match(result.responseText, /example\.test/); assert.match(result.responseText, /Напоминание сохранено/);
});

test('a tool parameter question resumes that call before its dependent mutation', async () => {
    const value = input(); let asks = 0; let writes = 0; let round = 0;
    const registry = new ToolRegistry([
        tool('test.ask', 'state', async (_, ctx) => {
            asks++;
            if (!ctx.continuationAnswer) return { status: 'needs_input', summary: 'Нужен город', question: 'Какой город?', result: { responseText: 'Какой город?' } };
            assert.equal(ctx.continuationAnswer, 'Казань'); return { status: 'ok', summary: 'Город подтверждён', data: { city: 'Казань' } };
        }),
        tool('test.next', 'state', async () => { writes++; return { status: 'ok', summary: 'Сохранено' }; }),
    ], () => true);
    const first = await runKiraRuntime(value, { forceLoop: true, registry, persist, respond, decide: async () => round++ === 0 ? { calls: [{ id: 'city', tool: 'test.ask', args: {} }, { id: 'write', tool: 'test.next', args: {}, dependsOn: ['city'] }] } : { finish: true } });
    assert.equal(first.operationStatus, 'needs_input'); assert.equal(value.ctx.session.agentRuntime?.question, 'Какой город?'); assert.equal(writes, 0);
    const second = await continueQuestionRuntime(value.ctx, 'Казань', { registry, persist, respond, decide: async () => ({ finish: true }) });
    assert.equal(asks, 2); assert.equal(writes, 1); assert.equal(second?.operationStatus, 'ok'); assert.equal(value.ctx.session.agentRuntime?.receipts.some(receipt => receipt.status === 'running'), false);
});

test('context compaction cannot erase a completed dependency needed by a resumed task', async () => {
    const value = input(); const previous = pending('compacted-goal', 'compacted-key'); previous.completedCalls = { earlier: 'ok' };
    previous.pendingCalls = [{ id: 'next', tool: 'test.next', args: {}, dependsOn: ['earlier'] }];
    value.ctx.session.agentRuntime = previous; let writes = 0;
    const result = await runKiraRuntime(value, { continuation: previous, registry: new ToolRegistry([tool('test.next', 'state', async () => { writes++; return { status: 'ok', summary: 'Готово' }; })], () => true), persist, respond, decide: async () => ({ finish: true }) });
    assert.equal(writes, 1); assert.equal(result.operationStatus, 'ok');
});

test('an old memory confirmation resumes exactly its goal while preserving the current waiting goal', async () => {
    const value = input(); const keyA = memoryConfirmationKey('synthetic-a', 'personal'); const keyB = memoryConfirmationKey('synthetic-b', 'personal');
    value.ctx.session.agentRuntime = pending('goal-b', keyB); value.ctx.session.agentRuntimePending = [pending('goal-a', keyA)]; let writes = 0;
    const result = await continueConfirmedRuntime(value.ctx, ['memory.forget'], 'Удалён факт A', { registry: new ToolRegistry([tool('test.next', 'state', async (_, ctx) => { writes++; assert.ok(ctx.observations.some(item => item.confirmationKey === keyA && item.status === 'ok')); return { status: 'ok', summary: 'Готово' }; })], () => true), persist, respond, decide: async () => ({ finish: true }) }, keyA);
    assert.equal(writes, 1); assert.equal(result?.operationStatus, 'ok'); assert.equal(value.ctx.session.agentRuntimePending?.[0].runId, 'goal-b'); assert.equal(value.ctx.session.agentRuntimePending?.[0].observations?.[0].status, 'needs_input');
});

test('cancelling one memory confirmation leaves other pending operations intact', async t => {
    t.mock.method(persistence, 'persistAgentRuntime', persist);
    const value = input(); const keyA = memoryConfirmationKey('synthetic-a', 'personal'); const keyB = memoryConfirmationKey('synthetic-b', 'personal');
    value.ctx.session.agentRuntime = pending('goal-b', keyB); value.ctx.session.agentRuntimePending = [pending('goal-a', keyA)];
    await cancelRuntimeContinuation(value.ctx, ['memory.forget'], keyA);
    assert.equal(value.ctx.session.agentRuntime.status, 'waiting'); assert.equal(value.ctx.session.agentRuntimePending[0].status, 'failed');
});

test('a new cancellation command is not consumed as an answer to an unrelated parameter question', () => {
    const value = input(); value.ctx.session.agentRuntime = { ...pending('question', ''), question: 'Какой город?' };
    for (const text of ['Отмени напоминание', 'Удали задачу', 'Перенеси встречу', 'Включи экономию']) assert.equal(hasRuntimeQuestionAnswer(value.ctx, text), false, text);
    assert.equal(hasRuntimeQuestionAnswer(value.ctx, 'Казань'), true); assert.equal(hasRuntimeQuestionAnswer(value.ctx, 'отмена'), true);
});

test('large reminder lists retain real IDs, pagination and a filter for later mutations', async t => {
    const owner = config.allowedUserId; config.allowedUserId = 101;
    const records = Array.from({ length: 80 }, (_, i) => ({ id: `synthetic-${i}`, text: `${i === 79 ? 'Искомое' : 'Обычное'} напоминание ${i} ${'текст '.repeat(250)}`, dueDate: new Date('2099-01-01T10:00:00Z') }));
    t.mock.method(ReminderRegistry.getInstance(), 'getActiveByChatId', () => records as any);
    try {
        const registry = createKiraToolRegistry(); const page = await registry.execute('reminders.list', {}, context());
        const data = page.data as any; assert.ok(data.items.length > 0); assert.ok(data.items[0].id); assert.ok(data.nextOffset); assert.ok(JSON.stringify(data).length < 12_000);
        const filtered = await registry.execute('reminders.list', { query: 'Искомое' }, context());
        assert.equal((filtered.data as any).items[0].id, 'synthetic-79'); assert.equal((filtered.data as any).total, 1);
    } finally { config.allowedUserId = owner; }
});

test('a partially committed reminder batch does not authorize dependent steps as a full success', async t => {
    const owner = config.allowedUserId; config.allowedUserId = 101;
    const details = ['one', 'two'].map(id => ({ id, text: `Синтетическая задача ${id}`, dueDate: new Date('2099-01-01T10:00:00Z') }));
    t.mock.method(reminders, 'reminderAgent', async () => ({ responseText: '', reminderCreated: true, reminderDetailsList: details }));
    t.mock.method(reminderService, 'createReminder', async (_ctx: any, detail: any) => { if (detail.id === 'two') throw new Error('Synthetic failed save'); return { ...detail, chatId: 101 }; });
    try {
        const result = await createKiraToolRegistry().execute('reminders.request', { request: 'Напомни две синтетические задачи' }, context());
        assert.equal(result.status, 'unknown'); assert.equal(result.result?.reminderDetailsList?.length, 1); assert.equal(result.result?.remindersPersisted, true); assert.match(result.summary, /Автоматический повтор остановлен/);
    } finally { config.allowedUserId = owner; }
});

test('unavailable memory storage cannot acknowledge deletion or resume dependent actions', async t => {
    t.mock.method(vector, 'getVectorService', () => null as any);
    await assert.rejects(deleteMemoryById(input().ctx, 'synthetic-memory', 'personal'), /не подтверждено/);
});

test('the actual API handler chain routes a compound memory request into orchestration', async t => {
    const owner = config.allowedUserId; config.allowedUserId = 101;
    t.mock.method(persistence.TypeORMSessionStorage.prototype, 'read', async () => undefined);
    t.mock.method(persistence.TypeORMSessionStorage.prototype, 'write', async () => {});
    t.mock.method(history, 'addToHistory', async () => {});
    t.mock.method(reconsolidation, 'reconsolidateAfterResponse', async () => {});
    const process = t.mock.method(orchestrator, 'processMessage', async (_ctx: any, message: string) => { assert.equal(message, 'Забудь старый синтетический факт и напомни проверить'); return { responseText: 'Составной запрос дошёл до ядра', skipOptionalFollowups: true }; });
    const bot = new Bot<BotContext>('1234567890:abcdefghijklmnopqrstuvwxyzABCDE', { botInfo: { id: 1234567890, is_bot: true, first_name: 'Synthetic', username: 'synthetic_bot' } as any });
    try {
        const backend = new BotApiBackend(bot, { token: 'synthetic-audit-api-token-1234567890123456789012', ownerId: 101, host: '127.0.0.1', port: 3200 });
        const result = await backend.message('Забудь старый синтетический факт и напомни проверить');
        assert.equal(process.mock.callCount(), 1); assert.ok(result.messages.some(item => item.text === 'Составной запрос дошёл до ядра'));
    } finally { config.allowedUserId = owner; }
});

test('Telegram reading uses its typed tool arguments rather than the primary unrelated intent details', async t => {
    const owner = config.allowedUserId; config.allowedUserId = 101;
    const reader = t.mock.method(reading, 'readMessagesAgent', async (...args: any[]) => {
        assert.equal(args[5].intent, 'ПРОВЕРКА_СООБЩЕНИЙ'); assert.equal(args[5].details.messagesCheckType, 'ANALYZE_CONVERSATION');
        assert.equal(args[5].details.contactQuery, 'Контакт Сигма'); assert.equal(args[5].details.saveFactsAboutUser, false);
        assert.equal(args[5].details.reminderAction, undefined); return { responseText: 'Анализ переписки', operationStatus: 'ok' } as const;
    });
    try {
        const value = context(); value.classification.intent = 'НАПОМИНАНИЕ'; value.classification.details.reminderAction = 'cancel';
        const result = await createKiraToolRegistry().execute('telegram.readMessages', { request: 'Что обсуждали?', mode: 'conversation', contactQuery: 'Контакт Сигма' }, value);
        assert.equal(result.status, 'ok'); assert.equal(reader.mock.callCount(), 1);
    } finally { config.allowedUserId = owner; }
});

test('maps distinguish missing parameters, failed retrieval and failed request parsing', async t => {
    const model = t.mock.method(completion, 'createChatCompletionForTask', async () => ({ choices: [{ message: { content: JSON.stringify({ queryType: 'directions' }) } }] }) as any);
    const directions = t.mock.method(GoogleMapsService.prototype, 'getDirections', async () => null);
    const missing = await mapsAgent('Построй маршрут'); assert.equal(missing.operationStatus, 'needs_input'); assert.ok(missing.clarificationQuestion); assert.equal(directions.mock.callCount(), 0);
    model.mock.mockImplementation(async () => ({ choices: [{ message: { content: JSON.stringify({ queryType: 'directions', origin: 'Точка А', destination: 'Точка Б' }) } }] }) as any);
    assert.equal((await mapsAgent('Маршрут из точки А в точку Б')).operationStatus, 'failed');
    model.mock.mockImplementation(async () => { throw new Error('Synthetic provider failure'); });
    assert.equal((await mapsAgent('Построй маршрут')).operationStatus, 'failed');
});

test('failed chat study cannot masquerade as a completed delegated task', async t => {
    t.mock.method(fetchChat, 'runFetchChatMessagesAgent', async () => ({ error: 'Синтетическая ошибка загрузки' }));
    const value = context(); value.ctx.suppressAgentProgress = true;
    const result = await studyChatAndSaveFacts(value.ctx, 'Контакт Сигма', 202, 'week');
    assert.equal(result.operationStatus, 'failed'); assert.equal(result.savedCount, 0);
});

test('contact identity confirmation resumes its parent only on an acknowledged save', async t => {
    const value = input(); value.ctx.session.pendingContactMemory = { createdAt: 1000 } as any;
    const memoryCallback = t.mock.method(contactMemory, 'handleContactMemoryCallback', async (_ctx: any, _data: string, onSaved?: (summary: string) => void) => { onSaved?.('Подтверждённый факт'); return true; });
    const resumed = t.mock.method(kernel, 'continueConfirmedRuntime', async (_ctx: any, names: string[], summary: string, _deps: any, key?: string) => { assert.deepEqual(names, ['memory.rememberContact', 'telegram.readMessages', 'agents.start']); assert.equal(key, 'cmem:1000'); assert.equal(summary, 'Подтверждённый факт'); return undefined; });
    const bot = new Bot<BotContext>('1234567890:abcdefghijklmnopqrstuvwxyzABCDE', { botInfo: { id: 1234567890, is_bot: true, first_name: 'Synthetic', username: 'synthetic_bot' } as any });
    bot.use(async (ctx, next) => { ctx.session = value.ctx.session; await next(); }); registerCallback(bot);
    const update = { update_id: 101, callback_query: { id: 'synthetic-callback', from: { id: 101, is_bot: false, first_name: 'Synthetic' }, data: 'cmem:202', message: { message_id: 1, date: 1, chat: { id: 101, type: 'private', first_name: 'Synthetic' } } } } as any;
    await bot.handleUpdate(update); assert.equal(resumed.mock.callCount(), 1);
    memoryCallback.mock.mockImplementation(async () => true);
    await bot.handleUpdate({ ...update, update_id: 102 }); assert.equal(resumed.mock.callCount(), 1);
});
