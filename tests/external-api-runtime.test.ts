import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Api, Bot, InlineKeyboard, InputFile } from 'grammy';
import { ApiActionTokens } from '../api/actionTokens';
import { ApiFiles } from '../api/files';
import { ApiTransport } from '../api/transport';
import { BotApiBackend } from '../api/backend';
import { PersistentApiOperations } from '../api/operations';
import { ApiError, ApiReply } from '../api/contracts';
import { AppDataSource } from '../data-source';
import { TypeORMSessionStorage } from '../services/SessionStorage';
import { buildHealthMenuResult } from '../agents/healthAgent';
import * as orchestrator from '../orchestrator';
import * as history from '../utils/history';
import * as reconsolidation from '../services/MemoryReconsolidationService';
import { saveMessageDraft, getMessageDraft, deleteMessageDraft } from '../agents/sendMessagesAgent';
import type { BotContext, SessionData } from '../types';

const token = 'synthetic-test-token-with-at-least-32-characters';
const owner = 730001;
const botToken = '1234567890:abcdefghijklmnopqrstuvwxyzABCDE';

test('actions are signed, bound to the owner, expire and reject tampering', t => {
    const signer = new ApiActionTokens(token, owner);
    const action = signer.sign(-123, 'health:log:food', 'Дневник');
    assert.equal(signer.verify(action).data, 'health:log:food');
    assert.throws(() => signer.verify(action + 'x'), ApiError);
    assert.throws(() => new ApiActionTokens(token, 730002).verify(action), ApiError);
    assert.throws(() => new ApiActionTokens('different-synthetic-secret', owner).verify(action), ApiError);
    const now = Date.now();
    t.mock.method(Date, 'now', () => now + 16 * 60_000);
    assert.throws(() => signer.verify(action), (e: any) => e.code === 'action_expired');
});

test('transport captures text/buttons and files without sending them to Telegram', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kira-api-files-test-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const files = new ApiFiles(directory);
    const signer = new ApiActionTokens(token, owner);
    const upstream = new Api(botToken);
    let externalCalls = 0;
    upstream.config.use(async () => { externalCalls++; throw new Error('unexpected Telegram call'); });
    const transport = new ApiTransport(botToken, owner, signer, files, upstream);
    const sent = await transport.api.sendMessage(owner, 'Выбери действие', {
        reply_markup: new InlineKeyboard().text('Подтвердить', 'send_message'),
    });
    await transport.api.editMessageText(owner, sent.message_id, 'Обновлено');
    await transport.api.sendDocument(owner, new InputFile(Buffer.from('synthetic content'), 'example.txt'));
    await transport.api.sendChatAction(owner, 'typing');
    const messages = transport.result().messages;
    assert.equal(messages.length, 3);
    assert.equal(signer.verify(messages[0].buttons![0][0].actionToken!).messageId, sent.message_id);
    assert.equal(messages[1].replacesMessageId, sent.message_id);
    const id = messages[2].fileUrl!.split('/').pop()!;
    assert.equal((await files.read(id)).data.toString(), 'synthetic content');
    await assert.rejects(files.read('../example.txt'), ApiError);
    assert.equal(externalCalls, 0);
    await assert.rejects(transport.api.sendMessage(730002, 'must require confirmation'), ApiError);
    await assert.rejects(transport.api.editMessageText(owner, 123, 'Telegram message'), ApiError);
    await assert.rejects(transport.api.deleteMessage(owner, 123), ApiError);
    const expired = new Date(Date.now() - 25 * 60 * 60_000);
    await fs.utimes(path.join(directory, `${id}.bin`), expired, expired);
    await assert.rejects(files.read(id), (e: any) => e.code === 'file_not_found');
});

test('backend reuses health command and callback handlers with a persistent API-only dialogue', async t => {
    let stored: SessionData | undefined;
    const keys: string[] = [];
    t.mock.method(TypeORMSessionStorage.prototype, 'read', async (key: string) => {
        keys.push(key);
        return stored ? structuredClone(stored) : undefined;
    });
    t.mock.method(TypeORMSessionStorage.prototype, 'write', async (key: string, session: SessionData) => {
        keys.push(key);
        stored = structuredClone(session);
    });
    const botInfo = { id: 1234567890, is_bot: true, first_name: 'Test assistant', username: 'synthetic_bot' } as any;
    const bot = new Bot<BotContext>(botToken, { botInfo });
    bot.api.config.use(async () => { throw new Error('No Telegram traffic expected'); });
    const options = { token, ownerId: owner, host: '127.0.0.1', port: 3200 };
    const backend = new BotApiBackend(bot, options);
    const result = await backend.message('/health');
    const menu = result.messages.find(item => item.text === buildHealthMenuResult().responseText)!;
    assert.ok(menu);
    assert.equal(menu.buttons!.flat().length, 11);
    const action = menu.buttons![0][0].actionToken!;
    const reply = await backend.action(action);
    assert.ok(reply.messages.length > 0);
    assert.equal(stored!.pendingHealthLog?.mode, 'food');
    assert.ok(keys.every(key => key === `api:${owner}`));
    assert.ok((await backend.history(20)).messages.length > 0);
    await assert.rejects(backend.action(action), (e: any) => e.code === 'action_expired');
});

test('mobile text awaits the shared orchestration result and retains owner identity', async t => {
    let stored: SessionData | undefined;
    t.mock.method(TypeORMSessionStorage.prototype, 'read', async () => stored);
    t.mock.method(TypeORMSessionStorage.prototype, 'write', async (_key: string, session: SessionData) => { stored = session; });
    t.mock.method(history, 'addToHistory', async (ctx: BotContext, role: string, content: string) => {
        ctx.session.messageHistory.unshift({ role, content, timestamp: new Date() });
    });
    t.mock.method(reconsolidation, 'reconsolidateAfterResponse', async () => {});
    let processed = false;
    t.mock.method(orchestrator, 'processMessage', async (ctx: BotContext, text: string) => {
        assert.equal(ctx.chat!.id, owner);
        assert.equal(ctx.from!.id, owner);
        assert.equal(ctx.sessionStorageKey, `api:${owner}`);
        assert.equal(text, 'Привет из приложения');
        await Promise.resolve();
        processed = true;
        return { responseText: 'Общий ответ', keyboard: new InlineKeyboard() };
    });
    const bot = new Bot<BotContext>(botToken, { botInfo: {
        id: 1234567890, is_bot: true, first_name: 'Test', username: 'synthetic_bot',
    } as any });
    const backend = new BotApiBackend(bot, { token, ownerId: owner, host: '127.0.0.1', port: 3200 });
    const reply = await backend.message('Привет из приложения');
    assert.ok(processed);
    assert.ok(reply.messages.some(item => item.text === 'Общий ответ'));
    assert.ok(stored!.messageHistory.some(item => item.role === 'bot' && item.content === 'Общий ответ'));
});

test('Telegram and mobile drafts cannot overwrite or send each other’s draft', () => {
    const key = `api:${owner}`;
    saveMessageDraft(owner, 730002, 'Telegram draft');
    saveMessageDraft(owner, 730003, 'Mobile draft', null, false, false, undefined, 'text', key);
    assert.equal(getMessageDraft(owner)!.text, 'Telegram draft');
    assert.equal(getMessageDraft(owner, key)!.text, 'Mobile draft');
    assert.equal(getMessageDraft(owner, key)!.originalChatId, owner);
    deleteMessageDraft(owner, key);
    assert.equal(getMessageDraft(owner, key), undefined);
    assert.equal(getMessageDraft(owner)!.text, 'Telegram draft');
    deleteMessageDraft(owner);
});

test('durable receipts survive a new store and prevent re-execution of uncertain operations', async t => {
    const rows = new Map<string, any>();
    const fakeRepo = {
        createQueryBuilder: () => {
            let values: any;
            const builder: any = {
                insert: () => builder, values: (data: any) => { values = data; return builder; },
                orIgnore: () => builder, returning: () => builder,
                execute: async () => {
                    if (rows.has(values.key)) return { raw: [] };
                    rows.set(values.key, values);
                    return { raw: [{ key: values.key }] };
                },
            };
            return builder;
        },
        findOneByOrFail: async ({ key }: any) => rows.get(key),
        update: async ({ key }: any, patch: any) => { Object.assign(rows.get(key), patch); },
    };
    t.mock.method(AppDataSource, 'getRepository', () => fakeRepo as any);
    let executions = 0;
    const work = async (): Promise<ApiReply> => { executions++; return { messages: [] }; };
    const first = new PersistentApiOperations();
    await first.run('test-key', 'test-fingerprint', work);
    await new PersistentApiOperations().run('test-key', 'test-fingerprint', work);
    assert.equal(executions, 1);
    await assert.rejects(first.run('test-key', 'other', work), (e: any) => e.code === 'idempotency_conflict');
    await assert.rejects(first.run('failed-key', 'same', async () => { throw new Error('interrupted'); }));
    await assert.rejects(new PersistentApiOperations().run('failed-key', 'same', work), (e: any) => e.code === 'operation_uncertain');
    assert.equal(executions, 1);
});

test('API session storage fails closed when the database is unavailable', async t => {
    t.mock.method(AppDataSource, 'getRepository', () => { throw new Error('synthetic DB failure'); });
    await assert.rejects(new TypeORMSessionStorage(true).read(`api:${owner}`), /synthetic DB failure/);
    await assert.rejects(new TypeORMSessionStorage(true).write(`api:${owner}`, {} as SessionData));
});
