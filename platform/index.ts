import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as dotenv from 'dotenv';
import { PlatformSecrets } from './crypto';
import { openPlatformDatabase, PostgresAccountStore } from './store';
import { TenantRuntimeManager } from './runtime';
import { TelegramBotGateway } from './telegram';
import { createPlatformServer } from './server';
import { createBrowserProxy } from './browserProxy';

async function main() {
    dotenv.config({ path: `.env.${process.env.NODE_ENV || 'production'}` });
    const secrets = new PlatformSecrets(process.env.KIRA_PLATFORM_MASTER_KEY || '');
    const port = Number(process.env.KIRA_PLATFORM_PORT || 3300);
    const capacity = Number(process.env.KIRA_PLATFORM_MAX_ACCOUNTS || 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !Number.isInteger(capacity) || capacity < 1 || capacity > 1000) {
        throw new Error('Invalid account server limits');
    }
    const root = path.resolve(process.env.KIRA_PLATFORM_DATA_DIR || 'runtime-data/accounts');
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    await fs.chmod(root, 0o700);
    const db = await openPlatformDatabase(process.env);
    const store = new PostgresAccountStore(db, capacity);
    await store.initialize();
    await db.query('CREATE TABLE IF NOT EXISTS kira_platform_key (id int PRIMARY KEY CHECK (id=1), canary text NOT NULL)');
    await db.query('INSERT INTO kira_platform_key(id,canary) VALUES (1,$1) ON CONFLICT DO NOTHING', [secrets.seal('kira-platform-key-v1', 'platform')]);
    const [key] = await db.query('SELECT canary FROM kira_platform_key WHERE id=1');
    if (secrets.open(key.canary, 'platform') !== 'kira-platform-key-v1') throw new Error('Platform master key changed');
    const telegram = new TelegramBotGateway();
    const browserProxy = createBrowserProxy();
    await new Promise<void>((resolve, reject) => { browserProxy.once('error', reject); browserProxy.listen(0, '127.0.0.1', resolve); });
    const proxyAddress = browserProxy.address();
    if (!proxyAddress || typeof proxyAddress === 'string') throw new Error('Browser proxy unavailable');
    const runtimes = new TenantRuntimeManager(store, db, secrets, telegram, root, {
        ...process.env, KIRA_BROWSER_PROXY_URL: `http://127.0.0.1:${proxyAddress.port}`,
    }, () => process.exit(1));
    const reservedBotIds = [process.env.KIRA_BOT_TOKEN?.split(':')[0] || '',
        ...(process.env.KIRA_PLATFORM_RESERVED_BOT_IDS || '').split(',').map(id => id.trim())];
    const server = createPlatformServer({ store, secrets, telegram, runtimes, reservedBotIds });
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, process.env.KIRA_PLATFORM_HOST || '127.0.0.1', resolve);
    });
    runtimes.start();
    console.log(`[accounts] listening port=${port}`);
    let stopping = false;
    const stop = async () => {
        if (stopping) return;
        stopping = true;
        const timeout = setTimeout(() => process.exit(1), 10_000);
        server.close();
        await runtimes.close();
        browserProxy.close();
        await store.close();
        clearTimeout(timeout);
        process.exit(0);
    };
    process.once('SIGTERM', () => { void stop(); });
    process.once('SIGINT', () => { void stop(); });
}

main().catch(() => {
    // Database errors and Telegram URLs may contain credentials. Never print the exception.
    console.error('[accounts] startup failed; check platform key, database credentials and singleton deployment');
    process.exit(1);
});
