import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createExternalApiServer } from '../api/server';
import { BrowserSessionApi } from '../api/browser';
import type { ApiBackend } from '../api/contracts';
import { LiveBrowserRegistry } from '../services/liveBrowserSession';

async function fixture(t: any) {
    const owner = 94001, scope = `api:${owner}`, token = 'synthetic-browser-http-token-not-a-real-credential';
    const registry = new LiveBrowserRegistry(), browser = new BrowserSessionApi(owner, scope, work => work(), registry,
        async text => ({ intent: 'pause', confidence: 1, evidence: text, reply: 'Пауза.' }));
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let operationId: string | undefined;
    const backend = { browserSession: browser, turnReady: async () => {}, message: async (_text: string, options: any) => {
        operationId = options.liveBrowserRequest?.operationId;
        registry.create(owner, scope, operationId!);
        await held; return { messages: [] };
    } } as unknown as ApiBackend;
    const server = createExternalApiServer({ ownerId: owner, token, host: '127.0.0.1', port: 0 }, backend,
        { run: async (_key, _fingerprint, work) => work() });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
    const request = (path: string, init: RequestInit = {}) => fetch(base + path, { ...init, headers: { Authorization: `Bearer ${token}`, ...init.headers } });
    const post = (path: string, body: unknown, headers: Record<string,string> = {}) => request(path, { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID(), ...headers }, body: JSON.stringify(body) });
    t.after(async () => { release(); registry.active(owner, scope)?.dispose(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); });
    return { browser, registry, owner, scope, base, request, post, release, operationId: () => operationId };
}

test('authenticated browser control bypasses a held ordinary message; opt-in operation linkage survives discovery', async t => {
    const f = await fixture(t), key = randomUUID();
    assert.equal((await fetch(f.base + '/browser/sessions/active')).status, 401);
    assert.equal((await f.request('/browser/sessions/active')).status, 200);
    const pending = f.post('/messages', { text: 'Synthetic browser task' }, { 'X-Kira-Browser-Session': 'v1', 'Idempotency-Key': key });
    let snapshot: any;
    for (let i = 0; i < 30; i++) {
        snapshot = await (await f.request(`/browser/sessions/active?operationId=${key}`)).json();
        if (snapshot.session) break; await new Promise(r => setTimeout(r, 5));
    }
    assert.ok(snapshot.session); assert.equal(snapshot.session.operationId, key); assert.equal(f.operationId(), key);
    const path = `/browser/sessions/${snapshot.session.sessionId}`;
    const stopped = await f.post(`${path}/commands`, { type: 'stop' });
    assert.equal(stopped.status, 200); assert.equal((await stopped.json() as any).session.state, 'cancelled');
    f.release(); assert.equal((await pending).status, 200);
});

test('public routes enforce account/scope, method, observer, confirmation and input schemas', async t => {
    const f = await fixture(t); const session = f.registry.create(f.owner, f.scope, 'synthetic-operation'); t.after(() => session.dispose());
    const foreign = f.registry.create(94002, 'api:94002', 'foreign-operation'); t.after(() => foreign.dispose());
    assert.equal((await f.request(`/browser/sessions/${foreign.id}`)).status, 404);
    assert.equal((await f.post(`/browser/sessions/${session.id}/events`, {})).status, 404);
    assert.equal((await f.request(`/browser/sessions/${session.id}/events?observerId=${randomUUID()}`)).status, 409);
    assert.equal((await f.post(`/browser/sessions/${session.id}/observers`, { observerId: randomUUID(), token: 'unwanted' })).status, 422);
    assert.equal((await f.post(`/browser/sessions/${session.id}/input`, { input: { type: 'evaluate', script: 'danger' } })).status, 409);
    assert.equal((await f.request('/browser/sessions/not-a-uuid')).status, 404);
    const key = randomUUID(), observerId = randomUUID();
    assert.equal((await f.post(`/browser/sessions/${session.id}/observers`, { observerId }, { 'Idempotency-Key': key })).status, 200);
    assert.equal((await f.post(`/browser/sessions/${session.id}/observers`, { observerId }, { 'Idempotency-Key': key })).status, 200);
    assert.equal((await f.post(`/browser/sessions/${session.id}/observers`, { observerId: randomUUID() }, { 'Idempotency-Key': key })).status, 409);
});

test('SSE starts with an ordered authoritative snapshot and closing its socket safely disconnects the task', async t => {
    const f = await fixture(t); const session = f.registry.create(f.owner, f.scope, 'synthetic-operation'); t.after(() => session.dispose());
    const observerId = randomUUID(), path = `/browser/sessions/${session.id}`;
    assert.equal((await f.post(`${path}/observers`, { observerId })).status, 200);
    const abort = new AbortController();
    const stream = await f.request(`${path}/events?observerId=${observerId}&after=0`, { signal: abort.signal });
    assert.equal(stream.status, 200); assert.match(stream.headers.get('content-type')!, /text\/event-stream/);
    assert.equal(stream.headers.get('x-accel-buffering'), 'no');
    const reader = stream.body!.getReader(); const first = new TextDecoder().decode((await reader.read()).value);
    assert.match(first, /event: snapshot/); assert.match(first, /"resync":true/);
    abort.abort();
    for (let i = 0; i < 30 && session.state !== 'disconnected'; i++) await new Promise(r => setTimeout(r, 5));
    assert.equal(session.state, 'disconnected');
});
