import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { digest, newToken, PlatformSecrets } from '../platform/crypto';
import { openPlatformDatabase, PostgresAccountStore, provisionTenantDatabase } from '../platform/store';

test('PostgreSQL persists accounts, enforces unique bots and pairing leases, and denies cross-account database access', {
    skip: !process.env.KIRA_PLATFORM_TEST_PG_PORT,
}, async () => {
    // Explicit opt-in port for a disposable local database; never read production DB_* variables.
    const env = { DB_HOST: '127.0.0.1', DB_PORT: process.env.KIRA_PLATFORM_TEST_PG_PORT,
        DB_USER: 'postgres', DB_PASSWORD: 'synthetic-platform-test',
        KIRA_PLATFORM_DB_NAME: `kira_test_${randomUUID().replace(/-/g, '')}` };
    const secrets = new PlatformSecrets('34'.repeat(32));
    const db = await openPlatformDatabase(env);
    const store = new PostgresAccountStore(db, 2);
    const tenantNames: string[] = [];
    const connections: DataSource[] = [];
    const admin = await new DataSource({ type: 'postgres', host: env.DB_HOST, port: Number(env.DB_PORT),
        username: env.DB_USER, password: env.DB_PASSWORD, database: 'postgres' }).initialize();
    try {
        await store.initialize();
        const a = await store.create('synthetic_first', 'synthetic-hash-one');
        const b = await store.create('synthetic_second', 'synthetic-hash-two');
        await assert.rejects(() => store.create('synthetic_third', 'synthetic-hash'), /временно недоступна/);
        const token = newToken();
        await store.session(digest(token), a.id);
        assert.equal((await store.authenticate(digest(token)))?.id, a.id);
        assert.equal(await store.authenticate(token), undefined);
        await db.query("UPDATE kira_account_sessions SET expires_at=now()-interval '1 second'");
        assert.equal(await store.authenticate(digest(token)), undefined);
        await store.session(digest(newToken()), b.id);
        const hash = digest(newToken());
        const encrypted = secrets.seal({ botToken: 'synthetic-bot-token' }, a.id);
        await store.connect(a.id, '11001', 'synthetic_bot', encrypted, hash);
        await assert.rejects(() => store.connect(b.id, '11001', 'synthetic_bot', encrypted, hash), /уже подключён/);
        assert.equal(await store.pair(a.id, 'wrong-hash', 10001, 8), false);
        await store.offset(a.id, 'old-pairing-hash', 900);
        assert.equal(Number((await store.byId(a.id))!.update_offset), 0);
        assert.equal(await store.pair(a.id, hash, 10001, 8), true);
        assert.equal(await store.pair(a.id, hash, 10002, 9), false);
        assert.equal((await store.byId(a.id))!.owner_id, '10001');
        assert.equal(Number((await store.byId(a.id))!.update_offset), 8);
        await assert.rejects(() => store.connect(a.id, '11002', 'synthetic_bot_two', encrypted, hash), /уже подключён/);
        await store.updateSecrets(a.id, encrypted, secrets.seal({ botToken: 'synthetic-updated-token' }, a.id));
        await assert.rejects(() => store.updateSecrets(a.id, encrypted, 'bad'), /изменились/);
        for (const account of [a, b]) {
            const password = secrets.derive(account.id, 'database');
            const name = await provisionTenantDatabase(db, account.id, password);
            tenantNames.push(name);
            assert.equal(await provisionTenantDatabase(db, account.id, password), name);
            const connection = await new DataSource({ type: 'postgres', host: env.DB_HOST, port: Number(env.DB_PORT),
                username: name, password, database: name }).initialize();
            connections.push(connection);
            await connection.query('CREATE TABLE synthetic_memory (value text)');
            await connection.query('INSERT INTO synthetic_memory VALUES ($1)', [account.id]);
        }
        assert.equal((await connections[0].query('SELECT value FROM synthetic_memory'))[0].value, a.id);
        assert.equal((await connections[1].query('SELECT value FROM synthetic_memory'))[0].value, b.id);
        const attempt = async (database: string) => {
            const other = new DataSource({ type: 'postgres', host: env.DB_HOST, port: Number(env.DB_PORT),
                username: tenantNames[0], password: secrets.derive(a.id, 'database'), database });
            try { await other.initialize(); } finally { if (other.isInitialized) await other.destroy(); }
        };
        await assert.rejects(() => attempt(tenantNames[1]), /permission denied/);
        await assert.rejects(() => attempt(env.KIRA_PLATFORM_DB_NAME), /permission denied/);
        const secondStore = new PostgresAccountStore(db);
        await assert.rejects(() => secondStore.initialize(), /already running/);
    } finally {
        await Promise.all(connections.map(connection => connection.destroy()));
        await store.close();
        for (const name of tenantNames) { await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`); await admin.query(`DROP ROLE "${name}"`); }
        await admin.query(`DROP DATABASE "${env.KIRA_PLATFORM_DB_NAME}" WITH (FORCE)`);
        await admin.destroy();
    }
});
