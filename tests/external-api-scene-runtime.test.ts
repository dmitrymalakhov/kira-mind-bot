import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { Bot, InlineKeyboard } from 'grammy';
import type { BotContext, SessionData } from '../types';
import { BotApiBackend } from '../api/backend';
import { parseSceneTurn } from '../api/scene';
import { TypeORMSessionStorage } from '../services/SessionStorage';
import * as history from '../utils/history';
import * as orchestrator from '../orchestrator';
import * as completion from '../ai/chatCompletion';
import * as reconsolidation from '../services/MemoryReconsolidationService';
import { getActiveAiPresetName } from '../services/aiRuntimeConfigService';
import { DialogueJobRepository } from '../services/DialogueJobRepository';

const owner = 730001;
const botToken = '1234567890:abcdefghijklmnopqrstuvwxyzABCDE';
const botInfo = { id: 1234567890, is_bot: true, first_name: 'Test', username: 'synthetic_bot' } as any;
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]);
const room = '11111111-1111-4111-8111-111111111111', space = '22222222-2222-4222-8222-222222222222';
const chair = '33333333-3333-4333-8333-333333333333', seat = '44444444-4444-4444-8444-444444444444';

function scene() {
    return {
        roomId: room, roomVersion: 3, coordinateSpaceId: space, tracking: 'normal', observedAt: new Date().toISOString(),
        avatar: { position: [0.5, 0, -0.4], yaw: 0, pose: 'standing' },
        objects: [{ id: chair, name: 'Синтетический стул', category: 'chair', center: [0, 0.24, -1], size: [0.45, 0.48, 0.45], yaw: 3.14, source: 'user', present: true }],
        seats: [{ id: seat, objectId: chair, height: 0.47, yaw: 3.14, confirmed: true }],
    };
}

function fixture(t: TestContext, actions: unknown[] = []) {
    const rows = new Map<string, SessionData>();
    t.mock.method(TypeORMSessionStorage.prototype, 'read', async (key: string) => rows.has(key) ? structuredClone(rows.get(key)) : undefined);
    t.mock.method(TypeORMSessionStorage.prototype, 'write', async (key: string, value: SessionData) => { rows.set(key, structuredClone(value)); });
    t.mock.method(history, 'addToHistory', async (ctx: BotContext, role: string, content: string, options: { kind?: 'image' } = {}) => {
        ctx.session.messageHistory.unshift({ role, content, timestamp: new Date(), ...(options.kind ? { kind: options.kind } : {}) });
    });
    t.mock.method(reconsolidation, 'reconsolidateAfterResponse', async () => {});
    t.mock.method(DialogueJobRepository, 'beginTurn', async () => {});
    const chosen: string[] = [];
    t.mock.method(completion, 'createJsonChatCompletionForTask', async (task: string) => { chosen.push(`${task}@${await getActiveAiPresetName()}`); return { actions }; });
    const bot = new Bot<BotContext>(botToken, { botInfo });
    bot.api.config.use(async () => { assert.fail('a room turn must never call Telegram'); });
    const models: any = { read: async () => ({ preset: 'gpt-lean', revision: 'synthetic' }) };
    const backend = new BotApiBackend(bot, { token: 'synthetic-scene-token-with-at-least-32-characters', ownerId: owner, host: '127.0.0.1', port: 0 }, models);
    return { backend, rows, chosen };
}

test('words in the AR room go through the same text handlers and dialogue as the chat, with the room as context', async t => {
    const f = fixture(t);
    const seen: Array<{ text: string; key?: string; room?: BotContext['arRoom']; preset: string }> = [];
    t.mock.method(orchestrator, 'processMessage', async (ctx: BotContext, text: string) => {
        seen.push({ text, key: ctx.sessionStorageKey, room: ctx.arRoom, preset: await getActiveAiPresetName() });
        return { responseText: 'Поставила напоминание на завтра, 10:00.', keyboard: new InlineKeyboard().text('Отменить', 'synthetic:cancel') };
    });
    const turn = parseSceneTurn({ text: 'Напомни завтра в десять полить цветы', scene: scene() });
    const reply = await f.backend.sceneTurn(turn, await f.backend.sceneReady(turn)) as any;
    assert.deepEqual(seen.map(s => [s.text, s.key, s.preset, s.room?.frame]), [['Напомни завтра в десять полить цветы', `api:${owner}`, 'gpt-lean', false]]);
    assert.match(seen[0].room!.context, /AR-комнате/);
    assert.match(seen[0].room!.context, /Синтетический стул/);
    const text = reply.messages.find((m: any) => m.text === 'Поставила напоминание на завтра, 10:00.');
    assert.ok(text?.buttons?.[0]?.[0]?.actionToken);                                     // a button works as in the chat
    assert.deepEqual(f.chosen, ['intentClassification@gpt-lean']);
    const dialogue = f.rows.get(`api:${owner}`)!.messageHistory.map(m => [m.role, m.content]);
    assert.deepEqual(dialogue, [['bot', 'Поставила напоминание на завтра, 10:00.'], ['user', 'Напомни завтра в десять полить цветы']]);
    // the chat's next text turn has no room context
    seen.length = 0;
    await f.backend.message('Спасибо');
    assert.equal(seen[0].room, undefined);
});

test('a look in the AR room is a photo for Kira\'s recognition; what she read stays visual context, never facts', async t => {
    const f = fixture(t);
    const read: Array<{ buffer: Buffer; caption: string; room?: BotContext['arRoom']; preset: string }> = [];
    t.mock.method(orchestrator, 'processImage', async (ctx: BotContext, buffer: Buffer, caption: string) => {
        read.push({ buffer, caption, room: ctx.arRoom, preset: await getActiveAiPresetName() });
        return { responseText: 'Вижу стул у стены и кружку на нём.', description: 'Синтетический стул, на сиденье кружка.' };
    });
    const capabilities = await f.backend.sceneCapabilities() as any;
    const photo = (await f.backend.capabilities() as any).photo.vision;
    assert.deepEqual(capabilities.vision, photo);                                         // the frame's recipient is the photo model
    const turn = parseSceneTurn({ text: 'Что ты видишь?', scene: scene(),
        frame: { mime: 'image/jpeg', data: jpeg.toString('base64'), capturedAt: new Date().toISOString(), width: 1024, height: 768 } });
    const reply = await f.backend.sceneTurn(turn, await f.backend.sceneReady(turn)) as any;
    assert.equal(read.length, 1);
    assert.deepEqual(read[0].buffer, jpeg);
    assert.deepEqual([read[0].caption, read[0].preset, read[0].room?.frame], ['Что ты видишь?', 'gpt-lean', true]);
    assert.ok(reply.messages.some((m: any) => m.text === 'Вижу стул у стены и кружку на нём.'));
    assert.deepEqual([reply.vision.used, reply.vision.model], [true, photo.model]);
    const dialogue = f.rows.get(`api:${owner}`)!.messageHistory;
    assert.ok(dialogue.some(m => m.role === 'user' && m.content === '[Кадр камеры в AR-комнате] с подписью: "Что ты видишь?"' && m.kind === undefined));
    assert.ok(dialogue.filter(m => m.role === 'bot').every(m => m.kind === 'image'));
    assert.ok(![...f.rows.values()].some(row => JSON.stringify(row).includes(jpeg.toString('base64'))));
    assert.equal((f.backend as any).photoInputs.size, 0);
});

test('the phone\'s report of an action joins the same dialogue', async t => {
    const f = fixture(t, [{ kind: 'sit' }]);
    t.mock.method(orchestrator, 'processMessage', async () => ({ responseText: 'Сейчас найду, куда сесть.', skipOptionalFollowups: true }));
    const turn = parseSceneTurn({ text: 'Садись', scene: scene() });
    const reply = await f.backend.sceneTurn(turn, await f.backend.sceneReady(turn)) as any;
    assert.equal(reply.actions.length, 1);
    await f.backend.sceneActionResult({ actionId: reply.actions[0].id, status: 'completed', targetId: chair, detail: 'выбрано место: Синтетический стул; села' });
    assert.equal(f.rows.get(`api:${owner}`)!.messageHistory[0].content,
        '[Результат действия «сесть» в AR — выполнено: ты смогла сесть (выбрано место: Синтетический стул; села)]');
});
