import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Bot } from 'grammy';
import { config } from '../config';
import { BotApiBackend } from '../api/backend';
import type { BotContext, SessionData } from '../types';
import { TypeORMSessionStorage } from '../services/SessionStorage';
import * as storage from '../services/SessionStorage';
import * as history from '../utils/history';
import * as completion from '../ai/chatCompletion';
import * as memory from '../utils/agentMemoryContext';
import * as conversation from '../agents/conversationAgent';
import * as telegram from '../services/telegram';
import * as reading from '../agents/readMessagesAgent';
import * as agenda from '../utils/todayImportance';
import * as reconsolidation from '../services/MemoryReconsolidationService';
import { ChatGroupRepository } from '../services/ChatGroupRepository';
import { DialogueJobRepository } from '../services/DialogueJobRepository';
import { registerDialogueLifecycle } from '../services/dialogueJobs';
import { registerTextMessageHandler } from '../handlers/textMessages';
import * as shared from '../handlers/shared';
import { llmCache } from '../utils/llmCache';

for (const channel of ['app', 'telegram'] as const) for (const scenario of ['topics', 'frequency', 'continuation', 'partial'] as const)
test(`${channel}: ${scenario} reads today's private/group history and delivers one final answer`, async t => {
    const previous = { owner: config.allowedUserId, mode: process.env.KIRA_ORCHESTRATION_MODE, decisions: process.env.KIRA_DECISIONS_ENABLED };
    config.allowedUserId = 730061; process.env.KIRA_ORCHESTRATION_MODE = 'skills'; delete process.env.KIRA_DECISIONS_ENABLED;
    t.after(() => { config.allowedUserId = previous.owner;
        for (const [key, value] of [['KIRA_ORCHESTRATION_MODE', previous.mode], ['KIRA_DECISIONS_ENABLED', previous.decisions]])
            if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
    });
    const sessions = new Map<string, SessionData>();
    const key = channel === 'app' ? 'api:730061' : '730061';
    const originalQuestion = 'Какие сегодня были важные темы в чатах?';
    if (scenario === 'continuation') sessions.set(key, {
        reminders: [], domains: {}, dialogueSummary: '', lastSummarizedIndex: -1,
        messageHistory: [{ role: 'bot', content: 'С кем проанализировать переписку?', timestamp: new Date() }, { role: 'user', content: originalQuestion, timestamp: new Date() }],
        agentRuntime: JSON.parse(JSON.stringify({ version: 1, runId: 'legacy-read', goal: originalQuestion, status: 'waiting', startedAt: Date.now(), updatedAt: Date.now(),
            classification: { intent: 'ПРОВЕРКА_СООБЩЕНИЙ', confidenceLevel: 'ВЫСОКИЙ', details: { messagesCheckType: 'ANALYZE_CONVERSATION' } },
            question: 'С кем проанализировать переписку?', skills: ['telegram-reading'], receipts: [], agents: [], toolNames: [], pendingCalls: [], completedCalls: { old: 'needs_input' },
            parameterCall: { id: 'old', tool: 'telegram.readMessages', args: { request: originalQuestion, mode: 'conversation' } },
            observations: [{ id: 'old', tool: 'telegram.readMessages', status: 'needs_input', summary: 'С кем проанализировать переписку?' }] })),
    });
    t.mock.method(llmCache, 'get', () => undefined);
    t.mock.method(TypeORMSessionStorage.prototype, 'read', async (key: string) => structuredClone(sessions.get(key)));
    t.mock.method(TypeORMSessionStorage.prototype, 'write', async (key: string, value: SessionData) => { sessions.set(key, structuredClone(value)); });
    t.mock.method(storage, 'persistAgentRuntime', async () => {});
    t.mock.method(history, 'addToHistory', async (ctx: BotContext, role: string, content: string) => { ctx.session.messageHistory.unshift({ role, content, timestamp: new Date() }); });
    t.mock.method(reconsolidation, 'reconsolidateAfterResponse', async () => {});
    t.mock.method(DialogueJobRepository, 'beginTurn', async () => {});
    t.mock.method(ChatGroupRepository, 'findAll', async () => []);
    t.mock.method(memory, 'fetchAgentMemoryContext', async (_ctx: unknown, _message: string, options: any) => { assert.equal(options.memoryNeed, 'none'); return { domain: 'personal', context: '', recalledMemories: [] }; });
    const legacy = t.mock.method(reading, 'readMessagesAgent', async () => { throw Error('Legacy last-50 reading must not run'); });
    const snapshot = t.mock.method(agenda, 'buildTodayImportanceSnapshot', async () => { throw Error('Chat history must not become an agenda'); });
    t.mock.method(shared, 'shouldRunProactiveHint', () => false);
    const at = Math.floor(Date.now() / 1000) - 1;
    const init = t.mock.method(telegram, 'initTelegramClient', async () => ({
        getDialogs: async () => [{ id: 81061, title: 'Мирон Учебный', isUser: true, entity: {}, message: { id: 5, date: at } },
            { id: -10081062, title: 'Учебная группа', isGroup: true, entity: {}, message: { id: 4, date: at } }],
        getMessages: async (id: string, args: any) => {
            assert.ok(args.offsetDate); assert.equal(args.limit, 11);
            if (scenario === 'partial' && id === '-10081062') throw Error('synthetic-private-provider-error');
            return id === '81061' ? [{ id: 5, date: at, out: true, message: 'Я подготовлю учебный отчёт.' },
                { id: 4, date: at, out: true, message: 'Макет готов.' }, { id: 3, date: at, out: true, message: 'Бюджет пока не согласован.' },
                { id: 2, date: at, out: false, fromId: { userId: 81061 }, message: 'Обсудим макет завтра?' },
                { id: 1, date: 1775000000, message: 'СТАРАЯ_АПРЕЛЬСКАЯ_ПЕРЕПИСКА' }]
                : [{ id: 4, date: at, out: true, message: 'Тестовый релиз готов.' }, { id: 3, date: at, out: false, message: 'Проверяем сборку.' }, { id: 2, date: at, out: false, message: 'Проверка завершена.' }];
        },
    }) as any);
    let round = 0; let classifications = 0;
    t.mock.method(completion, 'createJsonChatCompletionForTask', async (task: string, request: any) => {
        if (task !== 'runtimePlanning') { classifications++; return { intent: 'ПРОВЕРКА_СООБЩЕНИЙ', confidenceLevel: 'СРЕДНИЙ', details: {
            messagesCheckType: 'ANALYZE_CONVERSATION', memoryNeed: 'none', memoryTask: 'none' }, fastReply: { mode: 'route' } } as any; }
        const input = JSON.parse(request.messages.at(-1).content);
        assert.ok(!request.messages[0].content.includes('"name":"telegram.readMessages"'));
        if (scenario === 'continuation') { assert.equal(input.request, originalQuestion); assert.equal(input.continuationAnswer, 'Все за сегодня'); }
        if (++round === 1) return { calls: [{ id: 'catalog', tool: 'telegram.listConversations', args: {} }] } as any;
        const data = input.observations;
        assert.equal(data[0].data.items[0].chatId, '81061');
        if (round === 2) return { calls: data[0].data.items.map((item: any, i: number) => ({ id: `read${i}`, tool: 'telegram.getHistory', args: { chatId: item.chatId } })) } as any;
        assert.match(JSON.stringify(data), /учебный отчёт/);
        assert.doesNotMatch(JSON.stringify(data), /СТАРАЯ_АПРЕЛЬСКАЯ/);
        return { finish: true } as any;
    });
    const synthesis = t.mock.method(conversation, 'conversationAgent', async (...args: any[]) => {
        assert.match(args[6].context, /Мирон Учебный/); assert.match(args[6].context, /Я подготовлю учебный отчёт/);
        assert.match(args[6].context, /"isOwn":true/); assert.match(args[6].context, /"isOwn":false/);
        assert.match(args[6].context, /"outgoing":3,"total":4/); assert.doesNotMatch(args[6].context, /СТАРАЯ_АПРЕЛЬСКАЯ/);
        if (scenario !== 'partial') assert.match(args[6].context, /"outgoing":1,"total":3/);
        return { responseText: scenario === 'frequency' ? 'Чаще всего ты писал Мирону: 3 исходящих сообщения, в учебную группу — 1.' : scenario === 'partial' ? 'Сегодня с Мироном обсудили макет. Группу прочитать не удалось.' : 'Сегодня с Мироном обсудили макет; в группе — тестовый релиз.', skipOptionalFollowups: true };
    });
    const bot = new Bot<BotContext>('1234567890:abcdefghijklmnopqrstuvwxyzABCDE', { botInfo: { id: 1234567890, is_bot: true, first_name: 'Test', username: 'synthetic_bot' } as any });
    const delivered: string[] = [];
    bot.api.config.use(async (_prev, method, payload: any) => {
        assert.equal(channel, 'telegram');
        if (method === 'sendMessage') { delivered.push(payload.text); return { ok: true, result: { message_id: 9002, date: at, chat: { id: 730061, type: 'private' }, text: payload.text } } as any; }
        assert.equal(method, 'sendChatAction'); return { ok: true, result: true } as any;
    });
    if (channel === 'telegram') {
        bot.use(async (ctx, next) => { ctx.session = structuredClone(sessions.get(key)) ?? { messageHistory: [], reminders: [], domains: {}, dialogueSummary: '', lastSummarizedIndex: -1 }; await next(); sessions.set(key, structuredClone(ctx.session)); });
        registerDialogueLifecycle(bot); registerTextMessageHandler(bot, { immediate: true });
    }
    let updateId = 9000;
    const send = async (text: string) => {
        round = 0;
        if (channel === 'app') {
            const backend = new BotApiBackend(bot, { token: 'synthetic-history-token-32-characters', ownerId: 730061, host: '127.0.0.1', port: 0 }, { read: async () => ({ preset: 'gpt-lean', revision: 'synthetic' }) } as any);
            const reply = (await backend.message(text)).messages.filter(m => m.text); assert.equal(reply.length, 1); return reply[0].text!;
        }
        const start = delivered.length;
        await bot.handleUpdate({ update_id: ++updateId, message: { message_id: updateId, date: at, from: { id: 730061, is_bot: false, first_name: 'Synthetic' }, chat: { id: 730061, type: 'private', first_name: 'Synthetic' }, text } });
        assert.equal(delivered.length - start, 1); return delivered.at(-1)!;
    };
    if (scenario === 'frequency') await send(originalQuestion);
    const result = await send(scenario === 'continuation' ? 'Все за сегодня' : scenario === 'frequency' ? 'С кем чаще всего сегодня общался?' : originalQuestion);
    assert.match(result, scenario === 'frequency' ? /Мирону: 3/ : /Сегодня с Мироном/);
    assert.doesNotMatch(result, /С кем|За какой период|СТАРАЯ_АПРЕЛЬСКАЯ|Не завершены некоторые шаги|provider-error/);
    if (scenario === 'partial') assert.match(result, /Обзор частичный/);
    assert.equal(synthesis.mock.callCount(), scenario === 'frequency' ? 2 : 1); assert.equal(init.mock.callCount(), scenario === 'frequency' ? 6 : 3);
    assert.equal(classifications, scenario === 'continuation' ? 0 : scenario === 'frequency' ? 2 : 1);
    assert.equal(legacy.mock.callCount(), 0); assert.equal(snapshot.mock.callCount(), 0);
});
