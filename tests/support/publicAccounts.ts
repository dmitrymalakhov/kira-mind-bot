import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { PlatformSecrets } from '../../platform/crypto';
import { openPlatformDatabase, PostgresAccountStore } from '../../platform/store';
import { initializePublicAccounts } from '../../platform/publicAccounts/schema';
import { loadPublicAccountConfig, PublicAccountConfig } from '../../platform/publicAccounts/config';

export const publicTestPort = process.env.KIRA_PLATFORM_TEST_PG_PORT;
export const publicTestSecrets = new PlatformSecrets('78'.repeat(32));
/** Synthetic protocol fixtures. Never read running DB credentials or provider credentials. */
export function publicTestConfig(): PublicAccountConfig {
    const config = loadPublicAccountConfig({});
    return { ...config, enabled: true, releaseReady: true, maxAccounts: 100,
        readyCapabilities:{apiOnlyRuntime:true,identities:true,sessions:true,consents:true,quotas:true,deletion:true,inbox:true,push:true},
        apple: { clientId: 'org.example.synthetic', teamId: 'SYNTHETIC1', keyId: 'SYNTHKEY01', privateKey: 'synthetic-test-key' },
        google: { clientId: 'synthetic-web.apps.googleusercontent.com', iosClientId: 'synthetic-ios.apps.googleusercontent.com' },
        telegram: { clientId: '123456789', clientSecret: 'synthetic-oidc-secret', redirectUri: 'kira-synthetic://oauth/telegram' },
        app: { bundleId: 'org.example.synthetic', teamId: 'SYNTHETIC1', environment: 'production' },
        captcha: { siteKey: 'synthetic-site-key', secret: 'synthetic-captcha-secret', hostname: 'synthetic.example.invalid',baseUrl:'https://synthetic.example.invalid' },
        privacyUrl: 'https://synthetic.example.invalid/privacy', supportUrl: 'https://synthetic.example.invalid/support',
        catalog: { version: 'synthetic-catalog-v1', recipients: [{ id: 'synthetic-ai', name: 'Synthetic AI', data: ['user content'], purposes: ['answer'], policyUrl: 'https://synthetic.example.invalid/privacy' }] },
        routes: [{ provider: 'openai', baseUrl: 'https://synthetic.example.invalid/v1', recipientIds: ['synthetic-ai'] }],
    };
}
export async function withPublicRegistry(run: (db: DataSource, store: PostgresAccountStore) => Promise<void>): Promise<void> {
    const env = { DB_HOST: '127.0.0.1', DB_PORT: publicTestPort, DB_USER: 'postgres', DB_PASSWORD: 'synthetic-platform-test',
        KIRA_PLATFORM_DB_NAME: `kira_public_test_${randomUUID().replace(/-/g, '')}` };
    const db = await openPlatformDatabase(env);
    const store = new PostgresAccountStore(db);
    const admin = await new DataSource({ type: 'postgres', host: env.DB_HOST, port: Number(publicTestPort), username: env.DB_USER, password: env.DB_PASSWORD, database: 'postgres' }).initialize();
    try { await store.initialize(); await initializePublicAccounts(db); await run(db, store); }
    finally { await store.close(); await admin.query(`DROP DATABASE "${env.KIRA_PLATFORM_DB_NAME}" WITH (FORCE)`); await admin.destroy(); }
}
