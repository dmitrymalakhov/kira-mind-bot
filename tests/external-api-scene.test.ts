import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type { AddressInfo } from 'node:net';
import { ApiBackend, ApiError, ApiOperationStore, ApiReply } from '../api/contracts';
import { createExternalApiServer } from '../api/server';
import { parseSceneTurn, roomContext, SceneService, validateActions, wantsPlainSit, MAX_FRAME_BYTES,
    type SceneChannel, type VisionRoute } from '../api/scene';
import type { ApiModelSelection, ApiModelSettingsStore } from '../api/modelSettings';
import type { AiPresetName } from '../ai/modelPresets';
import { getActiveAiPresetName } from '../services/aiRuntimeConfigService';
import { TypeORMSessionStorage } from '../services/SessionStorage';
import type { MessageHistory, SessionData } from '../types';

const token = 'synthetic-test-token-with-at-least-32-characters';
const owner = 730001;
const room = '11111111-1111-4111-8111-111111111111', space = '22222222-2222-4222-8222-222222222222';
const chair = '33333333-3333-4333-8333-333333333333', seat = '44444444-4444-4444-8444-444444444444';
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]);

function scene(changes: Record<string, unknown> = {}) {
    const now = new Date().toISOString();
    return {
        roomId: room, roomVersion: 3, coordinateSpaceId: space, tracking: 'normal', observedAt: now,
        camera: { position: [0, 1.4, 1.2], forward: [0, -0.2, -0.98] },
        avatar: { position: [0.5, 0, -0.4], yaw: 0, pose: 'standing' },
        objects: [{ id: chair, name: 'Синтетический стул', category: 'chair', center: [0, 0.24, -1], size: [0.45, 0.48, 0.45], yaw: 3.14, source: 'user', present: true }],
        seats: [{ id: seat, objectId: chair, height: 0.47, yaw: 3.14, confirmed: true }],
        ...changes,
    };
}
const frame = (changes: Record<string, unknown> = {}) => ({ mime: 'image/jpeg', data: jpeg.toString('base64'), capturedAt: new Date().toISOString(), width: 1024, height: 768, ...changes });

class AppMode implements ApiModelSettingsStore {
    constructor(public selection: ApiModelSelection = { preset: null, revision: 'none' }) {}
    async read() { return this.selection; }
    async write(preset: AiPresetName | null) { this.selection = { preset, revision: 'r' }; return this.selection; }
}

/** The app's dialogue as a room turn sees it: what was said, looked at and noted, and under which mode. */
class Channel implements SceneChannel {
    said: Array<{ text: string; context: string; preset: AiPresetName | null }> = [];
    looked: Array<{ frame: Buffer; text: string; context: string; preset: AiPresetName | null }> = [];
    notes: string[] = [];
    routeModes: string[] = [];
    history: MessageHistory[] = [];
    route: VisionRoute = { available: true, provider: 'openai', providerLabel: 'OpenAI', model: 'gpt-synthetic', location: 'cloud' };
    reply: ApiReply = { messages: [{ id: -1, type: 'text', text: 'Ответ из общего диалога' }] };
    async say(text: string, room: { context: string }, preset: AiPresetName | null) { this.said.push({ text, context: room.context, preset }); return this.reply; }
    async look(frame: Buffer, text: string, room: { context: string }, preset: AiPresetName | null) { this.looked.push({ frame, text, context: room.context, preset }); return this.reply; }
    async visionRoute() { this.routeModes.push(await getActiveAiPresetName()); return this.route; }
    async recent() { return this.history; }
    async note(line: string) { this.notes.push(line); }
}
/** The body's actions as the model would choose them, with the task and mode it was asked under. */
function chooser(actions: unknown, calls: Array<{ task: string; preset: string; user: string }> = []): any {
    return async (task: string, params: any) => { calls.push({ task, preset: await getActiveAiPresetName(), user: params.messages[1].content }); return { actions }; };
}

function sessions(t: TestContext) {
    const rows = new Map<string, SessionData>();
    t.mock.method(TypeORMSessionStorage.prototype, 'read', async (key: string) => rows.has(key) ? structuredClone(rows.get(key)) : undefined);
    t.mock.method(TypeORMSessionStorage.prototype, 'write', async (key: string, value: SessionData) => { rows.set(key, structuredClone(value)); });
    return rows;
}

test('scene turns are strict: unknown fields, stale snapshots, non-JPEG, oversized or mismatched frames are refused', () => {
    assert.equal(parseSceneTurn({ text: 'Что ты видишь?', scene: scene(), frame: frame() }).frame!.data.length, jpeg.length);
    const code = (body: Record<string, unknown>) => { try { parseSceneTurn(body); return 'ok'; } catch (e: any) { return e.code; } };
    assert.equal(code({ text: 'Привет', scene: scene(), userId: 1 }), 'invalid_scene');
    assert.equal(code({ text: 'Привет', scene: scene({ url: 'http://x' }) }), 'invalid_scene');
    assert.equal(code({ text: 'Привет', scene: scene({ observedAt: new Date(Date.now() - 600_000).toISOString() }) }), 'stale_scene');
    assert.equal(code({ text: 'Привет', scene: scene({ seats: [{ id: seat, objectId: room, height: 0.47, yaw: 0, confirmed: true }] }) }), 'invalid_scene');
    assert.equal(code({ text: 'Что видишь?', scene: scene(), frame: frame({ mime: 'image/png' }) }), 'unsupported_frame');
    assert.equal(code({ text: 'Что видишь?', scene: scene(), frame: frame({ data: Buffer.from('not a jpeg at all').toString('base64') }) }), 'unsupported_frame');
    assert.equal(code({ text: 'Что видишь?', scene: scene(), frame: frame({ data: Buffer.concat([jpeg, Buffer.alloc(MAX_FRAME_BYTES)]).toString('base64') }) }), 'frame_too_large');
    assert.equal(code({ text: 'Что видишь?', scene: scene(), frame: frame({ capturedAt: new Date(Date.now() - 30_000).toISOString() }) }), 'stale_frame');
    // a frame while tracking is lost is not "the room now"
    assert.equal(code({ text: 'Что видишь?', scene: scene({ tracking: 'limited' }), frame: frame() }), 'tracking_lost');
    assert.equal(code({ text: 'Сядь', scene: scene({ tracking: 'limited' }) }), 'ok');
});

test('actions are validated against the snapshot: known kinds, existing ids, possible from the current pose', () => {
    const s = parseSceneTurn({ text: 'Сядь', scene: scene() }).scene;
    const { actions, rejected } = validateActions([
        { kind: 'sit', targetId: seat }, { kind: 'sit', targetId: seat }, { kind: 'runScript', targetId: 'rm -rf' },
    ], s);
    assert.deepEqual(actions.map(a => [a.kind, a.targetId, a.roomVersion]), [['sit', seat, 3]]);
    assert.deepEqual(rejected.map(r => r.reason), ['Кира уже сидит', 'неизвестное действие']);
    assert.match(actions[0].id, /^[0-9a-f-]{36}$/);
    assert.equal(validateActions([{ kind: 'sit', targetId: '55555555-5555-4555-8555-555555555555' }], s).rejected[0].reason, 'нет такого подтверждённого места');
    assert.equal(validateActions([{ kind: 'stand' }], s).rejected[0].reason, 'Кира не сидит');
    assert.equal(validateActions([{ kind: 'approach', targetId: chair }], { ...s, avatar: { ...s.avatar, pose: 'seated', seatId: seat } }).rejected[0].reason, 'сначала нужно встать');
    assert.equal(validateActions('sit', s).actions.length, 0);
});

test('a frame is read by the model that reads photos, under the app mode, and refused before a receipt when it cannot', async t => {
    sessions(t);
    const channel = new Channel();
    const service = new SceneService(owner, new AppMode({ preset: 'gpt-lean', revision: 'r' }), channel, chooser([]));
    const capabilities = await service.capabilities() as any;
    assert.deepEqual(capabilities.vision, channel.route);
    assert.equal(capabilities.mode.preset, 'gpt-lean');
    assert.deepEqual(channel.routeModes, ['gpt-lean']);
    assert.match(capabilities.notes, /не становится фактами/);
    const look = parseSceneTurn({ text: 'Что ты видишь?', scene: scene(), frame: frame() });
    assert.equal(await service.ready(look), 'gpt-lean');
    channel.route = { available: false, reason: 'Модель gpt-synthetic не поддерживает изображения.' };
    await assert.rejects(service.ready(look), (e: any) => e.status === 503 && e.code === 'vision_unavailable' && /не поддерживает изображения/.test(e.message));
    assert.equal(await service.ready(parseSceneTurn({ text: 'Привет', scene: scene() })), 'gpt-lean');   // words need no vision
});

test('words in the room are a turn of the app dialogue: its handlers answer, with the room as context', async t => {
    const rows = sessions(t);
    const channel = new Channel();
    channel.reply = { messages: [
        { id: -1, type: 'text', text: 'Напомню завтра в десять.', buttons: [[{ text: 'Отменить', actionToken: 'synthetic' }]] } as any,
        { id: -2, type: 'photo', fileUrl: '/api/v1/files/synthetic' } as any,
    ] };
    const calls: Array<{ task: string; preset: string; user: string }> = [];
    const service = new SceneService(owner, new AppMode({ preset: 'gpt-lean', revision: 'r' }), channel, chooser([], calls));
    const reply = await service.turn(parseSceneTurn({ text: 'Напомни завтра в десять полить цветы', scene: scene() }), 'gpt-lean') as any;
    assert.deepEqual(channel.said.map(s => [s.text, s.preset]), [['Напомни завтра в десять полить цветы', 'gpt-lean']]);
    assert.equal(channel.looked.length, 0);
    assert.deepEqual(reply.messages, channel.reply.messages);                                   // buttons and pictures as in the chat
    assert.deepEqual(reply.actions, []);
    assert.deepEqual(reply.vision, { used: false });
    // the room reaches the answer by names, never by ids or coordinates Kira could read out
    const context = channel.said[0].context;
    assert.match(context, /AR-комнате/); assert.match(context, /Синтетический стул/); assert.match(context, /Кадра камеры в этой реплике нет/);
    assert.ok(!context.includes(chair) && !context.includes(seat) && !context.includes('0.24'));
    // the body's actions are chosen by the classifier task under the app's mode, from the room with its ids
    assert.deepEqual(calls.map(c => [c.task, c.preset]), [['intentClassification', 'gpt-lean']]);
    assert.ok(calls[0].user.includes(seat));
    assert.ok(!rows.has(`api:${owner}`));                                                       // the dialogue is the channel's
    assert.deepEqual(rows.get(`api-scene:${owner}`)!.messageHistory, []);
});

test('a look sends the frame to the photo recognition with the words as its caption and stores no image', async t => {
    const rows = sessions(t);
    rows.set(`api-scene:${owner}`, { reminders: [], messageHistory: [{ role: 'user', content: 'старая отдельная история', timestamp: new Date() }],
        dialogueSummary: '', lastSummarizedIndex: -1, domains: {}, sentMessages: {} } as SessionData);
    const channel = new Channel();
    const service = new SceneService(owner, new AppMode({ preset: 'gpt-lean', revision: 'r' }), channel, chooser([]));
    const turn = parseSceneTurn({ text: 'Что ты видишь?', scene: scene(), frame: frame() });
    const reply = await service.turn(turn, await service.ready(turn)) as any;
    assert.equal(channel.said.length, 0);
    assert.deepEqual(channel.looked[0].frame, jpeg);
    assert.equal(channel.looked[0].text, 'Что ты видишь?');
    assert.equal(channel.looked[0].preset, 'gpt-lean');
    assert.match(channel.looked[0].context, /приложен кадр камеры/);
    assert.equal(reply.messages[0].text, 'Ответ из общего диалога');
    assert.deepEqual([reply.vision.used, reply.vision.provider, reply.vision.model, reply.vision.location], [true, 'openai', 'gpt-synthetic', 'cloud']);
    const stored = JSON.stringify(rows.get(`api-scene:${owner}`));
    assert.ok(!stored.includes(jpeg.toString('base64')) && !stored.includes('старая отдельная история'));
    assert.match(roomContext(parseSceneTurn({ text: 'Сядь', scene: scene({ avatar: { position: [0, 0, -1], yaw: 3.14, pose: 'seated', seatId: seat } }) })),
        /Сейчас ты сидишь \(Синтетический стул\)/);
});

test('the body\'s actions are checked against the room; a failing choice leaves the answer without them', async t => {
    sessions(t);
    const channel = new Channel();
    const proposed = new SceneService(owner, new AppMode(), channel, chooser([{ kind: 'sit', targetId: seat }, { kind: 'sit', targetId: 'bad' }]));
    const reply = await proposed.turn(parseSceneTurn({ text: 'Сядь на стул', scene: scene() }), null) as any;
    assert.deepEqual(reply.actions.map((a: any) => a.targetId), [seat]);
    assert.equal(reply.rejectedActions[0].reason, 'нет такого подтверждённого места');
    const failing = new SceneService(owner, new AppMode(), channel, (async () => { throw new Error('provider down'); }) as any);
    const answered = await failing.turn(parseSceneTurn({ text: 'Как дела?', scene: scene() }), null) as any;
    assert.equal(answered.messages[0].text, 'Ответ из общего диалога');
    assert.deepEqual(answered.actions, []);
    const garbled = new SceneService(owner, new AppMode(), channel, (async () => null) as any);
    assert.deepEqual((await garbled.turn(parseSceneTurn({ text: 'Как дела?', scene: scene() }), null) as any).actions, []);
    // a failing answer is the turn's failure
    channel.say = async () => { throw new ApiError(502, 'synthetic', 'нет ответа'); };
    await assert.rejects(proposed.turn(parseSceneTurn({ text: 'Привет', scene: scene() }), null), (e: any) => e.code === 'synthetic');
});

test('action results: only actions Kira proposed, recorded once, in the dialogue the next turn reads', async t => {
    sessions(t);
    const channel = new Channel();
    const service = new SceneService(owner, new AppMode(), channel, chooser([{ kind: 'sit', targetId: seat }]));
    const reply = await service.turn(parseSceneTurn({ text: 'Сядь', scene: scene() }), null) as any;
    const id = reply.actions[0].id;
    await assert.rejects(service.actionResult({ actionId: '66666666-6666-4666-8666-666666666666', status: 'completed' }), (e: any) => e.code === 'unknown_action');
    await assert.rejects(service.actionResult({ actionId: id, status: 'done' }), (e: any) => e.code === 'invalid_scene');
    assert.deepEqual(await service.actionResult({ actionId: id, status: 'rejected', reason: 'Сиденье занято' }), { ok: true, actionId: id, status: 'rejected' });
    assert.deepEqual(await service.actionResult({ actionId: id, status: 'rejected', reason: 'Сиденье занято' }), { ok: true, actionId: id, status: 'rejected' });
    await assert.rejects(service.actionResult({ actionId: id, status: 'completed' }), (e: any) => e.code === 'action_already_reported');
    assert.equal(channel.notes.length, 1);
    assert.match(channel.notes[0], /^\[Результат действия «сесть» в AR — не выполнено \(rejected\): Сиденье занято\]$/);
});

test('sit without a target is the phone\'s own seat choice; a plain "sit down" becomes it even when the model chose none', async t => {
    const s = parseSceneTurn({ text: 'Садись', scene: scene() }).scene;
    const auto = validateActions([{ kind: 'sit' }, { kind: 'sit', targetId: 'auto' }], s);
    assert.deepEqual(auto.actions.map(a => [a.kind, a.targetId]), [['sit', undefined]]);           // one sit, no invented id
    assert.deepEqual(auto.rejected.map(r => r.reason), ['Кира уже сидит']);
    assert.equal(validateActions([{ kind: 'sit' }], { ...s, avatar: { ...s.avatar, pose: 'seated', seatId: seat } }).rejected[0].reason, 'Кира уже сидит');
    assert.equal(validateActions([{ kind: 'sit', targetId: 'bad' }], s).rejected[0].reason, 'нет такого подтверждённого места');   // the old form stays strict
    assert.ok(wantsPlainSit('Кира, садись') && wantsPlainSit('присядь, пожалуйста') && wantsPlainSit('Сядь куда-нибудь'));
    assert.ok(!wantsPlainSit('не садись') && !wantsPlainSit('Кира, не садись пока') && !wantsPlainSit('сядьмо') && !wantsPlainSit('как дела?'));
    sessions(t);
    const none = new SceneService(owner, new AppMode(), new Channel(), chooser([]));
    const reply = await none.turn(parseSceneTurn({ text: 'Кира, садись', scene: scene() }), null) as any;
    assert.deepEqual(reply.actions.map((a: any) => [a.kind, a.targetId, a.roomVersion]), [['sit', undefined, 3]]);
    assert.equal((await none.turn(parseSceneTurn({ text: 'Не садись, постой', scene: scene() }), null) as any).actions.length, 0);
    const seated = scene({ avatar: { position: [0, 0, -1], yaw: 3.14, pose: 'seated', seatId: seat } });
    assert.equal((await none.turn(parseSceneTurn({ text: 'Садись', scene: seated }), null) as any).actions.length, 0);   // already sitting: nothing
    // the model's own targeted sit is kept, not doubled
    const named = new SceneService(owner, new AppMode(), new Channel(), chooser([{ kind: 'sit', targetId: seat }]));
    assert.deepEqual((await named.turn(parseSceneTurn({ text: 'Садись на стул', scene: scene() }), null) as any).actions.map((a: any) => a.targetId), [seat]);
    assert.equal((await none.capabilities() as any).autoSeat, true);
});

test('the phone reports which seat it chose and what it did; the dialogue gets its words, not ids', async t => {
    sessions(t);
    const channel = new Channel();
    const service = new SceneService(owner, new AppMode(), channel, chooser([{ kind: 'sit' }]));
    const id = (await service.turn(parseSceneTurn({ text: 'Садись', scene: scene() }), null) as any).actions[0].id;
    await assert.rejects(service.actionResult({ actionId: id, status: 'completed', targetId: 'chair-1' }), (e: any) => e.code === 'invalid_scene');
    await assert.rejects(service.actionResult({ actionId: id, status: 'completed', where: 'x' }), (e: any) => e.code === 'invalid_scene');
    assert.deepEqual(await service.actionResult({ actionId: id, status: 'completed', targetId: chair,
        detail: 'выбрано место: Стул, сиденье 45 см; прошла 2.1 м по проверенному пути; развернулась спиной к сиденью; села' }), { ok: true, actionId: id, status: 'completed' });
    assert.match(channel.notes[0], /выполнено: ты смогла сесть \(выбрано место: Стул/);
    assert.ok(!channel.notes[0].includes(chair));
    // a refusal is a refusal, with the phone's reason
    const id2 = (await service.turn(parseSceneTurn({ text: 'Садись', scene: scene() }), null) as any).actions[0].id;
    await service.actionResult({ actionId: id2, status: 'rejected', reason: 'Не нашла, куда сесть: Стул у двери: на сиденье что-то есть' });
    assert.match(channel.notes[1], /не выполнено \(rejected\): Не нашла, куда сесть/);
});

class Receipts implements ApiOperationStore {
    keys: string[] = [];
    async run(key: string, _fingerprint: string, work: () => Promise<ApiReply>) { this.keys.push(key); return work(); }
}

test('HTTP: scene routes need the token, a JSON body within limits, an idempotency key, and refuse vision before receipts', async t => {
    const receipts = new Receipts();
    let turns = 0;
    const backend: ApiBackend = {
        status: async () => ({}), capabilities: async () => ({}), history: async () => ({}), reminders: async () => ({}), tasks: async () => ({}),
        message: async () => ({ messages: [] }), action: async () => ({ messages: [] }), file: async () => ({ data: Buffer.alloc(0), filename: 'x' }),
        modelSettings: async () => ({}), saveModelSettings: async () => ({}), turnReady: async () => {},
        photoReady: async () => null, photo: async () => ({ messages: [] }),
        sceneCapabilities: async () => ({ version: 1, vision: { available: false, reason: 'synthetic' } }),
        sceneReady: async turn => { if (turn.frame) throw new ApiError(503, 'vision_unavailable', 'нет зрения'); return null; },
        sceneTurn: async () => { turns++; return { messages: [{ id: -1, type: 'text', text: 'ok' }] }; },
        sceneActionResult: async body => ({ ok: true, body }),
    };
    const http = createExternalApiServer({ token, ownerId: owner, host: '127.0.0.1', port: 0 }, backend, receipts);
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    t.after(() => { http.closeAllConnections(); return new Promise<void>(resolve => http.close(() => resolve())); });
    const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/api/v1`;
    const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(url + path, { method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'scene-key-0001', ...headers }, body: JSON.stringify(body) });
    assert.equal((await fetch(url + '/scene')).status, 401);
    assert.equal((await (await fetch(url + '/scene', { headers: { Authorization: `Bearer ${token}` } })).json()).version, 1);
    assert.equal((await post('/scene/turns', { text: 'Что видишь?', scene: scene(), frame: frame() })).status, 503);
    assert.deepEqual(receipts.keys, []);
    assert.equal((await post('/scene/turns', { text: 'Сядь', scene: scene() }, { 'Idempotency-Key': '' })).status, 400);
    assert.equal((await post('/scene/turns', { text: 'Сядь', scene: scene() })).status, 200);
    assert.equal(turns, 1);
    // a large frame fits the scene route but not the ordinary 64 KiB message route
    const big = { text: 'Что видишь?', scene: scene(), frame: frame({ data: Buffer.concat([jpeg, Buffer.alloc(200_000)]).toString('base64') }) };
    assert.equal((await post('/scene/turns', big)).status, 503);   // parsed in full, then refused for vision
    assert.equal((await post('/messages', { text: 'x'.repeat(100_000) })).status, 413);
    assert.equal((await post('/scene/action-results', { actionId: seat, status: 'completed' })).status, 200);
    assert.equal((await fetch(url + '/scene/turns', { headers: { Authorization: `Bearer ${token}` } })).status, 405);
});
