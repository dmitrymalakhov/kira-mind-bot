import * as fs from 'node:fs';
import { digest } from '../crypto';
import { PUBLIC_ACCOUNTS_CONTRACT, AuthConfig, ConsentCatalog, RecipientDescriptor, IdentityProvider } from './contracts';

export interface ConsentRoute { provider: string; baseUrl: string; recipientIds: string[] }
export interface PublicAccountConfig {
    enabled: boolean; releaseReady: boolean; maxAccounts: number;
    enabledProviders: IdentityProvider[];
    apple: { clientId: string; teamId: string; keyId: string; privateKey: string };
    google: { clientId: string; iosClientId: string };
    telegram: { clientId: string; clientSecret: string; redirectUri: string };
    app: { bundleId: string; teamId: string; environment: 'production' | 'development' };
    captcha: { siteKey: string; secret: string; hostname: string; baseUrl: string };
    gateway: { peers: string[]; secret: string };
    privacyUrl: string | null; supportUrl: string | null;
    catalog: ConsentCatalog; routes: ConsentRoute[];
    aiLimit: number; imageLimit: number;
    readyCapabilities?: AuthConfig['capabilities'];
}
const https = (value: string) => {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.username || u.password || u.hash) throw new Error('Invalid public URL');
    return value;
};
const count = (value: string | undefined, fallback: number) => {
    const result = value === undefined || value === '' ? fallback : Number(value);
    if (!Number.isSafeInteger(result) || result < 0 || result > 1_000_000) throw new Error('Invalid public limit');
    return result;
};

export function loadConsentCatalog(path?: string): { catalog: ConsentCatalog; routes: ConsentRoute[] } {
    if (!path) return { catalog: { version: digest('unconfigured'), recipients: [] }, routes: [] };
    const value = JSON.parse(fs.readFileSync(path, 'utf8'));
    if (value.version !== 1 || !Array.isArray(value.recipients) || !Array.isArray(value.routes)
        || value.recipients.length > 64 || value.routes.length > 128) throw new Error('Invalid AI consent catalog');
    const ids = new Set<string>();
    const recipients: RecipientDescriptor[] = value.recipients.map((r: RecipientDescriptor) => {
        if (!r || !/^[a-z0-9_.-]{1,80}$/.test(r.id) || ids.has(r.id) || typeof r.name !== 'string' || r.name.length > 200
            || !Array.isArray(r.data) || !Array.isArray(r.purposes) || !r.data.length || !r.purposes.length
            || [...r.data, ...r.purposes].some(s => typeof s !== 'string' || !s || s.length > 500)) throw new Error('Invalid AI recipient');
        ids.add(r.id);
        return { id: r.id, name: r.name, data: [...r.data].sort(), purposes: [...r.purposes].sort(), policyUrl: https(r.policyUrl) };
    }).sort((a: RecipientDescriptor, b: RecipientDescriptor) => a.id.localeCompare(b.id));
    const routes: ConsentRoute[] = value.routes.map((r: ConsentRoute) => {
        if (!r || typeof r.provider !== 'string' || !/^[a-z][a-z0-9_-]{0,50}$/.test(r.provider)
            || !Array.isArray(r.recipientIds) || !r.recipientIds.length || r.recipientIds.some(id => !ids.has(id))) throw new Error('Invalid AI route');
        const u = new URL(r.baseUrl);
        if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw new Error('Invalid AI endpoint');
        // HTTP is allowed only for an explicitly declared local gateway; recipients must still be disclosed.
        return { provider: r.provider, baseUrl: u.href.replace(/\/$/, ''), recipientIds: [...new Set(r.recipientIds)].sort() };
    }).sort((a: ConsentRoute, b: ConsentRoute) => `${a.provider}:${a.baseUrl}`.localeCompare(`${b.provider}:${b.baseUrl}`));
    if (new Set(routes.map(r => `${r.provider}:${r.baseUrl}`)).size !== routes.length) throw new Error('Duplicate AI route');
    return { catalog: { version: digest(JSON.stringify({ recipients, routes })), recipients }, routes };
}

export function loadPublicAccountConfig(env: NodeJS.ProcessEnv = process.env): PublicAccountConfig {
    const get = (key: string) => env[`KIRA_PUBLIC_${key}`]?.trim() || '';
    const keyFile = get('APPLE_PRIVATE_KEY_FILE');
    const environment = get('APP_ATTEST_ENVIRONMENT') || 'production';
    if (!['production', 'development'].includes(environment)) throw new Error('Invalid App Attest environment');
    const enabledProviders = (get('IDENTITY_PROVIDERS') || 'apple,google,telegram').split(',').map(value => value.trim());
    if (new Set(enabledProviders).size !== enabledProviders.length || enabledProviders.some(value => !['apple','google','telegram'].includes(value))) {
        throw new Error('Invalid enabled identity providers');
    }
    const redirect = get('TELEGRAM_REDIRECT_URI');
    if (redirect) {
        const u = new URL(redirect);
        if (!/^(https:|[a-z][a-z0-9+.-]*:)$/.test(u.protocol) || ['http:', 'file:', 'data:', 'javascript:'].includes(u.protocol)
            || u.username || u.password || u.search || u.hash) throw new Error('Invalid Telegram redirect');
    }
    const catalog = loadConsentCatalog(get('AI_CATALOG_FILE'));
    const captchaHostname=get('HCAPTCHA_HOSTNAME').toLowerCase();
    const captchaBase=get('HCAPTCHA_BASE_URL') || (captchaHostname?`https://${captchaHostname}`:'');
    if(captchaBase){const u=new URL(https(captchaBase));if(u.hostname!==captchaHostname || u.origin!==captchaBase.replace(/\/$/,'') || u.search)throw new Error('hCaptcha base URL must be the configured verified HTTPS origin');}
    return {
        enabled: get('ACCOUNTS_ENABLED') === 'true', releaseReady: get('RELEASE_READY') === 'true', maxAccounts: count(env.KIRA_PLATFORM_MAX_ACCOUNTS, 10),
        enabledProviders: enabledProviders as IdentityProvider[],
        apple: { clientId: get('APPLE_CLIENT_ID'), teamId: get('APPLE_TEAM_ID'), keyId: get('APPLE_KEY_ID'), privateKey: keyFile ? fs.readFileSync(keyFile, 'utf8') : '' },
        google: { clientId: get('GOOGLE_CLIENT_ID'), iosClientId: get('GOOGLE_IOS_CLIENT_ID') },
        telegram: { clientId: get('TELEGRAM_CLIENT_ID'), clientSecret: get('TELEGRAM_CLIENT_SECRET'), redirectUri: redirect },
        app: { bundleId: get('APP_BUNDLE_ID'), teamId: get('APP_TEAM_ID'), environment: environment as 'production' | 'development' },
        captcha: { siteKey: get('HCAPTCHA_SITEKEY'), secret: get('HCAPTCHA_SECRET'), hostname: captchaHostname, baseUrl:captchaBase.replace(/\/$/,'') },
        gateway: { peers: get('GATEWAY_PEERS').split(',').map(x => x.trim()).filter(Boolean), secret: get('GATEWAY_SECRET') },
        privacyUrl: get('PRIVACY_URL') ? https(get('PRIVACY_URL')) : null,
        supportUrl: get('SUPPORT_URL') ? https(get('SUPPORT_URL')) : null,
        ...catalog, aiLimit: count(env.KIRA_PUBLIC_AI_DAILY_LIMIT, 20), imageLimit: count(env.KIRA_PUBLIC_IMAGE_DAILY_LIMIT, 1),
    };
}

export function publicAuthConfig(config: PublicAccountConfig): AuthConfig {
    const capabilities=config.readyCapabilities || {apiOnlyRuntime:true,identities:true,sessions:true,consents:true,quotas:true,deletion:false,inbox:true,push:false};
    const raw = [
        { provider: 'apple' as const, configured: Object.values(config.apple).every(Boolean), clientId: config.apple.clientId },
        { provider: 'google' as const, configured: Object.values(config.google).every(Boolean), clientId: config.google.clientId, iosClientId: config.google.iosClientId },
        { provider: 'telegram' as const, configured: Object.values(config.telegram).every(Boolean), clientId: config.telegram.clientId,
            redirectUri: config.telegram.redirectUri, scopes: ['openid', 'profile'] },
    ];
    // Push is optional: a Personal Team release can use the durable inbox without APNs.
    const requiredCapabilities = ['apiOnlyRuntime','identities','sessions','consents','quotas','deletion','inbox'] as const;
    const ready = config.enabled && config.releaseReady && requiredCapabilities.every(name => capabilities[name])
        && Boolean(config.app.bundleId && config.app.teamId && Object.values(config.captcha).every(Boolean)
            && config.privacyUrl && config.supportUrl && config.catalog.recipients.length);
    return { contract: PUBLIC_ACCOUNTS_CONTRACT, version: 1,
        publicRegistration: ready && raw.some(provider => config.enabledProviders.includes(provider.provider) && provider.configured),
        providers: raw.map(({ configured, ...r }) => {
            const selected = config.enabledProviders.includes(r.provider);
            const available = ready && selected && configured;
            return { ...r, available, ...(!available ? { reason: !selected ? 'disabled' as const : !configured ? 'not_configured' as const : 'release_not_ready' as const } : {}) };
        }),
        legacyPasswordLogin: true, accessTokenLifetimeSeconds: 900, refreshTokenLifetimeSeconds: 2592000,
        proof: { appAttest: Boolean(config.app.bundleId && config.app.teamId), environment: config.app.environment,
            appAttestAppId: config.app.bundleId && config.app.teamId ? `${config.app.teamId}.${config.app.bundleId}` : null,
            hcaptchaSiteKey: config.captcha.siteKey || null,hcaptchaBaseUrl:config.captcha.baseUrl || null,hcaptchaHostname:config.captcha.hostname || null }, aiConsent: config.catalog,
        links: { privacy: config.privacyUrl, support: config.supportUrl },
        // Each flag is enabled only when the corresponding integration slice is installed, not just its table.
        capabilities };
}
