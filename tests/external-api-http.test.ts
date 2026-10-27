import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type { AddressInfo } from 'node:net';
import { ApiBackend, ApiError, ApiOperationStore, ApiReply } from '../api/contracts';
import { createExternalApiServer } from '../api/server';
import { readExternalApiOptions } from '../api/options';

const token = 'synthetic-test-token-with-at-least-32-characters';
const options = { token, ownerId: 730001, host: '127.0.0.1', port: 3200 };

class Receipts implements ApiOperationStore {
    private rows = new Map<string, { fingerprint: string; result: ApiReply }>();
    async run(key: string, fingerprint: string, work: () => Promise<ApiReply>) {
        const row = this.rows.get(key);
        if (row) {
            if (row.fingerprint !== fingerprint) throw new ApiError(409, 'idempotency_conflict', 'conflict');
            return row.result;
        }
        const result = await work();
        this.rows.set(key, { fingerprint, result });
        return result;
    }
}

async function fixture(t: TestContext, changes: Partial<ApiBackend> = {}) {
    let executions = 0;
    const backend: ApiBackend = {
        status: async () => ({ ok: true }), capabilities: async () => ({ input: ['text'] }),
        history: async limit => ({ limit }), reminders: async () => ({ reminders: [] }),
        tasks: async () => ({ tasks: [] }),
        message: async text => { executions++; return { messages: [{ id: -1, type: 'text', text }] }; },
        action: async text => { executions++; return { messages: [{ id: -2, type: 'notice', text }] }; },
        file: async () => ({ data: Buffer.from('synthetic file'), filename: 'пример.txt' }),
        modelSettings: async () => ({ scope: 'app' }), saveModelSettings: async body => ({ saved: body }),
        turnReady: async () => {},
        photoReady: async () => null, photo: async () => ({ messages: [] }),
        sceneCapabilities: async () => ({ version: 1 }), sceneReady: async () => null,
        sceneTurn: async () => ({ messages: [] }), sceneActionResult: async () => ({ ok: true }),
        ...changes,
    };
    const server = createExternalApiServer(options, backend, new Receipts());
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
    const request = (path: string, init: RequestInit = {}) => fetch(url + path, {
        ...init, headers: { Authorization: `Bearer ${token}`, ...init.headers },
    });
    const post = (path: string, body: unknown, key = 'synthetic-key-001') => request(path, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
        body: JSON.stringify(body),
    });
    return { request, post, url, executions: () => executions };
}

test('API is opt-in and refuses insecure or ownerless configuration', () => {
    assert.equal(readExternalApiOptions({}, 0), undefined);
    assert.throws(() => readExternalApiOptions({ KIRA_API_ENABLED: 'true' }, 730001), /TOKEN/);
    assert.throws(() => readExternalApiOptions({ KIRA_API_ENABLED: 'true', KIRA_API_TOKEN: token }, 0), /USER_ID/);
    assert.throws(() => readExternalApiOptions({ KIRA_API_ENABLED: 'true', KIRA_API_TOKEN: token, KIRA_API_PORT: 'NaN' }, 730001));
    assert.equal(readExternalApiOptions({ KIRA_API_ENABLED: 'true', KIRA_API_TOKEN: token }, 730001)?.host, '127.0.0.1');
});

test('settings require authentication, validate the entire patch and accept idempotent updates without a mutation key', async t => {
    let calls = 0;
    let state: any = { budgetMode: 'normal', budgetModes: [], telegram: { personalSessionConfigured: false }, features: [] };
    const f = await fixture(t, {
        settings: async () => state,
        updateSettings: async patch => { calls++; state = { ...state, ...patch }; return state; },
    });
    assert.equal((await fetch(f.url + '/settings')).status, 401);
    assert.equal((await f.request('/settings')).status, 200);
    for (const patch of [{ background: { reflection: 'false' } }, { budgetMode: 'invalid' },
        { background: { reflection: false }, userId: 12345 }]) {
        const response = await f.request('/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
        assert.equal(response.status, 400);
    }
    assert.equal(calls, 0);
    const response = await f.request('/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ budgetMode: 'maximum', background: { reflection: false } }) });
    assert.equal(response.status, 200);
    assert.equal((await response.json() as any).budgetMode, 'maximum');
    assert.equal(calls, 1);
    const disallowed = await f.request('/settings', { method: 'DELETE' });
    assert.equal(disallowed.status, 405);
    assert.equal(disallowed.headers.get('allow'), 'GET, PATCH');
});

test('model preferences use authenticated GET/PUT and only accept one quality axis with three levels', async t => {
    const { parsePreferences } = await import('../ai/modelPreferences');
    let saved = { quality: 'high' };
    let writes = 0;
    const f = await fixture(t, {
        modelPreferences: async () => ({ preferences: saved, scope: 'account' }),
        updateModelPreferences: async body => {
            try { saved = parsePreferences(body); } catch { throw new ApiError(400, 'invalid_preferences', 'Invalid'); }
            writes++; return { success: true, preferences: saved };
        },
    });
    assert.equal((await fetch(f.url + '/model-preferences')).status, 401);
    assert.equal((await f.request('/model-preferences')).status, 200);
    for (const body of [{ ...saved, userId: 123 }, { ...saved, model: 'gpt-6-astra' }, { ...saved, cost: 'unlimited' }]) {
        assert.equal((await f.request('/model-preferences', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).status, 400);
    }
    assert.equal(writes, 0);
    assert.equal((await f.request('/model-preferences', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quality: 'standard' }) })).status, 200);
    assert.equal(saved.quality, 'standard'); assert.equal(writes, 1);
    assert.equal((await f.request('/model-preferences', { method: 'POST' })).status, 405);
});

test('every route including files requires a bearer token; errors carry no private details', async t => {
    const f = await fixture(t);
    for (const path of ['/status', '/history', '/files/12345678-1234-4123-8123-123456789012']) {
        const res = await fetch(f.url + path);
        assert.equal(res.status, 401);
        assert.equal(res.headers.get('cache-control'), 'no-store');
        assert.equal(res.headers.get('www-authenticate'), 'Bearer');
    }
    assert.equal((await f.request('/status', { headers: { Authorization: 'Bearer wrong' } })).status, 401);
    assert.equal(f.executions(), 0);
});

test('authenticated discovery, history limits and binary downloads', async t => {
    const f = await fixture(t);
    assert.deepEqual(await (await f.request('/status')).json(), { ok: true });
    assert.deepEqual(await (await f.request('/history?limit=5')).json(), { limit: 5 });
    assert.equal((await f.request('/history?limit=21')).status, 400);
    assert.equal((await f.request('/history?limit=1.5')).status, 400);
    assert.equal((await f.request('/internal/health')).status, 404);
    const file = await f.request('/files/12345678-1234-4123-8123-123456789012');
    assert.equal(await file.text(), 'synthetic file');
    assert.match(file.headers.get('content-disposition')!, /filename\*=UTF-8''/);
});

test('deferred dialogue results and cancellation are authenticated and do not accept a caller channel', async t => {
    const id = '12345678-1234-4123-8123-123456789012';
    const cancelled: string[] = [];
    const f = await fixture(t, { dialogueJobs: async () => ({ jobs: [{ id, status: 'completed', result: 'Синтетический ответ' }] }),
        cancelDialogueJob: async jobId => { cancelled.push(jobId); return { cancelled: true }; } });
    assert.equal((await fetch(f.url + '/dialogue-jobs')).status, 401);
    assert.equal((await fetch(f.url + `/dialogue-jobs/${id}`, { method: 'DELETE' })).status, 401);
    assert.equal((await (await f.request('/dialogue-jobs')).json()).jobs[0].result, 'Синтетический ответ');
    assert.equal((await f.request('/dialogue-jobs/not-an-id', { method: 'DELETE' })).status, 404);
    assert.equal((await f.request(`/dialogue-jobs/${id}`, { method: 'DELETE' })).status, 200);
    assert.deepEqual(cancelled, [id]); assert.equal(f.executions(), 0);
});

test('deferred answers require client opt-in and participate in idempotency', async t => {
    const preferences: boolean[] = [];
    const f = await fixture(t, { message: async (_text, options) => {
        preferences.push(options?.deferredDialogue === true);
        return { messages: [], ...(options?.deferredDialogue ? { backgroundJob: { id: '12345678-1234-4123-8123-123456789012', status: 'queued', required: true } } : {}) };
    } });
    await f.post('/messages', { text: 'Синтетический вопрос' }, 'sync-request-001');
    const headers = { 'Content-Type': 'application/json', 'Idempotency-Key': 'async-request-001', Prefer: 'respond-async' };
    const init = { method: 'POST', headers, body: JSON.stringify({ text: 'Синтетический вопрос' }) };
    const response = await f.request('/messages', init);
    assert.equal(response.status, 200); assert.equal(response.headers.get('Preference-Applied'), 'respond-async');
    const first = await response.json();
    assert.deepEqual(await (await f.request('/messages', init)).json(), first);
    assert.equal((await f.post('/messages', { text: 'Синтетический вопрос' }, 'async-request-001')).status, 409);
    assert.deepEqual(preferences, [false, true]);
});

test('message retries replay the receipt, and a reused key with different text conflicts', async t => {
    const f = await fixture(t);
    const first = await f.post('/messages', { text: 'Привет' });
    assert.equal(first.status, 200);
    const receipt = await first.json();
    assert.deepEqual(await (await f.post('/messages', { text: 'Привет' })).json(), receipt);
    assert.equal(f.executions(), 1);
    assert.equal((await f.post('/messages', { text: 'Другая команда' })).status, 409);
    assert.equal(f.executions(), 1);
});

test('one action is never repeated even when the client sends a new idempotency key', async t => {
    const f = await fixture(t);
    await f.post('/actions', { actionToken: 'signed-action-token' }, 'synthetic-first');
    await f.post('/actions', { actionToken: 'signed-action-token' }, 'synthetic-second');
    assert.equal(f.executions(), 1);
});

test('HTTP boundary rejects identity overrides, raw callbacks, invalid JSON and oversized bodies', async t => {
    const f = await fixture(t);
    for (const body of [{ text: '' }, { text: 'ok', userId: 730002 }, { text: 'ok', chatId: 730002 }, [],
        { text: 'x'.repeat(8001) }]) {
        assert.equal((await f.post('/messages', body)).status, 400);
    }
    assert.equal((await f.post('/actions', { callbackData: 'send_message' })).status, 400);
    assert.equal((await f.request('/messages', { method: 'POST', body: '{}' })).status, 415);
    assert.equal((await f.request('/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status, 400);
    assert.equal((await f.request('/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"text":"ok"}' })).status, 400);
    assert.equal((await f.post('/messages', { text: 'x'.repeat(70_000) })).status, 413);
    assert.equal((await f.request('/messages')).status, 405);
    assert.equal(f.executions(), 0);
});

test('concurrent mutations are refused before invoking the backend', async t => {
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { started = resolve; });
    const f = await fixture(t, { message: async () => { started(); await gate; return { messages: [] }; } });
    const pending = f.post('/messages', { text: 'Долгий запрос' });
    await ready;
    const busy = await f.post('/messages', { text: 'Второй запрос' }, 'synthetic-key-002');
    assert.equal(busy.status, 409);
    assert.equal((await busy.json()).error.code, 'conversation_busy');
    release();
    assert.equal((await pending).status, 200);
});

test('unexpected failures do not disclose secrets or stack traces', async t => {
    const f = await fixture(t, { status: async () => { throw new Error('synthetic-secret /private/path'); } });
    const res = await f.request('/status');
    assert.equal(res.status, 500);
    const body = await res.text();
    assert.doesNotMatch(body, /synthetic-secret|private\/path|stack/);
    assert.ok(res.headers.get('x-request-id'));
});
