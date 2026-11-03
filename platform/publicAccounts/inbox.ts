import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { ApiError } from '../../api/contracts';
import { digest, PlatformSecrets } from '../crypto';
import type { InboxEvent, NotificationPage, PushDeviceInput } from './contracts';
import type { NativeSession } from './sessions';
import * as v from './validation';

export class PublicInbox {
    constructor(private db: DataSource, private secrets: PlatformSecrets) {}

    async append(accountId: string, sourceKey: string, kind: InboxEvent['kind'], content: InboxEvent['content']): Promise<{ id: string; messageId: number }> {
        if (!['reminder','task_result','dialogue_result','account'].includes(kind) || !sourceKey || sourceKey.length > 512) v.invalid();
        v.text(content.text, 1, 40_000);
        if (content.resourceId !== undefined) v.text(content.resourceId, 1, 128);
        return this.db.transaction(async tx => {
            const [account] = await tx.query(`SELECT id FROM kira_accounts WHERE id=$1 AND account_state NOT IN ('deleting','deleted')
                AND NOT EXISTS(SELECT 1 FROM kira_public_deletion_ledger l WHERE l.account_id=kira_accounts.id) FOR UPDATE`, [accountId]);
            if (!account) throw new ApiError(403, 'account_deleting', 'Аккаунт удаляется.');
            const id = randomUUID();
            await tx.query(`INSERT INTO kira_public_inbox(id,account_id,source_key,kind,content) VALUES($1,$2,$3,$4,$5::jsonb)
                ON CONFLICT(account_id,source_key) DO NOTHING`, [id, accountId, digest(sourceKey), kind, JSON.stringify(content)]);
            const [event] = await tx.query('SELECT id,message_seq FROM kira_public_inbox WHERE account_id=$1 AND source_key=$2', [accountId, digest(sourceKey)]);
            // Inbox and all delivery intents commit together, regardless of APNs availability.
            const devices = await tx.query(`SELECT d.session_id,d.device_id FROM kira_public_push_devices d
                JOIN kira_public_sessions s ON s.id=d.session_id JOIN kira_public_identities i ON i.id=s.identity_id
                WHERE d.account_id=$1 AND s.account_id=$1 AND s.revoked_at IS NULL AND i.revoked_at IS NULL AND s.refresh_expires_at>now()`, [accountId]);
            for (const d of devices) await tx.query(`INSERT INTO kira_public_push_outbox(id,event_id,session_id,device_id)
                VALUES($1,$2,$3,$4) ON CONFLICT(event_id,session_id,device_id) DO NOTHING`, [randomUUID(), event.id, d.session_id, d.device_id]);
            return { id: event.id, messageId: Number(event.message_seq) };
        });
    }

    async bind(accountId: string, session: NativeSession, raw: Record<string, unknown>): Promise<void> {
        v.fields(raw, ['version','deviceId','token','environment'], ['version','deviceId','token','environment']); v.version(raw);
        const input = raw as unknown as PushDeviceInput;
        const device = v.uuid(input.deviceId), token = v.text(input.token, 64, 512).toLowerCase();
        if (!/^[0-9a-f]+$/.test(token) || token.length % 2 || !['sandbox','production'].includes(input.environment)) v.invalid();
        if (device !== session.device_id || accountId !== session.account_id) throw new ApiError(403, 'device_mismatch', 'Устройство не принадлежит этой сессии.');
        await this.db.transaction(async tx => {
            const [valid] = await tx.query(`SELECT s.id FROM kira_public_sessions s JOIN kira_accounts a ON a.id=s.account_id
                WHERE s.id=$1 AND s.account_id=$2 AND s.revoked_at IS NULL AND s.refresh_expires_at>now()
                AND a.account_state NOT IN ('deleting','deleted') AND NOT EXISTS(SELECT 1 FROM kira_public_deletion_ledger l WHERE l.account_id=a.id) FOR UPDATE OF s`, [session.id, accountId]);
            if (!valid) throw new ApiError(401, 'unauthorized', 'Войди в аккаунт ещё раз.');
            // Possession of the actual APNs token, not a client-picked device UUID, controls an account swap.
            await tx.query('DELETE FROM kira_public_push_devices WHERE token_hash=$1', [digest(token)]);
            await tx.query(`INSERT INTO kira_public_push_devices(account_id,device_id,session_id,token_hash,token_encrypted,environment)
                VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(account_id,device_id) DO UPDATE SET session_id=EXCLUDED.session_id,
                token_hash=EXCLUDED.token_hash,token_encrypted=EXCLUDED.token_encrypted,environment=EXCLUDED.environment,updated_at=now()`,
            [accountId, device, session.id, digest(token), this.secrets.seal(token, `push:${accountId}:${device}`), input.environment]);
        });
    }

    async unbind(accountId: string, deviceId: string): Promise<void> {
        await this.db.transaction(async tx => {
            await tx.query('DELETE FROM kira_public_push_devices WHERE account_id=$1 AND device_id=$2', [accountId, deviceId]);
            await tx.query(`UPDATE kira_public_push_outbox SET state='cancelled',lease_until=NULL,lease_token=NULL
                WHERE device_id=$2 AND event_id IN (SELECT id FROM kira_public_inbox WHERE account_id=$1) AND state IN ('pending','sending')`, [accountId, deviceId]);
        });
    }

    async list(accountId: string, limit: number, cursor?: string): Promise<NotificationPage> {
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) v.invalid();
        let before: { at: string; id: string } | undefined;
        if (cursor) {
            try {
                if (!/^[A-Za-z0-9_-]{1,256}$/.test(cursor)) v.invalid();
                const c = JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));
                if (typeof c.at !== 'string' || !Number.isFinite(Date.parse(c.at)) || !v.UUID.test(c.id)) v.invalid();
                before = c;
            } catch { v.invalid(); }
        }
        const rows = await this.db.query(`SELECT * FROM kira_public_inbox WHERE account_id=$1
            ${before ? 'AND (created_at,id)<($3::timestamptz,$4::uuid)' : ''} ORDER BY created_at DESC,id DESC LIMIT $2`,
        before ? [accountId, limit + 1, before.at, before.id] : [accountId, limit + 1]);
        const more = rows.length > limit, selected = rows.slice(0,limit);
        const last = selected[selected.length - 1];
        return { version: 1, events: selected.map((r: any) => ({ id:r.id, kind:r.kind, createdAt:new Date(r.created_at).toISOString(),
            readAt:r.read_at ? new Date(r.read_at).toISOString() : null, content:r.content })),
            nextCursor: more && last ? Buffer.from(JSON.stringify({at:new Date(last.created_at).toISOString(),id:last.id})).toString('base64url') : null };
    }
    async read(accountId: string, eventId: string): Promise<void> {
        const rows = await this.db.query('UPDATE kira_public_inbox SET read_at=COALESCE(read_at,now()) WHERE id=$1 AND account_id=$2 RETURNING id', [eventId, accountId]);
        if (!rows[0]?.length) throw new ApiError(404, 'not_found', 'Уведомление не найдено.');
    }
}
