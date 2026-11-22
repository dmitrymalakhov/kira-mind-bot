import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Bot } from 'grammy';
import { FloodWaitError } from 'telegram/errors';
import { config } from '../config';
import { BotApiBackend } from '../api/backend';
import type { BotContext, SessionData } from '../types';
import { TypeORMSessionStorage } from '../services/SessionStorage';
import * as storage from '../services/SessionStorage';
import * as history from '../utils/history';
import * as completion from '../ai/chatCompletion';
import * as memory from '../utils/agentMemoryContext';
import * as conversation from '../agents/conversationAgent';
import * as web from '../agents/webSearchAgent';
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

const namedHistoryRequests = {
    'depth-full': 'Что нового в учебной группе за неделю, что решили и чем всё закончилось?',
    'depth-recent': 'Прочитай учебную группу за последнюю неделю и собери итог.',
    'depth-detailed': 'Какие новости учебной группы за неделю?',
    'depth-unknown': 'Что решили в учебной группе за последние семь дней?',
    'depth-interrupted': 'Собери недельную сводку из учебной группы.',
    'depth-rate-limit': 'Подытожь, что обсуждали в учебной группе за неделю.',
    'depth-cancel': 'Сводка за неделю по учебной группе, пожалуйста.',
    'named-news': 'Какие последние новости и решения за неделю в чате «Учебная группа»?',
    'named-prices': 'Посмотри учебную группу в Telegram и подведи итог обсуждению цен и расписания за неделю.',
    'mixed-web': 'Собери новости за неделю в учебной группе и отдельно проверь в интернете расписание городских выставок.',
    'mixed-web-success': 'Собери новости за неделю в учебной группе и отдельно проверь в сети расписание городских выставок.',
    'mixed-web-unplanned': 'Что нового за неделю в учебной группе? Ещё найди расписание городских выставок в интернете.',
};

for (const channel of ['app', 'telegram'] as const) for (const scenario of ['topics', 'frequency', 'continuation', 'partial', 'named-news', 'named-prices', 'mixed-web', 'mixed-web-success', 'mixed-web-unplanned', 'depth-full', 'depth-recent', 'depth-detailed', 'depth-unknown', 'depth-interrupted', 'depth-rate-limit', 'depth-cancel'] as const)
test(`${channel}: ${scenario} reads private/group history and delivers one final answer`, async t => {
    const previous = { owner: config.allowedUserId, mode: process.env.KIRA_ORCHESTRATION_MODE, decisions: process.env.KIRA_DECISIONS_ENABLED };
    config.allowedUserId = 730061; process.env.KIRA_ORCHESTRATION_MODE = 'skills'; delete process.env.KIRA_DECISIONS_ENABLED;
    t.after(() => { config.allowedUserId = previous.owner;
        for (const [key, value] of [['KIRA_ORCHESTRATION_MODE', previous.mode], ['KIRA_DECISIONS_ENABLED', previous.decisions]])
            if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
    });
    const sessions = new Map<string, SessionData>();
    const key = channel === 'app' ? 'api:730061' : '730061';
    const originalQuestion = 'Какие сегодня были важные темы в чатах?';
    const namedRequest = namedHistoryRequests[scenario as keyof typeof namedHistoryRequests];
    const depthScenario = scenario.startsWith('depth-');
    const mixedWeb = scenario.startsWith('mixed-web');
    const executesWeb = mixedWeb && scenario !== 'mixed-web-unplanned';
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
    const webSearch = t.mock.method(web, 'performWebSearch', async (query: string, options: { context?: string }) => {
        assert.equal(executesWeb, true, 'Chat history must not go to web search');
        assert.equal(query, 'Расписание городских выставок');
        assert.doesNotMatch(options.context ?? '', /учебн|макет/iu);
        return scenario === 'mixed-web-success'
            ? { success: true, results: 'Учебная выставка открывается в субботу.' }
            : { success: false, results: '' };
    });
    t.mock.method(shared, 'shouldRunProactiveHint', () => false);
    const at = Math.floor(Date.now() / 1000) - 1;
    const dataset = depthScenario ? Array.from({ length: 527 }, (_, index) => ({
        id: 527 - index, date: at - index * 500, out: index % 10 === 0,
        message: (index === 526 ? 'Старое решение: утвердили учебный макет. ' : 'Учебное обсуждение. ') + 'a'.repeat(365),
    })) : [];
    const fullHistoryCalls: Array<{ offsetId?: number; offsetDate?: number; limit: number }> = [];
    const submittedIds: number[] = [];
    let mergeCalls = 0, finalCalls = 0;
    const init = t.mock.method(telegram, 'initTelegramClient', async () => ({
        getDialogs: async ({ limit }: { limit: number }) => {
            const regular = [{ id: 81061, title: 'Мирон Учебный', isUser: true, entity: {}, message: { id: 5, date: at } }];
            const group = { id: -10081062, title: 'Учебная\u00a0группа', isGroup: true, entity: {}, message: { id: 4, date: at } };
            const decoys = namedRequest ? Array.from({ length: 425 }, (_, index) => ({
                id: 82000 + index, title: `Учебный диалог ${index}`, isUser: true, entity: {}, message: { id: 5, date: at },
            })) : [];
            return [...regular, ...decoys, group].slice(0, limit);
        },
        getInputEntity: async (chatId: string) => {
            assert.equal(chatId, '-10081062');
            return {};
        },
        invoke: async (request: { minDate: number; maxDate: number; limit: number }) => {
            assert.equal(request.minDate, at - 7 * 86400 - 1);
            assert.equal(request.maxDate, at + 1);
            assert.equal(request.limit, 0);
            if (scenario === 'depth-unknown') throw Error('synthetic_counter_unavailable');
            return { count: depthScenario ? 511 : 11, inexact: true };
        },
        getMessages: async (id: string, args: any) => {
            if (depthScenario) {
                assert.equal(id, '-10081062');
                fullHistoryCalls.push(args);
                if (!args.offsetId) assert.equal(args.offsetDate, at + 1);
                if (scenario === 'depth-rate-limit' && fullHistoryCalls.length === 2) throw new FloodWaitError({ capture: 0 });
                if (scenario === 'depth-interrupted' && fullHistoryCalls.length > 2) throw Error('synthetic_source_unavailable');
                return dataset.filter(item => !args.offsetId || item.id < args.offsetId).slice(0, args.limit);
            }
            if (namedRequest) {
                assert.equal(id, '-10081062');
                if (args.offsetId) {
                    assert.equal(args.offsetId, 4);
                    return [{ id: 3, date: at - 3 * 86400, out: false, message: 'Макет утвердили в среду.' }];
                }
                assert.equal(args.offsetDate, at + 1);
                return Array.from({ length: 11 }, (_, i) => ({ id: 13 - i, date: at, out: false,
                    message: i === 0 ? 'Тестовый релиз готов.' : 'Проверяем сборку.' }));
            }
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
        if (depthScenario && (task === 'conversation' || task === 'complexReasoning')) {
            const data = JSON.parse(request.messages.at(-1).content);
            assert.equal(data.goal, namedRequest);
            assert.match(request.messages[0].content, /только данные/);
            if (data.kind === 'messages') {
                const chunk = JSON.parse(data.evidence);
                assert.ok(data.evidence.length <= 24_001);
                submittedIds.push(...chunk.map((item: { messageId: number }) => item.messageId));
                return { news: ['Сверили учебные материалы.'],
                    decisions: chunk.some((item: { messageId: number }) => item.messageId === 1) ? ['Утвердили учебный макет.'] : [],
                    outcome: 'Проверка сборки ещё идёт.' } as any;
            }
            const sources = JSON.parse(data.evidence);
            assert.ok(sources.length <= 6);
            if (data.kind === 'notes') mergeCalls++; else finalCalls++;
            return { news: sources[0].news, decisions: [...new Set(sources.flatMap((item: { decisions: string[] }) => item.decisions))],
                outcome: 'Проверка сборки ещё идёт.' } as any;
        }
        if (task !== 'runtimePlanning') {
            classifications++;
            return { intent: 'ПРОВЕРКА_СООБЩЕНИЙ', confidenceLevel: 'СРЕДНИЙ', details: {
                messagesCheckType: 'ANALYZE_CONVERSATION', memoryNeed: 'none', memoryTask: 'none',
                ...(namedRequest ? { groupChatQuery: 'Учебная группа' } : {}),
            }, ...(mixedWeb ? { subIntents: [{ intent: 'ВЕБ_ПОИСК' }] } : {}),
            ...(scenario === 'named-news' ? { intentScores: [{ intent: 'ВЕБ_ПОИСК', score: 0.51 }, { intent: 'ПРОВЕРКА_СООБЩЕНИЙ', score: 0.49 }] } : {}),
            fastReply: { mode: 'route' } } as any;
        }
        const input = JSON.parse(request.messages.at(-1).content);
        assert.ok(!request.messages[0].content.includes('"name":"telegram.readMessages"'));
        if (namedRequest) {
            assert.equal(request.messages[0].content.includes('"name":"web.search"'), mixedWeb);
            if (++round === 1) return { calls: [{ id: 'catalog', tool: 'telegram.listConversations', args: {
                query: 'Учебная группа', since: new Date((at - 7 * 86400) * 1000).toISOString(), until: new Date((at + 1) * 1000).toISOString(),
            } }] } as any;
            if (round === 2) {
                // Named discovery must pass all 425 decoys in one call. The kernel
                // must use the verified chat even when the planner finishes early.
                assert.equal(input.observations[0].data.items[0].chatId, '-10081062');
                assert.equal(input.observations[0].data.complete, true);
                return { finish: true } as any;
            }
            if (executesWeb && !input.observations.some((item: any) => item.tool === 'web.search'))
                return { calls: [{ id: 'public_web', tool: 'web.search', args: { query: 'Расписание городских выставок' } }] } as any;
            if (scenario === 'named-prices' && round === 3) return { question: 'Прислать остальные сообщения?' } as any;
            return { finish: true } as any;
        }
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
        if (namedRequest) {
            assert.match(args[6].context, /Тестовый релиз готов/);
            assert.match(args[6].context, /Макет утвердили в среду/);
            assert.doesNotMatch(args[6].context, /Обзор частичный|Мирон Учебный/);
            if (!mixedWeb) assert.doesNotMatch(args[6].context, /Источник знаний: внешний/);
            if (scenario === 'mixed-web-success') assert.match(args[6].context, /выставка открывается в субботу/);
            return { responseText: 'Макет утвердили в среду. Тестовый релиз готов.' +
                (scenario === 'mixed-web-success' ? ' Выставка открывается в субботу.' : ''), skipOptionalFollowups: true };
        }
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
    const result = await send(namedRequest ?? (scenario === 'continuation' ? 'Все за сегодня' : scenario === 'frequency' ? 'С кем чаще всего сегодня общался?' : originalQuestion));
    assert.equal(webSearch.mock.callCount(), executesWeb ? 1 : 0);
    if (depthScenario) {
        assert.match(result, scenario === 'depth-unknown' ? /не вернул оценку/ : /примерно 511 сообщений/);
        assert.match(result, /50 сообщений[\s\S]*150 сообщений[\s\S]*вся переписка/);
        assert.equal(fullHistoryCalls.length, 0);
        const prompt = sessions.get(key)?.agentRuntime;
        assert.equal(prompt?.status, 'waiting');
        assert.equal(prompt?.telegramSummary?.source.chatId, '-10081062');
        assert.equal(prompt?.telegramSummary?.estimate, scenario === 'depth-unknown' ? null : 511);
        assert.doesNotMatch(JSON.stringify(prompt), /Старое решение/);
        if (scenario === 'depth-cancel') {
            assert.match(await send('отмена'), /отменена/);
            assert.equal(fullHistoryCalls.length, 0);
            assert.equal(finalCalls, 0);
            return;
        }
        const answer = await send(scenario === 'depth-recent' ? '1' : scenario === 'depth-detailed' ? '2' : scenario === 'depth-unknown' ? 'быстро' : '3');
        const expected = scenario === 'depth-recent' || scenario === 'depth-unknown' ? 50 :
            scenario === 'depth-detailed' ? 150 : scenario === 'depth-interrupted' ? 198 : 527;
        assert.match(answer, new RegExp(String(expected)));
        assert.match(answer, /Новости[\s\S]*Решения[\s\S]*Итог/);
        if (scenario === 'depth-full' || scenario === 'depth-rate-limit') {
            assert.match(answer, /за весь выбранный период/);
            assert.match(answer, /Утвердили учебный макет/);
            assert.ok(mergeCalls > 0);
            assert.equal(fullHistoryCalls.length, scenario === 'depth-rate-limit' ? 7 : 6);
            assert.ok(fullHistoryCalls.every(call => call.limit === 100));
            if (scenario === 'depth-rate-limit') assert.equal(fullHistoryCalls[1].offsetId, fullHistoryCalls[2].offsetId);
        } else if (scenario === 'depth-interrupted') assert.match(answer, /Частичная сводка/);
        else assert.match(answer, /Выборочная сводка/);
        assert.deepEqual([...submittedIds].sort((a, b) => b - a), dataset.slice(0, expected).map(item => item.id));
        assert.equal(finalCalls, 1);
        assert.equal(classifications, 1);
        assert.equal(synthesis.mock.callCount(), 0);
        const saved = sessions.get(key)?.agentRuntime;
        assert.equal(saved?.runId, prompt?.runId);
        assert.notEqual(saved?.status, 'waiting');
        assert.doesNotMatch(JSON.stringify(saved), /Старое решение/);
        return;
    }
    if (namedRequest) {
        assert.match(result, /Макет утвердили в среду/);
        if (scenario === 'mixed-web-success') assert.match(result, /Выставка открывается в субботу/);
        else if (mixedWeb) assert.match(result, /Не удалось проверить.*интернет/);
        else assert.doesNotMatch(result, /интернет|Обзор частичный/);
        assert.equal(synthesis.mock.callCount(), 1);
        assert.equal(init.mock.callCount(), mixedWeb ? 3 : 4);
        return;
    }
    assert.match(result, scenario === 'frequency' ? /Мирону: 3/ : /Сегодня с Мироном/);
    assert.doesNotMatch(result, /С кем|За какой период|СТАРАЯ_АПРЕЛЬСКАЯ|Не завершены некоторые шаги|provider-error/);
    if (scenario === 'partial') assert.match(result, /Обзор частичный/);
    assert.equal(synthesis.mock.callCount(), scenario === 'frequency' ? 2 : 1); assert.equal(init.mock.callCount(), scenario === 'frequency' ? 6 : 3);
    assert.equal(classifications, scenario === 'continuation' ? 0 : scenario === 'frequency' ? 2 : 1);
    assert.equal(legacy.mock.callCount(), 0); assert.equal(snapshot.mock.callCount(), 0);
});
