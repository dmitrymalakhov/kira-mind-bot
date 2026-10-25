/** Trusted local onboarding of an existing installation. Never exposed as an HTTP endpoint. */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { DataSource } from 'typeorm';
import { PlatformSecrets, digest, newToken, passwordHash } from './crypto';
import { openPlatformDatabase, PostgresAccountStore, tenantName } from './store';
import { TelegramBotGateway } from './telegram';
import { BACKGROUND_FEATURE_KEYS, backgroundFeatureSettingKey, defaultBackgroundFeatureEnabled } from '../ai/backgroundFeatures';
import { BotSettingEntity } from '../entity/BotSettingEntity';
import type { TenantCredentials } from './runtime';

async function main() {
    const phase = process.argv[2];
    if (!['prepare', 'activate', 'check'].includes(phase)) throw new Error('Expected prepare, activate or check');
    const env = process.env;
    const secrets = new PlatformSecrets(env.KIRA_PLATFORM_MASTER_KEY || '');
    const root = path.resolve(env.KIRA_PLATFORM_DATA_DIR || 'runtime-data/accounts');
    const directory = path.join(root, 'import');
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.chmod(directory, 0o700);
    const file = path.join(directory, 'current-account.json');
    const registry = await openPlatformDatabase(env);
    const store = new PostgresAccountStore(registry);
    await store.initialize();
    let source: DataSource | undefined;
    try {
        let state: { accountId: string; username: string; password: string; accessToken: string; phase: string };
        try { state = JSON.parse(await fs.readFile(file, 'utf8')); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || phase !== 'prepare') throw error;
            const username = env.KIRA_EXISTING_ACCOUNT_USERNAME || 'current_user';
            if (!/^[a-z0-9_]{3,40}$/.test(username) || await store.byUsername(username)) throw new Error('Import account name unavailable');
            const password = newToken();
            const account = await store.create(username, await passwordHash(password));
            state = { accountId: account.id, username, password, accessToken: env.KIRA_API_TOKEN || '', phase: 'prepared' };
            if (!/^[A-Za-z0-9_-]{32,128}$/.test(state.accessToken)) throw new Error('Existing API credential is required');
            await fs.writeFile(file, JSON.stringify(state, null, 2), { flag: 'wx', mode: 0o600 });
        }
        const account = await store.byId(state.accountId);
        if (!account || account.username !== state.username) throw new Error('Import identity mismatch');
        const role = tenantName(account.id);
        const database = env.DB_NAME || 'KiraMind';
        if (!/^[A-Za-z0-9_-]{1,63}$/.test(database) || database === (env.KIRA_PLATFORM_DB_NAME || 'KiraPlatform')) throw new Error('Invalid source database');
        source = await new DataSource({ type: 'postgres', host: env.DB_HOST || 'postgres', port: Number(env.DB_PORT || 5432),
            username: env.DB_USER || 'postgres', password: env.DB_PASSWORD, database, entities: [BotSettingEntity], synchronize: false, logging: false }).initialize();
        if (phase === 'prepare') {
            // Give the regular account its own restricted role; existing tables and rows stay in place.
            if (!(await registry.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role])).length) {
                const password = secrets.derive(account.id, 'database');
                await registry.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
            }
            await registry.query(`GRANT CONNECT ON DATABASE "${database}" TO "${role}"`);
            await source.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
            await source.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${role}"`);
            await source.query(`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO "${role}"`);
            const repo = source.getRepository(BotSettingEntity);
            const rows = new Map((await repo.find()).map(row => [row.key, row.value]));
            const defaults = BACKGROUND_FEATURE_KEYS.filter(key => !rows.has(backgroundFeatureSettingKey(key))).map(key => ({
                key: backgroundFeatureSettingKey(key), value: key === 'reflection' && rows.has('KiraMindBot:reflection_mode_enabled')
                    ? rows.get('KiraMindBot:reflection_mode_enabled')! : String(defaultBackgroundFeatureEnabled(key, env)),
            }));
            if (defaults.length) await repo.upsert(defaults, ['key']);
            await fs.mkdir(path.join(root, role, 'data'), { recursive: true, mode: 0o700 });
            console.log(JSON.stringify({ phase: 'prepared', restrictedRole: true }));
        }
        if (phase === 'activate' && state.phase !== 'active') {
            const ownerId = Number(env.KIRA_ALLOWED_USER_ID);
            if (!Number.isSafeInteger(ownerId) || ownerId <= 0) throw new Error('Invalid existing owner');
            const bot = await new TelegramBotGateway().verify(env.KIRA_BOT_TOKEN || '');
            const namespace = (env.KIRA_MEMORY_NAMESPACE || env.KIRA_BOT_USERNAME || '').toLowerCase();
            const credentials: TenantCredentials = { botToken: env.KIRA_BOT_TOKEN!, apiToken: state.accessToken,
                existingStorage: { database, memoryNamespace: namespace, memoryBotId: env.KIRA_MEMORY_BOT_ID || 'kiramindbot', healthPort: 3100 } };
            if (env.TELEGRAM_API_ID && env.TELEGRAM_API_HASH && env.TELEGRAM_SESSION_STRING) credentials.telegram = {
                apiId: Number(env.TELEGRAM_API_ID), apiHash: env.TELEGRAM_API_HASH, sessionString: env.TELEGRAM_SESSION_STRING,
            };
            const encrypted = secrets.seal(credentials, account.id);
            if (account.secrets) throw new Error('Account already configured outside this import');
            await registry.query(`UPDATE kira_accounts SET bot_id=$2, bot_username=$3, owner_id=$4, secrets=$5 WHERE id=$1 AND secrets IS NULL`,
                [account.id, String(bot.id), bot.username, String(ownerId), encrypted]);
            await store.session(digest(state.accessToken), account.id);
            // Keep the existing long-lived API credential working until the user revokes it.
            await registry.query("UPDATE kira_account_sessions SET expires_at='infinity' WHERE token_hash=$1", [digest(state.accessToken)]);
            state.phase = 'active';
            await fs.writeFile(file, JSON.stringify(state, null, 2), { mode: 0o600 });
            console.log(JSON.stringify({ phase: 'active', ordinaryAccount: true, previousApiTokenPreserved: true }));
        }
        if (phase === 'check') {
            const authenticated = await store.authenticate(digest(state.accessToken));
            if (authenticated?.id !== account.id) throw new Error('Imported account cannot authenticate');
            const permissions = await source.query(`SELECT bool_and(has_table_privilege($1, quote_ident(table_schema)||'.'||quote_ident(table_name), 'SELECT')
                AND has_table_privilege($1, quote_ident(table_schema)||'.'||quote_ident(table_name), 'INSERT')
                AND has_table_privilege($1, quote_ident(table_schema)||'.'||quote_ident(table_name), 'UPDATE')
                AND has_table_privilege($1, quote_ident(table_schema)||'.'||quote_ident(table_name), 'DELETE')) AS allowed
                FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'`, [role]);
            if (!permissions[0]?.allowed) throw new Error('Imported account lacks table access');
            console.log(JSON.stringify({ authenticated: true, ordinaryAccount: true, storageAccess: true }));
        }
    } finally { if (source) await source.destroy(); await store.close(); }
}

main().catch(() => { console.error('Existing account import failed; private diagnostics suppressed. Original storage is retained.'); process.exit(1); });
