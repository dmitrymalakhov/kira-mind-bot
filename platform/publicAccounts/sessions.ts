import { randomUUID } from 'node:crypto';
import type { DataSource, EntityManager } from 'typeorm';
import { ApiError } from '../../api/contracts';
import { digest, newToken, PlatformSecrets } from '../crypto';
import type { Account } from '../store';
import type { SessionView, TokenPair } from './contracts';

export const ACCESS_SECONDS = 900;
export const REFRESH_SECONDS = 30 * 24 * 3600;
const RETRY_MS = 120_000;
export interface NativeSession {
    id: string; account_id: string; identity_id: string; device_id: string; device_name: string;
    access_hash: string; access_expires_at: Date; refresh_expires_at: Date;
    generation: number; revoked_at: Date | null; created_at: Date; last_used_at: Date;
}
const invalid = () => new ApiError(401, 'refresh_invalid', 'Войди в аккаунт ещё раз.');

export async function revokeSession(tx: EntityManager, id: string): Promise<void> {
    await tx.query('UPDATE kira_public_sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1', [id]);
    await tx.query('DELETE FROM kira_public_push_devices WHERE session_id=$1', [id]);
    await tx.query("UPDATE kira_public_push_outbox SET state='cancelled',lease_until=NULL,lease_token=NULL WHERE session_id=$1 AND state IN ('pending','sending')", [id]);
    await tx.query('UPDATE kira_public_refresh SET replay_encrypted=NULL WHERE session_id=$1', [id]);
}

export class PublicSessions {
    constructor(private db: DataSource, private secrets: PlatformSecrets, private now = () => new Date()) {}

    async issue(tx: EntityManager, accountId: string, identityId: string, deviceId: string, deviceName: string): Promise<TokenPair> {
        const [account] = await tx.query(`SELECT id FROM kira_accounts WHERE id=$1 AND account_state NOT IN ('deleting','deleted')
            AND NOT EXISTS(SELECT 1 FROM kira_public_deletion_ledger l WHERE l.account_id=kira_accounts.id) FOR UPDATE`, [accountId]);
        if (!account) throw new ApiError(403, 'account_deleting', 'Аккаунт удаляется.');
        const now = this.now();
        const id = randomUUID(), access = newToken(), refresh = newToken();
        const expiry = new Date(now.getTime() + REFRESH_SECONDS * 1000);
        await tx.query(`INSERT INTO kira_public_sessions(id,account_id,identity_id,device_id,device_name,access_hash,access_expires_at,refresh_expires_at,created_at,last_used_at)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`, [id, accountId, identityId, deviceId, deviceName, digest(access), new Date(now.getTime() + ACCESS_SECONDS * 1000), expiry, now]);
        await tx.query('INSERT INTO kira_public_refresh(token_hash,session_id,generation) VALUES($1,$2,0)', [digest(refresh), id]);
        // A newly authenticated account/device owns its token binding; old account bindings cannot survive a swap.
        await tx.query('DELETE FROM kira_public_push_devices WHERE device_id=$1 AND account_id=$2', [deviceId, accountId]);
        return this.pair(id, access, refresh, expiry);
    }

    async authenticate(access: string): Promise<{ account: Account; session: NativeSession } | undefined> {
        const [row] = await this.db.query(`SELECT row_to_json(a) AS account,row_to_json(s) AS session
            FROM kira_public_sessions s JOIN kira_accounts a ON a.id=s.account_id
            JOIN kira_public_identities i ON i.id=s.identity_id
            WHERE s.access_hash=$1 AND s.access_expires_at>$2 AND s.refresh_expires_at>$2 AND s.revoked_at IS NULL
            AND i.revoked_at IS NULL AND a.account_state NOT IN ('deleting','deleted')
            AND NOT EXISTS(SELECT 1 FROM kira_public_deletion_ledger l WHERE l.account_id=a.id)`, [digest(access), this.now()]);
        return row;
    }

    async rotate(refresh: string, deviceId: string, key: string): Promise<TokenPair> {
        const now = this.now(), tokenHash = digest(refresh), keyHash = digest(key);
        const result = await this.db.transaction(async tx => {
            const [old] = await tx.query('SELECT * FROM kira_public_refresh WHERE token_hash=$1 FOR UPDATE', [tokenHash]);
            if (!old) return undefined;
            const [s] = await tx.query(`SELECT s.*,a.account_state,i.revoked_at AS identity_revoked,
                EXISTS(SELECT 1 FROM kira_public_deletion_ledger l WHERE l.account_id=a.id) AS deleted
                FROM kira_public_sessions s JOIN kira_accounts a ON a.id=s.account_id
                JOIN kira_public_identities i ON i.id=s.identity_id WHERE s.id=$1 FOR UPDATE OF s`, [old.session_id]);
            if (!s || s.revoked_at || s.identity_revoked || s.deleted || ['deleting','deleted'].includes(s.account_state)
                || new Date(s.refresh_expires_at).getTime() <= now.getTime()) return undefined;
            if (old.replaced_at) {
                if (s.device_id === deviceId && old.request_key_hash === keyHash && old.replay_encrypted
                    && Number(s.generation) === Number(old.generation) + 1
                    && now.getTime() - new Date(old.replaced_at).getTime() <= RETRY_MS) {
                    return this.secrets.open<TokenPair>(old.replay_encrypted, `refresh:${s.id}:${tokenHash}`);
                }
                // Return, then throw outside the transaction: throwing here would roll back the revocation.
                await revokeSession(tx, s.id);
                return undefined;
            }
            if (s.device_id !== deviceId || Number(old.generation) !== Number(s.generation)) {
                await revokeSession(tx, s.id);
                return undefined;
            }
            const access = newToken(), next = newToken(), generation = Number(s.generation) + 1;
            const pair = this.pair(s.id, access, next, new Date(s.refresh_expires_at));
            await tx.query(`UPDATE kira_public_sessions SET access_hash=$2,access_expires_at=$3,generation=$4,last_used_at=$5 WHERE id=$1`,
                [s.id, digest(access), new Date(now.getTime() + ACCESS_SECONDS * 1000), generation, now]);
            await tx.query(`UPDATE kira_public_refresh SET replaced_at=$2,request_key_hash=$3,replay_encrypted=$4 WHERE token_hash=$1`,
                [tokenHash, now, keyHash, this.secrets.seal(pair, `refresh:${s.id}:${tokenHash}`)]);
            await tx.query('INSERT INTO kira_public_refresh(token_hash,session_id,generation) VALUES($1,$2,$3)', [digest(next), s.id, generation]);
            return pair;
        });
        if (!result) throw invalid();
        return result;
    }

    async logout(accountId: string, sessionId: string): Promise<void> {
        await this.db.transaction(async tx => {
            const [s] = await tx.query('SELECT id FROM kira_public_sessions WHERE id=$1 AND account_id=$2 FOR UPDATE', [sessionId, accountId]);
            if (!s) throw new ApiError(404, 'not_found', 'Сессия не найдена.');
            await revokeSession(tx, s.id);
        });
    }

    async list(accountId: string, current: string): Promise<SessionView[]> {
        const rows = await this.db.query(`SELECT s.*,i.provider FROM kira_public_sessions s JOIN kira_public_identities i ON i.id=s.identity_id
            WHERE s.account_id=$1 AND s.revoked_at IS NULL AND s.refresh_expires_at>$2 ORDER BY s.created_at DESC LIMIT 100`, [accountId, this.now()]);
        return rows.map((s: NativeSession & { provider: SessionView['provider'] }) => ({ id: s.id, deviceId: s.device_id,
            deviceName: s.device_name, provider: s.provider, createdAt: new Date(s.created_at).toISOString(),
            lastUsedAt: new Date(s.last_used_at).toISOString(), expiresAt: new Date(s.refresh_expires_at).toISOString(), current: s.id === current }));
    }

    private pair(id: string, access: string, refresh: string, expires: Date): TokenPair {
        return { version: 1, tokenType: 'Bearer', accessToken: access, expiresIn: ACCESS_SECONDS,
            refreshToken: refresh, refreshExpiresAt: expires.toISOString(), sessionId: id };
    }
}
