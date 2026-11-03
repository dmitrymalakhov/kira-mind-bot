import { X509Certificate } from 'node:crypto';
import * as cbor from 'cbor';
import type { DataSource } from 'typeorm';
import { ApiError } from '../../api/contracts';
import { digest } from '../crypto';
import { AppProof, ProviderLoginInput, PUBLIC_ACCOUNTS_CONTRACT, CaptchaRequirement } from './contracts';
import { PublicAccountConfig } from './config';
import { loadAppAttest } from './cryptoModules';
import { fields, object, text } from './validation';

export function proofPayload(provider: string, input: Omit<ProviderLoginInput, 'proof'> & { username?: string; password?: string }, challenge: string): string {
    const parts = provider === 'password'
        ? [input.username?.toLowerCase() || '', input.password || '', '']
        : [input.identityToken || '', input.authorizationCode || '', input.codeVerifier || ''];
    return [PUBLIC_ACCOUNTS_CONTRACT, 'POST', `/api/v1/auth/${provider}`, input.challengeId, challenge, input.deviceId, input.state, ...parts.map(digest)].join('\n');
}

export interface AppProofVerifier { verify(proof: AppProof, deviceId: string, challenge: string, payload: string, publicIp: string): Promise<void> }
export class CaptchaRequiredError extends ApiError{
    readonly proofRequirement:CaptchaRequirement;
    constructor(config:PublicAccountConfig,challengeId:string){
        super(403,'captcha_required','Нужна проверка hCaptcha.');
        if(!config.captcha.siteKey || !config.captcha.baseUrl || !config.captcha.hostname)throw new ApiError(503,'proof_unavailable','Проверка hCaptcha не настроена.');
        this.proofRequirement={type:'hcaptcha',reason:'risk',challengeId,siteKey:config.captcha.siteKey,baseUrl:config.captcha.baseUrl,hostname:config.captcha.hostname};
    }
}
export class OfficialAppProof implements AppProofVerifier {
    constructor(private db: DataSource, private config: PublicAccountConfig, private fetcher: typeof fetch = fetch,
        private now = () => new Date()) {}

    async verify(proof: AppProof, deviceId: string, challenge: string, payload: string, publicIp: string): Promise<void> {
        const input = object(proof);
        if (input.type === 'hcaptcha') {
            fields(input, ['type', 'token', 'reason'], ['type', 'token', 'reason']);
            if (!['unsupported', 'temporarily_unavailable', 'risk'].includes(String(input.reason))) this.denied();
            return this.captcha(text(input.token, 1, 16_384), publicIp);
        }
        if (input.type !== 'app_attest') this.denied();
        fields(input, ['type', 'keyId', 'attestation', 'assertion'], ['type', 'keyId', 'assertion']);
        if (!this.config.app.bundleId || !this.config.app.teamId) throw new ApiError(503, 'proof_unavailable', 'Проверка приложения недоступна.');
        const keyId = text(input.keyId, 40, 128);
        if (this.bytes(keyId).length !== 32) this.denied();
        const assertion = this.bytes(input.assertion);
        try {
            const library = await loadAppAttest();
            await this.db.transaction(async tx => {
                const keyHash = digest(keyId);
                // Serializes first registration as well as subsequent assertion counters.
                await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`app-attest:${keyHash}`]);
                let [stored] = await tx.query('SELECT * FROM kira_public_app_keys WHERE key_hash=$1 FOR UPDATE', [keyHash]);
                if (!stored) {
                    // No authenticated state is reset here. The consumed auth challenge must be
                    // replaced, and Apple requires a fresh key for a new attestation attempt.
                    if (!input.attestation) throw new ApiError(403, 'app_attest_key_unknown', 'Начни вход заново с новым ключом App Attest.');
                    const attestation = this.bytes(input.attestation);
                    const decoded = cbor.decodeAllSync(attestation);
                    if (decoded.length !== 1 || decoded[0]?.attStmt?.x5c?.length !== 2) this.denied();
                    // The upstream protocol verifier checks signatures/pinned Apple root. Also enforce certificate validity dates.
                    for (const der of decoded[0].attStmt.x5c) {
                        const cert = new X509Certificate(der);
                        if (Date.parse(cert.validFrom) > this.now().getTime() || Date.parse(cert.validTo) <= this.now().getTime()) this.denied();
                    }
                    const result = library.verifyAttestation({ attestation, challenge, keyId,
                        bundleIdentifier: this.config.app.bundleId, teamIdentifier: this.config.app.teamId,
                        allowDevelopmentEnvironment: this.config.app.environment === 'development' });
                    if (result.environment !== this.config.app.environment) this.denied();
                    stored = { public_key: result.publicKey, sign_count: 0, device_id: deviceId, environment: result.environment };
                    await tx.query(`INSERT INTO kira_public_app_keys(key_hash,device_id,public_key,environment,sign_count) VALUES($1,$2,$3,$4,0)`,
                        [keyHash, deviceId, result.publicKey, result.environment]);
                } else if (input.attestation || stored.device_id !== deviceId || stored.environment !== this.config.app.environment) this.denied();
                const { signCount } = library.verifyAssertion({ assertion, payload, publicKey: stored.public_key,
                    bundleIdentifier: this.config.app.bundleId, teamIdentifier: this.config.app.teamId, signCount: Number(stored.sign_count) });
                await tx.query('UPDATE kira_public_app_keys SET sign_count=$2 WHERE key_hash=$1', [keyHash, signCount]);
            });
        } catch (error) {
            if (error instanceof ApiError) throw error;
            this.denied(); // Invalid crypto is terminal, never hCaptcha fallback.
        }
    }

    private async captcha(token: string, publicIp: string): Promise<void> {
        const cfg = this.config.captcha;
        if (!cfg.siteKey || !cfg.secret || !cfg.hostname) throw new ApiError(503, 'proof_unavailable', 'Проверка приложения недоступна.');
        let response: Response;
        try { response = await this.fetcher('https://api.hcaptcha.com/siteverify', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ secret: cfg.secret, response: token, sitekey: cfg.siteKey, remoteip: publicIp }) }); }
        catch { throw new ApiError(503, 'proof_unavailable', 'Проверка приложения временно недоступна.'); }
        if (!response.ok) throw new ApiError(503, 'proof_unavailable', 'Проверка приложения временно недоступна.');
        let value: any;
        try { const body = await response.text(); if (body.length > 16_384) this.denied(); value = JSON.parse(body); } catch { this.denied(); }
        const stamp = Date.parse(value.challenge_ts);
        if (value.success !== true || value.hostname !== cfg.hostname || !Number.isFinite(stamp)
            || stamp > this.now().getTime() + 5000 || this.now().getTime() - stamp > 120_000) this.denied();
        const rows = await this.db.query(`INSERT INTO kira_public_proof_tokens(token_hash,expires_at) VALUES($1,$2)
            ON CONFLICT DO NOTHING RETURNING token_hash`, [digest(token), new Date(this.now().getTime() + 300_000)]);
        if (!rows.length) this.denied();
    }
    private bytes(value: unknown): Buffer {
        const encoded = text(value, 1, 32_768);
        if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return this.denied();
        const decoded = Buffer.from(encoded, 'base64');
        if (!decoded.length || decoded.toString('base64') !== encoded) return this.denied();
        return decoded;
    }
    private denied(): never { throw new ApiError(403, 'app_proof_invalid', 'Не удалось проверить приложение.'); }
}
