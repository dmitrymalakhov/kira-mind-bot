import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as dotenv from 'dotenv';
import { PlatformSecrets } from './crypto';
import { openPlatformDatabase, PostgresAccountStore } from './store';
import { TenantRuntimeManager } from './runtime';
import { TelegramBotGateway } from './telegram';
import { createPlatformServer } from './server';
import { createBrowserProxy } from './browserProxy';
import { PublicAccountsHttp } from './publicAccounts/http';
import { loadPublicAccountConfig } from './publicAccounts/config';
import { ApplePushTransport, loadApnsConfig } from './publicAccounts/apns';
import { PublicPushWorker } from './publicAccounts/pushWorker';
import { AccountDeletion } from './publicAccounts/deletion';
import { DeletionLedger } from './publicAccounts/deletionLedger';
import { OwnedAccountEraser } from './publicAccounts/eraser';
import { OfficialIdentityVerifier } from './publicAccounts/providers';
import { QdrantClient } from '@qdrant/js-client-rest';
import { tenantName } from './store';
import { PublicAccountMaintenance } from './publicAccounts/maintenance';

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
    const publicAccounts = new PublicAccountsHttp(db, store, secrets, runtimes, loadPublicAccountConfig(process.env));
    const publicMaintenance=new PublicAccountMaintenance(db);
    runtimes.setAccountAuthority({policy:publicAccounts.policy,inbox:publicAccounts.inbox});
    const apns=loadApnsConfig(process.env);
    const pushWorker=apns ? new PublicPushWorker(db,secrets,new ApplePushTransport(apns)) : undefined;
    const ledgerDirectory=process.env.KIRA_PUBLIC_DELETION_LEDGER_DIR;
    if(ledgerDirectory){
        const ledger=new DeletionLedger(path.resolve(ledgerDirectory),secrets.derive('deletion-ledger','api'));
        await ledger.restoreBarrier(db);
        const eraser=new OwnedAccountEraser(db,secrets,root,new QdrantClient({url:process.env.QDRANT_URL || 'http://qdrant:6333',apiKey:process.env.QDRANT_API_KEY}),process.env.KIRA_PUBLIC_DELETION_MANIFEST_FILE);
        publicAccounts.deletion=new AccountDeletion(db,store,secrets,runtimes,new OfficialIdentityVerifier(publicAccounts.config),ledger,eraser,id=>path.join(root,tenantName(id)));
    }
    publicAccounts.config.readyCapabilities={apiOnlyRuntime:true,identities:true,sessions:true,consents:true,quotas:true,
        deletion:Boolean(publicAccounts.deletion),inbox:true,push:Boolean(pushWorker)};
    const server = createPlatformServer({ store, secrets, telegram, runtimes, reservedBotIds, publicAccounts });
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, process.env.KIRA_PLATFORM_HOST || '127.0.0.1', resolve);
    });
    runtimes.start();
    pushWorker?.start();
    publicAccounts.deletion?.start();
    publicMaintenance.start();
    console.log(`[accounts] listening port=${port}`);
    let stopping = false;
    const stop = async () => {
        if (stopping) return;
        stopping = true;
        const timeout = setTimeout(() => process.exit(1), 10_000);
        server.close();
        await runtimes.close();
        await pushWorker?.close();
        await publicAccounts.deletion?.close();
        await publicMaintenance.close();
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
