import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type { AddressInfo } from 'node:net';
import * as http from 'node:http';
import { ApiBackend, ApiError, ApiOperationStore, ApiReply } from '../api/contracts';
import { createExternalApiServer } from '../api/server';
import { MAX_PHOTO_BYTES, parsePhotoTurn, photoVisionRoute } from '../api/photos';
import { runWithChannelPreset } from '../services/aiRuntimeConfigService';
import { runWithModelPolicy } from '../services/modelPreferenceService';
import { resolveModelForTaskAsync } from '../ai/modelResolver';
import { aiPresets } from '../ai/modelPresets';
import type { ModelPolicy } from '../ai/modelPreferences';

const token = 'synthetic-photo-test-token-at-least-32-characters';
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]);
const body = (changes: Record<string, unknown> = {}) => ({ photo: { mime: 'image/jpeg', data: jpeg.toString('base64'), width: 2048, height: 1536 }, ...changes });

test('photo parsing accepts one JPEG with or without a trimmed caption and rejects invalid shapes', () => {
    assert.deepEqual(parsePhotoTurn(body()).photo.data, jpeg);
    assert.equal(parsePhotoTurn(body({ text: '  Что на фото?  ' })).text, 'Что на фото?');
    const photo = body().photo;
    const cases: Array<[unknown, string]> = [
        [[], 'invalid_photo'], [null, 'invalid_photo'], [{}, 'invalid_photo'],
        [body({ userId: 730002 }), 'invalid_photo'], [body({ photo: { ...photo, extra: 1 } }), 'invalid_photo'],
        [body({ photo: { ...photo, mime: 'image/png' } }), 'unsupported_photo'],
        [body({ photo: { ...photo, data: Buffer.from('not JPEG').toString('base64') } }), 'unsupported_photo'],
        [body({ photo: { ...photo, data: 'not base64!' } }), 'invalid_photo'],
        [body({ photo: { ...photo, data: Buffer.concat([jpeg, Buffer.alloc(MAX_PHOTO_BYTES)]).toString('base64') } }), 'photo_too_large'],
        [body({ photo: { ...photo, width: 8, height: 8 } }), 'invalid_photo'],
        [body({ photo: { ...photo, height: 4097 } }), 'invalid_photo'],
        [body({ photo: { ...photo, width: 16.5 } }), 'invalid_photo'],
        [body({ text: 'x'.repeat(8001) }), 'invalid_photo'], [body({ text: '   ' }), 'invalid_photo'], [body({ text: null }), 'invalid_photo'],
    ];
    for (const [value, code] of cases) assert.throws(() => parsePhotoTurn(value), (e: any) => e.code === code);
});

test('photo vision follows the actual conversation route, app override and custom model policy', async () => {
    await runWithChannelPreset('gpt-lean', async () => {
        const actual = await resolveModelForTaskAsync('conversation');
        const route = await photoVisionRoute({ OPENAI_API_KEY: 'synthetic-key' });
        assert.equal(route.provider, actual.modelRef.provider);
        assert.equal(route.model, actual.modelRef.model);
        assert.equal(route.available, true);
        assert.equal(route.location, 'cloud');
        const missing = await photoVisionRoute({});
        assert.equal(missing.available, false); assert.match(missing.reason!, /ключ OpenAI/);
    });
    const policy = { presetName: 'gpt-balanced', models: { ...aiPresets['gpt-balanced'].models,
        conversation: { provider: 'lmstudio', model: 'synthetic-text-only' } } } as ModelPolicy;
    await runWithModelPolicy(policy, async () => {
        const route = await photoVisionRoute({ OPENAI_API_KEY: 'synthetic-key' });
        assert.equal(route.available, false);
        assert.equal(route.provider, 'lmstudio'); assert.equal(route.model, 'synthetic-text-only');
        assert.equal(route.location, 'server-local'); assert.match(route.reason!, /не поддерживает изображения/);
    });
});

class Receipts implements ApiOperationStore {
    rows = new Map<string, { fingerprint: string; result: ApiReply }>();
    async run(key: string, fingerprint: string, work: () => Promise<ApiReply>, _options?: { releaseRefusals?: boolean }) {
        const old = this.rows.get(key);
        if (old) {
            if (old.fingerprint !== fingerprint) throw new ApiError(409, 'idempotency_conflict', 'Этот ключ уже использован с другим запросом.');
            return old.result;
        }
        const result = await work();
        this.rows.set(key, { fingerprint, result });
        return result;
    }
}

async function fixture(t: TestContext, changes: Partial<ApiBackend> = {}) {
    let calls = 0;
    const operations = new Receipts();
    const backend: ApiBackend = {
        status: async () => ({}), capabilities: async () => ({}), history: async () => ({}), reminders: async () => ({}), tasks: async () => ({}),
        message: async () => ({ messages: [] }), action: async () => ({ messages: [] }), file: async () => ({ data: Buffer.alloc(0), filename: 'x' }),
        modelSettings: async () => ({}), saveModelSettings: async () => ({}), turnReady: async () => {},
        photoReady: async () => null, photo: async buffer => {
            calls++; assert.deepEqual(buffer, jpeg);
            return { messages: [{ id: -1, type: 'text', text: 'На фото синтетический кот.' }] };
        },
        sceneCapabilities: async () => ({}), sceneReady: async () => null, sceneTurn: async () => ({ messages: [] }), sceneActionResult: async () => ({}), ...changes,
    };
    const server = createExternalApiServer({ token, ownerId: 730001, host: '127.0.0.1', port: 0 }, backend, operations);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/photos`;
    const request = (value: unknown = body(), key: string | null = 'photo-synthetic-001', headers: Record<string, string> = {}) => fetch(url, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json',
            ...(key === null ? {} : { 'idempotency-key': key }), ...headers }, body: JSON.stringify(value),
    });
    return { url, request, operations, calls: () => calls };
}

test('HTTP photos require authentication, POST, a valid body and idempotency key; errors are safe', async t => {
    const f = await fixture(t);
    assert.equal((await fetch(f.url)).status, 401);
    const get = await fetch(f.url, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(get.status, 405); assert.equal(get.headers.get('allow'), 'POST');
    const missing = await f.request(body(), null);
    assert.equal(missing.status, 400); assert.equal((await missing.json()).error.code, 'idempotency_key_required');
    assert.equal((await f.request(body(), 'bad key')).status, 400);
    const extra = await f.request(body({ extra: 'synthetic-secret' }));
    assert.equal(extra.status, 400);
    const error = await extra.json();
    assert.equal(error.error.code, 'invalid_photo'); assert.ok(error.requestId);
    assert.match(error.error.message, /фото/); assert.ok(!JSON.stringify(error).includes('synthetic-secret'));
    assert.equal((await f.request(body({ photo: { ...body().photo, mime: 'image/png' } }))).status, 415);
    assert.equal((await f.request(body({ text: 'x'.repeat(3 * 1024 * 1024) }))).status, 413);
    assert.equal(f.calls(), 0); assert.equal(f.operations.rows.size, 0);
});

test('retries return one completed photo response; a different body conflicts and receipts contain no pixels', async t => {
    const f = await fixture(t);
    const first = await f.request(body({ text: 'Что на фото?' }));
    assert.equal(first.status, 200);
    const result = await first.json();
    assert.deepEqual(await (await f.request(body({ text: 'Что на фото?' }))).json(), result);
    const conflict = await f.request(body({ text: 'Другая подпись' }));
    assert.equal(conflict.status, 409); assert.equal((await conflict.json()).error.code, 'idempotency_conflict');
    assert.equal(f.calls(), 1);
    const stored = JSON.stringify([...f.operations.rows]);
    assert.ok(!stored.includes(jpeg.toString('base64')) && !stored.includes('Что на фото?'));
    assert.ok([...f.operations.rows.keys()][0].startsWith('730001:photo:'));
});

test('photo requests stay synchronous despite respond-async and do not race another conversation turn', async t => {
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const f = await fixture(t, { photo: async () => { entered(); await gate; return { messages: [{ id: -1, type: 'text', text: 'Готово' }] }; } });
    const pending = f.request(body(), 'photo-slow-001', { Prefer: 'respond-async' });
    await started;
    const busy = await f.request(body(), 'photo-parallel-002');
    assert.equal(busy.status, 409); assert.equal(busy.headers.get('retry-after'), '2');
    assert.equal((await busy.json()).error.code, 'conversation_busy');
    const text = await fetch(f.url.replace('/photos', '/messages'), { method: 'POST', headers: { authorization: `Bearer ${token}`,
        'content-type': 'application/json', 'idempotency-key': 'text-parallel-001' }, body: '{"text":"Привет"}' });
    assert.equal(text.status, 409);
    release();
    const response = await pending;
    assert.equal(response.status, 200); assert.equal(response.headers.get('preference-applied'), null);
    assert.equal((await response.json()).backgroundJob, undefined);
});

test('unavailable vision is refused before creating an operation receipt', async t => {
    const f = await fixture(t, { photoReady: async () => { throw new ApiError(503, 'vision_unavailable', 'У модели нет зрения.'); } });
    const response = await f.request();
    assert.equal(response.status, 503); assert.equal((await response.json()).error.code, 'vision_unavailable');
    assert.equal(f.operations.rows.size, 0); assert.equal(f.calls(), 0);
});

test('disconnecting the client does not cancel analysis; retry replays the completed receipt', async t => {
    let entered!: () => void, release!: () => void, stored!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const completed = new Promise<void>(resolve => { stored = resolve; });
    let calls = 0;
    const f = await fixture(t, { photo: async () => { calls++; entered(); await gate; return { messages: [{ id: -1, type: 'text', text: 'Завершила анализ' }] }; } });
    const original = f.operations.run.bind(f.operations);
    t.mock.method(f.operations, 'run', async (...args: Parameters<ApiOperationStore['run']>) => { const result = await original(...args); stored(); return result; });
    const request = http.request(f.url, { method: 'POST', headers: { authorization: `Bearer ${token}`,
        'content-type': 'application/json', 'idempotency-key': 'photo-disconnect-001' } });
    const closed = new Promise<void>(resolve => request.once('error', () => resolve()));
    request.end(JSON.stringify(body()));
    await started; request.destroy(new Error('synthetic client disconnect')); await closed;
    release(); await completed;
    const retry = await f.request(body(), 'photo-disconnect-001');
    assert.equal(retry.status, 200); assert.equal((await retry.json()).messages[0].text, 'Завершила анализ');
    assert.equal(calls, 1);
});
