import { createHash } from 'node:crypto';
import { ApiError } from '../../api/contracts';
import { PublicAccountConfig } from './config';
import { IdentityProvider, ProviderLoginInput } from './contracts';
import { loadJose } from './cryptoModules';

export interface VerifiedIdentity { provider: IdentityProvider; subject: string; revocationToken?: string; clientId?: string }
export interface ProviderChallenge { nonce: string; code_challenge: string | null; created_at: Date }
export interface IdentityVerifier {
    verify(provider: IdentityProvider, input: ProviderLoginInput, challenge: ProviderChallenge): Promise<VerifiedIdentity>;
    revokeApple(token: string, clientId: string): Promise<void>;
}
const TRUSTED = {
    apple: { issuer: ['https://appleid.apple.com'], jwks: 'https://appleid.apple.com/auth/keys' },
    google: { issuer: ['https://accounts.google.com', 'accounts.google.com'], jwks: 'https://www.googleapis.com/oauth2/v3/certs' },
    telegram: { issuer: ['https://oauth.telegram.org'], jwks: 'https://oauth.telegram.org/.well-known/jwks.json' },
};
const denied = () => new ApiError(401, 'invalid_provider_proof', 'Не удалось подтвердить вход.');

/** Fixed issuers/JWKS/algorithms. Only the test constructor may inject a local trusted key resolver. */
export class OfficialIdentityVerifier implements IdentityVerifier {
    private keys = new Map<IdentityProvider, any>();
    constructor(private config: PublicAccountConfig, private fetcher: typeof fetch = fetch,
        private now = () => new Date(), private testKeys?: Partial<Record<IdentityProvider, any>>) {}

    async verify(provider: IdentityProvider, input: ProviderLoginInput, challenge: ProviderChallenge): Promise<VerifiedIdentity> {
        const config = this.config[provider];
        if (!config.clientId) throw new ApiError(503, 'provider_unavailable', 'Вход временно недоступен.');
        try {
            let jwt = input.identityToken;
            let revocationToken: string | undefined;
            if (provider === 'telegram') {
                if (!input.authorizationCode || !input.codeVerifier || !challenge.code_challenge
                    || createHash('sha256').update(input.codeVerifier).digest('base64url') !== challenge.code_challenge) throw denied();
                const result = await this.exchange('https://oauth.telegram.org/token', {
                    grant_type: 'authorization_code', code: input.authorizationCode, redirect_uri: this.config.telegram.redirectUri,
                    client_id: config.clientId, code_verifier: input.codeVerifier,
                }, `Basic ${Buffer.from(`${config.clientId}:${this.config.telegram.clientSecret}`).toString('base64')}`);
                jwt = result.id_token;
            }
            if (!jwt) throw denied();
            const claims = await this.verifyJwt(provider, jwt, challenge);
            if (provider === 'apple') {
                if (!input.authorizationCode) throw denied();
                const result = await this.exchange('https://appleid.apple.com/auth/token', {
                    grant_type: 'authorization_code', code: input.authorizationCode,
                    client_id: config.clientId, client_secret: await this.appleSecret(config.clientId),
                });
                const exchanged = await this.verifyJwt(provider, result.id_token, challenge);
                if (exchanged.sub !== claims.sub || typeof result.refresh_token !== 'string' || !result.refresh_token) throw denied();
                revocationToken = result.refresh_token;
            }
            return { provider, subject: claims.sub!, ...(revocationToken ? { revocationToken, clientId: config.clientId } : {}) };
        } catch (error) {
            if (error instanceof ApiError) throw error;
            throw denied();
        }
    }

    async verifyJwt(provider: IdentityProvider, token: string, challenge: ProviderChallenge) {
        const jose = await loadJose();
        let keys = this.testKeys?.[provider] || this.keys.get(provider);
        if (!keys) {
            keys = jose.createRemoteJWKSet(new URL(TRUSTED[provider].jwks), { timeoutDuration: 8000, cooldownDuration: 30_000 });
            this.keys.set(provider, keys);
        }
        try {
            const { payload } = await jose.jwtVerify(token, keys, {
                issuer: TRUSTED[provider].issuer, audience: this.config[provider].clientId,
                algorithms: ['RS256'], requiredClaims: ['sub', 'iat', 'exp', ...(provider==='telegram'?[]:['nonce'])],
                currentDate: this.now(), clockTolerance: 5, maxTokenAge: 300,
            });
            if (typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 512 || (payload.nonce!==undefined && payload.nonce !== challenge.nonce)
                || typeof payload.iat !== 'number' || payload.iat * 1000 < new Date(challenge.created_at).getTime() - 30_000
                || (payload.azp !== undefined && payload.azp !== this.config[provider].clientId
                    && !(provider === 'google' && payload.azp === this.config.google.iosClientId))) throw denied();
            return payload;
        } catch { throw denied(); }
    }

    async revokeApple(token: string, clientId: string): Promise<void> {
        await this.exchange('https://appleid.apple.com/auth/revoke', {
            client_id: clientId, client_secret: await this.appleSecret(clientId), token, token_type_hint: 'refresh_token',
        }, undefined, true);
    }

    private async appleSecret(clientId: string): Promise<string> {
        const jose = await loadJose();
        const key = await jose.importPKCS8(this.config.apple.privateKey, 'ES256');
        return new jose.SignJWT({}).setProtectedHeader({ alg: 'ES256', kid: this.config.apple.keyId })
            .setIssuer(this.config.apple.teamId).setAudience('https://appleid.apple.com').setSubject(clientId)
            .setIssuedAt(Math.floor(this.now().getTime() / 1000)).setExpirationTime(Math.floor(this.now().getTime() / 1000) + 300).sign(key);
    }

    private async exchange(url: string, body: Record<string, string>, authorization?: string, empty = false): Promise<any> {
        let response: Response;
        try { response = await this.fetcher(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
            headers: { 'content-type': 'application/x-www-form-urlencoded', ...(authorization ? { authorization } : {}) }, body: new URLSearchParams(body) }); }
        catch { throw new ApiError(503, 'provider_unavailable', 'Сервис входа временно недоступен.'); }
        if (!response.ok) throw denied();
        if (empty) return {};
        const text = await response.text();
        if (text.length > 64 * 1024) throw denied();
        try { return JSON.parse(text); } catch { throw denied(); }
    }
}
