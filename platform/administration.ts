import path from 'node:path';
import { DataSource } from 'typeorm';
import { ApiError } from '../api/contracts';
import { PlatformSecrets, digest } from './crypto';
import { tenantEnvironment, TenantCredentials, AccountRuntimes } from './runtime';
import { AccountStore, tenantName } from './store';
import { parseAccountSettings } from '../utils/accountSettings';
import { canonicalJson } from './publicAccounts/validation';
import type { PublicAccountPolicy } from './publicAccounts/policy';
const { getMemoryEmbeddingProfile, DEFAULT_MEMORY_EMBEDDING_PROFILE } = require('../admin-panel/memoryEmbeddingProfileRegistry');
const { createMemoryEmbeddingHttp } = require('../ai/memoryEmbeddingHttp');
const { getProviderDescriptor } = require('../ai/memoryEmbeddingProviderSupport');

/** Canonical bindings are derived in the manager; no HTTP client chooses a database, namespace or path. */
export class TenantAdministration {
    constructor(private db: DataSource, private store: AccountStore, private secrets: PlatformSecrets,
        private runtimes: AccountRuntimes, private root: string, private env: NodeJS.ProcessEnv, private policy: PublicAccountPolicy) {}

    private async load(id: string) {
        const [account] = await this.db.query(`SELECT * FROM kira_accounts WHERE id=$1 AND account_state IN ('active','restricted')
            AND NOT EXISTS(SELECT 1 FROM kira_public_deletion_ledger l WHERE l.account_id=kira_accounts.id)`, [id]);
        if (!account || !account.secrets || (!account.owner_id && account.runtime_mode !== 'api_only')) throw new ApiError(409, 'account_not_ready', 'Сначала заверши подключение и запуск этой Киры.');
        const credentials = this.secrets.open<TenantCredentials>(account.secrets, id);
        const directory = tenantName(id);
        const environment = tenantEnvironment(this.env, account, credentials, path.join(this.root, directory), this.secrets);
        const [exists] = await this.db.query('SELECT 1 FROM pg_database WHERE datname=$1', [environment.DB_NAME]);
        if (!exists) throw new ApiError(409, 'account_not_ready', 'Хранилище этой Киры ещё создаётся.');
        const settings = parseAccountSettings(credentials.adminSettings || {});
        return { account, credentials, directory, environment, revision: digest(canonicalJson(settings)) };
    }

    async context(id: string) {
        const state = await this.load(id), env = { ...state.environment };
        for (const key of ['KIRA_API_TOKEN','KIRA_COMMERCE_STORAGE_KEY','KIRA_RUNTIME_DATA_DIR','PERSONALITY_FILE','TMPDIR','PATH']) delete env[key];
        return { id, username: state.account.display_name || state.account.username, ownerId: state.account.runtime_mode === 'api_only' ? state.account.runtime_principal! : state.account.owner_id!,
            profile: 'KiraMindBot', directory: state.directory, env, settingsRevision: state.revision,
            status: this.runtimes.status(id), memoryNamespace: state.environment.KIRA_MEMORY_NAMESPACE!, memoryBotId: state.environment.KIRA_MEMORY_BOT_ID! };
    }

    async settings(id: string, updates: unknown, revision: string) {
        let patch: Record<string, string | null>;
        try { patch = parseAccountSettings(updates, true); } catch (error) { throw new ApiError(400, 'invalid_settings', (error as Error).message); }
        const state = await this.load(id);
        if (revision !== state.revision) throw new ApiError(409, 'settings_changed', 'Настройки аккаунта изменились. Обнови их перед сохранением.');
        const next = { ...(state.credentials.adminSettings || {}) };
        for (const [key, value] of Object.entries(patch)) { if (value === null) delete next[key]; else next[key] = value; }
        state.credentials.adminSettings = next;
        await this.store.updateSecrets(id, state.account.secrets!, this.secrets.seal(state.credentials, id));
        return { revision: digest(canonicalJson(next)) };
    }

    async restart(id: string) { await this.load(id); await this.runtimes.restart(id); return { restarting: true }; }
    async quota(id: string) { await this.load(id); return { quota: await this.policy.quota(id) }; }
    async embedding(id: string, text: string, expectedProfile: string, requestKey: string) {
        const state = await this.load(id), env = state.environment;
        const connection = new DataSource({type:'postgres',host:env.DB_HOST,port:Number(env.DB_PORT||5432),username:env.DB_USER,
            password:env.DB_PASSWORD,database:env.DB_NAME,logging:false,synchronize:false,extra:{max:1,statement_timeout:10000}});
        const operationId = `admin-memory:${requestKey}`;
        try {
            await connection.initialize();
            const [setting] = await connection.query("SELECT value FROM bot_settings WHERE key='MEMORY_EMBEDDING_PROFILE'");
            const name = setting?.value || env.MEMORY_EMBEDDING_PROFILE || DEFAULT_MEMORY_EMBEDDING_PROFILE;
            if (name !== expectedProfile) throw new ApiError(409,'settings_changed','Профиль памяти изменился. Обнови настройки.');
            const profile = getMemoryEmbeddingProfile(name);
            const vector = await createMemoryEmbeddingHttp(text,profile,{env,
                resolveApiKey:(provider:string)=>env[getProviderDescriptor(provider)?.envKey] || '',
                fetchImpl:async(url:string,options:RequestInit)=>{
                    await this.policy.authorizeOutbound(id,{operationId,provider:profile.provider,endpoint:url,image:false,background:false});
                    return fetch(url,{...options,redirect:'error',signal:AbortSignal.timeout(30000)});
                },
            });
            if(!Array.isArray(vector) || vector.length!==profile.outputDimension || vector.some(x=>typeof x!=='number'||!Number.isFinite(x))) throw new ApiError(502,'embedding_unavailable','Модель не вернула корректный вектор памяти.');
            return {vector};
        } catch(error) {
            if(error instanceof ApiError)throw error;
            throw new ApiError(502,'embedding_unavailable','Не удалось подготовить память выбранного аккаунта.');
        } finally {
            if(connection.isInitialized)await connection.destroy();
            await this.policy.release(id,operationId,false).catch(()=>{});
        }
    }
}
