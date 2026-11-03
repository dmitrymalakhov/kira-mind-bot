import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { DataSource } from 'typeorm';
import { digest, PlatformSecrets } from '../platform/crypto';
import { openPlatformDatabase, PostgresAccountStore } from '../platform/store';
import { initializePublicAccounts } from '../platform/publicAccounts/schema';
import { PublicSessions } from '../platform/publicAccounts/sessions';
import { PublicLimits, publicClientAddress } from '../platform/publicAccounts/limits';

const port = process.env.KIRA_PLATFORM_TEST_PG_PORT;
const secrets = new PlatformSecrets('56'.repeat(32));
async function registry(run: (db: DataSource, store: PostgresAccountStore) => Promise<void>) {
    const env = { DB_HOST: '127.0.0.1', DB_PORT: port, DB_USER: 'postgres', DB_PASSWORD: 'synthetic-platform-test',
        KIRA_PLATFORM_DB_NAME: `kira_public_test_${randomUUID().replace(/-/g, '')}` };
    const db = await openPlatformDatabase(env);
    const store = new PostgresAccountStore(db);
    const admin = await new DataSource({ type: 'postgres', host: env.DB_HOST, port: Number(port),
        username: env.DB_USER, password: env.DB_PASSWORD, database: 'postgres' }).initialize();
    try { await store.initialize(); await initializePublicAccounts(db); await run(db, store); }
    finally { await store.close(); await admin.query(`DROP DATABASE "${env.KIRA_PLATFORM_DB_NAME}" WITH (FORCE)`); await admin.destroy(); }
}
async function account(db: DataSource, store: PostgresAccountStore) {
    const a = await store.create(`synthetic_${randomUUID().slice(0, 8)}`, 'synthetic-legacy-hash');
    await initializePublicAccounts(db);
    return a;
}

test('public sessions persist hashed credentials and rotate exactly once across concurrent retries/restarts', { skip: !port }, async () => {
    await registry(async (db, store) => {
        const a = await account(db, store), device = randomUUID();
        const sessions = new PublicSessions(db, secrets);
        const first = await db.transaction(tx => sessions.issue(tx, a.id, a.id, device, 'Synthetic phone'));
        assert.equal((await sessions.authenticate(first.accessToken))?.account.id, a.id);
        const [left, right] = await Promise.all([
            sessions.rotate(first.refreshToken, device, 'same-refresh-key'),
            new PublicSessions(db, secrets).rotate(first.refreshToken, device, 'same-refresh-key'),
        ]);
        assert.deepEqual(left, right);
        assert.notEqual(left.refreshToken, first.refreshToken);
        assert.equal(await sessions.authenticate(first.accessToken), undefined);
        assert.equal((await sessions.authenticate(left.accessToken))?.account.id, a.id);
        const dump = JSON.stringify(await db.query('SELECT * FROM kira_public_sessions')) + JSON.stringify(await db.query('SELECT * FROM kira_public_refresh'));
        for (const secret of [first.accessToken, first.refreshToken, left.accessToken, left.refreshToken]) assert.equal(dump.includes(secret), false);
        assert.equal((await sessions.list(a.id, first.sessionId))[0].current, true);
        assert.equal(left.expiresIn, 900);
    });
});

test('refresh reuse revokes family and push; rollback cannot undo revocation; another account is isolated', { skip: !port }, async () => {
    await registry(async (db, store) => {
        const a = await account(db, store), b = await account(db, store), device = randomUUID();
        const sessions = new PublicSessions(db, secrets);
        const first = await db.transaction(tx => sessions.issue(tx, a.id, a.id, device, 'Synthetic phone'));
        const other = await db.transaction(tx => sessions.issue(tx, b.id, b.id, randomUUID(), 'Other phone'));
        const next = await sessions.rotate(first.refreshToken, device, 'first-key');
        await db.query(`INSERT INTO kira_public_push_devices(account_id,device_id,session_id,token_hash,token_encrypted,environment)
            VALUES($1,$2,$3,$4,'encrypted','sandbox')`, [a.id, device, first.sessionId, digest('synthetic-apns')]);
        await assert.rejects(() => sessions.logout(b.id, first.sessionId), (e: any) => e.code === 'not_found');
        await assert.rejects(() => sessions.rotate(first.refreshToken, device, 'different-key'), (e: any) => e.code === 'refresh_invalid');
        assert.equal(await sessions.authenticate(next.accessToken), undefined);
        await assert.rejects(() => sessions.rotate(next.refreshToken, device, 'next-key'), (e: any) => e.code === 'refresh_invalid');
        assert.equal((await db.query('SELECT * FROM kira_public_push_devices WHERE account_id=$1', [a.id])).length, 0);
        assert.equal((await sessions.authenticate(other.accessToken))?.account.id, b.id);
    });
});

test('refresh R/device D2/same idempotency K after successful R/D/K is reuse 401, not conflict 409, and revokes only that family', {skip:!port},async()=>{
    await registry(async(db,store)=>{
        const a=await account(db,store),device=randomUUID(),sessions=new PublicSessions(db,secrets);
        const first=await db.transaction(tx=>sessions.issue(tx,a.id,a.id,device,'Synthetic phone'));
        const independent=await db.transaction(tx=>sessions.issue(tx,a.id,a.id,randomUUID(),'Independent phone'));
        const next=await sessions.rotate(first.refreshToken,device,'synthetic-same-key');
        await assert.rejects(()=>sessions.rotate(first.refreshToken,randomUUID(),'synthetic-same-key'),(e:any)=>e.status===401 && e.code==='refresh_invalid');
        assert.equal(await sessions.authenticate(next.accessToken),undefined);
        await assert.rejects(()=>sessions.rotate(next.refreshToken,device,'synthetic-next-key'),(e:any)=>e.code==='refresh_invalid');
        assert.ok(await sessions.authenticate(independent.accessToken));
    });
});

test('expired retry window, wrong device and older generation never replay usable tokens', { skip: !port }, async () => {
    await registry(async (db, store) => {
        const a = await account(db, store), device = randomUUID();
        let now = new Date('2035-04-01T00:00:00Z');
        const sessions = new PublicSessions(db, secrets, () => now);
        const create = () => db.transaction(tx => sessions.issue(tx, a.id, a.id, device, 'Synthetic phone'));
        const first = await create();
        const second = await sessions.rotate(first.refreshToken, device, 'rotation-one');
        now = new Date(now.getTime() + 120_001);
        await assert.rejects(() => sessions.rotate(first.refreshToken, device, 'rotation-one'), (e: any) => e.code === 'refresh_invalid');
        assert.equal(await sessions.authenticate(second.accessToken), undefined);
        const wrong = await create();
        await assert.rejects(() => sessions.rotate(wrong.refreshToken, randomUUID(), 'wrong-device'), (e: any) => e.code === 'refresh_invalid');
        assert.equal(await sessions.authenticate(wrong.accessToken), undefined);
        const old = await create();
        const middle = await sessions.rotate(old.refreshToken, device, 'old-key');
        const latest = await sessions.rotate(middle.refreshToken, device, 'middle-key');
        await assert.rejects(() => sessions.rotate(old.refreshToken, device, 'old-key'), (e: any) => e.code === 'refresh_invalid');
        assert.equal(await sessions.authenticate(latest.accessToken), undefined);
        const expired = await create();
        now = new Date(now.getTime() + 30 * 24 * 3600_000 + 1);
        await assert.rejects(() => sessions.rotate(expired.refreshToken, device, 'expired-key'), (e: any) => e.code === 'refresh_invalid');
    });
});

test('durable abuse windows survive new instances and concurrent requests without storing source identifiers', { skip: !port }, async () => {
    await registry(async db => {
        let now = new Date('2035-04-01T00:00:00Z');
        const make = () => new PublicLimits(db, 'synthetic-operator-secret-at-least-32-chars', () => now);
        const results = await Promise.allSettled(Array.from({ length: 12 }, () => make().take('ip:192.0.2.123', 3, 60)));
        assert.equal(results.filter(r => r.status === 'fulfilled').length, 3);
        for (const r of results) if (r.status === 'rejected') assert.equal(r.reason.code, 'rate_limited');
        assert.doesNotMatch(JSON.stringify(await db.query('SELECT * FROM kira_public_limits')), /192\.0\.2\.123/);
        now = new Date(now.getTime() + 60_000);
        await make().take('ip:192.0.2.123', 3, 60);
    });
});

test('forwarded headers never bypass public IP windows and trusted gateway hop requires its secret', () => {
    const req = (peer: string, headers: Record<string, string>) => ({ socket: { remoteAddress: peer }, headers }) as IncomingMessage;
    assert.equal(publicClientAddress(req('192.0.2.1', { 'x-forwarded-for': '198.51.100.1', 'x-kira-client-ip': '198.51.100.2' }), [], ''), '192.0.2.1');
    assert.throws(() => publicClientAddress(req('127.0.0.1', { 'x-kira-client-ip': '198.51.100.2' }), ['127.0.0.1'], 'secret'), (e: any) => e.code === 'unauthorized');
    assert.equal(publicClientAddress(req('::ffff:127.0.0.1', { 'x-kira-client-ip': '198.51.100.2', 'x-kira-gateway-secret': 'secret' }), ['127.0.0.1'], 'secret'), '198.51.100.2');
});
