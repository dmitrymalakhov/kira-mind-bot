/** Canonical native-account wire contract. Availability is advertised separately from this schema. */
export const PUBLIC_ACCOUNTS_CONTRACT = 'kira.public-accounts.v1' as const;
export const PUBLIC_ACCOUNTS_VERSION = 1 as const;
export type IdentityProvider = 'apple' | 'google' | 'telegram';
export type AccountState = 'registered' | 'active' | 'restricted' | 'deleting' | 'deleted';
export type RuntimeState = 'not_activated' | 'queued' | 'starting' | 'ready' | 'unavailable';
export type AuthPurpose = 'login' | 'reauthenticate' | 'link';

export interface ProviderConfig {
    provider: IdentityProvider;
    available: boolean;
    reason?: 'disabled' | 'not_configured' | 'not_implemented' | 'release_not_ready';
    clientId?: string;
    iosClientId?: string;
    redirectUri?: string;
    scopes?: string[];
}
export interface RecipientDescriptor {
    id: string;
    name: string;
    data: string[];
    purposes: string[];
    policyUrl: string;
}
export interface ConsentCatalog {
    version: string;
    recipients: RecipientDescriptor[];
}
export interface AuthConfig {
    contract: typeof PUBLIC_ACCOUNTS_CONTRACT;
    version: 1;
    publicRegistration: boolean;
    providers: ProviderConfig[];
    legacyPasswordLogin: boolean;
    accessTokenLifetimeSeconds: 900;
    refreshTokenLifetimeSeconds: 2592000;
    proof: { appAttest: boolean; environment: 'production' | 'development'; hcaptchaSiteKey: string | null;
        appAttestAppId: string | null; hcaptchaBaseUrl: string | null; hcaptchaHostname: string | null };
    aiConsent: ConsentCatalog;
    links: { privacy: string | null; support: string | null };
    capabilities: { apiOnlyRuntime: boolean; identities: boolean; sessions: boolean; consents: boolean;
        quotas: boolean; deletion: boolean; inbox: boolean; push: boolean };
}

export interface ChallengeInput {
    version: 1;
    provider: IdentityProvider | 'password';
    purpose: AuthPurpose;
    deviceId: string;
    codeChallenge?: string;
    codeChallengeMethod?: 'S256';
    reauthenticationToken?: string;
}
export interface AuthChallenge {
    version: 1;
    challengeId: string;
    challenge: string;
    nonce: string;
    state: string;
    expiresAt: string;
    authorizationUrl?: string;
    proofRequirement: { mode: 'app_attest_or_hcaptcha'; reason: null } | { mode: 'hcaptcha'; reason: 'risk' };
}
export interface CaptchaRequirement {
    type: 'hcaptcha'; reason: 'risk'; challengeId: string; siteKey: string; baseUrl: string; hostname: string;
}
export type AppProof =
    | { type: 'app_attest'; keyId: string; attestation?: string; assertion: string }
    | { type: 'hcaptcha'; token: string; reason: 'unsupported' | 'temporarily_unavailable' | 'risk' };
export interface ProviderLoginInput {
    version: 1;
    challengeId: string;
    state: string;
    deviceId: string;
    deviceName: string;
    identityToken?: string;
    authorizationCode?: string;
    codeVerifier?: string;
    proof: AppProof;
}
export interface PasswordLoginInput {
    version: 1;
    challengeId: string;
    state: string;
    deviceId: string;
    deviceName: string;
    username: string;
    password: string;
    proof: AppProof;
}
export interface AccountView {
    id: string;
    username: string;
    accountState: AccountState;
    runtimeState: RuntimeState;
    runtimeMode: 'api_only' | 'telegram';
    isReady: boolean;
    autonomousAiEnabled: boolean;
    consent: { requiredVersion: string; acceptedVersion: string | null; aiAllowed: boolean };
    quota: QuotaView;
    bot: { id: string; username: string | null; connected: boolean; status: string } | null;
}
export interface SessionView {
    id: string;
    deviceId: string;
    deviceName: string;
    provider: IdentityProvider | 'password';
    createdAt: string;
    lastUsedAt: string;
    expiresAt: string;
    current: boolean;
}
export interface TokenPair {
    version: 1;
    tokenType: 'Bearer';
    accessToken: string;
    expiresIn: 900;
    refreshToken: string;
    refreshExpiresAt: string;
    sessionId: string;
}
export interface LoginReply extends TokenPair { account: AccountView }
export interface RefreshInput { version: 1; refreshToken: string; deviceId: string }
export interface ReauthenticationReply { version: 1; reauthenticationToken: string; expiresAt: string }
export interface IdentityView { id: string; provider: IdentityProvider | 'password'; linkedAt: string; lastUsedAt: string | null }
export interface ConsentInput { version: 1; consentVersion: string; accepted: boolean; recipientIds: string[] }
export interface QuotaView {
    day: string;
    resetAt: string;
    ai: { limit: number; used: number; reserved: number; remaining: number };
    images: { limit: number; used: number; reserved: number; remaining: number };
}
export interface ActivationInput { version: 1 }
export interface DeleteAccountInput { version: 1; confirmation: 'delete_my_account'; reauthenticationToken: string }
export interface DeletionReply { version: 1; status: 'deleting'; deletionId: string; requestedAt: string }
export interface PushDeviceInput {
    version: 1;
    deviceId: string;
    token: string;
    environment: 'sandbox' | 'production';
}
export interface InboxEvent {
    id: string;
    kind: 'reminder' | 'task_result' | 'dialogue_result' | 'account';
    createdAt: string;
    readAt: string | null;
    content: { text: string; resourceId?: string };
}
export interface NotificationPage { version: 1; events: InboxEvent[]; nextCursor: string | null }
export interface ComplaintInput { version: 1; replyId: string; category: 'unsafe' | 'privacy' | 'other'; details?: string }
export interface PublicAccountError {
    error: { code: string; message: string; retryAfterSeconds?: number; requiredConsentVersion?: string; proofRequirement?: CaptchaRequirement };
    requestId: string;
}
