import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as telegram from '../services/telegram';
import { conversationRange, listTelegramConversations, readTelegramConversation } from '../services/telegramConversationHistory';
import { createKiraToolRegistry, runKiraRuntime } from '../orchestration/runtime/kernel';
import type { ToolContext } from '../orchestration/runtime/types';
import { config } from '../config';
import { telegramHistoryCoverage, telegramHistoryStatistics } from '../orchestration/runtime/telegramTools';
import { telegramTools } from '../orchestration/runtime/telegramTools';
import { ToolRegistry } from '../orchestration/runtime/registry';

const range = { since: '2026-11-13T00:00:00Z', until: '2026-11-14T00:00:00Z' };
const second = Date.parse(range.since) / 1000;
const dialog = (id: number, extra = {}) => ({ id, title: `Учебный чат ${id}`, isUser: true, entity: {}, message: { id: 50, date: second + 60 }, ...extra });
const message = (id: number, extra = {}) => ({ id, date: second + 60, message: `Учебное сообщение ${id}`, ...extra });
function context(): ToolContext {
    return { ctx: { from: { id: 101 }, chat: { id: 101, type: 'private' }, session: { messageHistory: [], reminders: [], domains: {}, dialogueSummary: '', lastSummarizedIndex: -1 } } as any,
        message: 'Составь выжимку сегодняшних переписок', isForwarded: false, forwardFrom: '', messageHistory: [], classification: {
            intent: 'ПРОВЕРКА_СООБЩЕНИЙ', confidenceLevel: 'ВЫСОКИЙ', details: { messagesCheckType: 'ANALYZE_CONVERSATION', memoryNeed: 'none' } },
        runId: 'synthetic', signal: new AbortController().signal, memoryContext: '', observations: [] };
}

test('calendar defaults use account timezone across midnight and DST, explicit periods require offsets', () => {
    assert.deepEqual(conversationRange({}, new Date('2026-11-13T23:30:00Z'), 'Europe/Moscow'), { since: '2026-11-13T21:00:00.000Z', until: '2026-11-13T23:30:00.000Z' });
    assert.equal(conversationRange({}, new Date('2026-10-25T10:00:00Z'), 'Europe/Amsterdam').since, '2026-10-24T22:00:00.000Z');
    assert.equal(conversationRange({}, new Date('2026-03-29T10:00:00Z'), 'Europe/Amsterdam').since, '2026-03-28T23:00:00.000Z');
    for (const args of [{ since: range.since }, { since: '2026-11-13', until: range.until }, { since: range.until, until: range.since }, { since: 'bad', until: range.until }])
        assert.throws(() => conversationRange(args));
});

test('dialog discovery pages past bots/channels and older pinned chats without dropping the cursor', async t => {
    let calls = 0;
    t.mock.method(telegram, 'initTelegramClient', async () => ({ getInputEntity: async (id: string) => ({ syntheticPeer: id }), getDialogs: async (args: any) => {
        assert.equal(args.ignorePinned, false);
        if (++calls === 1) return [dialog(201, { entity: { bot: true } }), dialog(-100301, { isUser: false, isChannel: true }), dialog(202)];
        assert.equal(args.limit, 5);
        return [dialog(201, { entity: { bot: true } }), dialog(-100301, { isUser: false, isChannel: true }), dialog(202, { message: { id: 51, date: second + 120, out: true } }), dialog(203, { message: { id: 1, date: second - 1 } })];
    } }) as any);
    const first = await listTelegramConversations({ ...range, limit: 2 });
    assert.deepEqual(first.items, []); assert.equal(first.complete, false); assert.ok(first.nextCursor);
    const next = await listTelegramConversations({ cursor: first.nextCursor, limit: 2 });
    assert.equal(next.items[0].chatId, '202'); assert.equal(next.complete, true); assert.equal(next.nextCursor, undefined);
    await assert.rejects(listTelegramConversations({ cursor: first.nextCursor, query: 'другое' }));
    await assert.rejects(listTelegramConversations({ cursor: first.nextCursor, since: '2026-11-12T00:00:00Z', until: range.until }));
});

test('history keeps equal-timestamp messages with offsetId, author/forward metadata and half-open range', async t => {
    let calls = 0;
    t.mock.method(telegram, 'initTelegramClient', async () => ({ getMessages: async (id: string, args: any) => {
        assert.equal(id, '202');
        if (++calls === 1) { assert.equal(args.offsetDate, Date.parse(range.until) / 1000); return [message(10, { out: true, fromId: { userId: 101 } }), message(9, { fromId: { userId: 202 }, fwdFrom: { fromName: 'Учебный автор' } }), message(8)]; }
        assert.equal(args.offsetId, 9); assert.equal(args.offsetDate, undefined);
        return [message(8, { date: second }), message(7, { date: second - 1 })];
    } }) as any);
    const first = await readTelegramConversation({ ...range, chatId: '202', limit: 2 });
    assert.equal(first.items[0].isOwn, true); assert.equal(first.items[1].senderId, '202'); assert.equal(first.items[1].isForwarded, true);
    assert.equal(first.complete, false);
    const next = await readTelegramConversation({ chatId: '202', cursor: first.nextCursor, limit: 2 });
    assert.deepEqual(next.items.map(m => m.messageId), [8]); assert.equal(next.complete, true);
    await assert.rejects(readTelegramConversation({ chatId: '203', cursor: first.nextCursor }));
});

test('history bounds payloads with a resumable page and reports text/media gaps', async t => {
    const messages = Array.from({ length: 21 }, (_, i) => message(100 - i, { message: 'я'.repeat(5000), media: { className: 'MessageMediaPhoto' } }));
    t.mock.method(telegram, 'initTelegramClient', async () => ({ getMessages: async () => messages }) as any);
    const result = await readTelegramConversation({ ...range, chatId: '202', limit: 20 });
    assert.ok(JSON.stringify(result).length < 8500); assert.ok(result.items.length < 20); assert.ok(result.nextCursor);
    assert.equal(result.items[0].textTruncated, true); assert.equal(result.items[0].mediaType, 'MessageMediaPhoto');
    const cursor = JSON.parse(Buffer.from(result.nextCursor!, 'base64url').toString());
    assert.equal(cursor.messageId, result.items.at(-1)!.messageId);
});

test('older pinned chats do not terminate discovery and active pinned conversations remain visible', async t => {
    t.mock.method(telegram, 'initTelegramClient', async () => ({ getDialogs: async () => [
        dialog(201, { pinned: true, message: { id: 1, date: second - 100 } }),
        dialog(202, { pinned: true }), dialog(203),
    ] }) as any);
    const result = await listTelegramConversations({ ...range, chatType: 'private' });
    assert.deepEqual(result.items.map(item => item.chatId), ['202', '203']);
    assert.equal(result.complete, true);
});

test('addressed history discovery accepts usernames with or without @ and explicit channel scope', async t => {
    t.mock.method(telegram, 'initTelegramClient', async () => ({ getDialogs: async () => [
        dialog(202, { entity: { username: 'synthetic_miron' } }),
        dialog(-100203, { isUser: false, isChannel: true, entity: { username: 'synthetic_news' } }),
    ] }) as any);
    for (const query of ['@synthetic_miron', 'synthetic_miron']) {
        const result = await listTelegramConversations({ ...range, query });
        assert.deepEqual(result.items.map(item => item.chatId), ['202']);
    }
    const channel = await listTelegramConversations({ ...range, chatType: 'channel', query: '@synthetic_news' });
    assert.deepEqual(channel.items.map(item => item.chatId), ['-100203']);
});

test('catalog scan limit is explicitly partial and an upper time boundary is exclusive', async t => {
    const init = t.mock.method(telegram, 'initTelegramClient', async () => ({ getDialogs: async ({ limit }: any) => Array.from({ length: limit }, (_, i) => dialog(2000 + i)) }) as any);
    const cursor = Buffer.from(JSON.stringify({ ...range, kind: 'dialogs', peer: '201', messageId: 50, date: second, offset: 980, query: '', chatType: 'conversations' })).toString('base64url');
    const result = await listTelegramConversations({ cursor, limit: 20 });
    assert.equal(result.scanLimitReached, true); assert.equal(result.complete, false); assert.equal(result.nextCursor, undefined);
    init.mock.mockImplementation(async () => ({ getMessages: async () => [message(3, { date: Date.parse(range.until) / 1000 }), message(2, { date: second })] }) as any);
    const history = await readTelegramConversation({ ...range, chatId: '202' });
    assert.deepEqual(history.items.map(m => m.messageId), [2]); assert.equal(history.complete, true);
});

test('coverage follows consumed cursors and distinguishes unvisited chats and abbreviated text', () => {
    const catalog: any = { id: 'find', tool: 'telegram.listConversations', status: 'ok', summary: '', data: { items: [{ chatId: '202' }], nextCursor: 'catalog-next' } };
    assert.match(telegramHistoryCoverage([catalog])!, /не прочитано найденных чатов: 1/);
    const pages: any[] = [catalog, { ...catalog, id: 'next', data: { items: [], cursor: 'catalog-next' } },
        { id: 'history', tool: 'telegram.getHistory', status: 'ok', data: { chatId: '202', items: [], nextCursor: 'history-next' } }];
    assert.match(telegramHistoryCoverage(pages)!, /есть продолжение чтения \(источников: 1\)/);
    pages.push({ id: 'history-next', tool: 'telegram.getHistory', status: 'ok', data: { chatId: '202', cursor: 'history-next', items: [] } });
    assert.equal(telegramHistoryCoverage(pages), undefined);
    pages.at(-1).data.items.push({ textTruncated: true });
    assert.match(telegramHistoryCoverage(pages)!, /с сокращением/);
});

test('frequency counts deduplicate message IDs and keep chats, periods and message direction separate', () => {
    const page = (chatId: string, items: any[], period = range) => ({ id: 'read', tool: 'telegram.getHistory', status: 'ok' as const, summary: '', data: { ...period, chatId, chatTitle: 'Учебный чат', items } });
    const stats = telegramHistoryStatistics([
        page('202', [{ messageId: 1, isOwn: true }, { messageId: 2, isOwn: false }]),
        page('202', [{ messageId: 1, isOwn: true }, { messageId: 3, isOwn: true }]),
        page('203', [{ messageId: 1, isOwn: false }]),
        page('202', [{ messageId: 1, isOwn: true }], { since: '2026-11-12T00:00:00Z', until: range.since }),
    ]);
    assert.deepEqual(stats.map(({ chatId, incoming, outgoing, total }) => ({ chatId, incoming, outgoing, total })), [
        { chatId: '202', incoming: 1, outgoing: 2, total: 3 }, { chatId: '202', incoming: 0, outgoing: 1, total: 1 }, { chatId: '203', incoming: 1, outgoing: 0, total: 1 },
    ]);
});

test('rejected graph reasons stay in diagnostics and partial tool texts are replaced by one synthesis', async t => {
    const warning = t.mock.method(console, 'warn', () => {});
    let step = 0; let reads = 0; let answers = 0;
    const registry = new ToolRegistry(telegramTools().map(tool => ({ ...tool, execute: async (args: any) => {
        reads++; return { status: 'ok' as const, summary: 'Учебные данные', result: { responseText: 'Промежуточный частный ответ' },
            data: tool.name === 'telegram.listConversations' ? { ...range, items: [{ chatId: '202' }] } : { ...range, chatId: args.chatId, items: [] } };
    } })), () => true);
    const result = await runKiraRuntime(context(), { registry, persist: async () => {}, decide: async () => {
        if (++step === 1) return { calls: [{ id: 'bad', tool: 'telegram.listConversations', args: { query: 'synthetic-private-argument' }, dependsOn: ['missing'] }] };
        if (step === 2) { assert.equal(reads, 0); return { calls: [{ id: 'find', tool: 'telegram.listConversations', args: {} }] }; }
        if (step === 3) return { calls: [{ id: 'read', tool: 'telegram.getHistory', args: { chatId: '202' } }] };
        return { finish: true };
    }, respond: async (_input, evidence) => { answers++; assert.doesNotMatch(evidence, /Неизвестная зависимость/); return { responseText: 'Единый итог.' }; } });
    assert.equal(result.responseText, 'Единый итог.'); assert.equal(result.operationStatus, 'ok'); assert.equal(answers, 1);
    const log = warning.mock.calls.find(call => call.arguments[0] === '[KIRA runtime] plan rejected');
    assert.equal((log?.arguments[1] as any)?.code, 'unknown_dependency');
    assert.doesNotMatch(JSON.stringify(log?.arguments), /synthetic-private-argument/);
});

test('runtime cannot declare a history request complete without checking Telegram', async t => {
    const value = context();
    const result = await runKiraRuntime(value, { persist: async () => {}, decide: async () => ({ finish: true }), respond: async (_input, evidence) => {
        assert.match(evidence, /история Telegram не проверена/); return { responseText: 'Нет проверенных сообщений.' };
    } });
    assert.equal(result.operationStatus, 'failed'); assert.equal(result.responseText, 'Нет проверенных сообщений.');
});

test('a premature model finish is replanned before failing an available history task', async t => {
    const old = config.allowedUserId; config.allowedUserId = 101; t.after(() => { config.allowedUserId = old; });
    t.mock.method(telegram, 'initTelegramClient', async () => ({ getDialogs: async () => [], getMessages: async () => [] }) as any);
    let decisions = 0;
    const result = await runKiraRuntime(context(), { persist: async () => {}, decide: async ({ context: c }) => {
        if (++decisions === 1) return { finish: true };
        if (decisions === 2) {
            assert.ok(c.observations.some(o => o.tool === 'kernel.requireSource'));
            return { calls: [{ id: 'find', tool: 'telegram.listConversations', args: {} }] };
        }
        return { finish: true };
    }, respond: async (_input, evidence) => { assert.doesNotMatch(evidence, /kernel.requireSource/); return { responseText: 'За сегодня доступных переписок не найдено.' }; } });
    assert.equal(result.operationStatus, 'ok'); assert.equal(decisions, 3);
});

test('a serialized legacy analysis continuation keeps its already confirmed read result', async () => {
    const value = context();
    const previous: any = JSON.parse(JSON.stringify({ version: 1, runId: 'legacy-analysis', status: 'running', startedAt: Date.now(), updatedAt: Date.now(), receipts: [], agents: [], skills: ['telegram-reading'], toolNames: ['telegram.readMessages'],
        observations: [{ id: 'legacy-read', tool: 'telegram.readMessages', status: 'ok', summary: 'Подтверждённая сводка учебного чата за неделю.' }], completedCalls: { 'legacy-read': 'ok' } }));
    const result = await runKiraRuntime(value, { continuation: previous, persist: async () => {}, decide: async () => ({ finish: true }),
        respond: async (_input, evidence) => { assert.match(evidence, /Подтверждённая сводка/); return { responseText: 'Сводка готова.' }; } });
    assert.equal(result.operationStatus, 'ok');
});

test('runtime labels a catalogue-only result partial even if the model finishes early', async t => {
    const old = config.allowedUserId; config.allowedUserId = 101; t.after(() => { config.allowedUserId = old; });
    t.mock.method(telegram, 'initTelegramClient', async () => ({ getDialogs: async () => [dialog(202)] }) as any);
    let step = 0;
    const result = await runKiraRuntime(context(), { persist: async () => {}, decide: async () => ++step === 1 ? { calls: [{ id: 'list', tool: 'telegram.listConversations', args: range }] } : { finish: true },
        respond: async (_input, evidence) => { assert.match(evidence, /Обзор частичный/); return { responseText: 'Найден учебный чат.' }; } });
    assert.match(result.responseText, /Обзор частичный.*не прочитано найденных чатов: 1/);
    assert.equal(result.operationStatus, 'failed');
});

test('large multi-chat reads retain an explicit answer-context coverage warning', async () => {
    const chats = Array.from({ length: 6 }, (_, i) => ({ chatId: String(200 + i), title: `Учебный чат ${i}` }));
    const registry = new ToolRegistry(telegramTools().map(tool => ({ ...tool, execute: async (args: any) => ({ status: 'ok' as const, summary: 'Учебные данные.',
        data: tool.name === 'telegram.listConversations' ? { items: chats, complete: true } : { chatId: args.chatId, items: [{ text: 'а'.repeat(7000) }], complete: true } }) })), () => true);
    let step = 0;
    const result = await runKiraRuntime(context(), { registry, persist: async () => {}, decide: async () => ++step === 1
        ? { calls: [{ id: 'find', tool: 'telegram.listConversations', args: {} }] }
        : step === 2 ? { calls: chats.map((chat, i) => ({ id: `read${i}`, tool: 'telegram.getHistory', args: { chatId: chat.chatId } })) } : { finish: true },
        respond: async (_input, evidence) => { assert.ok(evidence.length <= 40_000); assert.match(evidence, /не поместилась/); return { responseText: 'Учебная выжимка.' }; } });
    assert.match(result.responseText, /Обзор частичный.*не поместилась/);
});

test('unavailable, empty, cancelled and denied history remain distinct; tools are private owner reads', async t => {
    const old = config.allowedUserId; config.allowedUserId = 101; t.after(() => { config.allowedUserId = old; });
    const registry = createKiraToolRegistry(), value = context();
    for (const name of ['telegram.listConversations', 'telegram.getHistory']) {
        const def = registry.get(name)!; assert.equal(def.effect, 'read'); assert.equal(def.privateOnly, true);
        const other = context(); other.ctx.from!.id = 102;
        assert.equal((await registry.execute(name, {}, other)).status, 'failed');
        const group = context(); (group.ctx.chat as any).type = 'group';
        assert.equal((await registry.execute(name, {}, group)).status, 'failed');
    }
    assert.equal((await registry.execute('telegram.getHistory', { chatId: '202' }, value)).status, 'failed');
    const init = t.mock.method(telegram, 'initTelegramClient', async () => undefined);
    assert.equal((await registry.execute('telegram.listConversations', {}, value)).status, 'failed');
    init.mock.mockImplementation(async () => ({ getDialogs: async () => [] }) as any);
    const empty = await registry.execute('telegram.listConversations', {}, { ...value, readOnly: true });
    assert.equal(empty.status, 'ok'); assert.equal((empty.data as any).complete, true);
    const abort = new AbortController(); abort.abort();
    await assert.rejects(listTelegramConversations({}, abort.signal));
    init.mock.mockImplementation(async () => ({ getMessages: async () => { throw Error('Synthetic provider details'); } }) as any);
    value.observations = [{ id: 'list', tool: 'telegram.listConversations', status: 'ok', summary: '', data: { items: [{ chatId: '202' }] } }];
    const failure = await registry.execute('telegram.getHistory', { chatId: '202' }, value);
    assert.equal(failure.status, 'failed'); assert.doesNotMatch(failure.summary, /Synthetic provider/);
});

test('actual runtime preserves catalog and history through planning, session JSON and final synthesis', async t => {
    const old = config.allowedUserId; config.allowedUserId = 101; t.after(() => { config.allowedUserId = old; });
    t.mock.method(telegram, 'initTelegramClient', async () => ({ getDialogs: async () => [dialog(202)], getMessages: async () => [message(9, { out: true }), message(8)] }) as any);
    const value = context(); let step = 0;
    const result = await runKiraRuntime(value, {
        persist: async c => { JSON.parse(JSON.stringify(c.ctx.session.agentRuntime)); },
        decide: async ({ context: c }) => {
            if (++step === 1) return { calls: [{ id: 'find', tool: 'telegram.listConversations', args: range }] };
            if (step === 2) {
                const data = c.observations.find(o => o.id === 'find')!.data as any;
                assert.equal(data.items[0].chatId, '202');
                return { calls: [{ id: 'read', tool: 'telegram.getHistory', args: { ...range, chatId: data.items[0].chatId } }] };
            }
            return { finish: true };
        },
        respond: async (_input, evidence) => {
            assert.match(evidence, /Учебный чат 202/); assert.match(evidence, /Учебное сообщение 9/); assert.match(evidence, /"isOwn":true/);
            return { responseText: 'Учебная сводка: владелец обсудил отчёт с собеседником.' };
        },
    });
    assert.equal(result.operationStatus, 'ok'); assert.match(result.responseText, /Учебная сводка/);
    assert.deepEqual(value.ctx.session.agentRuntime?.toolNames, ['telegram.listConversations', 'telegram.getHistory']);
});
