import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DataSource } from 'typeorm';
import { ApiError } from '../../api/contracts';
import { digest, newToken, PlatformSecrets } from '../crypto';
import type { Account, AccountStore } from '../store';
import type { AccountView } from './contracts';
import { PublicAccountConfig } from './config';
import { AuthenticatedAccount, IdentityAuthResult, PublicIdentities } from './identities';
import { PublicSessions, revokeSession } from './sessions';
import { PublicLimits } from './limits';
import { OfficialIdentityVerifier, IdentityVerifier } from './providers';
import { OfficialAppProof, AppProofVerifier } from './proof';
import type { PublicWebConfig } from './webConfig';
import type { WebAuthReply, WebChallengeReply, WebProvider } from './webContracts';
import { WEB_ACCESS_COOKIE, WEB_BROWSER_COOKIE, WEB_REFRESH_COOKIE, clearBrowserCookie, clearWebCredentials,
    equalSecret, requireWebOrigin, setBrowserCookie, setWebCredentials, webCookie, webCsrfToken } from './webCookies';
import * as v from './validation';

export interface WebBrowser { cookie: string; hash: string; deviceId: string; accountId: string|null; sessionId: string|null }
interface FlowPrivate { state: string; verifier?: string; code?: string }
interface FlowRow {
    challenge_id: string; browser_hash: string; provider: WebProvider; purpose: 'login'|'reauthenticate'|'link';
    private_encrypted: string; callback_received: boolean; expires_at: Date; device_id: string;
    account_id: string|null; session_id: string|null; consumed_at: Date|null; result_encrypted: string|null;
}
export interface WebAuthDependencies {
    identityVerifierFactory?: (config: PublicAccountConfig) => IdentityVerifier;
    proofVerifier?: AppProofVerifier;
}
const expired = () => new ApiError(401, 'web_flow_invalid', 'Начни вход заново.');

/** Browser cookies carry the existing canonical access/rotating refresh pair. */
export class PublicWebAuth {
    readonly identities: PublicIdentities;
    private identityConfig: PublicAccountConfig;
    constructor(readonly db: DataSource, private store: AccountStore, private secrets: PlatformSecrets,
        readonly sessions: PublicSessions, private config: PublicAccountConfig, private limits: PublicLimits,
        readonly settings: PublicWebConfig, private view: (account: Account) => Promise<AccountView>, dependencies: WebAuthDependencies = {}) {
        if (settings.origin !== config.captcha.baseUrl) throw Error('Browser origin must match the configured CAPTCHA origin');
        this.identityConfig = { ...config, telegram: { ...config.telegram, redirectUri: settings.origin + '/api/v1/web/auth/telegram/callback' } };
        this.identities = new PublicIdentities(db, store, secrets, sessions, this.identityConfig,
            dependencies.identityVerifierFactory?.(this.identityConfig) || new OfficialIdentityVerifier(this.identityConfig),
            dependencies.proofVerifier || new OfficialAppProof(db, config), limits, () => new Date(), false);
    }

    async browser(req: IncomingMessage, res?: ServerResponse, create = false): Promise<WebBrowser> {
        let cookie = webCookie(req, WEB_BROWSER_COOKIE);
        if (cookie) {
            const [row] = await this.db.query('SELECT device_id,account_id,session_id FROM kira_public_web_browsers WHERE cookie_hash=$1 AND expires_at>now()', [digest(cookie)]);
            if (row) return { cookie, hash: digest(cookie), deviceId: row.device_id, accountId: row.account_id, sessionId: row.session_id };
        }
        if (!create || !res) throw expired();
        cookie = newToken();
        const deviceId = randomUUID(), expiry = new Date(Date.now() + 8 * 3600_000);
        await this.db.query('INSERT INTO kira_public_web_browsers(cookie_hash,device_id,expires_at) VALUES($1,$2,$3)', [digest(cookie), deviceId, expiry]);
        setBrowserCookie(res, cookie, expiry);
        return { cookie, hash: digest(cookie), deviceId, accountId: null, sessionId: null };
    }

    csrf(browser: WebBrowser): string { return webCsrfToken(browser.cookie, this.secrets.derive('web-csrf', 'api')); }
    requireCsrf(req: IncomingMessage, browser: WebBrowser): void {
        requireWebOrigin(req, this.settings.origin);
        const supplied = req.headers['x-csrf-token'];
        if (typeof supplied !== 'string' || !equalSecret(supplied, this.csrf(browser))) throw new ApiError(403, 'csrf_invalid', 'Открой страницу аккаунта и повтори действие.');
    }
    authenticate(req: IncomingMessage): Promise<AuthenticatedAccount|undefined> {
        const access = webCookie(req, WEB_ACCESS_COOKIE);
        return access ? this.sessions.authenticate(access) : Promise.resolve(undefined);
    }

    async challenge(browser: WebBrowser, body: Record<string, unknown>, auth?: AuthenticatedAccount): Promise<WebChallengeReply> {
        v.fields(body, ['version','provider','purpose','reauthenticationToken'], ['version','provider','purpose']); v.version(body);
        if (!['google','telegram','password'].includes(String(body.provider)) || !['login','reauthenticate','link'].includes(String(body.purpose))) v.invalid();
        if (body.purpose === 'login' && auth) throw new ApiError(409, 'already_authenticated', 'Добавь новый способ входа в настройках текущей Киры.');
        if (body.purpose !== 'login' && !auth) throw new ApiError(401, 'unauthorized', 'Войди в аккаунт ещё раз.');
        this.identityConfig.readyCapabilities = this.config.readyCapabilities;
        const provider = body.provider as WebProvider;
        const verifier = provider === 'telegram' ? randomBytes(48).toString('base64url') : undefined;
        const challenge = await this.identities.challenge({ ...body, deviceId: browser.deviceId,
            ...(verifier ? { codeChallenge: createHash('sha256').update(verifier).digest('base64url'), codeChallengeMethod: 'S256' } : {}) }, auth);
        const privateData: FlowPrivate = { state: challenge.state, ...(verifier ? { verifier } : {}) };
        await this.db.query(`INSERT INTO kira_public_web_flows(challenge_id,browser_hash,provider,purpose,private_encrypted,expires_at)
            VALUES($1,$2,$3,$4,$5,$6)`, [challenge.challengeId, browser.hash, provider, body.purpose,
            this.secrets.seal(privateData, `web-flow:${challenge.challengeId}`), challenge.expiresAt]);
        return { version: 1, flowId: challenge.challengeId, provider, purpose: body.purpose as WebChallengeReply['purpose'], nonce: challenge.nonce,
            expiresAt: challenge.expiresAt, ...(challenge.authorizationUrl ? { authorizationUrl: challenge.authorizationUrl } : {}), proofRequirement: { type: 'hcaptcha' } };
    }

    async pending(browser: WebBrowser, flowId?: string): Promise<unknown> {
        const [row] = await this.db.query(`SELECT w.challenge_id,w.provider,w.purpose,w.callback_received,c.result_encrypted,c.consumed_at,w.expires_at
            FROM kira_public_web_flows w JOIN kira_public_challenges c ON c.id=w.challenge_id
            WHERE w.browser_hash=$1 AND w.expires_at>now() AND ($2::uuid IS NULL OR w.challenge_id=$2)
            ORDER BY w.expires_at DESC LIMIT 1`, [browser.hash, flowId || null]);
        return { version: 1, pending: row ? { flowId: row.challenge_id, provider: row.provider, purpose: row.purpose,
            callbackReceived: row.callback_received, consumed: Boolean(row.consumed_at), outcomeAvailable: Boolean(row.result_encrypted), expiresAt: new Date(row.expires_at).toISOString() } : null };
    }

    async telegramCallback(browser: WebBrowser, query: URLSearchParams): Promise<void> {
        if ([...query.keys()].some(key => !['state','code','error','error_description'].includes(key) || query.getAll(key).length !== 1)
            || query.getAll('state').length !== 1 || (query.has('error') && query.has('code')) || (query.has('error_description') && !query.has('error'))) v.invalid();
        const state = v.text(query.get('state'), 32, 128);
        await this.db.transaction(async tx => {
            const [row] = await tx.query(`SELECT w.* FROM kira_public_web_flows w JOIN kira_public_challenges c ON c.id=w.challenge_id
                WHERE w.browser_hash=$1 AND w.provider='telegram' AND c.state_hash=$2 AND w.expires_at>now() FOR UPDATE OF w`, [browser.hash, digest(state)]);
            if (!row || row.callback_received) throw expired();
            if (query.has('error')) {
                await tx.query('DELETE FROM kira_public_web_flows WHERE challenge_id=$1', [row.challenge_id]);
                return;
            }
            if (query.getAll('code').length !== 1) v.invalid();
            const code = v.text(query.get('code'), 1, 4096);
            const privateData = this.secrets.open<FlowPrivate>(row.private_encrypted, `web-flow:${row.challenge_id}`);
            await tx.query('UPDATE kira_public_web_flows SET callback_received=true,private_encrypted=$2 WHERE challenge_id=$1',
                [row.challenge_id, this.secrets.seal({ ...privateData, code }, `web-flow:${row.challenge_id}`)]);
        });
    }

    private async flow(browser: WebBrowser, id: string): Promise<FlowRow> {
        const [row] = await this.db.query(`SELECT w.*,c.device_id,c.account_id,c.session_id,c.consumed_at,c.result_encrypted
            FROM kira_public_web_flows w JOIN kira_public_challenges c ON c.id=w.challenge_id
            WHERE w.challenge_id=$1 AND w.browser_hash=$2 AND w.expires_at>now()`, [id, browser.hash]);
        if (!row || row.device_id !== browser.deviceId) throw expired();
        return row;
    }

    private async recovered(flow: FlowRow, auth: AuthenticatedAccount|undefined): Promise<IdentityAuthResult> {
        if (!flow.result_encrypted || !flow.consumed_at || Date.now() - new Date(flow.consumed_at).getTime() > 120_000) {
            throw new ApiError(409, 'operation_uncertain', 'Результат не подтверждён. Проверь текущее состояние аккаунта или начни новый вход.');
        }
        const saved = this.secrets.open<{ result?: IdentityAuthResult; error?: { status: number; code: string; message: string } }>(flow.result_encrypted, `challenge:${flow.challenge_id}`);
        if (saved.error) throw new ApiError(saved.error.status, saved.error.code, saved.error.message);
        const result = saved.result!;
        if (!result || (flow.purpose === 'login' ? result.kind !== 'login' : result.kind !== flow.purpose)) throw expired();
        if (result.kind === 'login') {
            const verified = await this.sessions.authenticate(result.pair.accessToken);
            if (!verified || verified.account.id !== result.accountId || verified.session.device_id !== flow.device_id) throw expired();
            if (auth && auth.session.id !== verified.session.id) throw new ApiError(409, 'web_session_changed', 'Текущий вход уже изменился. Обнови страницу аккаунта.');
        } else {
            if (!auth || auth.account.id !== flow.account_id || auth.session.id !== flow.session_id) throw expired();
            if (result.kind === 'reauthenticate') {
                const [grant] = await this.db.query('SELECT token_hash FROM kira_public_reauthentication WHERE token_hash=$1 AND session_id=$2 AND consumed_at IS NULL AND expires_at>now()',
                    [digest(result.result.reauthenticationToken), auth.session.id]);
                if (!grant) throw new ApiError(409, 'reauthentication_required', 'Подтверди вход ещё раз.');
            } else if (!(await this.identities.list(auth.account.id)).some(identity => identity.id === result.identity.id)) throw expired();
        }
        return result;
    }

    async complete(browser: WebBrowser, provider: WebProvider, body: Record<string, unknown>, ip: string,
        res: ServerResponse, auth?: AuthenticatedAccount): Promise<WebAuthReply> {
        v.fields(body, ['version','flowId','identityToken','username','password','captchaToken'], ['version','flowId']); v.version(body);
        const flow = await this.flow(browser, v.uuid(body.flowId));
        if (flow.provider !== provider) throw expired();
        if (!flow.consumed_at && flow.purpose === 'login' && auth) throw new ApiError(409, 'web_session_changed', 'Текущий вход уже изменился. Обнови страницу аккаунта.');
        let result: IdentityAuthResult;
        if (flow.consumed_at && Object.keys(body).length === 2) result = await this.recovered(flow, auth);
        else {
            const secret = this.secrets.open<FlowPrivate>(flow.private_encrypted, `web-flow:${flow.challenge_id}`);
            if (provider === 'telegram' && (!flow.callback_received || !secret.code || !secret.verifier)) throw expired();
            if ((provider !== 'google' && body.identityToken !== undefined) || (provider !== 'password' && (body.username !== undefined || body.password !== undefined))) v.invalid();
            const input = { version: 1, challengeId: flow.challenge_id, state: secret.state, deviceId: browser.deviceId, deviceName: 'Web browser',
                ...(provider === 'google' ? { identityToken: v.text(body.identityToken, 1, 20_000) } : provider === 'password'
                    ? { username: v.text(body.username, 3, 40), password: v.text(body.password, 12, 256) }
                    : { authorizationCode: secret.code, codeVerifier: secret.verifier }),
                proof: { type: 'hcaptcha', reason: 'unsupported', token: v.text(body.captchaToken, 1, 16_384) } };
            // Only hashes/opaque credentials are persisted by the canonical auth
            // receipt. Google JWT/profile claims and CAPTCHA input are not stored.
            await this.identities.authenticate(provider, input,
                createHmac('sha256', this.secrets.derive('web-auth-receipt', 'api')).update(flow.challenge_id).digest('hex'), ip, auth);
            result = await this.recovered(await this.flow(browser, flow.challenge_id), auth);
        }
        if (result.kind !== 'login') return result.kind === 'link' ? result.identity : result.result;
        const checked = await this.sessions.authenticate(result.pair.accessToken);
        if (!checked || checked.account.id !== result.accountId) throw expired();
        const expiry = new Date(result.pair.refreshExpiresAt);
        const rows = await this.db.query(`UPDATE kira_public_web_browsers SET expires_at=$2,account_id=$3,session_id=$4
            WHERE cookie_hash=$1 AND (account_id IS NULL OR account_id=$3) RETURNING cookie_hash`, [browser.hash, expiry, checked.account.id, checked.session.id]);
        if (!rows[0]?.length) throw new ApiError(409, 'web_session_changed', 'Текущая Кира уже изменилась. Обнови страницу аккаунта.');
        setWebCredentials(res, result.pair);
        setBrowserCookie(res, browser.cookie, expiry);
        return { version: 1, account: await this.view(checked.account) };
    }

    async refresh(req: IncomingMessage, browser: WebBrowser, res: ServerResponse): Promise<void> {
        const refresh = webCookie(req, WEB_REFRESH_COOKIE);
        if (!refresh) { clearWebCredentials(res); throw new ApiError(401, 'refresh_invalid', 'Войди в аккаунт ещё раз.'); }
        const key = createHmac('sha256', this.secrets.derive('web-refresh-receipt', 'api')).update(browser.deviceId + '\n' + refresh).digest('hex');
        try {
            const pair = await this.sessions.rotate(refresh, browser.deviceId, key);
            const auth = await this.sessions.authenticate(pair.accessToken);
            if (!auth || auth.account.id !== browser.accountId) {
                if (auth) await this.sessions.logout(auth.account.id, auth.session.id);
                throw new ApiError(401, 'refresh_invalid', 'Войди в аккаунт ещё раз.');
            }
            setWebCredentials(res, pair);
            setBrowserCookie(res, browser.cookie, new Date(pair.refreshExpiresAt));
        } catch (error) { if (error instanceof ApiError && error.status === 401) clearWebCredentials(res); throw error; }
    }

    async logout(req: IncomingMessage, browser: WebBrowser, res: ServerResponse): Promise<void> {
        // Logout alone may use the exact server-recorded browser/session binding.
        // This remains useful after terminal refresh failure clears credentials;
        // it cannot read data, link identities, or revoke another session family.
        await this.db.transaction(async tx => {
            if (browser.accountId) await tx.query('SELECT id FROM kira_accounts WHERE id=$1 FOR UPDATE', [browser.accountId]);
            const [bound] = await tx.query('SELECT * FROM kira_public_web_browsers WHERE cookie_hash=$1 FOR UPDATE', [browser.hash]);
            if (!bound || bound.device_id !== browser.deviceId) throw expired();
            if (bound.account_id && bound.session_id) {
                const [session] = await tx.query(`SELECT id FROM kira_public_sessions WHERE id=$1 AND account_id=$2 AND device_id=$3 FOR UPDATE`,
                    [bound.session_id, bound.account_id, bound.device_id]);
                if (session) await revokeSession(tx, session.id);
            }
            await tx.query('DELETE FROM kira_public_web_browsers WHERE cookie_hash=$1', [browser.hash]);
        });
        clearWebCredentials(res); clearBrowserCookie(res);
    }
}
