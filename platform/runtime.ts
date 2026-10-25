import { ChildProcess, fork } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { DataSource } from 'typeorm';
import { ApiError } from '../api/contracts';
import { PlatformSecrets } from './crypto';
import { Account, AccountStore, provisionTenantDatabase, tenantName } from './store';
import { pairingOwner, TelegramGateway, TelegramSession } from './telegram';

export interface TenantCredentials {
    botToken: string;
    telegram?: TelegramSession;
    apiToken?: string;
    /** Trusted local import preserves an existing account's storage without copying or resetting it. */
    existingStorage?: { database: string; memoryNamespace: string; memoryBotId: string; healthPort?: number };
}
export interface RuntimeEndpoint { port: number; token: string }
export interface AccountRuntimes {
    status(id: string): string;
    endpoint(account: Account): RuntimeEndpoint;
    restart(id: string): Promise<void>;
}

/** Whitelist infrastructure/model credentials; personal identity and integrations are never inherited. */
export function tenantEnvironment(env: NodeJS.ProcessEnv, account: Account, credentials: TenantCredentials,
    directory: string, secrets: PlatformSecrets): NodeJS.ProcessEnv {
    const child: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(env)) {
        if (/^(?:PATH|LANG|TZ|NODE_EXTRA_CA_CERTS|PLAYWRIGHT_[A-Z_]+|CHROMIUM_[A-Z_]+|OPENAI_[A-Z_]+|GEMINI_[A-Z_]+|GOOGLE_API_KEY|GOOGLE_MAPS_API_KEY|ELEVENLABS_[A-Z_]+|OPENROUTER_[A-Z_]+|ZAI_[A-Z_]+|LM_STUDIO_[A-Z_]+|AI_MODEL_PRESET|MEMORY_EMBEDDING_[A-Z_]+|DB_HOST|DB_PORT|QDRANT_URL|QDRANT_API_KEY)$/.test(key)) child[key] = value;
    }
    const name = tenantName(account.id);
    const existing = credentials.existingStorage;
    if (existing && (!/^[A-Za-z0-9_-]{1,63}$/.test(existing.database) || !/^[a-z0-9_-]{1,100}$/.test(existing.memoryNamespace)
        || !/^[a-z0-9_-]{1,100}$/.test(existing.memoryBotId))) throw new Error('Invalid imported storage binding');
    Object.assign(child, {
        NODE_ENV: 'production', TMPDIR: path.join(directory, 'temp'),
        KIRA_TENANT_ID: account.id, KIRA_INSTANCE_NAME: name,
        DB_NAME: existing?.database || name, DB_USER: name, DB_PASSWORD: secrets.derive(account.id, 'database'),
        KIRA_DATABASE_SYNC: existing ? 'false' : 'true',
        VECTOR_PROVIDER: 'qdrant', KIRA_MEMORY_NAMESPACE: existing?.memoryNamespace || name,
        KIRA_MEMORY_BOT_ID: existing?.memoryBotId || name,
        KIRA_BOT_TOKEN: credentials.botToken, KIRA_BOT_USERNAME: account.bot_username!,
        KIRA_ALLOWED_USER_ID: account.owner_id!, KIRA_ADMIN_USER_ID: account.owner_id!,
        PERSONALITY_FILE: path.join(directory, 'personality.json'), KIRA_RUNTIME_DATA_DIR: path.join(directory, 'data'),
        KIRA_API_ENABLED: 'true', KIRA_API_TOKEN: credentials.apiToken || secrets.derive(account.id, 'api'),
        KIRA_API_HOST: '127.0.0.1', KIRA_API_PORT: '0', KIRA_RUNTIME_HEALTH_DISABLED: existing?.healthPort ? 'false' : 'true',
        ...(existing?.healthPort ? { KIRA_RUNTIME_HEALTH_PORT: String(existing.healthPort) } : {}),
        // Pairing consumes all updates up to this cursor before the worker starts polling.
        KIRA_TELEGRAM_UPDATE_OFFSET: String(account.update_offset),
        KIRA_BROWSER_PROXY_URL: env.KIRA_BROWSER_PROXY_URL,
    });
    if (credentials.telegram) Object.assign(child, {
        TELEGRAM_API_ID: String(credentials.telegram.apiId), TELEGRAM_API_HASH: credentials.telegram.apiHash,
        TELEGRAM_SESSION_STRING: credentials.telegram.sessionString,
    });
    return child;
}

type Worker = { child: ChildProcess; port?: number; token: string; state: string; startedAt: number };

export class TenantRuntimeManager implements AccountRuntimes {
    private workers = new Map<string, Worker>();
    private retryAt = new Map<string, number>();
    private pairingErrors = new Map<string, string>();
    private revisions = new Map<string, number>();
    private ticking = false;
    private stopped = false;
    private timer?: NodeJS.Timeout;
    constructor(private store: AccountStore, private admin: DataSource, private secrets: PlatformSecrets,
        private telegram: TelegramGateway, private root: string, private env = process.env,
        private fatal?: () => void) {}

    status(id: string): string { return this.workers.get(id)?.state || this.pairingErrors.get(id) || 'waiting'; }
    endpoint(account: Account): RuntimeEndpoint {
        const worker = this.workers.get(account.id);
        if (worker?.state !== 'ready' || !worker.port) throw new ApiError(503, 'kira_starting', 'Кира ещё запускается. Повтори запрос позже.');
        return { port: worker.port, token: worker.token };
    }
    start() {
        this.timer = setInterval(() => { void this.tick(); }, 2000);
        void this.tick();
    }
    async tick(): Promise<void> {
        if (this.ticking || this.stopped) return;
        this.ticking = true;
        try {
            const accounts = await this.store.configured();
            // One unavailable Telegram bot must not block all other accounts.
            await Promise.allSettled(accounts.map(account => this.reconcile(account)));
        } catch {
            console.error('[accounts] manager lease unavailable; stopping runtimes');
            await this.close();
            this.fatal?.();
        }
        finally { this.ticking = false; }
    }
    private async reconcile(account: Account) {
        if (this.workers.has(account.id) || (this.retryAt.get(account.id) || 0) > Date.now()) return;
        const revision = this.revisions.get(account.id);
        try {
            const credentials = this.secrets.open<TenantCredentials>(account.secrets!, account.id);
            if (!account.owner_id) {
                if (!account.pairing_hash || !account.pairing_expires || new Date(account.pairing_expires).getTime() <= Date.now()) {
                    this.pairingErrors.set(account.id, 'pairing_expired'); return;
                }
                this.pairingErrors.set(account.id, 'awaiting_telegram');
                const updates = await this.telegram.updates(credentials.botToken, Number(account.update_offset));
                for (const update of updates) {
                    const owner = pairingOwner(update, account.pairing_hash);
                    if (owner) {
                        const offset = update.update_id + 1;
                        if (await this.store.pair(account.id, account.pairing_hash, owner, offset)) {
                            this.pairingErrors.delete(account.id);
                        }
                        return; // Next tick re-reads the committed identity.
                    }
                }
                if (updates.length) await this.store.offset(account.id, account.pairing_hash, Math.max(...updates.map(item => item.update_id)) + 1);
                return;
            }
            const directory = path.join(this.root, tenantName(account.id));
            await fs.mkdir(path.join(directory, 'temp'), { recursive: true, mode: 0o700 });
            await fs.chmod(directory, 0o700);
            const personality = path.join(directory, 'personality.json');
            try { await fs.writeFile(personality, '{}', { mode: 0o600, flag: 'wx' }); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
            if (!credentials.existingStorage) await provisionTenantDatabase(this.admin, account.id, this.secrets.derive(account.id, 'database'));
            if (this.stopped || revision !== this.revisions.get(account.id)) return;
            const workerEnv = tenantEnvironment(this.env, account, credentials, directory, this.secrets);
            const child = fork(path.resolve(__dirname, '..', 'index.js'), [], {
                cwd: directory, env: workerEnv,
                execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
            });
            const worker: Worker = { child, token: workerEnv.KIRA_API_TOKEN!, state: 'starting', startedAt: Date.now() };
            this.workers.set(account.id, worker);
            const timeout = setTimeout(() => { child.kill('SIGKILL'); }, 120_000);
            child.on('message', (message: unknown) => {
                const data = message as { type?: string; port?: number };
                if (data?.type === 'kira-ready' && Number.isInteger(data.port) && data.port! > 0 && data.port! <= 65535) {
                    worker.port = data.port; worker.state = 'ready'; clearTimeout(timeout);
                }
            });
            const exited = () => {
                clearTimeout(timeout);
                if (this.workers.get(account.id) !== worker) return;
                this.workers.delete(account.id);
                this.retryAt.set(account.id, Date.now() + 30_000);
                this.pairingErrors.set(account.id, 'restarting');
                console.error(`[accounts] runtime stopped account=${account.id}`);
            };
            child.once('exit', exited);
            child.once('error', exited);
        } catch (error) {
            this.pairingErrors.set(account.id, error instanceof ApiError ? error.code : 'runtime_error');
            this.retryAt.set(account.id, Date.now() + 30_000);
            console.error(`[accounts] reconciliation failed account=${account.id}`);
        }
    }
    async restart(id: string): Promise<void> {
        this.revisions.set(id, (this.revisions.get(id) || 0) + 1);
        const worker = this.workers.get(id);
        if (worker) {
            await new Promise<void>(resolve => {
                const timeout = setTimeout(() => worker.child.kill('SIGKILL'), 5000);
                worker.child.once('exit', () => { clearTimeout(timeout); resolve(); });
                worker.child.kill('SIGTERM');
            });
        }
        this.retryAt.delete(id);
    }
    async close() {
        this.stopped = true;
        clearInterval(this.timer);
        await Promise.all([...this.workers.values()].map(worker => new Promise<void>(resolve => {
            const timer = setTimeout(() => { worker.child.kill('SIGKILL'); }, 5000);
            worker.child.once('exit', () => { clearTimeout(timer); resolve(); });
            worker.child.kill('SIGTERM');
        })));
    }
}
