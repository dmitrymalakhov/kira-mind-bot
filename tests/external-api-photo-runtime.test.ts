import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { Bot } from 'grammy';
import type { BotContext, SessionData } from '../types';
import { BotApiBackend } from '../api/backend';
import { TypeORMSessionStorage } from '../services/SessionStorage';
import * as storage from '../services/SessionStorage';
import * as history from '../utils/history';
import * as orchestrator from '../orchestrator';
import * as health from '../agents/healthAgent';
import * as image from '../agents/imageAgent';
import * as memory from '../utils/agentMemoryContext';
import * as completion from '../ai/chatCompletion';
import * as reminder from '../reminder';
import { getActiveAiPresetName } from '../services/aiRuntimeConfigService';
import { resolveModelForTaskAsync } from '../ai/modelResolver';
import { runWithChannelPreset } from '../services/aiRuntimeConfigService';
import { DialogueJobRepository } from '../services/DialogueJobRepository';
import { registerPhotoMessageHandler } from '../handlers/photoMessages';

const owner = 730001;
const botToken = '1234567890:abcdefghijklmnopqrstuvwxyzABCDE';
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]);
const botInfo = { id: 1234567890, is_bot: true, first_name: 'Test', username: 'synthetic_bot' } as any;
const emptySession = (): SessionData => ({ reminders: [], messageHistory: [], dialogueSummary: '', lastSummarizedIndex: -1, domains: {} });

function fixture(t: TestContext) {
    let saved: SessionData | undefined;
    const keys: string[] = [];
    t.mock.method(TypeORMSessionStorage.prototype, 'read', async (key: string) => { keys.push(key); return saved; });
    t.mock.method(TypeORMSessionStorage.prototype, 'write', async (key: string, value: SessionData) => { keys.push(key); saved = structuredClone(value); });
    t.mock.method(history, 'addToHistory', async (ctx: BotContext, role: string, content: string) => {
        ctx.session.messageHistory.unshift({ role, content, timestamp: new Date() });
    });
    t.mock.method(DialogueJobRepository, 'beginTurn', async () => {});
    const activate = t.mock.method(DialogueJobRepository, 'activate', async () => {});
    const bot = new Bot<BotContext>(botToken, { botInfo });
    bot.api.config.use(async () => { assert.fail('photo input must never call Telegram'); });
    const models: any = { read: async () => ({ preset: 'gpt-lean', revision: 'synthetic' }) };
    const backend = new BotApiBackend(bot, { token: 'synthetic-photo-token-with-at-least-32-characters', ownerId: owner, host: '127.0.0.1', port: 0 }, models);
    return { backend, saved: () => saved!, keys, activate };
}

test('capabilities expose the exact conversation model of the app preset and honest photo storage notes', async t => {
    const f = fixture(t);
    const capabilities = await f.backend.capabilities();
    assert.deepEqual(capabilities.input, ['text', 'actions', 'photo']);
    assert.deepEqual(capabilities.photo.mime, ['image/jpeg']); assert.equal(capabilities.photo.maxBytes, 2_000_000);
    const actual = await runWithChannelPreset('gpt-lean', () => resolveModelForTaskAsync('conversation'));
    assert.equal(capabilities.photo.vision.model, actual.modelRef.model);
    assert.equal(capabilities.photo.vision.provider, actual.modelRef.provider);
    assert.equal(capabilities.photo.vision.available, true);
    assert.equal(capabilities.photo.notes, 'Фото анализируется один раз и не сохраняется; в историю попадает только текст.');
    assert.deepEqual(capabilities.output, ['text', 'photo', 'document', 'voice']);
});

test('API photos share the canonical pipeline and API session; only text survives the turn', async t => {
    const f = fixture(t);
    const process = t.mock.method(orchestrator, 'processImage', async (ctx: BotContext, buffer: Buffer, caption: string) => {
        assert.equal(ctx.sessionStorageKey, `api:${owner}`); assert.equal(ctx.from!.id, owner); assert.equal(ctx.chat!.id, owner);
        assert.equal(await getActiveAiPresetName(), 'gpt-lean'); assert.equal(ctx.allowDeferredDialogue, false);
        assert.deepEqual(buffer, jpeg); assert.equal(caption, 'Что на фото?');
        return { responseText: 'На фото тестовый кот.', description: 'Кот на зелёном коврике.', detectedText: 'Тестовая надпись' };
    });
    const reply = await f.backend.photo(jpeg, 'Что на фото?');
    assert.equal(process.mock.callCount(), 1);
    assert.ok(reply.messages.some(message => message.type === 'text' && message.text === 'На фото тестовый кот.'));
    assert.ok(f.saved().messageHistory.some(message => message.content === '[Изображение] с подписью: "Что на фото?"'));
    assert.ok(f.saved().messageHistory.some(message => message.content === 'Кот на зелёном коврике.'));
    assert.ok(!JSON.stringify(f.saved()).includes(jpeg.toString('base64')));
    assert.ok(!JSON.stringify(f.saved()).includes('"type":"Buffer"'));
    assert.ok(f.keys.every(key => key === `api:${owner}`)); assert.equal(f.activate.mock.callCount(), 0);
    assert.equal((f.backend as any).photoInputs.size, 0);
});

test('a medical caption reaches healthPhotoAgent with synthetic file metadata and the same bytes', async t => {
    const f = fixture(t);
    t.mock.method(orchestrator, 'processImage', async () => { assert.fail('health photo must use the diary'); });
    const analyze = t.mock.method(health, 'healthPhotoAgent', async (ctx: BotContext, data: Buffer, caption: string, fileId: string, messages: any[], _extra: Buffer[], fileIds: string[]) => {
        assert.equal(ctx.sessionStorageKey, `api:${owner}`); assert.deepEqual(data, jpeg);
        assert.equal(caption, 'Сыпь на руке'); assert.match(fileId, /^api-photo-/); assert.deepEqual(fileIds, [fileId]);
        assert.ok(messages.some(message => message.content.includes('Сыпь на руке')));
        return { responseText: 'Сохранила текстовое наблюдение.' };
    });
    assert.equal((await f.backend.photo(jpeg, 'Сыпь на руке')).messages[0].text, 'Сохранила текстовое наблюдение.');
    assert.equal(analyze.mock.callCount(), 1);
});

test('analysis failure is a normal reply and never logs the image or raw provider error', async t => {
    const f = fixture(t);
    const logs: unknown[][] = [];
    t.mock.method(console, 'error', (...args: unknown[]) => { logs.push(args); });
    t.mock.method(orchestrator, 'processImage', async () => { throw new Error(`synthetic-private-body ${jpeg.toString('base64')}`); });
    const result = await f.backend.photo(jpeg);
    assert.match(result.messages[0].text!, /не смогла его детально проанализировать/);
    assert.ok(f.saved().messageHistory.some(message => message.content === '[Изображение]'));
    assert.ok(!JSON.stringify(logs).includes(jpeg.toString('base64')));
    assert.ok(!JSON.stringify(logs).includes('synthetic-private-body'));
    assert.equal((f.backend as any).photoInputs.size, 0);
});

test('skills mode inspects the photo once and persists no attached bytes in its ledger', async t => {
    const f = fixture(t);
    const previous = process.env.KIRA_ORCHESTRATION_MODE;
    process.env.KIRA_ORCHESTRATION_MODE = 'skills';
    t.after(() => { if (previous === undefined) delete process.env.KIRA_ORCHESTRATION_MODE; else process.env.KIRA_ORCHESTRATION_MODE = previous; });
    t.mock.method(memory, 'fetchAgentMemoryContext', async () => ({ context: '', recalledMemories: [] }) as any);
    const ledgers: string[] = [];
    t.mock.method(storage, 'persistAgentRuntime', async (ctx: BotContext) => { ledgers.push(JSON.stringify(ctx.session.agentRuntime)); });
    const inspect = t.mock.method(image, 'imageAgent', async (data: Buffer, _caption: string, _history: any[], _images: Buffer[], _memory: string, options: any) => {
        assert.deepEqual(data, jpeg); assert.deepEqual(options, { readOnly: true });
        return { responseText: 'На фото синтетическая чашка.', description: 'Белая чашка.' };
    });
    const result = await f.backend.photo(jpeg);
    assert.equal(inspect.mock.callCount(), 1); assert.ok(result.messages.some(message => message.text?.includes('синтетическая чашка')));
    assert.ok(ledgers.length > 0);
    assert.ok(!JSON.stringify([ledgers, f.saved()]).includes(jpeg.toString('base64')));
});

test('the image agent itself does not log pixel-bearing provider exceptions', async t => {
    const logs: unknown[][] = [];
    t.mock.method(console, 'error', (...args: unknown[]) => { logs.push(args); });
    t.mock.method(completion, 'createChatCompletionForTask', async () => { throw new Error(jpeg.toString('base64')); });
    const result = await image.imageAgent(jpeg);
    assert.ok(result.responseText.length > 0); assert.ok(!JSON.stringify(logs).includes(jpeg.toString('base64')));
});

test('Telegram single photos and media groups retain their history and routing after extraction', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const bot = new Bot<BotContext>(botToken, { botInfo });
    const session = emptySession();
    const replies: string[] = [];
    let groupDone!: () => void;
    const completed = new Promise<void>(resolve => { groupDone = resolve; });
    bot.api.config.use(async (_prev, method, payload: any) => {
        if (method === 'getFile') return { ok: true, result: { file_id: payload.file_id, file_unique_id: payload.file_id, file_path: 'synthetic.jpg' } } as any;
        if (method === 'sendMessage') { replies.push(payload.text); if (payload.text === 'Ответ на группу') groupDone(); }
        return { ok: true, result: { message_id: replies.length + 1 } } as any;
    });
    bot.use(async (ctx, next) => { ctx.session = session; await next(); });
    t.mock.method(history, 'addToHistory', async (ctx: BotContext, role: string, content: string) => { ctx.session.messageHistory.unshift({ role, content, timestamp: new Date() }); });
    t.mock.method(reminder, 'getBotRef', () => bot);
    const single = t.mock.method(orchestrator, 'processImage', async (_ctx: BotContext, data: Buffer) => { assert.deepEqual(data, jpeg); return { responseText: 'Ответ на одно фото' }; });
    const group = t.mock.method(orchestrator, 'processImageGroup', async (_ctx: BotContext, images: Buffer[]) => { assert.equal(images.length, 2); return { responseText: 'Ответ на группу' }; });
    registerPhotoMessageHandler(bot, (async () => ({ arrayBuffer: async () => jpeg })) as any);
    const update = (id: number, media_group_id?: string): any => ({ update_id: id, message: { message_id: id, date: 1,
        from: { id: owner, is_bot: false, first_name: 'Owner' }, chat: { id: owner, type: 'private' },
        photo: [{ file_id: `synthetic-${id}`, file_unique_id: `synthetic-${id}`, width: 16, height: 16 }], caption: 'Кот', ...(media_group_id ? { media_group_id } : {}) } });
    await bot.handleUpdate(update(1));
    assert.equal(single.mock.callCount(), 1); assert.ok(replies.includes('Ответ на одно фото'));
    assert.ok(session.messageHistory.some(message => message.content === '[Изображение] с подписью: "Кот"'));
    await bot.handleUpdate(update(2, 'synthetic-group')); await bot.handleUpdate(update(3, 'synthetic-group'));
    t.mock.timers.tick(1000); await completed;
    assert.equal(group.mock.callCount(), 1);
    assert.ok(session.messageHistory.some(message => message.content === '[Группа изображений (2 шт.)] с подписью: "Кот"'));
});
