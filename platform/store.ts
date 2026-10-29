import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { DataSource, QueryRunner } from 'typeorm';
import { ApiError } from '../api/contracts';

export interface Account {
    id: string;
    username: string;
    password_hash: string;
    bot_id: string | null;
    bot_username: string | null;
    owner_id: string | null;
    secrets: string | null;
    pairing_hash: string | null;
    pairing_expires: Date | null;
    update_offset: number;
}

export interface AccountStore {
    create(username: string, hash: string): Promise<Account>;
    byUsername(username: string): Promise<Account | undefined>;
    byId(id: string): Promise<Account | undefined>;
    session(hash: string, accountId: string): Promise<void>;
    authenticate(hash: string): Promise<Account | undefined>;
    logout(hash: string): Promise<void>;
    connect(id: string, botId: string, username: string, encrypted: string, pairingHash: string): Promise<void>;
    pair(id: string, hash: string, ownerId: number, offset: number): Promise<boolean>;
    offset(id: string, hash: string, offset: number): Promise<void>;
    configured(): Promise<Account[]>;
    updateSecrets(id: string, previous: string, encrypted: string): Promise<void>;
}

export function tenantName(id: string): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) throw new Error('Invalid account ID');
    return `kira_u_${id.replace(/-/g, '')}`;
}

function databaseOptions(env: NodeJS.ProcessEnv, database: string) {
    return { type: 'postgres' as const, host: env.DB_HOST || 'postgres', port: Number(env.DB_PORT || 5432),
        username: env.DB_USER || 'postgres', password: env.DB_PASSWORD, database,
        synchronize: false, logging: false, extra: { max: 5 } };
}

export class PostgresAccountStore implements AccountStore {
    private lock?: QueryRunner;
    constructor(readonly db: DataSource, private maxAccounts = 100) {}

    async initialize(): Promise<void> {
        // A session lock held on a dedicated connection prevents two managers polling the same bots.
        this.lock = this.db.createQueryRunner();
        await this.lock.connect();
        const [row] = await this.lock.query("SELECT pg_try_advisory_lock(706283004) AS acquired");
        if (!row.acquired) {
            await this.lock.release(); this.lock = undefined;
            throw new Error('Another Kira account manager is already running');
        }
        await this.db.query(`CREATE TABLE IF NOT EXISTS kira_accounts (
            id uuid PRIMARY KEY, username text UNIQUE NOT NULL, password_hash text NOT NULL,
            bot_id text UNIQUE, bot_username text, owner_id text, secrets text,
            pairing_hash text, pairing_expires timestamptz, update_offset bigint NOT NULL DEFAULT 0,
            created_at timestamptz NOT NULL DEFAULT now()
        )`);
        await this.db.query(`CREATE TABLE IF NOT EXISTS kira_account_sessions (
            token_hash text PRIMARY KEY, account_id uuid NOT NULL REFERENCES kira_accounts(id) ON DELETE CASCADE,
            expires_at timestamptz NOT NULL DEFAULT now() + interval '30 days'
        )`);
        await this.db.query(`CREATE TABLE IF NOT EXISTS kira_analytics_sources (
            account_id uuid PRIMARY KEY REFERENCES kira_accounts(id) ON DELETE CASCADE,
            database_name text NOT NULL, imported boolean NOT NULL DEFAULT false
        )`);
        await this.db.query(`CREATE TABLE IF NOT EXISTS kira_analytics_meta (id int PRIMARY KEY CHECK(id=1), started_at timestamptz NOT NULL DEFAULT now())`);
        await this.db.query('INSERT INTO kira_analytics_meta(id) VALUES(1) ON CONFLICT DO NOTHING');
    }
    async create(username: string, hash: string): Promise<Account> {
        try {
            return await this.db.transaction(async manager => {
                await manager.query('SELECT pg_advisory_xact_lock(706283005)');
                const [{ count }] = await manager.query('SELECT count(*) FROM kira_accounts');
                if (Number(count) >= this.maxAccounts) throw new ApiError(503, 'capacity_reached', 'Регистрация временно недоступна.');
                const [row] = await manager.query('INSERT INTO kira_accounts(id, username, password_hash) VALUES ($1,$2,$3) RETURNING *', [randomUUID(), username, hash]);
                return row;
            });
        } catch (error) {
            if ((error as { code?: string }).code === '23505') throw new ApiError(409, 'username_unavailable', 'Логин занят.');
            throw error;
        }
    }
    async byUsername(username: string) { return (await this.db.query('SELECT * FROM kira_accounts WHERE username=$1', [username]))[0]; }
    async byId(id: string) { return (await this.db.query('SELECT * FROM kira_accounts WHERE id=$1', [id]))[0]; }
    async session(hash: string, accountId: string) {
        await this.db.query('DELETE FROM kira_account_sessions WHERE expires_at <= now()');
        await this.db.transaction(async manager => {
            await manager.query('SELECT id FROM kira_accounts WHERE id=$1 FOR UPDATE', [accountId]);
            await manager.query(`DELETE FROM kira_account_sessions WHERE token_hash IN (
                SELECT token_hash FROM kira_account_sessions WHERE account_id=$1 ORDER BY expires_at DESC OFFSET 19
            )`, [accountId]);
            await manager.query('INSERT INTO kira_account_sessions(token_hash,account_id) VALUES ($1,$2)', [hash, accountId]);
        });
    }
    async authenticate(hash: string) {
        return (await this.db.query(`SELECT a.* FROM kira_accounts a JOIN kira_account_sessions s ON s.account_id=a.id
            WHERE s.token_hash=$1 AND s.expires_at>now()`, [hash]))[0];
    }
    async logout(hash: string) { await this.db.query('DELETE FROM kira_account_sessions WHERE token_hash=$1', [hash]); }
    async connect(id: string, botId: string, username: string, encrypted: string, pairingHash: string) {
        try {
            const rows = await this.db.query(`UPDATE kira_accounts SET bot_id=$2, bot_username=$3, secrets=$4,
                pairing_hash=$5, pairing_expires=now()+interval '15 minutes', update_offset=0
                WHERE id=$1 AND owner_id IS NULL RETURNING id`, [id, botId, username, encrypted, pairingHash]);
            if (!rows[0]?.length) throw new ApiError(409, 'bot_already_connected', 'Бот уже подключён.');
        } catch (error) {
            if ((error as { code?: string }).code === '23505') throw new ApiError(409, 'bot_unavailable', 'Этот бот уже подключён к аккаунту.');
            throw error;
        }
    }
    async pair(id: string, hash: string, ownerId: number, offset: number): Promise<boolean> {
        const [rows] = await this.db.query(`UPDATE kira_accounts SET owner_id=$3, pairing_hash=NULL, pairing_expires=NULL, update_offset=$4
            WHERE id=$1 AND pairing_hash=$2 AND pairing_expires>now() AND owner_id IS NULL RETURNING id`, [id, hash, String(ownerId), offset]);
        return rows.length === 1;
    }
    async offset(id: string, hash: string, offset: number) {
        await this.db.query('UPDATE kira_accounts SET update_offset=GREATEST(update_offset,$3) WHERE id=$1 AND pairing_hash=$2 AND owner_id IS NULL', [id, hash, offset]);
    }
    async configured(): Promise<Account[]> {
        // Reading through the lease connection detects a lost PostgreSQL session before polling bots again.
        if (!this.lock) throw new Error('Account manager lease unavailable');
        return this.lock.query('SELECT * FROM kira_accounts WHERE secrets IS NOT NULL');
    }
    async updateSecrets(id: string, previous: string, encrypted: string): Promise<void> {
        const [rows] = await this.db.query('UPDATE kira_accounts SET secrets=$3 WHERE id=$1 AND secrets=$2 RETURNING id', [id, previous, encrypted]);
        if (!rows.length) throw new ApiError(409, 'account_changed', 'Настройки изменились. Повтори запрос.');
    }
    async close() { await this.lock?.release(); await this.db.destroy(); }
}

/** Database and role names are server-generated; credentials never come from request bodies. */
export async function provisionTenantDatabase(admin: DataSource, id: string, password: string): Promise<string> {
    const name = tenantName(id);
    if (!/^[0-9a-f]{64}$/.test(password)) throw new Error('Invalid database credential');
    if (!(await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [name])).length) {
        await admin.query(`CREATE ROLE "${name}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    }
    const existing = await admin.query('SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname=$1', [name]);
    if (!existing.length) await admin.query(`CREATE DATABASE "${name}" OWNER "${name}"`);
    else if (existing[0].owner !== name) throw new Error('Tenant database owner mismatch');
    await admin.query(`REVOKE ALL ON DATABASE "${name}" FROM PUBLIC`);
    return name;
}

export async function openPlatformDatabase(env: NodeJS.ProcessEnv): Promise<DataSource> {
    const name = env.KIRA_PLATFORM_DB_NAME || 'KiraPlatform';
    if (!/^[A-Za-z][A-Za-z0-9_]{0,62}$/.test(name)) throw new Error('Invalid KIRA_PLATFORM_DB_NAME');
    const admin = await new DataSource(databaseOptions(env, 'postgres')).initialize();
    try {
        if (!(await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [name])).length) await admin.query(`CREATE DATABASE "${name}"`);
        await admin.query(`REVOKE ALL ON DATABASE "${name}" FROM PUBLIC`);
    } finally { await admin.destroy(); }
    return new DataSource(databaseOptions(env, name)).initialize();
}
