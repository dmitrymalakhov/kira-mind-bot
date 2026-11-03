import { randomUUID } from 'node:crypto';
import type { DataSource, EntityManager } from 'typeorm';
import { ApiError } from '../../api/contracts';
import { checkPassword, digest, newToken, passwordHash, PlatformSecrets } from '../crypto';
import type { Account, AccountStore } from '../store';
import { PublicAccountConfig, publicAuthConfig } from './config';
import type { AuthChallenge, ChallengeInput, IdentityProvider, IdentityView, PasswordLoginInput, ProviderLoginInput, ReauthenticationReply, TokenPair } from './contracts';
import { AppProofVerifier, proofPayload, CaptchaRequiredError } from './proof';
import { IdentityVerifier, VerifiedIdentity } from './providers';
import { NativeSession, PublicSessions, revokeSession } from './sessions';
import { PublicLimits } from './limits';
import * as v from './validation';

export interface AuthenticatedAccount { account: Account; session: NativeSession }
interface ChallengeRow {
    id: string; provider: IdentityProvider | 'password'; purpose: 'login' | 'link' | 'reauthenticate'; device_id: string;
    account_id: string | null; session_id: string | null; challenge: string; nonce: string; state_hash: string;
    code_challenge: string | null; grant_hash: string | null; expires_at: Date; consumed_at: Date | null;
    request_key_hash: string | null; fingerprint: string | null; result_encrypted: string | null; created_at: Date;
    captcha_required:boolean;accepted_app_request_hash:string|null;
}
export type IdentityAuthResult = { kind: 'login'; pair: TokenPair; accountId: string }
    | { kind: 'reauthenticate'; result: ReauthenticationReply }
    | { kind: 'link'; identity: IdentityView };
const noChallenge = () => new ApiError(401, 'challenge_invalid', 'Начни вход заново.');
const noCredentials = () => new ApiError(401, 'invalid_credentials', 'Не удалось подтвердить вход.');
class IdentityOwnerChanged extends Error {}

export async function consumeReauthentication(tx: EntityManager, accountId: string, sessionId: string, token: string, now: Date): Promise<void> {
    const rows = await tx.query(`UPDATE kira_public_reauthentication SET consumed_at=$4
        WHERE token_hash=$1 AND account_id=$2 AND session_id=$3 AND expires_at>$4 AND consumed_at IS NULL RETURNING token_hash`,
    [digest(token), accountId, sessionId, now]);
    if (!rows[0]?.length) throw new ApiError(409, 'reauthentication_required', 'Подтверди вход в аккаунт ещё раз.');
}

export class PublicIdentities {
    private dummyHash = passwordHash(newToken());
    constructor(private db: DataSource, private store: AccountStore, private secrets: PlatformSecrets,
        private sessions: PublicSessions, private config: PublicAccountConfig, private verifier: IdentityVerifier,
        private proof: AppProofVerifier, private limits: PublicLimits, private now = () => new Date()) {}

    async challenge(raw: Record<string, unknown>, auth?: AuthenticatedAccount,risk=false): Promise<AuthChallenge> {
        v.fields(raw, ['version', 'provider', 'purpose', 'deviceId', 'codeChallenge', 'codeChallengeMethod', 'reauthenticationToken'], ['version','provider','purpose','deviceId']);
        v.version(raw);
        if (!['apple','google','telegram','password'].includes(String(raw.provider)) || !['login','link','reauthenticate'].includes(String(raw.purpose))) v.invalid();
        const input = raw as unknown as ChallengeInput;
        const device = v.uuid(input.deviceId);
        if (input.provider !== 'password' && !publicAuthConfig(this.config).providers.find(p => p.provider === input.provider)?.available) {
            throw new ApiError(503, 'provider_unavailable', 'Этот способ входа ещё не настроен.');
        }
        if (input.provider === 'telegram') {
            if (input.codeChallengeMethod !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(v.text(input.codeChallenge, 43, 43))) v.invalid();
        } else if (input.codeChallenge !== undefined || input.codeChallengeMethod !== undefined) v.invalid();
        if (input.purpose !== 'login' && (!auth || auth.session.device_id !== device)) throw new ApiError(401, 'unauthorized', 'Нужна сессия этого устройства.');
        if (input.purpose === 'link' && input.provider === 'password') v.invalid();
        if (input.purpose === 'link') v.text(input.reauthenticationToken, 32, 128);
        else if (input.reauthenticationToken !== undefined) v.invalid();
        const id = randomUUID(), challenge = newToken(), nonce = newToken(), state = newToken();
        const expiry = new Date(this.now().getTime() + 300_000);
        await this.db.transaction(async tx => {
            if (auth && input.purpose !== 'login') await this.checkSession(tx, auth);
            if (input.purpose === 'link') {
                const [grant] = await tx.query(`SELECT token_hash FROM kira_public_reauthentication
                    WHERE token_hash=$1 AND account_id=$2 AND session_id=$3 AND consumed_at IS NULL AND expires_at>$4`,
                [digest(input.reauthenticationToken!), auth!.account.id, auth!.session.id, this.now()]);
                if (!grant) throw new ApiError(409, 'reauthentication_required', 'Подтверди текущий аккаунт.');
            }
            if(input.provider==='telegram'){
                const rows=await tx.query(`INSERT INTO kira_public_pkce_bindings(challenge_hash,challenge_id,created_at) VALUES($1,$2,$3)
                    ON CONFLICT DO NOTHING RETURNING challenge_id`,[input.codeChallenge,id,this.now()]);
                if(!rows.length)throw new ApiError(409,'pkce_reused','Начни новый вход с новым PKCE verifier.');
            }
            await tx.query(`INSERT INTO kira_public_challenges(id,provider,purpose,device_id,account_id,session_id,challenge,nonce,state_hash,code_challenge,grant_hash,expires_at,created_at,captcha_required)
                VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
            [id, input.provider, input.purpose, device, input.purpose === 'login' ? null : auth!.account.id,
                input.purpose === 'login' ? null : auth!.session.id, challenge, nonce, digest(state), input.codeChallenge || null,
                input.reauthenticationToken ? digest(input.reauthenticationToken) : null, expiry, this.now(),risk]);
        });
        const result: AuthChallenge = { version: 1, challengeId: id, challenge, nonce, state, expiresAt: expiry.toISOString(),
            proofRequirement: risk ? {mode:'hcaptcha',reason:'risk'} : {mode:'app_attest_or_hcaptcha',reason:null} };
        if (input.provider === 'telegram') {
            const url = new URL('https://oauth.telegram.org/auth');
            url.search = new URLSearchParams({ client_id: this.config.telegram.clientId, redirect_uri: this.config.telegram.redirectUri,
                response_type: 'code', scope: 'openid profile', state, nonce, code_challenge: input.codeChallenge!, code_challenge_method: 'S256' }).toString();
            result.authorizationUrl = url.href;
        }
        return result;
    }

    async authenticate(provider: IdentityProvider | 'password', raw: Record<string, unknown>, key: string, ip: string, auth?: AuthenticatedAccount): Promise<IdentityAuthResult> {
        const common = ['version','challengeId','state','deviceId','deviceName','proof'];
        v.fields(raw, [...common, ...(provider === 'password' ? ['username','password'] : ['identityToken','authorizationCode','codeVerifier'])], common);
        v.version(raw); v.uuid(raw.challengeId); const deviceId=v.uuid(raw.deviceId); v.text(raw.deviceName, 1, 100); v.text(raw.state, 32, 128);
        if (provider === 'password') { v.text(raw.username, 3, 40); v.text(raw.password, 12, 256); }
        else {
            if (provider !== 'telegram') v.text(raw.identityToken, 1, 20_000);
            if (provider !== 'google') v.text(raw.authorizationCode, 1, 4096);
            if (provider === 'telegram') {
                if (raw.identityToken !== undefined || !/^[A-Za-z0-9._~-]{43,128}$/.test(v.text(raw.codeVerifier, 43, 128))) v.invalid();
            } else if (raw.codeVerifier !== undefined || (provider === 'google' && raw.authorizationCode !== undefined)) v.invalid();
        }
        v.object(raw.proof);
        const input = raw as unknown as ProviderLoginInput;
        const fingerprint = digest(v.canonicalJson({ provider, body: raw }));
        const [preflight]:ChallengeRow[]=await this.db.query('SELECT * FROM kira_public_challenges WHERE id=$1',[input.challengeId]);
        const risk=Boolean(preflight?.captcha_required) || await this.limits.captchaRequired(`public-auth-ip:${ip}`);
        if(preflight && !preflight.consumed_at && risk && input.proof.type==='app_attest'){
            if(preflight.provider!==provider || preflight.device_id!==deviceId || preflight.state_hash!==digest(input.state)
                || new Date(preflight.expires_at)<=this.now() || (preflight.purpose!=='login' && (preflight.account_id!==auth?.account.id || preflight.session_id!==auth?.session.id)))throw noChallenge();
            if(preflight.accepted_app_request_hash!==fingerprint){
                try{await this.proof.verify(input.proof,deviceId,preflight.challenge,proofPayload(provider,input,preflight.challenge),ip);}
                catch(error){
                    if(error instanceof ApiError && ['app_proof_invalid','app_attest_key_unknown'].includes(error.code))await this.db.query(`UPDATE kira_public_challenges SET consumed_at=$2,request_key_hash=$3,fingerprint=$4,result_encrypted=$5 WHERE id=$1 AND consumed_at IS NULL`,
                        [preflight.id,this.now(),digest(key),fingerprint,this.secrets.seal({error:{status:error.status,code:error.code,message:error.message}},`challenge:${preflight.id}`)]);
                    throw error;
                }
                await this.db.query('UPDATE kira_public_challenges SET accepted_app_request_hash=$2 WHERE id=$1 AND consumed_at IS NULL',[preflight.id,fingerprint]);
            }
            throw new CaptchaRequiredError(this.config,preflight.id);
        }
        const claimed = await this.db.transaction(async tx => {
            const [c]: ChallengeRow[] = await tx.query('SELECT * FROM kira_public_challenges WHERE id=$1 FOR UPDATE', [input.challengeId]);
            if (!c || c.provider !== provider || c.device_id !== deviceId || c.state_hash !== digest(input.state)
                || (c.purpose!=='login' && c.account_id && (c.account_id !== auth?.account.id || c.session_id !== auth?.session.id))) throw noChallenge();
            if(provider==='telegram'){
                const [binding]=await tx.query('SELECT challenge_id FROM kira_public_pkce_bindings WHERE challenge_hash=$1',[c.code_challenge]);
                if(binding?.challenge_id!==c.id)throw noChallenge();
            }
            if (c.consumed_at) {
                if (c.request_key_hash !== digest(key)) throw noChallenge();
                if (c.fingerprint !== fingerprint) throw new ApiError(409, 'idempotency_conflict', 'Запрос с этим ключом уже отличается.');
                if (!c.result_encrypted) throw new ApiError(409, 'operation_uncertain', 'Исход входа не подтверждён. Начни новый вход.');
                if (this.now().getTime() - new Date(c.consumed_at).getTime() > 120_000) throw noChallenge();
                const saved = this.secrets.open<{ result?: IdentityAuthResult; error?: { status: number; code: string; message: string } }>(c.result_encrypted, `challenge:${c.id}`);
                if (saved.error) throw new ApiError(saved.error.status, saved.error.code, saved.error.message);
                if (saved.result?.kind === 'login') {
                    const [s] = await tx.query('SELECT generation,revoked_at,access_expires_at FROM kira_public_sessions WHERE id=$1', [saved.result.pair.sessionId]);
                    if (!s || s.revoked_at || Number(s.generation) !== 0 || new Date(s.access_expires_at) <= this.now()) throw noChallenge();
                }
                return { replay: saved.result! };
            }
            if (new Date(c.expires_at) <= this.now()) throw noChallenge();
            if (auth && c.purpose !== 'login') await this.checkSession(tx, auth);
            await tx.query(`UPDATE kira_public_challenges SET consumed_at=$2,request_key_hash=$3,fingerprint=$4 WHERE id=$1`,
                [c.id, this.now(), digest(key), fingerprint]);
            return { challenge: c };
        });
        if (claimed.replay) return claimed.replay;
        const c = claimed.challenge!;
        try {
            await this.proof.verify(input.proof, deviceId, c.challenge, proofPayload(provider, input, c.challenge), ip);
            let identity: VerifiedIdentity | { provider: 'password'; subject: string };
            if (provider === 'password') identity = await this.password(raw as unknown as PasswordLoginInput);
            else identity = await this.verifier.verify(provider, input, c);
            const finish = () => this.db.transaction(async tx => {
                // Account -> identity is shared with unlink and legacy password issuance.
                // Looking up the immutable owner without a row lock avoids the inverse
                // identity -> account wait that could deadlock with unlink.
                const [known] = await tx.query('SELECT account_id FROM kira_public_identities WHERE provider=$1 AND subject=$2', [identity.provider, identity.subject]);
                const lockedAccountId = c.purpose === 'login' ? known?.account_id : c.account_id;
                if (lockedAccountId) await tx.query('SELECT id FROM kira_accounts WHERE id=$1 FOR UPDATE', [lockedAccountId]);
                if (auth && c.purpose !== 'login') await this.checkSession(tx, auth);
                await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`identity:${identity.provider}:${identity.subject}`]);
                let [linked] = await tx.query('SELECT * FROM kira_public_identities WHERE provider=$1 AND subject=$2 FOR UPDATE', [identity.provider, identity.subject]);
                // A concurrent first login may have created the identity after our lookup.
                // Roll back and retry only this database phase with the newly known
                // owner, without repeating provider exchange or application proof.
                if (c.purpose === 'login' && linked && linked.account_id !== lockedAccountId) throw new IdentityOwnerChanged();
                let result: IdentityAuthResult;
                if (c.purpose === 'reauthenticate') {
                    if (!linked || linked.account_id !== c.account_id || linked.revoked_at) throw noCredentials();
                    const token = newToken(), expires = new Date(this.now().getTime() + 300_000);
                    await tx.query('INSERT INTO kira_public_reauthentication(token_hash,account_id,session_id,expires_at) VALUES($1,$2,$3,$4)',
                        [digest(token), c.account_id, c.session_id, expires]);
                    result = { kind: 'reauthenticate', result: { version: 1, reauthenticationToken: token, expiresAt: expires.toISOString() } };
                } else if (c.purpose === 'link') {
                    const grants = await tx.query(`UPDATE kira_public_reauthentication SET consumed_at=$4
                        WHERE token_hash=$1 AND account_id=$2 AND session_id=$3 AND consumed_at IS NULL AND expires_at>$4 RETURNING token_hash`,
                    [c.grant_hash, c.account_id, c.session_id, this.now()]);
                    if (!grants[0]?.length) throw new ApiError(409, 'reauthentication_required', 'Подтверди текущий аккаунт.');
                    if (linked && linked.account_id !== c.account_id) throw new ApiError(409, 'identity_conflict', 'Этот способ входа уже связан с другим аккаунтом.');
                    if (!linked) linked = await this.link(tx, c.account_id!, identity);
                    else await tx.query('UPDATE kira_public_identities SET revoked_at=NULL,revocation_reason=NULL WHERE id=$1', [linked.id]);
                    result = { kind: 'link', identity: this.view(linked) };
                } else {
                    if (linked?.revoked_at){
                        if(linked.revocation_reason!=='provider')throw noCredentials();
                        await tx.query('UPDATE kira_public_identities SET revoked_at=NULL,revocation_reason=NULL WHERE id=$1',[linked.id]);
                    }
                    if (!linked) {
                        if (identity.provider === 'password' || !publicAuthConfig(this.config).publicRegistration) throw noCredentials();
                        await tx.query('SELECT pg_advisory_xact_lock(706283005)');
                        const [{ count }] = await tx.query("SELECT count(*) FROM kira_accounts WHERE account_state <> 'deleted'");
                        if (Number(count) >= this.config.maxAccounts) throw new ApiError(503, 'capacity_reached', 'Регистрация временно недоступна.');
                        const id = randomUUID();
                        await tx.query(`INSERT INTO kira_accounts(id,username,password_hash,account_state,runtime_mode,runtime_principal,public_origin,autonomous_ai_enabled)
                            VALUES($1,$2,'disabled','registered','api_only',nextval('kira_runtime_principals'),true,false)`, [id, `user_${id.replace(/-/g, '')}`]);
                        linked = await this.link(tx, id, identity);
                    }
                    const pair = await this.sessions.issue(tx, linked.account_id, linked.id, deviceId, input.deviceName);
                    result = { kind: 'login', pair, accountId: linked.account_id };
                }
                if ('revocationToken' in identity && identity.revocationToken) {
                    await tx.query('UPDATE kira_public_identities SET credential_encrypted=$2 WHERE id=$1',
                        [linked.id, this.secrets.seal({ token: identity.revocationToken, clientId: identity.clientId }, `identity:${linked.id}`)]);
                }
                await tx.query('UPDATE kira_public_identities SET last_used_at=$2 WHERE id=$1', [linked.id, this.now()]);
                await tx.query('UPDATE kira_public_challenges SET result_encrypted=$2,account_id=$3,session_id=$4 WHERE id=$1',
                    [c.id, this.secrets.seal({ result }, `challenge:${c.id}`),linked.account_id,result.kind==='login'?result.pair.sessionId:c.session_id]);
                return result;
            });
            for (let attempt = 0; ; attempt++) {
                try { return await finish(); }
                catch (error) {
                    if (!(error instanceof IdentityOwnerChanged)) throw error;
                    if (attempt >= 2) throw noChallenge();
                }
            }
        } catch (error) {
            const safe = error instanceof ApiError ? error : new ApiError(500, 'internal_error', 'Не удалось выполнить вход.');
            await this.db.query('UPDATE kira_public_challenges SET result_encrypted=$2 WHERE id=$1 AND result_encrypted IS NULL',
                [c.id, this.secrets.seal({ error: { status: safe.status, code: safe.code, message: safe.message } }, `challenge:${c.id}`)]);
            throw safe;
        }
    }

    async list(accountId: string): Promise<IdentityView[]> {
        return (await this.db.query('SELECT * FROM kira_public_identities WHERE account_id=$1 AND revoked_at IS NULL ORDER BY linked_at,id', [accountId])).map((r: any) => this.view(r));
    }

    async unlink(auth: AuthenticatedAccount, identityId: string, reauthenticationToken: string): Promise<void> {
        await this.db.transaction(async tx => {
            await this.checkSession(tx, auth);
            await tx.query('SELECT id FROM kira_accounts WHERE id=$1 FOR UPDATE', [auth.account.id]);
            const rows = await tx.query('SELECT * FROM kira_public_identities WHERE account_id=$1 AND revoked_at IS NULL FOR UPDATE', [auth.account.id]);
            if (!rows.some((r: any) => r.id === identityId)) throw new ApiError(404, 'not_found', 'Способ входа не найден.');
            if (rows.length <= 1) throw new ApiError(409, 'last_identity', 'Сначала добавь другой способ входа.');
            await consumeReauthentication(tx, auth.account.id, auth.session.id, reauthenticationToken, this.now());
            await tx.query("UPDATE kira_public_identities SET revoked_at=$2,revocation_reason='user' WHERE id=$1", [identityId, this.now()]);
            for (const s of await tx.query('SELECT id FROM kira_public_sessions WHERE identity_id=$1', [identityId])) await revokeSession(tx, s.id);
            // Legacy password sessions are invalid once the corresponding method is removed.
            if (rows.find((r: any) => r.id === identityId).provider === 'password') await tx.query('DELETE FROM kira_account_sessions WHERE account_id=$1', [auth.account.id]);
        });
    }

    private async password(input: PasswordLoginInput): Promise<{ provider: 'password'; subject: string }> {
        const username = input.username.toLowerCase();
        const account = await this.store.byUsername(username);
        // Every username pays a KDF cost and an opaque per-name attempt window; no existence oracle.
        const ticket = await this.limits.reserve(`password-failure:${digest(username)}`, 5, 900);
        const valid = await checkPassword(input.password, account && account.password_hash !== 'disabled' ? account.password_hash : await this.dummyHash);
        if (!account || !valid || account.password_hash === 'disabled') throw noCredentials();
        await this.limits.refund(ticket);
        await this.db.query(`INSERT INTO kira_public_identities(id,account_id,provider,subject) VALUES($1,$1,'password',$2) ON CONFLICT(provider,subject) DO NOTHING`, [account.id, account.id]);
        return { provider: 'password', subject: account.id };
    }

    private async checkSession(tx: EntityManager, auth: AuthenticatedAccount): Promise<void> {
        const [valid] = await tx.query(`SELECT s.id FROM kira_public_sessions s JOIN kira_accounts a ON a.id=s.account_id
            WHERE s.id=$1 AND s.account_id=$2 AND s.revoked_at IS NULL AND s.access_expires_at>$3 AND s.refresh_expires_at>$3
            AND a.account_state NOT IN ('deleting','deleted') AND NOT EXISTS(SELECT 1 FROM kira_public_deletion_ledger l WHERE l.account_id=a.id)`, [auth.session.id, auth.account.id, this.now()]);
        if (!valid) throw new ApiError(401, 'unauthorized', 'Войди в аккаунт ещё раз.');
    }
    private async link(tx: EntityManager, accountId: string, identity: { provider: string; subject: string }): Promise<any> {
        const [row] = await tx.query('INSERT INTO kira_public_identities(id,account_id,provider,subject) VALUES($1,$2,$3,$4) RETURNING *', [randomUUID(), accountId, identity.provider, identity.subject]);
        return row;
    }
    private view(row: any): IdentityView {
        return { id: row.id, provider: row.provider, linkedAt: new Date(row.linked_at).toISOString(), lastUsedAt: row.last_used_at ? new Date(row.last_used_at).toISOString() : null };
    }
}
