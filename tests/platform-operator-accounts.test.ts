import assert from 'node:assert/strict';
import test from 'node:test';
import * as http from 'node:http';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { ApiError } from '../api/contracts';
import { BotConnections } from '../platform/botConnection';
import { OperatorAccountsHttp, ManagedAccountStore } from '../platform/operatorAccounts';
import { Account, PostgresAccountStore } from '../platform/store';
import { createPlatformServer } from '../platform/server';
import { digest, checkPassword } from '../platform/crypto';
import { TenantRuntimeManager } from '../platform/runtime';
import { pairingOwner, TelegramGateway } from '../platform/telegram';
import { PublicReceipts } from '../platform/publicAccounts/receipts';
import { canonicalJson } from '../platform/publicAccounts/validation';
import { operatorRouteAllowed } from '../platform/publicAccounts/operatorProxy';
import { publicTestPort, publicTestSecrets as secrets, withPublicRegistry } from './support/publicAccounts';
import { close, listen, publicWebHarness } from './support/publicWeb';

const adminRequire = createRequire(path.resolve('admin-panel/package.json'));
const express = adminRequire('express');
const { createOperatorAuth } = adminRequire('./operatorAuth');
const { registerAccountsRoutes } = adminRequire('./accounts');
const operatorPassword = 'synthetic-operator-password-123';
const userPassword = 'synthetic-owner-password-123';
const tokenA = '111111:abcdefghijklmnopqrstuvwxyzABCDE';
const tokenB = '222222:abcdefghijklmnopqrstuvwxyzABCDE';

class MemoryManagedStore implements ManagedAccountStore {
    rows = new Map<string, Account>(); sessions = new Map<string, string>(); requests = new Map<string, { fingerprint: string; id: string }>();
    async create(username: string, hash: string) {
        if (await this.byUsername(username)) throw new ApiError(409, 'username_unavailable', 'Логин занят.');
        const row: Account = { id: randomUUID(), username, password_hash: hash, bot_id: null, bot_username: null, owner_id: null,
            secrets: null, pairing_hash: null, pairing_expires: null, update_offset: 0, runtime_mode: 'telegram', account_state: 'active', autonomous_ai_enabled: false, public_origin: true };
        this.rows.set(row.id, row); return row;
    }
    async createManaged(username: string, hash: string, key: string, fingerprint: string) {
        const old = this.requests.get(key);
        if (old) { if (old.fingerprint !== fingerprint) throw new ApiError(409, 'idempotency_conflict', 'Другие поля.'); return this.rows.get(old.id)!; }
        const row = await this.create(username, hash); this.requests.set(key, { fingerprint, id: row.id }); return row;
    }
    async listManaged() { return [...this.rows.values()].filter(a => !['deleting','deleted'].includes(a.account_state || '')); }
    async byId(id: string) { return this.rows.get(id); }
    async byUsername(username: string) { return [...this.rows.values()].find(a => a.username === username); }
    async session(hash: string, id: string) { this.sessions.set(hash, id); }
    async authenticate(hash: string) { return this.rows.get(this.sessions.get(hash) || ''); }
    async logout(hash: string) { this.sessions.delete(hash); }
    async connect(id: string, botId: string, username: string, encrypted: string, hash: string) {
        const row = this.rows.get(id)!;
        if (row.owner_id) throw new ApiError(409, 'bot_already_connected', 'Подключён.');
        if ([...this.rows.values()].some(a => a.bot_id === botId && a.id !== id)) throw new ApiError(409, 'bot_unavailable', 'Занят.');
        Object.assign(row, { bot_id: botId, bot_username: username, secrets: encrypted, pairing_hash: hash, pairing_expires: new Date(Date.now() + 900_000) });
    }
    async pair(id: string, hash: string, owner: number, offset: number) {
        const row = this.rows.get(id)!;
        if (row.owner_id || row.pairing_hash !== hash || !row.pairing_expires || row.pairing_expires.getTime() <= Date.now()) return false;
        Object.assign(row, { owner_id: String(owner), pairing_hash: null, pairing_expires: null, update_offset: offset }); return true;
    }
    async offset(id: string, hash: string, offset: number) { const row = this.rows.get(id)!; if (row.pairing_hash === hash) row.update_offset = offset; }
    async configured() { return (await this.listManaged()).filter(a => a.secrets).map(a => ({ ...a })); }
    async updateSecrets(id: string, _previous: string, encrypted: string) { this.rows.get(id)!.secrets = encrypted; }
}
class MemoryReceipts implements Pick<PublicReceipts, 'run'> {
    rows = new Map<string, { fingerprint: string; result: unknown }>();
    async run<T>(account: string, key: string, method: string, route: string, body: unknown, work: () => Promise<T>): Promise<T> {
        const id = `${account}:${key}`, fingerprint = canonicalJson({ method, route, body }), old = this.rows.get(id);
        if (old) { if (old.fingerprint !== fingerprint) throw new ApiError(409, 'idempotency_conflict', 'Другой запрос.'); return old.result as T; }
        const result = await work(); this.rows.set(id, { fingerprint, result }); return result;
    }
}

async function harness(store: ManagedAccountStore, receipts: Pick<PublicReceipts, 'run'>) {
    let verifies = 0;
    const updates = new Map<string, any[]>();
    const telegram: TelegramGateway = {
        verify: async token => { verifies++; if (token === 'webhook') throw new ApiError(409, 'bot_has_webhook', 'synthetic-private-provider-payload');
            if (![tokenA, tokenB, 'reserved'].includes(token)) throw new ApiError(400, 'invalid_bot_token', token);
            return { id: token === tokenA ? 111111 : token === tokenB ? 222222 : 333333, username: token === tokenA ? 'synthetic_first_bot' : 'synthetic_second_bot' }; },
        updates: async token => updates.get(token) || [], verifySession: async () => {},
    };
    let runtimeStatus = 'ready';
    const runtimes = { status: () => runtimeStatus, endpoint: () => ({ port: 1, token: 'unused' }), restart: async () => {} };
    const bots = new BotConnections(store, secrets, telegram, ['333333']);
    let socialAllowed = true;
    const bridge = { introspect: async (token: string, browser: string) => ({ version: 1, authorized: socialAllowed && token === 'a'.repeat(43) && browser === 'b'.repeat(43), accountId: '11111111-1111-4111-8111-111111111111' }) };
    const management = new OperatorAccountsHttp(store, secrets, runtimes, bots, receipts, { username: 'synthetic_operator', password: operatorPassword,
        capacity: 100, bridgeSecret: 'c'.repeat(64), operator: bridge as any });
    const platform = createPlatformServer({ store, secrets, runtimes, telegram, botConnections: bots, operatorAccounts: management });
    const base = await listen(platform);
    const operator = createOperatorAuth({ username: 'synthetic_operator', password: operatorPassword, sessionSecret: 'synthetic-session-secret', cookieName: 'synthetic.sid',
        env: { KIRA_ACCOUNT_AUTH_URL: base } });
    const app = express(); app.use(operator.prepare); app.use(express.json()); app.use(operator.session); app.use(operator.csrfGuard); operator.register(app);
    app.post('/api/login', operator.rateLimit, operator.login); app.post('/api/logout', (req: any, res: any) => req.session.destroy(() => res.json({ success: true })));
    registerAccountsRoutes(app, { requireAuth: operator.requireAuth, operatorAuth: operator });
    const admin = http.createServer(app), adminBase = await listen(admin);
    let cookie = '', csrf = '';
    const call = async (route: string, body?: unknown, options: { method?: string; key?: string; headers?: Record<string,string> } = {}) => {
        const method = options.method || (body === undefined ? 'GET' : 'POST');
        const response = await fetch(adminBase + route, { method, headers: { cookie, origin: adminBase, 'x-csrf-token': csrf,
            ...(body ? { 'content-type': 'application/json' } : {}), ...(options.key ? { 'idempotency-key': options.key } : {}), ...options.headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
        const set = response.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
        const data: any = await response.json(); if (data.csrfToken) csrf = data.csrfToken;
        return { status: response.status, data, headers: response.headers };
    };
    return { base, store, telegram, updates, call, verifies: () => verifies, revoke: () => { socialAllowed = false; }, setStatus: (state: string) => { runtimeStatus = state; },
        close: async () => { await close(admin); await close(platform); } };
}

async function scenario(store: ManagedAccountStore, receipts: Pick<PublicReceipts, 'run'>) {
    const h = await harness(store, receipts);
    try {
        assert.equal((await h.call('/api/accounts')).status, 401);
        await h.call('/api/auth/context');
        assert.equal((await h.call('/api/login', { username: 'synthetic_operator', password: operatorPassword })).status, 200);
        const create = (username: string, key = randomUUID()) => h.call('/api/accounts', { username, password: userPassword }, { key });
        assert.equal((await h.call('/api/accounts', { username: 'synthetic_denied', password: userPassword }, { key: randomUUID(), headers: { 'x-csrf-token': '' } })).status, 403);
        const key = randomUUID(), a = await create('SYNTHETIC_FIRST', key), again = await create('synthetic_first', key), b = await create('synthetic_second');
        assert.equal(a.status, 201); assert.equal(b.status, 201); assert.equal(again.data.account.id, a.data.account.id);
        assert.notEqual(a.data.account.id, b.data.account.id);
        assert.equal((await create('synthetic_changed', key)).status, 409);
        assert.equal((await create('synthetic_first')).status, 409);
        assert.equal((await create('bad name')).status, 400);
        assert.equal((await h.call('/api/accounts', { username: 'synthetic_short', password: 'short' }, { key: randomUUID() })).status, 400);
        const aId = a.data.account.id, bId = b.data.account.id;
        const row = (await store.byId(aId))!;
        assert.equal(row.runtime_mode, 'telegram'); assert.equal(row.autonomous_ai_enabled, false);
        assert.equal(await checkPassword(userPassword, row.password_hash), true);
        const attach = (id: string, token: string, key = randomUUID()) => h.call(`/api/accounts/${id}/bot`, { botToken: token }, { method: 'PUT', key });
        assert.equal((await attach(aId, 'invalid')).status, 400);
        const webhook = await attach(aId, 'webhook'); assert.equal(webhook.status, 409); assert.doesNotMatch(JSON.stringify(webhook.data), /synthetic-private-provider-payload/);
        assert.equal((await attach(aId, 'reserved')).status, 409);
        const botKey = randomUUID(), first = await attach(aId, tokenA, botKey), calls = h.verifies(), retry = await attach(aId, tokenA, botKey);
        assert.equal(first.status, 202); assert.equal(h.verifies(), calls); assert.equal(retry.data.pairing.pairingUrl, first.data.pairing.pairingUrl);
        assert.equal((await attach(aId, tokenB, botKey)).status, 409);
        assert.equal((await attach(bId, tokenA)).status, 409);
        const second = await attach(bId, tokenB); assert.equal(second.status, 202);
        assert.notEqual(second.data.pairing.pairingUrl, first.data.pairing.pairingUrl);
        h.setStatus('bot_in_use');
        assert.equal((await h.call('/api/accounts')).data.accounts[0].status, 'bot_in_use', 'polling conflicts remain visible before pairing');
        h.setStatus('ready');
        const recovered = await h.call(`/api/accounts/${aId}/pairing`);
        assert.equal(recovered.data.pairing.pairingUrl, first.data.pairing.pairingUrl);
        const list = await h.call('/api/accounts'); assert.equal(list.headers.get('cache-control'), 'no-store'); assert.equal(list.data.accounts.length, 2);
        assert.doesNotMatch(JSON.stringify(list.data), /pairingUrl|start=|password_hash|pairing_hash|secrets|abcdefghijklmnopqrstuvwxyz|synthetic-owner-password|synthetic-operator-password/);
        assert.equal((await h.call('/api/accounts?accountId=other')).status, 400);
        const codeA = new URL(first.data.pairing.pairingUrl).searchParams.get('start');
        const codeB = new URL(second.data.pairing.pairingUrl).searchParams.get('start');
        const update = (code: string, id: number, group = false) => ({ update_id: 7, message: { message_id: 1, date: 1, text: `/start ${code}`, from: { id, is_bot: false }, chat: { id, type: group ? 'group' : 'private' } } });
        assert.equal(pairingOwner(update(codeA!, 10001, true) as any, digest(codeA!)), undefined);
        h.updates.set(tokenA, [update(codeA!, 10001)]); h.updates.set(tokenB, [update(codeB!, 10001)]);
        // Real manager tick consumes the one-time Telegram updates; it never accepts an owner ID over HTTP.
        const manager = new TenantRuntimeManager(store, {} as any, secrets, h.telegram, '/synthetic-unused');
        await manager.tick();
        assert.equal((await store.byId(aId))!.owner_id, '10001'); assert.equal((await store.byId(bId))!.owner_id, '10001');
        assert.equal((await h.call(`/api/accounts/${aId}/pairing`)).data.pairing, null);
        assert.equal((await attach(aId, tokenB)).status, 409);
        assert.equal((await h.call('/api/accounts')).data.accounts[0].canConnectBot, false);
        const encrypted = (await store.byId(aId))!.secrets!;
        const privateCredential = secrets.open<any>(encrypted, aId);
        assert.equal(privateCredential.botToken, tokenA); assert.throws(() => secrets.open(encrypted, bId));
        const login = await fetch(h.base + '/api/v1/accounts/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'synthetic_first', password: userPassword }) });
        assert.equal(login.status, 200);
        const bearer = (await login.json() as any).accessToken;
        const unauthorized = await fetch(h.base + '/internal/operator/accounts', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}`, 'x-kira-operator-bridge': 'c'.repeat(64) },
            body: JSON.stringify({ version: 1, operator: { kind: 'password', username: 'synthetic_operator', password: 'wrong-password' }, operation: 'list', input: {} }) });
        assert.equal(unauthorized.status, 401);
        const social = () => fetch(h.base + '/internal/operator/accounts', { method: 'POST', headers: { 'content-type': 'application/json', 'x-kira-operator-bridge': 'c'.repeat(64) },
            body: JSON.stringify({ version: 1, operator: { kind: 'account', accessToken: 'a'.repeat(43), browserCookie: 'b'.repeat(43) }, operation: 'list', input: {} }) });
        assert.equal((await social()).status, 200); h.revoke(); assert.equal((await social()).status, 403);
        assert.equal((await fetch(h.base + '/api/v1/accounts/register', { method: 'POST' })).status, 410);
    } finally { await h.close(); }
}

test('operator console creates independent Telegram accounts, recovers pairing, and requires authenticated CSRF-protected operator actions', async () => {
    await scenario(new MemoryManagedStore(), new MemoryReceipts());
});
test('PostgreSQL operator onboarding persists credentials, identities, receipts and owner pairing through the actual HTTP surfaces', { skip: !publicTestPort }, async () => {
    await withPublicRegistry(async (db, store) => {
        await scenario(store, new PublicReceipts(db));
        const [counts] = await db.query("SELECT count(*) FROM kira_public_identities WHERE provider='password'");
        assert.equal(Number(counts.count), 2);
        const receipts = await db.query('SELECT result FROM kira_public_receipts');
        assert.doesNotMatch(JSON.stringify(receipts), /pairingUrl|botToken|start=/);
        const bounded = new PostgresAccountStore(db, 2);
        await assert.rejects(() => bounded.createManaged('synthetic_over_capacity', 'synthetic-hash', 'new-key', 'new-fingerprint'),
            (error: any) => error.code === 'capacity_reached');
        const [request] = await db.query('SELECT * FROM kira_operator_account_requests LIMIT 1');
        const existing = (await store.byId(request.account_id))!;
        // A retry still works when capacity is reached and never replaces its original credential.
        const replay = await bounded.createManaged(existing.username, 'another-unused-hash', request.key_hash, request.fingerprint);
        assert.equal(replay.id, existing.id); assert.equal(replay.password_hash, existing.password_hash);
        await db.query("UPDATE kira_operator_account_requests SET fingerprint='deleted' WHERE key_hash=$1", [request.key_hash]);
        await assert.rejects(() => store.createManaged(existing.username, 'unused', request.key_hash, request.fingerprint),
            (error: any) => error.code === 'account_deleted');
    });
});
test('expired pairing can be renewed, API-only/deleted accounts stay fixed, and a competing connection never changes the confirmed owner', async () => {
    const store = new MemoryManagedStore();
    const a = await store.create('synthetic_pending', 'unused'), b = await store.create('synthetic_api', 'unused');
    b.runtime_mode = 'api_only';
    let release: () => void = () => {};
    const telegram = { verify: async () => { await new Promise<void>(resolve => { release = resolve; }); return { id: 111111, username: 'synthetic_bot' }; } };
    const bots = new BotConnections(store, secrets, telegram);
    await assert.rejects(() => bots.connect(b.id, tokenB), (error: any) => error.code === 'runtime_mode_fixed');
    a.account_state = 'deleted';
    await assert.rejects(() => bots.connect(a.id, tokenA), (error: any) => error.code === 'account_not_found');
    a.account_state = 'active';
    const first = bots.connect(a.id, tokenA);
    await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(() => bots.connect(a.id, tokenB), (error: any) => error.code === 'connection_busy');
    release(); await first;
    const old = bots.pairing(a)!.pairingUrl;
    a.pairing_expires = new Date(Date.now() - 1);
    assert.equal(bots.pairing(a), null);
    const renewed = bots.connect(a.id, tokenA); await new Promise(resolve => setImmediate(resolve)); release(); await renewed;
    assert.notEqual(bots.pairing(a)!.pairingUrl, old);
    a.owner_id = '10001'; assert.equal(bots.pairing(a), null);
    await assert.rejects(() => bots.connect(a.id, tokenB), (error: any) => error.code === 'bot_already_connected');
});
test('operator account routes have an exact public proxy inventory and never expose internal management endpoints', () => {
    const id = randomUUID();
    for (const [method, route] of [['GET','/api/accounts'],['POST','/api/accounts'],['PUT',`/api/accounts/${id}/bot`],['GET',`/api/accounts/${id}/pairing`],
        ['PATCH',`/api/accounts/${id}`],['DELETE',`/api/accounts/${id}`],['POST',`/api/accounts/${id}/bot/replacement`]]) assert.equal(operatorRouteAllowed(method, route), true);
    for (const [method, route] of [['POST','/internal/operator/accounts'],['GET',`/api/accounts/${id}/secrets`],['PUT',`/api/accounts/${id}`],['GET',`/api/accounts/${id}/bot/replacement`],['PUT','/api/accounts/../bot']]) assert.equal(operatorRouteAllowed(method, route), false);
});
test('public operator accounts management requires local login intent and a fresh canonical role on every derived request', { skip: !publicTestPort }, async () => {
    await withPublicRegistry(async (db, store) => {
        const h = await publicWebHarness(db, store);
        try {
            const a = await h.account(), c = h.client();
            await h.webLogin(c, a); await c.call('/operator/api/auth/context');
            assert.equal((await c.call('/operator/api/accounts')).status, 401);
            assert.equal((await c.call('/operator/api/operator/login-account', {})).status, 401);
            await db.query('INSERT INTO kira_public_operator_grants(account_id) VALUES($1)', [a.id]);
            assert.equal((await c.call('/operator/api/accounts')).status, 401, 'a role alone never establishes local operator intent');
            assert.equal((await c.call('/operator/api/operator/login-account', {})).status, 200);
            const list = await c.call('/operator/api/accounts'); assert.equal(list.status, 200); assert.equal(list.data.accounts[0].id, a.id);
            const body = { username: 'synthetic_social_managed', password: userPassword };
            assert.equal((await c.call('/operator/api/accounts', body)).status, 201);
            await db.query('UPDATE kira_public_operator_grants SET revoked_at=now() WHERE account_id=$1', [a.id]);
            assert.equal((await c.call('/operator/api/accounts')).status, 401);
            assert.equal((await c.call('/operator/api/accounts', { ...body, username: 'synthetic_forbidden_after_revoke' })).status, 401);
            assert.equal(await store.byUsername('synthetic_forbidden_after_revoke'), undefined);
            for(const [method,route,body] of [
                ['PATCH',`/operator/api/accounts/${a.id}`,{displayName:'Synthetic forbidden',revision:list.data.accounts[0].revision}],
                ['DELETE',`/operator/api/accounts/${a.id}`,{confirmation:a.username,revision:list.data.accounts[0].revision}],
                ['POST',`/operator/api/accounts/${a.id}/bot/replacement`,{botToken:tokenA,confirmation:a.username,revision:list.data.accounts[0].revision}],
            ] as const)assert.equal((await c.call(route,body,{method})).status,401,'revoked operator role must deny every lifecycle action');
        } finally { await h.shutdown(); }
    });
});
