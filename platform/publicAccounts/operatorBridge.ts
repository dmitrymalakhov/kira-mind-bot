import type { IncomingMessage } from 'node:http';
import type { DataSource } from 'typeorm';
import { ApiError } from '../../api/contracts';
import { readBody } from '../../api/server';
import { digest } from '../crypto';
import { PublicSessions } from './sessions';
import { consumeReauthentication } from './identities';
import type { PublicWebConfig } from './webConfig';
import { equalSecret } from './webCookies';
import * as v from './validation';

/** The bridge authenticates the operator SERVER, never an end-user role header. */
export class PublicOperatorBridge {
    constructor(private db: DataSource, private sessions: PublicSessions, private settings: PublicWebConfig) {}

    async authorized(accountId: string): Promise<boolean> {
        if (!this.settings.operatorEnabled) return false;
        return Boolean((await this.db.query('SELECT account_id FROM kira_public_operator_grants WHERE account_id=$1 AND revoked_at IS NULL', [accountId]))[0]);
    }

    // One statement gives session, identity, account, browser and role the same
    // PostgreSQL snapshot. A later role grant cannot authorize a revoked session
    // that was read earlier in this request.
    async introspect(access: string, browserCookie: string): Promise<{ version: 1; authorized: boolean; accountId?: string; sessionId?: string }> {
        if (!this.settings.operatorEnabled) return { version: 1, authorized: false };
        const [row] = await this.db.query(`SELECT a.id AS account_id,s.id AS session_id,g.account_id IS NOT NULL AS authorized
            FROM kira_public_sessions s JOIN kira_accounts a ON a.id=s.account_id
            JOIN kira_public_identities i ON i.id=s.identity_id
            JOIN kira_public_web_browsers b ON b.session_id=s.id AND b.account_id=a.id AND b.device_id=s.device_id
            LEFT JOIN kira_public_operator_grants g ON g.account_id=a.id AND g.revoked_at IS NULL
            WHERE s.access_hash=$1 AND b.cookie_hash=$2 AND b.expires_at>now()
            AND s.access_expires_at>now() AND s.refresh_expires_at>now() AND s.revoked_at IS NULL AND i.revoked_at IS NULL
            AND a.account_state NOT IN ('deleting','deleted')
            AND NOT EXISTS(SELECT 1 FROM kira_public_deletion_ledger l WHERE l.account_id=a.id)`, [digest(access), digest(browserCookie)]);
        return row ? { version: 1, authorized: row.authorized, accountId: row.account_id, sessionId: row.session_id } : { version: 1, authorized: false };
    }

    async setGrant(access: string, browserCookie: string, grant: string, confirmedAccountId: string, enabled: boolean): Promise<{ version: 1; accountId: string; operatorAccess: boolean }> {
        await this.db.transaction(async tx => {
            // Account first, then session, matching identity removal/deletion.
            // Session rotation/logout serialize on this exact session row.
            await tx.query('SELECT id FROM kira_accounts WHERE id=$1 FOR UPDATE', [confirmedAccountId]);
            const [bound] = await tx.query(`SELECT s.id FROM kira_public_sessions s
                JOIN kira_public_web_browsers b ON b.session_id=s.id AND b.account_id=s.account_id AND b.device_id=s.device_id
                WHERE s.account_id=$1 AND s.access_hash=$2 AND b.cookie_hash=$3 AND b.expires_at>now() FOR UPDATE OF s`,
                [confirmedAccountId, digest(access), digest(browserCookie)]);
            const fresh = bound && await this.sessions.authenticate(access, tx);
            if (!fresh || fresh.account.id !== confirmedAccountId || fresh.session.id !== bound.id) throw new ApiError(401, 'unauthorized', 'Подтверди вход именно в выбранную Киру.');
            await consumeReauthentication(tx, fresh.account.id, fresh.session.id, grant, new Date());
            if (enabled) await tx.query(`INSERT INTO kira_public_operator_grants(account_id,granted_by_session) VALUES($1,$2)
                ON CONFLICT(account_id) DO UPDATE SET granted_by_session=$2,granted_at=now(),revoked_at=NULL`, [fresh.account.id, fresh.session.id]);
            else await tx.query('UPDATE kira_public_operator_grants SET revoked_at=now() WHERE account_id=$1', [fresh.account.id]);
        });
        return { version: 1, accountId: confirmedAccountId, operatorAccess: enabled };
    }

    async route(req: IncomingMessage, path: string, json: (status: number, body: unknown) => void): Promise<boolean> {
        if (!['/internal/operator/session','/internal/operator/grants'].includes(path)) return false;
        if (!this.settings.operatorEnabled) throw new ApiError(404, 'not_found', 'Ресурс не найден.');
        const supplied = req.headers['x-kira-operator-bridge'];
        if (typeof supplied !== 'string' || !this.settings.operatorBridgeSecret || !equalSecret(supplied, this.settings.operatorBridgeSecret)) {
            throw new ApiError(401, 'unauthorized', 'Недопустимый служебный запрос.');
        }
        if (req.method !== 'POST') throw new ApiError(405, 'method_not_allowed', 'Недопустимый метод.');
        const body = await readBody(req);
        if (path === '/internal/operator/session') {
            v.fields(body, ['version','accessToken','browserCookie'], ['version','accessToken','browserCookie']); v.version(body);
            json(200, await this.introspect(v.text(body.accessToken, 32, 128), v.text(body.browserCookie, 32, 128)));
        } else {
            v.fields(body, ['version','accessToken','browserCookie','reauthenticationToken','confirmedAccountId','operation'], ['version','accessToken','browserCookie','reauthenticationToken','confirmedAccountId','operation']); v.version(body);
            if (!['grant','revoke'].includes(String(body.operation))) v.invalid();
            json(200, await this.setGrant(v.text(body.accessToken, 32, 128), v.text(body.browserCookie, 32, 128), v.text(body.reauthenticationToken, 32, 128), v.uuid(body.confirmedAccountId), body.operation === 'grant'));
        }
        return true;
    }
}
