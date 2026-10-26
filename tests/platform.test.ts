import assert from 'node:assert/strict';
import test from 'node:test';
import * as http from 'node:http';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { AddressInfo } from 'node:net';
import { ApiError, ApiOperationStore, ApiReply } from '../api/contracts';
import { checkPassword, digest, newToken, passwordHash, PlatformSecrets } from '../platform/crypto';
import { Account, AccountStore, tenantName } from '../platform/store';
import { AccountRuntimes, TenantRuntimeManager, tenantEnvironment } from '../platform/runtime';
import { pairingOwner, TelegramGateway } from '../platform/telegram';
import { createPlatformServer } from '../platform/server';
import { createBrowserProxy, publicAddress } from '../platform/browserProxy';
import { createExternalApiServer } from '../api/server';
import type { ApiSettings } from '../api/settings';
import { parsePreferences } from '../ai/modelPreferences';

class MemoryApiOperations implements ApiOperationStore {
    private results = new Map<string, { fingerprint: string; result: ApiReply }>();
    async run(key: string, fingerprint: string, work: () => Promise<ApiReply>): Promise<ApiReply> {
        const existing = this.results.get(key);
        if (existing) {
            if (existing.fingerprint !== fingerprint) throw new ApiError(409, 'idempotency_conflict', 'Другой запрос.');
            return existing.result;
        }
        const result = await work(); this.results.set(key, { fingerprint, result }); return result;
    }
}

class MemoryAccounts implements AccountStore {
    accounts = new Map<string, Account>();
    sessions = new Map<string, string>();
    async create(username: string, hash: string) {
        if (await this.byUsername(username)) throw new ApiError(409, 'username_unavailable', 'Логин занят.');
        const account: Account = { id: randomUUID(), username, password_hash: hash, bot_id: null, bot_username: null,
            owner_id: null, secrets: null, pairing_hash: null, pairing_expires: null, update_offset: 0 };
        this.accounts.set(account.id, account); return account;
    }
    async byUsername(username: string) { return [...this.accounts.values()].find(a => a.username === username); }
    async byId(id: string) { return this.accounts.get(id); }
    async session(hash: string, id: string) { this.sessions.set(hash, id); }
    async authenticate(hash: string) { return this.accounts.get(this.sessions.get(hash) || ''); }
    async logout(hash: string) { this.sessions.delete(hash); }
    async connect(id: string, botId: string, username: string, encrypted: string, hash: string) {
        if ([...this.accounts.values()].some(a => a.id !== id && a.bot_id === botId)) throw new ApiError(409, 'bot_unavailable', 'Бот занят.');
        Object.assign(this.accounts.get(id)!, { bot_id: botId, bot_username: username, secrets: encrypted,
            pairing_hash: hash, pairing_expires: new Date(Date.now() + 900_000), update_offset: 0 });
    }
    async pair(id: string, hash: string, ownerId: number, offset: number) {
        const a = this.accounts.get(id)!;
        if (a.owner_id || a.pairing_hash !== hash || !a.pairing_expires || a.pairing_expires.getTime() <= Date.now()) return false;
        Object.assign(a, { owner_id: String(ownerId), pairing_hash: null, pairing_expires: null, update_offset: offset }); return true;
    }
    async offset(id: string, hash: string, offset: number) { const a = this.accounts.get(id)!; if (a.pairing_hash === hash) a.update_offset = offset; }
    async configured() { return [...this.accounts.values()].filter(a => a.secrets).map(a => ({ ...a })); }
    async updateSecrets(id: string, previous: string, encrypted: string) { assert.equal(this.accounts.get(id)!.secrets, previous); this.accounts.get(id)!.secrets = encrypted; }
}

const secrets = new PlatformSecrets('12'.repeat(32));
async function listen(server: http.Server) {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function close(server: http.Server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }

test('passwords, account-bound encryption, and internal credentials cannot be reused between accounts', async () => {
    const password = 'synthetic-password-123';
    const hash = await passwordHash(password);
    assert.notEqual(hash, await passwordHash(password));
    assert.equal(await checkPassword(password, hash), true);
    assert.equal(await checkPassword(password + 'wrong', hash), false);
    const encrypted = secrets.seal({ botToken: 'synthetic-private-token' }, 'one');
    assert.doesNotMatch(encrypted, /synthetic-private-token/);
    assert.deepEqual(secrets.open(encrypted, 'one'), { botToken: 'synthetic-private-token' });
    assert.throws(() => secrets.open(encrypted, 'two'));
    assert.throws(() => new PlatformSecrets('bad'));
    assert.notEqual(secrets.derive('one', 'api'), secrets.derive('two', 'api'));
    assert.notEqual(secrets.derive('one', 'api'), secrets.derive('one', 'database'));
});

test('each worker has independent storage/identity and never inherits operator personal credentials', async () => {
    const store = new MemoryAccounts();
    const first = await store.create('synthetic_first', 'unused');
    const second = await store.create('synthetic_second', 'unused');
    const operator = { KIRA_ALLOWED_USER_ID: '10000', OWNER_NAME: 'Синтетический оператор', USER_BIRTH_DATE: 'synthetic',
        TELEGRAM_SESSION_STRING: 'operator-private-session', TELEGRAM_API_HASH: 'operator-private-hash',
        KIRA_SELF_MEMORY_PATH: '/operator/private.json', PERSONALITY_FILE: '/operator/personality.json',
        BROWSER_PROFILE_DIR: '/operator/browser', KIRA_PLATFORM_MASTER_KEY: 'operator-secret',
        DB_PASSWORD: 'operator-db-password', OPENAI_API_KEY: 'shared-provider-key', KIRA_BROWSER_PROXY_URL: 'http://127.0.0.1:1234' };
    first.owner_id = second.owner_id = '10001'; // Same human may own independent bots/accounts.
    first.bot_username = 'synthetic_first_bot'; second.bot_username = 'synthetic_second_bot';
    const a = tenantEnvironment(operator, first, { botToken: 'first-bot' }, '/synthetic/one', secrets);
    const b = tenantEnvironment(operator, second, { botToken: 'second-bot' }, '/synthetic/two', secrets);
    for (const key of ['DB_NAME', 'DB_USER', 'DB_PASSWORD', 'KIRA_API_TOKEN', 'KIRA_RUNTIME_DATA_DIR', 'PERSONALITY_FILE', 'KIRA_MEMORY_NAMESPACE', 'TMPDIR']) assert.notEqual(a[key], b[key], key);
    assert.equal(a.KIRA_ALLOWED_USER_ID, '10001');
    assert.equal(a.OPENAI_API_KEY, 'shared-provider-key');
    assert.equal(a.TELEGRAM_SESSION_STRING, undefined);
    assert.equal(b.TELEGRAM_SESSION_STRING, undefined);
    const own = tenantEnvironment(operator, first, { botToken: 'first-bot', telegram: {
        apiId: 12345, apiHash: 'synthetic-own-hash', sessionString: 'synthetic-own-session',
    } }, '/synthetic/one', secrets);
    assert.equal(own.TELEGRAM_SESSION_STRING, 'synthetic-own-session');
    assert.equal(own.TELEGRAM_API_HASH, 'synthetic-own-hash');
    for (const key of ['OWNER_NAME', 'USER_BIRTH_DATE', 'BROWSER_PROFILE_DIR', 'KIRA_SELF_MEMORY_PATH', 'KIRA_PLATFORM_MASTER_KEY']) assert.equal(a[key], undefined);
    assert.doesNotMatch(JSON.stringify(a), /operator-private|operator-secret|operator-db-password/);
    assert.throws(() => tenantName('../escape'));
    const imported = tenantEnvironment(operator, first, { botToken: 'first-bot', apiToken: 'ab'.repeat(32),
        existingStorage: { database: 'SyntheticLegacy', memoryNamespace: 'synthetic_old_bot', memoryBotId: 'synthetic_profile', healthPort: 3100 },
    }, '/synthetic/one', secrets);
    assert.equal(imported.DB_NAME, 'SyntheticLegacy');
    assert.equal(imported.DB_USER, tenantName(first.id), 'imported users still use their own restricted role');
    assert.notEqual(imported.DB_PASSWORD, operator.DB_PASSWORD);
    assert.equal(imported.KIRA_MEMORY_NAMESPACE, 'synthetic_old_bot');
    assert.equal(imported.KIRA_MEMORY_BOT_ID, 'synthetic_profile');
    assert.equal(imported.KIRA_DATABASE_SYNC, 'false', 'adoption cannot rewrite the original schema');
    assert.equal(imported.KIRA_API_TOKEN, 'ab'.repeat(32), 'existing confirmations and clients retain their credential');
});

test('pairing accepts only a private message from the real sender with the current one-time code', () => {
    const code = newToken();
    const message = { update_id: 7, message: { message_id: 4, date: 1, text: `/start ${code}`,
        from: { id: 10001, is_bot: false, first_name: 'Синтетический владелец' }, chat: { id: 10001, type: 'private' } } } as any;
    assert.equal(pairingOwner(message, digest(code)), 10001);
    assert.equal(pairingOwner(message, digest(newToken())), undefined);
    assert.equal(pairingOwner({ ...message, message: { ...message.message, chat: { id: 10001, type: 'group' } } }, digest(code)), undefined);
    assert.equal(pairingOwner({ ...message, message: { ...message.message, from: { ...message.message.from, id: 10002 } } }, digest(code)), undefined);
});

test('two API accounts register/login, pair separate bots, and route history, files and actions only to their own runtime', async () => {
    const store = new MemoryAccounts();
    const endpoints = new Map<string, { port: number; token: string }>();
    const runtimes: AccountRuntimes = { status: id => endpoints.has(id) ? 'ready' : 'waiting',
        endpoint: account => endpoints.get(account.id)!, restart: async () => {} };
    const updates = new Map<string, any[]>();
    const verifiedOwners: string[] = [];
    const telegram: TelegramGateway = { verify: async token => ({ id: token === 'first' ? 11001 : 11002, username: 'synthetic_bot' }),
        updates: async token => updates.get(token) || [], verifySession: async (_session, ownerId) => { verifiedOwners.push(ownerId); } };
    const server = createPlatformServer({ store, secrets, runtimes, telegram });
    const url = await listen(server);
    const workers: http.Server[] = [];
    try {
        const call = async (route: string, method = 'GET', token?: string, body?: unknown, key?: string) => {
            const response = await fetch(url + route, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}),
                ...(body ? { 'content-type': 'application/json' } : {}), ...(key ? { 'idempotency-key': key } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
            return { status: response.status, data: await response.json() as any };
        };
        assert.equal((await call('/api/v1/account')).status, 401);
        const first = await call('/api/v1/accounts/register', 'POST', undefined, { username: 'synthetic_first', password: 'synthetic-password-123' });
        const second = await call('/api/v1/accounts/register', 'POST', undefined, { username: 'synthetic_second', password: 'synthetic-password-456' });
        assert.equal(first.status, 201); assert.equal(second.status, 201);
        const a = first.data.accessToken, b = second.data.accessToken;
        assert.deepEqual((await call('/api/v1/account/telegram', 'GET', a)).data, { personalSessionConfigured: false });
        assert.notEqual(a, b);
        assert.equal(store.sessions.has(digest(a)), true); assert.equal(store.sessions.has(a), false);
        assert.doesNotMatch(JSON.stringify(first.data), /password_hash|secrets/);
        assert.equal((await call('/api/v1/status', 'GET', a)).status, 409);
        assert.equal((await call('/api/v1/accounts/login', 'POST', undefined, { username: 'synthetic_first', password: 'wrong-password-123' })).status, 401);
        const logged = await call('/api/v1/accounts/login', 'POST', undefined, { username: 'SYNTHETIC_FIRST', password: 'synthetic-password-123' });
        assert.equal(logged.status, 200);
        assert.equal((await call('/api/v1/account?accountId=' + second.data.account.id, 'GET', a)).data.account.id, first.data.account.id);
        const pairA = await call('/api/v1/account/bot', 'PUT', a, { botToken: 'first' });
        const conflict = await call('/api/v1/account/bot', 'PUT', b, { botToken: 'first' });
        assert.equal(conflict.status, 409);
        const pairB = await call('/api/v1/account/bot', 'PUT', b, { botToken: 'second' });
        assert.equal(pairA.status, 202); assert.equal(pairB.status, 202);
        assert.doesNotMatch(store.accounts.get(first.data.account.id)!.secrets!, /first/);
        const codeA = new URL(pairA.data.pairingUrl).searchParams.get('start');
        const codeB = new URL(pairB.data.pairingUrl).searchParams.get('start');
        for (const [token, code, owner] of [['first', codeA, 10001], ['second', codeB, 10002]] as const) {
            updates.set(token, [{ update_id: 8, message: { text: `/start ${code}`, from: { id: owner, is_bot: false }, chat: { id: owner, type: 'private' } } }]);
        }
        const manager = new TenantRuntimeManager(store, null as any, secrets, telegram, '/unused');
        await manager.tick(); // Both are pending; this tick only validates Telegram identity.
        assert.equal(store.accounts.get(first.data.account.id)!.owner_id, '10001');
        assert.equal(store.accounts.get(second.data.account.id)!.owner_id, '10002');
        assert.equal(store.accounts.get(first.data.account.id)!.pairing_hash, null);
        for (const entry of [first, second]) {
            const id = entry.data.account.id;
            let executions = 0;
            let sceneExecutions = 0;
            let modelPreset: unknown = null;
            let modelPreferences = { cost: 'medium', quality: 'high' };
            const internalToken = secrets.derive(id, 'api');
            let settings: ApiSettings = { budgetMode: 'normal', budgetModes: [], telegram: { personalSessionConfigured: false }, features: [] };
            const worker = createExternalApiServer({ token: internalToken, ownerId: Number(store.accounts.get(id)!.owner_id), host: '127.0.0.1', port: 0 }, {
                status: async () => ({ accountId: id }), history: async () => ({ messages: [{ text: id }] }),
                capabilities: async () => ({}), reminders: async () => ({ reminders: [id] }), tasks: async () => ({ tasks: [id] }),
                file: async () => ({ filename: `${id}.txt`, data: Buffer.from(id) }),
                message: async () => ({ messages: [{ id: 1, type: 'text', text: `${id}:${++executions}` }] }),
                action: async () => ({ messages: [] }),
                turnReady: async () => {},
                modelSettings: async () => ({ accountId: id, preset: modelPreset }),
                modelPreferences: async () => ({ accountId: id, preferences: modelPreferences }),
                updateModelPreferences: async body => {
                    try { modelPreferences = parsePreferences(body); } catch { throw new ApiError(400, 'invalid_preferences', 'Invalid'); }
                    return { accountId: id, preferences: modelPreferences };
                },
                saveModelSettings: async body => { modelPreset = body.preset; return { accountId: id, preset: modelPreset }; },
                sceneCapabilities: async () => ({ accountId: id, version: 1 }),
                sceneReady: async () => null,
                sceneTurn: async () => ({ messages: [{ id: -1, type: 'text', text: `${id}:scene:${++sceneExecutions}` }] }),
                sceneActionResult: async body => ({ accountId: id, actionId: body.actionId }),
                settings: async () => settings,
                updateSettings: async patch => { settings = { ...settings, budgetMode: patch.budgetMode || settings.budgetMode }; return settings; },
            }, new MemoryApiOperations());
            await listen(worker); workers.push(worker);
            endpoints.set(id, { port: (worker.address() as AddressInfo).port, token: internalToken });
        }
        assert.equal((await call('/api/v1/model-preferences')).status, 401);
        assert.equal((await call('/api/v1/model-preferences', 'PUT', a, { cost: 'low', quality: 'high' })).data.accountId, first.data.account.id);
        assert.equal((await call('/api/v1/model-preferences', 'GET', a)).data.preferences.cost, 'low');
        assert.equal((await call('/api/v1/model-preferences', 'GET', b)).data.preferences.cost, 'medium');
        assert.equal((await call('/api/v1/model-preferences', 'PUT', a, { cost: 'high', quality: 'high', accountId: second.data.account.id })).status, 400);
        for (const [token, id] of [[a, first.data.account.id], [b, second.data.account.id]]) {
            assert.equal((await call('/api/v1/history', 'GET', token)).data.messages[0].text, id);
            const result = await call('/api/v1/messages', 'POST', token, { text: 'Привет' }, 'same-key-for-both');
            assert.equal(result.data.messages[0].text, `${id}:1`);
            assert.deepEqual(await call('/api/v1/messages', 'POST', token, { text: 'Привет' }, 'same-key-for-both'), result);
            const file = await fetch(url + '/api/v1/files/' + randomUUID(), { headers: { authorization: `Bearer ${token}` } });
            assert.equal(await file.text(), id);
            assert.equal((await call('/api/v1/model-settings', 'GET', token)).data.accountId, id);
            assert.equal((await call('/api/v1/scene', 'GET', token)).data.accountId, id);
            const snapshot = { roomId: randomUUID(), roomVersion: 1, coordinateSpaceId: randomUUID(),
                observedAt: new Date().toISOString(), tracking: 'normal',
                avatar: { position: [0, 0, 0], yaw: 0, pose: 'standing' }, objects: [], seats: [] };
            const turn = { text: 'Посмотри на синтетическую комнату', scene: snapshot,
                frame: { mime: 'image/jpeg', data: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200_000)]).toString('base64'),
                    capturedAt: snapshot.observedAt, width: 640, height: 480 } };
            const sceneResult = await call('/api/v1/scene/turns', 'POST', token, turn, 'same-scene-key-for-both');
            assert.equal(sceneResult.status, 200, 'AR frames larger than 64 KiB must reach the selected worker');
            assert.equal(sceneResult.data.messages[0].text, `${id}:scene:1`);
            assert.deepEqual(await call('/api/v1/scene/turns', 'POST', token, turn, 'same-scene-key-for-both'), sceneResult);
            assert.equal((await call('/api/v1/scene/action-results', 'POST', token, { actionId: snapshot.roomId, status: 'completed' })).data.accountId, id);
        }
        assert.equal((await call('/api/v1/scene')).status, 401);
        assert.equal((await call('/api/v1/scene/unknown', 'POST', a, {})).status, 404);
        assert.equal((await call('/api/v1/model-settings', 'PUT', a, { preset: 'gpt-balanced', expectedRevision: 'none' })).data.preset, 'gpt-balanced');
        assert.equal((await call('/api/v1/model-settings', 'GET', b)).data.preset, null, 'model selection stays within its account');
        assert.equal((await call('/api/v1/model-settings', 'PUT', a, { preset: 'x'.repeat(70_000) })).status, 413, 'only scene turns get the larger body limit');
        assert.equal((await call('/api/v1/messages', 'POST', a, { text: 'x'.repeat(70_000) }, 'oversized-message')).status, 413);
        assert.equal((await call('/api/v1/scene/turns', 'POST', a, { text: 'x'.repeat(3 * 1024 * 1024) }, 'oversized-scene')).status, 413);
        assert.equal((await call('/api/v1/settings', 'PATCH', a, { budgetMode: 'maximum' })).data.budgetMode, 'maximum');
        assert.equal((await call('/api/v1/settings', 'GET', b)).data.budgetMode, 'normal');
        assert.equal((await call('/api/v1/settings', 'PATCH', a, { budgetMode: 'normal', accountId: second.data.account.id })).status, 400);
        const session = { apiId: 12345, apiHash: 'ab'.repeat(16), sessionString: 'synthetic-own-telegram-session' };
        assert.equal((await call('/api/v1/account/telegram', 'PUT', a, session)).status, 202);
        assert.deepEqual(verifiedOwners, ['10001']);
        assert.equal((await call('/api/v1/account/telegram', 'GET', a)).data.personalSessionConfigured, true);
        assert.equal((await call('/api/v1/account/telegram', 'GET', b)).data.personalSessionConfigured, false);
        const encrypted = store.accounts.get(first.data.account.id)!.secrets!;
        assert.doesNotMatch(encrypted, /synthetic-own-telegram-session/);
        assert.deepEqual((secrets.open(encrypted, first.data.account.id) as any).telegram, session);
        assert.equal((await call('/api/v1/account/telegram', 'DELETE', a)).status, 202);
        assert.equal((await call('/api/v1/account/telegram', 'GET', a)).data.personalSessionConfigured, false);
        assert.equal((secrets.open(store.accounts.get(first.data.account.id)!.secrets!, first.data.account.id) as any).botToken, 'first');
        assert.equal((await call('/api/v1/account/telegram', 'DELETE', a)).status, 200);
        assert.equal((await call('/api/v1/messages', 'POST', a, { text: 'Привет', ownerId: 10002 }, 'spoofed-key')).status, 400);
        assert.equal((await call('/api/v1/accounts/logout', 'POST', a)).status, 200);
        assert.equal((await call('/api/v1/account', 'GET', a)).status, 401);
        assert.equal((await call('/api/v1/account', 'GET', logged.data.accessToken)).status, 200);
        assert.equal((await call('/api/v1/account', 'GET', b)).data.account.id, second.data.account.id);
    } finally { await Promise.all(workers.map(close)); await close(server); }
});

test('browser proxy rejects internal and transition networks, even with public-looking DNS names', async () => {
    const privateV4 = [[127, 0, 0, 1], [10, 0, 0, 1], [192, 168, 1, 2], [100, 64, 0, 1], [169, 254, 169, 254], [0, 0, 0, 0], [198, 18, 0, 1]].map(octets => octets.join('.'));
    for (const ip of [...privateV4, '::1', '::ffff:127.0.0.1', 'fc00::1', '2002:7f00:1::', '2001:db8::1']) assert.equal(publicAddress(ip), false, ip);
    assert.equal(publicAddress('1.1.1.1'), true);
    assert.equal(publicAddress('2606:4700:4700::1111'), true);
    const server = createBrowserProxy();
    const url = new URL(await listen(server));
    try {
        for (const target of ['http://127.0.0.1:6333/collections', 'http://localhost/collections', 'http://[::1]/', 'file:///private/secrets']) {
            const status = await new Promise<number>(resolve => {
                const req = http.request({ hostname: url.hostname, port: url.port, path: target }, res => { res.resume(); resolve(res.statusCode!); });
                req.end();
            });
            assert.equal(status, 403, target);
        }
    } finally { await close(server); }
});

test('manager restores paired accounts, waits for readiness, restarts workers and stops them when its database lease is lost', async t => {
    const store = new MemoryAccounts();
    const account = await store.create('synthetic_restored', 'unused');
    account.owner_id = '10001'; account.bot_id = '11001'; account.bot_username = 'synthetic_restored_bot';
    account.secrets = secrets.seal({ botToken: 'synthetic-worker-token' }, account.id);
    const name = tenantName(account.id);
    const db = { query: async (sql: string) => sql.includes('pg_roles') ? [{ exists: true }] : sql.includes('pg_database') ? [{ owner: name }] : [] } as any;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kira-worker-test-'));
    const children: EventEmitter[] = [];
    t.mock.method(require('node:child_process'), 'fork', (_file: string, _args: unknown, options: any) => {
        assert.equal(options.env.DB_NAME, name);
        assert.equal(options.env.KIRA_BOT_TOKEN, 'synthetic-worker-token');
        const child = new EventEmitter() as any;
        child.kill = () => { queueMicrotask(() => child.emit('exit', 0)); return true; };
        children.push(child); return child;
    });
    let fatal = false;
    const manager = new TenantRuntimeManager(store, db, secrets, {} as any, root, {}, () => { fatal = true; });
    try {
        await manager.tick();
        assert.equal(children.length, 1);
        assert.equal(manager.status(account.id), 'starting');
        assert.throws(() => manager.endpoint(account), /ещё запускается/);
        children[0].emit('message', { type: 'kira-ready', port: 12345 });
        assert.equal(manager.endpoint(account).port, 12345);
        await manager.tick(); assert.equal(children.length, 1, 'no second poller for a live runtime');
        await manager.restart(account.id);
        await manager.tick(); assert.equal(children.length, 2);
        children[1].emit('message', { type: 'kira-ready', port: 12346 });
        assert.equal(manager.endpoint(account).port, 12346);
        t.mock.method(store, 'configured', async () => { throw new Error('synthetic database lease lost'); });
        await manager.tick();
        assert.equal(fatal, true);
        assert.throws(() => manager.endpoint(account), /ещё запускается/);
        assert.equal((await fs.stat(path.join(root, name))).mode & 0o777, 0o700);
    } finally { await manager.close(); await fs.rm(root, { recursive: true, force: true }); }
});
