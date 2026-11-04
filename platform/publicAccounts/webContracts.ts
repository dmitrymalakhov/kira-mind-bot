import type { AccountView, AuthConfig, AuthPurpose, IdentityProvider, IdentityView, ReauthenticationReply } from './contracts';

export type WebProvider = Exclude<IdentityProvider, 'apple'> | 'password';
export interface WebChallengeInput {
    version: 1;
    provider: WebProvider;
    purpose: AuthPurpose;
    reauthenticationToken?: string;
}
export interface WebChallengeReply {
    version: 1;
    flowId: string;
    provider: WebProvider;
    purpose: AuthPurpose;
    nonce: string;
    expiresAt: string;
    authorizationUrl?: string;
    proofRequirement: { type: 'hcaptcha' };
}
export interface WebCompleteInput {
    version: 1;
    flowId: string;
    identityToken?: string;
    username?: string;
    password?: string;
    captchaToken?: string;
}
export type WebAuthReply = { version: 1; account: AccountView } | IdentityView | ReauthenticationReply;
export type WebAuthConfig = Omit<AuthConfig, 'publicRegistration'> & {
    channel: 'web';
    hasBrowserSession: boolean;
    publicRegistration: false;
    csrfToken: string;
};
export interface WebSessionView {
    version: 1;
    account: AccountView;
    operatorAccess: boolean;
    operatorLinkingAvailable: boolean;
}
