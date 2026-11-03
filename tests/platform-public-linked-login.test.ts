import assert from 'node:assert/strict';
import test from 'node:test';
import * as http from 'node:http';
import { createHash, randomUUID, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { createPlatformServer } from '../platform/server';
import { PublicAccountsHttp } from '../platform/publicAccounts/http';
import { digest, passwordHash } from '../platform/crypto';
import { publicTestConfig, publicTestPort, publicTestSecrets, withPublicRegistry } from './support/publicAccounts';

function latch() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
async function bounded<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('Synthetic concurrency gate timed out')), 5000); })]); }
    finally { clearTimeout(timer!); }
}
async function waitForBlockedTransaction(db: any) {
    const until = Date.now() + 4000;
    while (Date.now() < until) {
        const [row] = await db.query(`SELECT count(*)::int AS count FROM pg_stat_activity
            WHERE datname=current_database() AND wait_event_type='Lock' AND cardinality(pg_blocking_pids(pid))>0`);
        if (row.count > 0) return;
        await delay(10);
    }
    throw Error('Synthetic transaction did not reach a PostgreSQL lock wait');
}
async function harness(db: any, store: any) {
    const config = publicTestConfig();
    const runtimes = { status: () => 'ready', endpoint: () => { throw Error('No synthetic worker required'); }, restart: async () => {} };
    const accounts = new PublicAccountsHttp(db, store, publicTestSecrets, runtimes, config, {
        // Only provider/app cryptography is doubled here; real HTTP, scrypt, registry,
        // sessions, grants and PostgreSQL locks are exercised. Crypto has its own suite.
        identityVerifier: { verify: async (provider, input) => ({ provider, subject: input.identityToken || input.authorizationCode! }), revokeApple: async () => {} },
        proofVerifier: { verify: async () => {} },
    });
    const server = createPlatformServer({ store, secrets: publicTestSecrets, runtimes, telegram: {} as any, publicAccounts: accounts });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/`;
    const call = async (route: string, body?: unknown, token?: string, method = body === undefined ? 'GET' : 'POST') => {
        const response = await fetch(base + route, { method, headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID(),
            ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        return { status: response.status, body: await response.json() as any };
    };
    const deviceId = randomUUID(), password = 'synthetic-existing-password';
    const proof = async (provider: 'google' | 'password' | 'telegram', purpose: 'login' | 'reauthenticate' | 'link', value: string,
        token?: string, grant?: string) => {
        const verifier = randomBytes(48).toString('base64url');
        const challenge = await call('auth/challenges', { version: 1, provider, purpose, deviceId,
            ...(provider === 'telegram' ? { codeChallenge: createHash('sha256').update(verifier).digest('base64url'), codeChallengeMethod: 'S256' } : {}),
            ...(grant ? { reauthenticationToken: grant } : {}) }, token);
        assert.equal(challenge.status, 200);
        return call(`auth/${provider}`, { version: 1, challengeId: challenge.body.challengeId, state: challenge.body.state,
            deviceId, deviceName: 'Synthetic linked-login phone',
            ...(provider === 'password' ? { username: value, password } : provider === 'google' ? { identityToken: value } : { authorizationCode: value, codeVerifier: verifier }),
            proof: { type: 'hcaptcha', token: `synthetic-proof-${randomUUID()}`, reason: 'unsupported' } }, token);
    };
    const setup = async () => {
        const account = await store.create(`synthetic_${randomUUID().replace(/-/g, '').slice(0, 15)}`, await passwordHash(password));
        const saved = publicTestSecrets.seal({ botToken: 'synthetic-personal-bot-token', existingStorage: {
            database: 'synthetic_existing_tenant', memoryNamespace: 'synthetic_existing_memory', memoryBotId: 'synthetic_existing_bot' } }, account.id);
        await db.query('UPDATE kira_accounts SET secrets=$2,owner_id=$3,bot_id=$4,bot_username=$5 WHERE id=$1',
            [account.id, saved, '42424242', '51515151', 'synthetic_preserved_bot']);
        const legacy = await call('accounts/login', { username: account.username, password });
        assert.equal(legacy.status, 200, 'trusted existing password row can acquire its explicit password identity');
        const native = await proof('password', 'login', account.username);
        assert.equal(native.status, 200); assert.equal(native.body.account.id, account.id);
        const fresh = await proof('password', 'reauthenticate', account.username, native.body.accessToken);
        assert.equal(fresh.status, 200); assert.deepEqual(Object.keys(fresh.body).sort(), ['expiresAt', 'reauthenticationToken', 'version']);
        const linked = await proof('google', 'link', 'synthetic-linked-google-subject', native.body.accessToken, fresh.body.reauthenticationToken);
        assert.equal(linked.status, 200); assert.equal(linked.body.provider, 'google'); assert.equal(linked.body.account, undefined);
        const google = await proof('google', 'login', 'synthetic-linked-google-subject');
        assert.equal(google.status, 200); assert.equal(google.body.account.id, account.id);
        const identities = await accounts.identities.list(account.id);
        const grant = await proof('google', 'reauthenticate', 'synthetic-linked-google-subject', google.body.accessToken);
        assert.equal(grant.status, 200);
        return { account, saved, legacy: legacy.body, native: native.body, google: google.body,
            passwordIdentity: identities.find(i => i.provider === 'password')!, grant: grant.body.reauthenticationToken };
    };
    const close = async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); };
    return { accounts, call, proof, password, setup, close };
}

test('existing password and linked Google/Telegram retain one UUID and storage; removing password closes both password login channels', { skip: !publicTestPort, timeout: 20000 }, async () => {
    await withPublicRegistry(async (db, store) => {
        const h = await harness(db, store);
        try {
            const s = await h.setup();
            assert.equal((await h.call('account', undefined, s.legacy.accessToken)).body.account.id, s.account.id, 'native upgrade preserves the independent legacy token');
            const passwordAgain = await h.proof('password', 'login', s.account.username);
            assert.equal(passwordAgain.status, 200); assert.equal(passwordAgain.body.account.id, s.account.id);
            const linked = await h.proof('telegram', 'link', 'synthetic-linked-telegram-code', s.google.accessToken, s.grant);
            assert.equal(linked.status, 200); assert.equal(linked.body.provider, 'telegram');
            const telegram = await h.proof('telegram', 'login', 'synthetic-linked-telegram-code');
            assert.equal(telegram.status, 200); assert.equal(telegram.body.account.id, s.account.id);
            const grant = await h.proof('google', 'reauthenticate', 'synthetic-linked-google-subject', s.google.accessToken);
            assert.equal((await h.call(`account/identities/${s.passwordIdentity.id}`, { version: 1, reauthenticationToken: grant.body.reauthenticationToken }, s.google.accessToken, 'DELETE')).status, 200);
            const legacy = await h.call('accounts/login', { username: s.account.username, password: h.password });
            assert.equal(legacy.status, 401); assert.equal(legacy.body.error.code, 'invalid_credentials');
            const native = await h.proof('password', 'login', s.account.username);
            assert.equal(native.status, 401); assert.equal(native.body.error.code, 'invalid_credentials');
            assert.equal((await h.call('account', undefined, s.legacy.accessToken)).status, 401);
            assert.equal((await h.call('account', undefined, s.native.accessToken)).status, 401);
            assert.equal((await h.call('account', undefined, s.google.accessToken)).body.account.id, s.account.id);
            assert.equal((await store.byId(s.account.id))!.secrets, s.saved, 'identity operations do not reencrypt or replace storage bindings');
            assert.equal((await store.byId(s.account.id))!.owner_id, '42424242');
            assert.equal((await db.query('SELECT count(*) FROM kira_accounts'))[0].count, '1');
            assert.equal((await h.call('account/consents', undefined, s.google.accessToken)).body.aiAllowed, false);
        } finally { await h.close(); }
    });
});

test('legacy password issuance queued behind an actual unlink cannot issue a bearer after revocation commits', { skip: !publicTestPort, timeout: 20000 }, async () => {
    await withPublicRegistry(async (db, store) => {
        const h = await harness(db, store), original = db.transaction.bind(db), locked = latch(), resume = latch();
        let unlink: Promise<void> | undefined, login: ReturnType<typeof h.call> | undefined;
        try {
            const s = await h.setup(), auth = (await h.accounts.sessions.authenticate(s.google.accessToken))!;
            (db as any).transaction = (run: any) => original(async tx => {
                const query = tx.query.bind(tx);
                (tx as any).query = async (sql: string, parameters: any[]) => {
                    const result = await query(sql, parameters);
                    if (sql === 'SELECT id FROM kira_accounts WHERE id=$1 FOR UPDATE') { locked.resolve(); await resume.promise; }
                    return result;
                };
                return run(tx);
            });
            unlink = h.accounts.identities.unlink(auth, s.passwordIdentity.id, s.grant);
            await bounded(locked.promise);
            login = h.call('accounts/login', { username: s.account.username, password: h.password });
            await waitForBlockedTransaction(db);
            resume.resolve();
            await unlink;
            assert.equal((await login).status, 401, 'the fresh statement after the account lock observes the removed method');
            assert.equal((await db.query('SELECT count(*) FROM kira_account_sessions WHERE account_id=$1', [s.account.id]))[0].count, '0');
        } finally {
            resume.resolve(); await Promise.allSettled([unlink, login]); (db as any).transaction = original; await h.close();
        }
    });
});

test('concurrent Google login and password unlink complete without an identity/account lock inversion', { skip: !publicTestPort, timeout: 20000 }, async () => {
    await withPublicRegistry(async (db, store) => {
        const h = await harness(db, store), original = db.transaction.bind(db), identityLocked = latch(), resume = latch();
        let login: ReturnType<typeof h.proof> | undefined, unlink: Promise<void> | undefined;
        try {
            const s = await h.setup(), auth = (await h.accounts.sessions.authenticate(s.google.accessToken))!;
            (db as any).transaction = (run: any) => original(async tx => {
                const query = tx.query.bind(tx);
                (tx as any).query = async (sql: string, parameters: any[]) => {
                    const result = await query(sql, parameters);
                    if (sql === 'SELECT * FROM kira_public_identities WHERE provider=$1 AND subject=$2 FOR UPDATE') { identityLocked.resolve(); await resume.promise; }
                    return result;
                };
                return run(tx);
            });
            login = h.proof('google', 'login', 'synthetic-linked-google-subject');
            await bounded(identityLocked.promise);
            unlink = h.accounts.identities.unlink(auth, s.passwordIdentity.id, s.grant);
            await waitForBlockedTransaction(db);
            resume.resolve();
            const [logged] = await Promise.all([login, unlink]);
            assert.equal(logged.status, 200, 'a concurrent unlink must not turn valid login into an internal/deadlock error');
            assert.equal(logged.body.account.id, s.account.id);
            assert.deepEqual((await h.accounts.identities.list(s.account.id)).map(i => i.provider), ['google']);
        } finally {
            resume.resolve(); await Promise.allSettled([login, unlink]); (db as any).transaction = original; await h.close();
        }
    });
});
