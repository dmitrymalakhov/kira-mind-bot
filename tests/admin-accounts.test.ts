import assert from 'node:assert/strict';
import test from 'node:test';
const { registerAccountsRoutes } = require('../admin-panel/accounts');

const id = '11111111-1111-4111-8111-111111111111';
const account = { id, username: 'synthetic_account', accountState: 'active', runtimeMode: 'telegram', status: 'awaiting_telegram',
    bot: { username: 'synthetic_account_bot', connected: false }, canConnectBot: true };
async function request(operation: string, result: any, input: any = {}) {
    const handlers = new Map<string, any>();
    const register = (method: string) => (route: string, _auth: any, handler: any) => handlers.set(`${method} ${route}`, handler);
    const app = { get: register('GET'), post: register('POST'), put: register('PUT'),patch:register('PATCH'),delete:register('DELETE') };
    let calls = 0;
    registerAccountsRoutes(app, { requireAuth: () => {}, operatorAuth: { manageAccounts: async () => { calls++; return result; } } });
    const req = { query: {}, params: {}, headers: { 'idempotency-key': 'synthetic-request-key' }, body: {}, ...input };
    const res = { statusCode: 200, body: undefined as any, headers: {} as any, status(code: number) { this.statusCode = code; return this; },
        json(body: any) { this.body = body; return this; }, setHeader(name: string, value: string) { this.headers[name] = value; } };
    const routes: Record<string, string> = { list: 'GET /api/accounts', create: 'POST /api/accounts', connect: 'PUT /api/accounts/:id/bot', pairing: 'GET /api/accounts/:id/pairing' };
    await handlers.get(routes[operation])(req, res); return { ...res, calls };
}
test('account panel distinguishes standalone from an unavailable authority and never forwards credentials or arbitrary upstream errors', async () => {
    const standalone = await request('list', undefined); assert.deepEqual(standalone.body, { version: 1, available: false, accounts: [] });
    assert.equal((await request('create', undefined, { body: { username: 'synthetic_account', password: 'synthetic-password' } })).statusCode, 409);
    const result = { ok: true, status: 200, body: { version: 1, capacity: 10, accounts: [{ ...account, secrets: 'synthetic-secret', password_hash: 'synthetic-hash', owner_id: '10001' }] } };
    const list = await request('list', result); assert.equal(list.headers['Cache-Control'], 'no-store'); assert.deepEqual(list.body.accounts, [account]);
    for (const value of [
        { ok: false, status: 500, body: { error: { code: 'unknown', message: 'synthetic-provider-secret' } } },
        { ok: true, body: { ...result.body, version: 2 } },
        { ok: true, body: { ...result.body, accounts: [{ ...account, bot: { username: 'https://synthetic.evil.invalid', connected: false } }] } },
    ]) {
        const response = await request('list', value); assert.equal(response.statusCode, 503); assert.doesNotMatch(JSON.stringify(response.body), /synthetic-provider-secret/);
    }
});
test('account panel validates exact operation fields and keys and only exposes a verified Telegram pairing URL', async () => {
    for (const input of [{ query: { accountId: id } }, { body: { username: 'synthetic_account', password: 'synthetic-password', ownerId: 10001 } },
        { body: [] }, { headers: {}, body: { username: 'synthetic_account', password: 'synthetic-password' } }]) {
        const response = await request('create', undefined, input); assert.equal(response.statusCode, 400); assert.equal(response.calls, 0);
    }
    const response = (pairing: any) => ({ ok: true, body: { version: 1, account, pairing } });
    const pairing = { pairingUrl: `https://t.me/synthetic_account_bot?start=${'a'.repeat(43)}`, expiresAt: '2037-01-01T00:00:00Z' };
    assert.deepEqual((await request('pairing', response(pairing), { params: { id } })).body.pairing, pairing);
    for (const url of ['https://synthetic.evil.invalid', pairing.pairingUrl + '&redirect=external', pairing.pairingUrl.replace('synthetic_account_bot','different_bot')]) {
        assert.equal((await request('pairing', response({ ...pairing, pairingUrl: url }), { params: { id } })).statusCode, 503);
    }
    assert.equal((await request('pairing', response(null), { params: { id: '../secrets' } })).statusCode, 400);
});
