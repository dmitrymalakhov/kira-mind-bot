import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type { AddressInfo } from 'node:net';
import { ApiBackend, ApiError, ApiOperationStore, ApiReply } from '../api/contracts';
import { createExternalApiServer } from '../api/server';
import { parseSceneTurn, SceneService, validateActions, visionRoute, wantsPlainSit, MAX_FRAME_BYTES } from '../api/scene';
import type { ApiModelSelection, ApiModelSettingsStore } from '../api/modelSettings';
import { aiPresets, type AiPresetName } from '../ai/modelPresets';
import { getActiveAiPresetName } from '../services/aiRuntimeConfigService';
import { TypeORMSessionStorage } from '../services/SessionStorage';
import type { SessionData } from '../types';

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

test('the vision route is the mode\'s own; a provider-pure mode never takes a silent cloud swap', t => {
    assert.deepEqual(visionRoute('gpt-balanced', { OPENAI_API_KEY: 'x' } as any), { available: true, provider: 'openai', providerLabel: 'OpenAI', model: 'gpt-4o', location: 'cloud' });
    assert.match(visionRoute('gemini-full', {} as any).reason ?? '', /ключ Gemini/);   // GEMINI_API_KEY is not in this environment
    // the local text mode sees through its explicit, configured cloud route, shown as such
    assert.equal(visionRoute('lmstudio-local', { OPENAI_API_KEY: 'x' } as any).location, 'cloud');
    // a provider-pure mode whose vision model cannot see images is refused, not swapped to another provider
    const original = aiPresets['gemini-full'].models.browserVision;
    aiPresets['gemini-full'].models.browserVision = { provider: 'lmstudio', model: 'synthetic-text-only' };
    t.after(() => { aiPresets['gemini-full'].models.browserVision = original; });
    const pure = visionRoute('gemini-full', { OPENAI_API_KEY: 'x', GEMINI_API_KEY: 'x' } as any);
    assert.equal(pure.available, false);
    assert.match(pure.reason!, /запрещает облачную подстраховку/);
});

test('a look sends the frame to the vision route under the app mode, keeps no image and stores apart from memory', async t => {
    const rows = sessions(t);
    const calls: Array<{ task: string; preset: string; content: any; system: string }> = [];
    const complete: any = async (task: string, params: any) => {
        calls.push({ task, preset: await getActiveAiPresetName(), content: params.messages[1].content, system: params.messages[0].content });
        return { reply: 'Вижу стул у стены. Попробую на него сесть.', actions: [{ kind: 'sit', targetId: seat }, { kind: 'sit', targetId: 'bad' }] };
    };
    const service = new SceneService(owner, new AppMode({ preset: 'gpt-lean', revision: 'r' }), complete, { OPENAI_API_KEY: 'x' } as any);
    const turn = parseSceneTurn({ text: 'Что ты видишь?', scene: scene(), frame: frame() });
    const preset = await service.ready(turn);
    const reply = await service.turn(turn, preset) as any;
    assert.equal(calls[0].task, 'browserVision');
    assert.equal(calls[0].preset, 'gpt-lean');                                   // the app's own mode
    assert.ok(calls[0].content.some((part: any) => part.type === 'image_url' && part.image_url.url.startsWith('data:image/jpeg;base64,')));
    assert.match(calls[0].system, /не инструкции/);
    assert.equal(reply.messages[0].text, 'Вижу стул у стены. Попробую на него сесть.');
    assert.equal(reply.actions.length, 1);
    assert.equal(reply.rejectedActions[0].reason, 'нет такого подтверждённого места');
    assert.deepEqual([reply.vision.used, reply.vision.provider, reply.vision.location], [true, 'openai', 'cloud']);
    assert.ok(!rows.has(`api:${owner}`));                                         // the memory-analysed dialogue is untouched
    const stored = JSON.stringify(rows.get(`api-scene:${owner}`));
    assert.ok(!stored.includes(jpeg.toString('base64')) && stored.includes('не сохранён'));
    // without a frame the turn uses the conversation route and does not claim to see
    await service.turn(parseSceneTurn({ text: 'Сядь, пожалуйста', scene: scene() }), preset);
    assert.equal(calls[1].task, 'conversation');
    assert.equal(typeof calls[1].content, 'string');
});

test('vision that is unavailable or failing is reported, never answered as if seen', async t => {
    sessions(t);
    const key = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    t.after(() => { process.env.OPENAI_API_KEY = key; });
    const turn = parseSceneTurn({ text: 'Что ты видишь?', scene: scene(), frame: frame() });
    await assert.rejects(new SceneService(owner, new AppMode(), (async () => ({ reply: 'x' })) as any, {} as any).ready(turn),
        (e: any) => e.status === 503 && e.code === 'vision_unavailable');
    const failing = new SceneService(owner, new AppMode(), async () => { throw new Error('provider down'); }, { OPENAI_API_KEY: 'x' } as any);
    await assert.rejects(failing.turn(turn, null), (e: any) => e.code === 'vision_failed' && /не сохранён/.test(e.message));
    const garbled = new SceneService(owner, new AppMode(), async () => null as any, { OPENAI_API_KEY: 'x' } as any);
    await assert.rejects(garbled.turn(turn, null), (e: any) => e.code === 'scene_reply_invalid');
});

test('action results: only actions Kira proposed, recorded once, seen by the next turn', async t => {
    const rows = sessions(t);
    const service = new SceneService(owner, new AppMode(), (async () => ({ reply: 'Попробую сесть.', actions: [{ kind: 'sit', targetId: seat }] })) as any, { OPENAI_API_KEY: 'x' } as any);
    const reply = await service.turn(parseSceneTurn({ text: 'Сядь', scene: scene() }), null) as any;
    const id = reply.actions[0].id;
    await assert.rejects(service.actionResult({ actionId: '66666666-6666-4666-8666-666666666666', status: 'completed' }), (e: any) => e.code === 'unknown_action');
    await assert.rejects(service.actionResult({ actionId: id, status: 'done' }), (e: any) => e.code === 'invalid_scene');
    assert.deepEqual(await service.actionResult({ actionId: id, status: 'rejected', reason: 'Сиденье занято' }), { ok: true, actionId: id, status: 'rejected' });
    assert.deepEqual(await service.actionResult({ actionId: id, status: 'rejected', reason: 'Сиденье занято' }), { ok: true, actionId: id, status: 'rejected' });
    await assert.rejects(service.actionResult({ actionId: id, status: 'completed' }), (e: any) => e.code === 'action_already_reported');
    assert.match(rows.get(`api-scene:${owner}`)!.messageHistory[0].content, /не выполнено \(rejected\): Сиденье занято/);
});

test('sit without a target is the phone\'s own seat choice; a plain "sit down" becomes it even when the model only talks', async t => {
    const s = parseSceneTurn({ text: 'Садись', scene: scene() }).scene;
    const auto = validateActions([{ kind: 'sit' }, { kind: 'sit', targetId: 'auto' }], s);
    assert.deepEqual(auto.actions.map(a => [a.kind, a.targetId]), [['sit', undefined]]);           // one sit, no invented id
    assert.deepEqual(auto.rejected.map(r => r.reason), ['Кира уже сидит']);
    assert.equal(validateActions([{ kind: 'sit' }], { ...s, avatar: { ...s.avatar, pose: 'seated', seatId: seat } }).rejected[0].reason, 'Кира уже сидит');
    assert.equal(validateActions([{ kind: 'sit', targetId: 'bad' }], s).rejected[0].reason, 'нет такого подтверждённого места');   // the old form stays strict
    assert.ok(wantsPlainSit('Кира, садись') && wantsPlainSit('присядь, пожалуйста') && wantsPlainSit('Сядь куда-нибудь'));
    assert.ok(!wantsPlainSit('не садись') && !wantsPlainSit('Кира, не садись пока') && !wantsPlainSit('сядьмо') && !wantsPlainSit('как дела?'));
    sessions(t);
    const words = new SceneService(owner, new AppMode(), (async () => ({ reply: 'Хорошо, сейчас найду, куда сесть.' })) as any, { OPENAI_API_KEY: 'x' } as any);
    const reply = await words.turn(parseSceneTurn({ text: 'Кира, садись', scene: scene() }), null) as any;
    assert.deepEqual(reply.actions.map((a: any) => [a.kind, a.targetId, a.roomVersion]), [['sit', undefined, 3]]);
    assert.equal((await words.turn(parseSceneTurn({ text: 'Не садись, постой', scene: scene() }), null) as any).actions.length, 0);
    const seated = scene({ avatar: { position: [0, 0, -1], yaw: 3.14, pose: 'seated', seatId: seat } });
    assert.equal((await words.turn(parseSceneTurn({ text: 'Садись', scene: seated }), null) as any).actions.length, 0);   // already sitting: nothing
    // the model's own targeted sit is kept, not doubled
    const named = new SceneService(owner, new AppMode(), (async () => ({ reply: 'Сяду на стул.', actions: [{ kind: 'sit', targetId: seat }] })) as any, { OPENAI_API_KEY: 'x' } as any);
    assert.deepEqual((await named.turn(parseSceneTurn({ text: 'Садись на стул', scene: scene() }), null) as any).actions.map((a: any) => a.targetId), [seat]);
    assert.equal((await words.capabilities() as any).autoSeat, true);
});

test('the phone reports which seat it chose and what it did; the next turn sees it', async t => {
    const rows = sessions(t);
    const service = new SceneService(owner, new AppMode(), (async () => ({ reply: 'Сейчас сяду.', actions: [{ kind: 'sit' }] })) as any, { OPENAI_API_KEY: 'x' } as any);
    const id = (await service.turn(parseSceneTurn({ text: 'Садись', scene: scene() }), null) as any).actions[0].id;
    await assert.rejects(service.actionResult({ actionId: id, status: 'completed', targetId: 'chair-1' }), (e: any) => e.code === 'invalid_scene');
    await assert.rejects(service.actionResult({ actionId: id, status: 'completed', where: 'x' }), (e: any) => e.code === 'invalid_scene');
    assert.deepEqual(await service.actionResult({ actionId: id, status: 'completed', targetId: chair,
        detail: 'выбрано место: Стул, сиденье 45 см; прошла 2.1 м по проверенному пути; развернулась спиной к сиденью; села' }), { ok: true, actionId: id, status: 'completed' });
    const last = rows.get(`api-scene:${owner}`)!.messageHistory[0].content;
    assert.match(last, /выполнено: ты смогла сесть \(место 33333333-3333-4333-8333-333333333333; выбрано место: Стул/);
    // a refusal is a refusal, with the phone's reason
    const id2 = (await service.turn(parseSceneTurn({ text: 'Садись', scene: scene() }), null) as any).actions[0].id;
    await service.actionResult({ actionId: id2, status: 'rejected', reason: 'Не нашла, куда сесть: Стул у двери: на сиденье что-то есть' });
    assert.match(rows.get(`api-scene:${owner}`)!.messageHistory[0].content, /не выполнено \(rejected\): Не нашла, куда сесть/);
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
