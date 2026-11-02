import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test, TestContext } from 'node:test';
import type { AddressInfo } from 'node:net';
import { ApiBackend, ApiError, ApiOperationStore, ApiReply } from '../api/contracts';
import { createExternalApiServer } from '../api/server';
import { WorkoutHttpApi, workoutRouteAllowed } from '../api/workouts/http';
import { fixture, syncInput, evt } from './helpers/workouts';

class JsonReceipts implements ApiOperationStore {
    private ledger = new Map<string, { fingerprint: string; result?: object }>();
    async run(key: string, fingerprint: string, work: () => Promise<ApiReply>) { return this.runJson(key, fingerprint, work); }
    async runJson<T extends object>(key: string, fingerprint: string, work: () => Promise<T>): Promise<T> {
        const old = this.ledger.get(key);
        if (old) {
            if (old.fingerprint !== fingerprint) throw new ApiError(409, 'idempotency_conflict', 'conflict');
            if (old.result) return old.result as T;
            throw new ApiError(409, 'operation_uncertain', 'unknown');
        }
        const row: { fingerprint: string; result?: object } = { fingerprint }; this.ledger.set(key, row);
        const result = await work(); row.result = result; return result;
    }
}
async function httpFixture(t: TestContext) {
    const f = fixture(), api = new WorkoutHttpApi(f.service), receipts = new JsonReceipts(), token = 'synthetic-workout-http-access-token-at-least-32';
    const backend = { workouts: api } as ApiBackend;
    const server = createExternalApiServer({ token, ownerId: 739501, host: '127.0.0.1', port: 0 }, backend, receipts);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); });
    const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/api/v1';
    async function request(path: string, method = 'GET', body?: unknown, key: string = randomUUID(), authorized = true) {
        return fetch(base + path, { method, headers: { ...(authorized ? { Authorization: 'Bearer ' + token } : {}),
            'Content-Type': 'application/json', 'Idempotency-Key': key }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    }
    async function json(path: string, method = 'GET', body?: unknown, key?: string): Promise<any> {
        const response = await request(path, method, body, key);
        const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result;
    }
    return { ...f, request, json };
}

test('real HTTP boundary: authenticate, register, offline start/finish, replay, typed summary and scoped lookup', async t => {
    const f = await httpFixture(t);
    assert.equal((await f.request('/workouts', 'GET', undefined, undefined, false)).status, 401);
    const key = randomUUID(), registration = { installationId: randomUUID(), platform: 'ios' };
    const { device } = await f.json('/workouts/devices', 'POST', registration, key);
    assert.deepEqual(await f.json('/workouts/devices', 'POST', registration, key), { device });
    assert.equal((await f.request('/workouts/devices', 'POST', { ...registration, platform: 'watchos' }, key)).status, 409);
    assert.equal((await f.request('/workouts/devices', 'POST', { ...registration, userId: 123 })).status, 400);
    const input = syncInput(device, [evt(1, 'started', 0), evt(2, 'finished', 60000)]);
    const { workout } = await f.json('/workouts/sync', 'POST', input);
    assert.equal(workout.state, 'finished');
    const page = await f.json('/workouts?limit=1');
    assert.equal(page.workouts[0].metrics.activeDurationMs, 60000);
    assert.equal(page.nextCursor, null);
    assert.equal('events' in page.workouts[0], false);
    assert.equal((await f.json('/workouts/' + workout.id)).workout.events.length, 2);
    assert.equal((await f.request('/workouts/' + randomUUID())).status, 404);
    assert.equal((await f.request('/workouts?limit=1&limit=2')).status, 400);
    assert.equal((await f.request('/workouts/active', 'POST', {})).status, 404);
    const planId = randomUUID(), plan = { id: planId, title: 'Тестовый план', activityType: 'walking', kind: 'plan', steps: [{ title: 'Ходьба', durationMs: 120000 }] };
    await f.json('/workouts/plans', 'POST', plan);
    assert.equal((await f.json('/workouts/plans')).plans.length, 1);
    const { id, ...values } = plan;
    await f.json('/workouts/plans/' + id, 'PUT', { ...values, expectedRevision: 1 });
    await f.json('/workouts/plans/' + id + '?expectedRevision=2', 'DELETE');
    await f.json('/workouts/devices/' + device.id, 'DELETE');
});

test('HTTP command remains requested until claim, causal event and applied ACK', async t => {
    const f = await httpFixture(t), { device } = await f.json('/workouts/devices', 'POST', { installationId: randomUUID(), platform: 'ios' });
    const binding = { deviceId: device.id, bindingId: device.bindingId };
    const { command } = await f.json('/workouts/commands', 'POST', { ...binding, action: 'start',
        args: { activityType: 'running', location: 'outdoor', mode: 'manual', timeZone: 'UTC' } });
    assert.equal((await f.json('/workouts/active')).workout.state, 'requested');
    const polled = await f.json('/workouts/commands?' + new URLSearchParams(binding));
    assert.equal(polled.commands[0].recordingId, command.recordingId);
    await f.json('/workouts/commands/' + command.id + '/claim', 'POST', binding);
    const start = evt(1, 'started', 0, {}, command.id);
    assert.equal((await f.request('/workouts/commands/' + command.id + '/result', 'POST', { ...binding, status: 'applied', eventId: start.eventId, seq: 1 })).status, 409);
    await f.json('/workouts/sync', 'POST', { ...syncInput(device, [start]), ...command.args, workoutId: command.workoutId, recordingId: command.recordingId });
    await f.json('/workouts/commands/' + command.id + '/result', 'POST', { ...binding, status: 'applied', eventId: start.eventId, seq: 1 });
    assert.equal((await f.json('/workouts/active')).workout.state, 'running');
});

test('HTTP consent and erase are receipt-backed; body limit and gateway route policy remain bounded', async t => {
    const f = await httpFixture(t), { device } = await f.json('/workouts/devices', 'POST', { installationId: randomUUID(), platform: 'ios' });
    const binding = { deviceId: device.id, bindingId: device.bindingId };
    const { sync } = await f.json('/health-sync/consent', 'PUT', { ...binding, enabled: true, consentVersion: 1 });
    const result = await f.json('/health-sync/batch', 'POST', { ...binding, generation: sync.generation, changes: [] });
    assert.equal(result.accepted, 0);
    assert.equal((await f.json('/health-sync/data', 'DELETE')).sync.enabled, false);
    assert.equal((await f.request('/workouts/devices', 'POST', { installationId: 'x'.repeat(70000), platform: 'ios' })).status, 413);
    assert.equal(workoutRouteAllowed('GET', '/api/v1/workouts'), true);
    assert.equal(workoutRouteAllowed('DELETE', '/api/v1/workouts'), false);
    assert.equal(workoutRouteAllowed('POST', '/api/v1/workouts/' + randomUUID()), false);
    assert.equal(workoutRouteAllowed('POST', '/api/v1/workouts/commands/' + randomUUID() + '/claim'), true);
    assert.equal(workoutRouteAllowed('GET', '/api/v1/workouts/../../settings'), false);
});
