import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DataSource } from 'typeorm';
import { ApiError } from '../../api/contracts';
import { readBody } from '../../api/server';
import { digest, PlatformSecrets } from '../crypto';
import type { Account, AccountStore } from '../store';
import type { AccountRuntimes } from '../runtime';
import { AccountView, IdentityProvider } from './contracts';
import { loadConsentCatalog, PublicAccountConfig, publicAuthConfig } from './config';
import { OfficialIdentityVerifier,IdentityVerifier } from './providers';
import { OfficialAppProof,AppProofVerifier } from './proof';
import { AuthenticatedAccount, PublicIdentities } from './identities';
import { NativeSession, PublicSessions } from './sessions';
import { PublicLimits, publicClientAddress } from './limits';
import { PublicAccountPolicy } from './policy';
import { PublicReceipts } from './receipts';
import * as v from './validation';
import { PublicInbox } from './inbox';
import type { AccountDeletion } from './deletion';
import { ProviderSecurityEvents } from './securityEvents';
import { PublicComplaints,ownedReplyResolver } from './complaints';

type Json = (status: number, body: unknown) => void;
export class PublicAccountsHttp {
    readonly sessions: PublicSessions;
    readonly identities: PublicIdentities;
    readonly policy: PublicAccountPolicy;
    readonly limits: PublicLimits;
    readonly receipts: PublicReceipts;
    readonly inbox: PublicInbox;
    deletion?: AccountDeletion;
    readonly securityEvents:ProviderSecurityEvents;
    readonly complaints:PublicComplaints;
    constructor(readonly db: DataSource, private store: AccountStore, private secrets: PlatformSecrets,
        private runtimes: AccountRuntimes, readonly config: PublicAccountConfig,
        dependencies:{identityVerifier?:IdentityVerifier;proofVerifier?:AppProofVerifier}={}) {
        this.sessions = new PublicSessions(db, secrets);
        this.limits = new PublicLimits(db, secrets.derive('public-accounts', 'api'));
        this.receipts = new PublicReceipts(db);
        this.inbox = new PublicInbox(db,secrets);
        this.securityEvents=new ProviderSecurityEvents(db,config);
        this.complaints=new PublicComplaints(db,secrets,this.limits,ownedReplyResolver(db,secrets));
        this.policy = new PublicAccountPolicy(db, () => ({ ...config,
            ...(process.env.KIRA_PUBLIC_AI_CATALOG_FILE ? loadConsentCatalog(process.env.KIRA_PUBLIC_AI_CATALOG_FILE) : {}) }));
        this.identities = new PublicIdentities(db, store, secrets, this.sessions, config,
            dependencies.identityVerifier || new OfficialIdentityVerifier(config), dependencies.proofVerifier || new OfficialAppProof(db, config), this.limits);
    }

    async authLimit(req: IncomingMessage): Promise<string> {
        const ip = publicClientAddress(req, this.config.gateway.peers, this.config.gateway.secret);
        await this.limits.take(`public-auth-ip:${ip}`, 30, 60);
        return ip;
    }

    async publicRoute(req: IncomingMessage, res: ServerResponse, path: string, json: Json): Promise<boolean> {
        const event=path.match(/^\/api\/v1\/auth\/events\/(apple|google)$/);
        if(event){await this.authLimit(req);await this.securityEvents.request(req,event[1] as 'apple'|'google');json(202,{version:1,received:true});return true;}
        if (path === '/api/v1/accounts/register') throw new ApiError(410, 'registration_closed', 'Регистрация логином и паролем закрыта.');
        // Preserve the existing password-only clients on their existing endpoint.
        // Native provider/password routes always require proof; public signup is closed.
        if (!path.startsWith('/api/v1/auth/') || path === '/api/v1/auth/logout') return false;
        const known = path === '/api/v1/auth/config' || ['/api/v1/auth/challenges','/api/v1/auth/refresh',
            '/api/v1/auth/apple','/api/v1/auth/google','/api/v1/auth/telegram','/api/v1/auth/password'].includes(path);
        if (!known) return false;
        const ip = await this.authLimit(req);
        if (path === '/api/v1/auth/config' && req.method === 'GET') { req.resume(); json(200, publicAuthConfig(this.config)); return true; }
        if (req.method !== 'POST' || path === '/api/v1/auth/config') throw new ApiError(405, 'method_not_allowed', 'Недопустимый метод.');
        const body = await readBody(req);
        if (path === '/api/v1/auth/refresh') {
            v.fields(body, ['version','refreshToken','deviceId'], ['version','refreshToken','deviceId']); v.version(body);
            const pair = await this.sessions.rotate(v.text(body.refreshToken, 32, 128), v.uuid(body.deviceId), v.idempotency(req.headers['idempotency-key']));
            json(200, pair); return true;
        }
        const bearer = req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{32,128})$/i)?.[1];
        const auth = bearer ? await this.sessions.authenticate(bearer) : undefined;
        if (path === '/api/v1/auth/challenges') { json(200, await this.identities.challenge(body, auth,await this.limits.captchaRequired(`public-auth-ip:${ip}`))); return true; }
        const provider = path.split('/').pop() as IdentityProvider | 'password';
        const result = await this.identities.authenticate(provider, body, v.idempotency(req.headers['idempotency-key']), ip, auth);
        if (result.kind === 'login') {
            const account = await this.store.byId(result.accountId);
            if (!account) throw new ApiError(401, 'unauthorized', 'Войди в аккаунт ещё раз.');
            json(200, { ...result.pair, account: await this.view(account) });
        } else if (result.kind === 'reauthenticate') json(200, result.result);
        else json(200, result.identity);
        return true;
    }

    async view(account: Account): Promise<AccountView> {
        const state = account.account_state || 'active';
        const runtime = this.runtimes.status(account.id);
        const runtimeState = state === 'registered' ? 'not_activated' : runtime === 'ready' ? 'ready'
            : ['starting','restarting'].includes(runtime) ? 'starting' : runtime === 'waiting' ? 'queued' : 'unavailable';
        const consent = await this.policy.consent(account.id);
        return { id: account.id, username: account.username, accountState: state, runtimeState,
            runtimeMode: account.runtime_mode || 'telegram', isReady: state === 'active' && runtimeState === 'ready',
            autonomousAiEnabled: account.autonomous_ai_enabled ?? true,
            consent: { requiredVersion: consent.catalog.version, acceptedVersion: consent.acceptedVersion, aiAllowed: consent.aiAllowed },
            quota: await this.policy.quota(account.id),
            bot: account.bot_id ? { id: account.bot_id, username: account.bot_username, connected: Boolean(account.owner_id), status: runtime } : null };
    }

    async accountRoute(req: IncomingMessage, _res: ServerResponse, path: string, account: Account, session: NativeSession | undefined, json: Json): Promise<boolean> {
        if (path === '/api/v1/account' && req.method === 'GET') { json(200, { account: await this.view(account) }); return true; }
        if (path === '/api/v1/account/quota' && req.method === 'GET') { json(200, { version: 1, quota: await this.policy.quota(account.id) }); return true; }
        if (path === '/api/v1/account/consents' && req.method === 'GET') { json(200, await this.policy.consent(account.id)); return true; }
        if (path === '/api/v1/account/identities' && req.method === 'GET') { json(200, { version: 1, identities: await this.identities.list(account.id) }); return true; }
        if (path === '/api/v1/account/sessions' && req.method === 'GET') { json(200, { version: 1, sessions: await this.sessions.list(account.id, session?.id || '') }); return true; }
        if(path==='/api/v1/notifications' && req.method==='GET'){
            const query=new URL(req.url || '/','http://localhost').searchParams;
            if([...query.keys()].some(k=>!['limit','cursor'].includes(k)))v.invalid();
            json(200,await this.inbox.list(account.id,Number(query.get('limit') || 20),query.get('cursor') || undefined));return true;
        }
        const sessionMatch = path.match(/^\/api\/v1\/account\/sessions\/([0-9a-f-]{36})$/i);
        const identityMatch = path.match(/^\/api\/v1\/account\/identities\/([0-9a-f-]{36})$/i);
        const pushMatch=path.match(/^\/api\/v1\/account\/push-devices\/([0-9a-f-]{36})$/i);
        const readMatch=path.match(/^\/api\/v1\/notifications\/([0-9a-f-]{36})\/read$/i);
        const pushBind=path==='/api/v1/account/push-devices' && req.method==='PUT';
        const deleting=path==='/api/v1/account' && req.method==='DELETE';
        const complaint=path==='/api/v1/account/complaints' && req.method==='POST';
        const mutation = (path === '/api/v1/auth/logout' && req.method === 'POST')
            || (path === '/api/v1/account/consents' && req.method === 'PUT')
            || (path === '/api/v1/account/activate' && req.method === 'POST')
            || ((sessionMatch || identityMatch || pushMatch) && req.method === 'DELETE') || deleting || complaint || pushBind || (readMatch && req.method==='POST');
        if (!mutation) return false;
        const body = await readBody(req); v.version(body);
        if (identityMatch || path === '/api/v1/auth/logout' || pushBind || deleting) {
            if (!session) throw new ApiError(409, 'reauthentication_required', 'Используй вход в приложении с обновляемой сессией.');
        }
        if (path !== '/api/v1/account/consents' && !pushBind && !deleting && !complaint) v.fields(body, identityMatch ? ['version','reauthenticationToken'] : ['version'], identityMatch ? ['version','reauthenticationToken'] : ['version']);
        if (path === '/api/v1/account/activate') await this.limits.take(`activation:${account.id}`, 10, 900);
        const result = await this.receipts.run(account.id, v.idempotency(req.headers['idempotency-key']), req.method!, path, body, async () => {
            if (path === '/api/v1/account/consents') return this.policy.setConsent(account.id, body);
            if(deleting){if(!this.deletion)throw new ApiError(503,'feature_unavailable','Удаление хранилищ ещё не настроено.');return this.deletion.request({account,session:session!},body);}
            if(complaint)return this.complaints.report(account,body);
            if(pushBind){await this.inbox.bind(account.id,session!,body);return {version:1,registered:true};}
            if(pushMatch){await this.inbox.unbind(account.id,v.uuid(pushMatch[1]));return {version:1,ok:true};}
            if(readMatch){await this.inbox.read(account.id,v.uuid(readMatch[1]));return {version:1,ok:true};}
            if (path === '/api/v1/auth/logout') await this.sessions.logout(account.id, session!.id);
            else if (sessionMatch) await this.sessions.logout(account.id, v.uuid(sessionMatch[1]));
            else if (identityMatch) await this.identities.unlink({ account, session: session! }, v.uuid(identityMatch[1]), v.text(body.reauthenticationToken, 32, 128));
            else if (path === '/api/v1/account/activate') {
                const activated = await this.db.transaction(async tx => {
                    const [fresh] = await tx.query(`SELECT * FROM kira_accounts WHERE id=$1
                        AND NOT EXISTS(SELECT 1 FROM kira_public_deletion_ledger l WHERE l.account_id=kira_accounts.id) FOR UPDATE`, [account.id]);
                    if (!fresh || ['deleting','deleted'].includes(fresh.account_state)) throw new ApiError(403, 'account_deleting', 'Аккаунт удаляется.');
                    if (fresh.account_state === 'restricted') throw new ApiError(403, 'account_restricted', 'Аккаунт ограничен.');
                    if(fresh.runtime_mode==='telegram' && !fresh.owner_id){
                        if(fresh.bot_id || fresh.secrets)throw new ApiError(409,'activation_required','Сначала заверши начатое подключение Telegram-бота.');
                        // An old password-only row has no tenant/bot resources to migrate.
                        await tx.query(`UPDATE kira_accounts SET account_state='active',runtime_mode='api_only',
                            runtime_principal=COALESCE(runtime_principal,nextval('kira_runtime_principals')),autonomous_ai_enabled=false,secrets=$2 WHERE id=$1`,
                            [account.id,this.secrets.seal({runtimeMode:'api_only'},account.id)]);
                    }else if (fresh.account_state === 'registered') {
                        if (fresh.runtime_mode !== 'api_only') throw new ApiError(409, 'activation_required', 'Заверши подключение аккаунта.');
                        await tx.query(`UPDATE kira_accounts SET account_state='active',secrets=$2 WHERE id=$1`, [account.id, this.secrets.seal({ runtimeMode: 'api_only' }, account.id)]);
                    }
                    return (await tx.query('SELECT * FROM kira_accounts WHERE id=$1', [account.id]))[0] as Account;
                });
                return { version: 1, account: await this.view(activated) };
            }
            return { version: 1, ok: true };
        });
        json(path === '/api/v1/account/activate' || deleting || complaint ? 202 : 200, result); return true;
    }
}
