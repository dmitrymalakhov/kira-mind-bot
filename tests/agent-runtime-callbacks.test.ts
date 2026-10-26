import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { Bot } from 'grammy';
import type { BotContext, SessionData } from '../types';
import type { ToolContext, RuntimeSessionState } from '../orchestration/runtime/types';
import * as reading from '../agents/readMessagesAgent';
import * as telegram from '../services/telegram';
import * as completion from '../ai/chatCompletion';
import * as study from '../utils/studyChatPipeline';
import * as studyFlow from '../utils/studyChatFlow';
import * as persistence from '../services/SessionStorage';
import * as kernel from '../orchestration/runtime/kernel';
import * as contactMemory from '../utils/contactMemory';
import * as shared from '../handlers/shared';
import { ContactsStore } from '../stores/ContactsStore';
import { MessageStore } from '../stores/MessageStore';
import { domainTools } from '../orchestration/runtime/domainTools';
import { agentTools } from '../orchestration/runtime/agents';
import { contactMemoryConfirmationKey, CONTACT_MEMORY_PARENT_TOOLS } from '../orchestration/runtime/confirmation';
import { ToolRegistry, objectSchema } from '../orchestration/runtime/registry';
import { registerCallback } from '../callbacks';

const originalMode = process.env.KIRA_ORCHESTRATION_MODE;
process.env.KIRA_ORCHESTRATION_MODE = 'skills';
after(() => { if (originalMode === undefined) delete process.env.KIRA_ORCHESTRATION_MODE; else process.env.KIRA_ORCHESTRATION_MODE = originalMode; });
const session = (): SessionData => ({ reminders: [], messageHistory: [], dialogueSummary: '', lastSummarizedIndex: -1, domains: {} });
function ctx(): BotContext { return { from: { id: 101 }, chat: { id: 101, type: 'private' }, session: session(), suppressAgentProgress: true } as any; }
function state(key: string): RuntimeSessionState {
    return { version: 1, runId: 'synthetic-run', goal: 'Проанализируй чат и напомни проверить', status: 'waiting', startedAt: Date.now(), updatedAt: Date.now(), agents: [], skills: [], toolNames: [], receipts: [],
        observations: [{ id: 'read', tool: 'telegram.readMessages', status: 'needs_input', summary: 'Выбор периода', confirmationKey: key }],
        pendingCalls: [{ id: 'next', tool: 'test.next', args: {}, dependsOn: ['read'] }] };
}
function context(value: BotContext): ToolContext { return { ctx: value, message: 'Изучи синтетическую переписку', isForwarded: false, forwardFrom: '', messageHistory: [], classification: { intent: 'ПРОВЕРКА_СООБЩЕНИЙ', confidenceLevel: 'ВЫСОКИЙ', details: {} }, memoryContext: '', runId: 'synthetic-run', signal: new AbortController().signal, observations: [] }; }
function request(value: BotContext) {
    value.session.chatAnalysisPeriodRequest = { requestId: 'synthetic-request', groupNames: ['Группа Сигма'], displayName: 'Группа Сигма', analysisQuery: 'Составь сводку', step: 'period', createdAt: Date.now(), expiresAt: Date.now() + 60_000 };
}
function callbackBot(value: BotContext) {
    const bot = new Bot<BotContext>('1234567890:abcdefghijklmnopqrstuvwxyzABCDE', { botInfo: { id: 1234567890, is_bot: true, first_name: 'Synthetic', username: 'synthetic_bot' } as any });
    bot.api.config.use(async () => ({ ok: true, result: { message_id: 1, date: 1, chat: { id: 101, type: 'private' } } }) as any);
    bot.use(async (current, next) => { current.session = value.session; await next(); }); registerCallback(bot);
    return async (data: string, updateId = 101) => bot.handleUpdate({ update_id: updateId, callback_query: { id: `synthetic-${updateId}`, from: { id: 101, is_bot: false, first_name: 'Synthetic' }, data, message: { message_id: 1, date: 1, chat: { id: 101, type: 'private' } } } } as any);
}

test('Telegram connection and summary provider failures remain typed across legacy string adapters', async t => {
    t.mock.method(ContactsStore.getInstance(), 'searchContactsByName', () => [{ id: 202, firstName: 'Контакт Сигма' }] as any);
    t.mock.method(telegram, 'initTelegramClient', async () => null);
    assert.equal((await reading.getAnswerFromMessagesResult('Контакт Сигма', 'Что нового?')).operationStatus, 'failed');
    assert.match((await reading.getAnswerFromMessages('Контакт Сигма', 'Что нового?'))!, /подключиться/);
    t.mock.method(MessageStore.getInstance(), 'getRecentMessages', () => [{ messages: [{ text: 'Синтетическое сообщение', senderName: 'Контакт Сигма' }] }] as any);
    t.mock.method(completion, 'createChatCompletionForTask', async () => { throw new Error('Synthetic provider failure'); });
    assert.equal((await reading.getMessagesSummaryResult()).operationStatus, 'failed');
    const result = await reading.readMessagesAgent(ctx(), 'Покажи сообщения', false, '', [], { intent: 'ПРОВЕРКА_СООБЩЕНИЙ', confidenceLevel: 'ВЫСОКИЙ', details: { messagesCheckType: 'ALL_MESSAGES' } });
    assert.equal(result.operationStatus, 'failed');
});

test('group analysis connection failure is failed and never resumes the remaining mutation', async t => {
    const value = ctx(); request(value);
    t.mock.method(persistence, 'persistSessionNow', async () => {});
    t.mock.method(telegram, 'initTelegramClient', async () => null);
    const resumed = t.mock.method(kernel, 'continueConfirmedRuntime', async () => undefined);
    const cancelled = t.mock.method(kernel, 'cancelRuntimeContinuation', async (...[_ctx, _tools, key, _summary, status]: Parameters<typeof kernel.cancelRuntimeContinuation>) => { assert.equal(key, 'chat-analysis:synthetic-request'); assert.equal(status, 'failed'); });
    await callbackBot(value)('chat_analysis:synthetic-request:week');
    assert.equal(resumed.mock.callCount(), 0); assert.equal(cancelled.mock.callCount(), 1);
});

test('successful actual group callback resumes only its keyed parent and returns both results', async t => {
    const value = ctx(); request(value);
    t.mock.method(persistence, 'persistSessionNow', async () => {});
    t.mock.method(telegram, 'initTelegramClient', async () => ({}) as any);
    t.mock.method(telegram, 'searchGroupByTitle', async () => ({ id: 303, title: 'Группа Сигма' }) as any);
    t.mock.method(studyFlow, 'getMessagesInDateRange', async () => [{ id: 1, message: 'Синтетическое событие', date: 1 }] as any);
    t.mock.method(completion, 'createChatCompletionForTask', async () => ({ choices: [{ message: { content: 'Сводка Сигма' } }] }) as any);
    const resumed = t.mock.method(kernel, 'continueConfirmedRuntime', async (...[_ctx, names, _summary, _deps, key]: Parameters<typeof kernel.continueConfirmedRuntime>) => { assert.deepEqual(names, ['telegram.readMessages']); assert.equal(key, 'chat-analysis:synthetic-request'); return { responseText: 'Напоминание сохранено', operationStatus: 'ok' }; });
    const sent = t.mock.method(shared, 'sendResultToUser', async (...[_ctx, result]: Parameters<typeof shared.sendResultToUser>) => { assert.match(result.responseText, /Сводка Сигма/); assert.match(result.responseText, /Напоминание сохранено/); });
    await callbackBot(value)('chat_analysis:synthetic-request:week');
    assert.equal(resumed.mock.callCount(), 1); assert.equal(sent.mock.callCount(), 1);
});

test('study period hands off its exact pending parent to contact identity confirmation', async t => {
    const value = ctx(); value.session.agentRuntime = state('study-chat:synthetic-request');
    value.session.studyChatRequest = { requestId: 'synthetic-request', contactName: 'Контакт Сигма', contactId: 202, step: 'period', createdAt: Date.now(), expiresAt: Date.now() + 60_000 };
    t.mock.method(persistence, 'persistSessionNow', async () => {}); t.mock.method(persistence, 'persistAgentRuntime', async () => {});
    t.mock.method(study, 'studyChatAndSaveFacts', async (current: BotContext) => { assert.equal(current.suppressAgentProgress, true); current.session.pendingContactMemory = { confirmationId: 'synthetic-memory', createdAt: Date.now() } as any; return { responseText: 'Требуется личность', savedCount: 0, operationStatus: 'needs_input' }; });
    const resumed = t.mock.method(kernel, 'continueConfirmedRuntime', async () => undefined);
    await callbackBot(value)('study_chat:synthetic-request:week');
    assert.equal(value.session.agentRuntime.observations?.[0].confirmationKey, 'cmem:synthetic-memory');
    assert.equal(value.session.agentRuntime.status, 'waiting'); assert.equal(resumed.mock.callCount(), 0);
});

test('a completed independent read is not waiting on another workflow in the same session', async t => {
    const value = ctx(); value.session.pendingBrowserTask = { originalTask: 'Чужая задача' } as any;
    value.session.pendingHealthLog = { createdAt: Date.now() } as any; value.session.pendingContactMemory = { createdAt: Date.now() } as any;
    t.mock.method(reading, 'readMessagesAgent', async () => ({ responseText: 'Новых сообщений нет', operationStatus: 'ok' }));
    const result = await domainTools().find(tool => tool.name === 'telegram.readMessages')!.execute({ request: 'Покажи новые сообщения', mode: 'unread' }, context(value));
    assert.equal(result.status, 'ok'); assert.equal(result.confirmationKey, undefined);
});

test('old contact buttons cannot confirm or cancel a newer clarification and retry timestamps keep identity', async () => {
    const value = ctx(); value.session.pendingContactMemory = { confirmationId: 'new-flow', createdAt: Date.now(), candidateIds: [202] } as any;
    const notices: string[] = []; (value as any).answerCallbackQuery = async ({ text }: any) => { notices.push(text); }; (value as any).editMessageText = async () => {};
    const original = value.session.pendingContactMemory!; let saved = false; let cancelled = false;
    await contactMemory.handleContactMemoryCallback(value, 'cmem:old-flow:202', () => { saved = true; }, () => { cancelled = true; });
    await contactMemory.handleContactMemoryCallback(value, 'cmem:old-flow:cancel', () => { saved = true; }, () => { cancelled = true; });
    assert.equal(value.session.pendingContactMemory, original); assert.equal(saved, false); assert.equal(cancelled, false); assert.equal(notices.length, 2);
    const key = contactMemoryConfirmationKey(value); original.createdAt++;
    assert.equal(contactMemoryConfirmationKey(value), key);
    await contactMemory.handleContactMemoryCallback(value, 'cmem:new-flow:cancel', undefined, () => { cancelled = true; });
    assert.equal(cancelled, true); assert.equal(value.session.pendingContactMemory, undefined);
});

test('delegated study awaiting identity completes its metadata before its dependent step', async t => {
    const value = ctx(); value.session.agentRuntime = { ...state('unused'), status: 'running', observations: [] };
    t.mock.method(persistence, 'persistAgentRuntime', async () => {});
    t.mock.method(ContactsStore.getInstance(), 'getContact', () => ({ id: 202, firstName: 'Контакт Сигма' }) as any);
    t.mock.method(study, 'studyChatAndSaveFacts', async (current: BotContext) => { current.session.pendingContactMemory = { confirmationId: 'synthetic-memory', createdAt: Date.now() } as any; return { responseText: 'Уточни личность', savedCount: 0, operationStatus: 'needs_input' }; });
    const output = await agentTools()[0].execute({ kind: 'study-chat', task: 'Изучи переписку', contactId: 202 }, context(value));
    assert.equal(output.confirmationKey, 'cmem:synthetic-memory');
    const parent = value.session.agentRuntime; parent.status = 'waiting'; parent.classification = context(value).classification; parent.skills = ['telegram-reading']; parent.observations = [{ id: 'read', tool: 'agents.start', status: output.status, summary: output.summary, confirmationKey: output.confirmationKey, data: output.data }];
    let writes = 0;
    const result = await kernel.continueConfirmedRuntime(value, CONTACT_MEMORY_PARENT_TOOLS, 'Факты сохранены', { persist: async () => {}, respond: async () => ({ responseText: 'Общий итог' }), decide: async () => ({ finish: true }), registry: new ToolRegistry([{ name: 'test.next', effect: 'state', skill: 'reminders', ownerOnly: false, description: 'Synthetic', inputSchema: objectSchema({}), execute: async () => { writes++; assert.equal(value.session.agentRuntime?.agents[0].status, 'completed'); return { status: 'ok', summary: 'Напоминание сохранено' }; } }], () => true) }, output.confirmationKey);
    assert.equal(writes, 1); assert.equal(result?.operationStatus, 'ok');
});

test('an uncertain callback outcome closes the child and retains an unknown receipt', async t => {
    const value = ctx(); const parent = state('synthetic-key'); value.session.agentRuntime = parent;
    parent.observations![0].tool = 'agents.start'; parent.observations![0].data = { run: { id: 'synthetic-child' } };
    parent.agents = [{ id: 'synthetic-child', parentRunId: parent.runId, kind: 'study-chat', status: 'waiting', createdAt: Date.now(), updatedAt: Date.now() }];
    parent.receipts = [{ key: 'synthetic-receipt', tool: 'agents.start', status: 'needs_input' }];
    t.mock.method(persistence, 'persistAgentRuntime', async () => {});
    await kernel.cancelRuntimeContinuation(value, ['agents.start'], 'synthetic-key', 'Неизвестный исход записи', 'unknown');
    assert.equal(parent.agents[0].status, 'failed'); assert.equal(parent.receipts[0].status, 'unknown'); assert.deepEqual(parent.pendingCalls, []);
});
