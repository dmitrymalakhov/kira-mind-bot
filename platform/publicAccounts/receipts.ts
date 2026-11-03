import type { DataSource } from 'typeorm';
import { ApiError } from '../../api/contracts';
import { digest } from '../crypto';
import { canonicalJson } from './validation';

/** Durable intent first. Unknown outcome never re-enters work after a process interruption. */
export class PublicReceipts {
    constructor(private db: DataSource) {}
    async run<T>(accountId: string, key: string, method: string, path: string, body: unknown, work: () => Promise<T>): Promise<T> {
        const keyHash = digest(key), fingerprint = digest(canonicalJson({ method, path, body }));
        const created = await this.db.query(`INSERT INTO kira_public_receipts(account_id,key_hash,fingerprint,status)
            VALUES($1,$2,$3,'pending') ON CONFLICT DO NOTHING RETURNING key_hash`, [accountId, keyHash, fingerprint]);
        if (!created.length) {
            const [old] = await this.db.query('SELECT * FROM kira_public_receipts WHERE account_id=$1 AND key_hash=$2', [accountId, keyHash]);
            if (!old || old.fingerprint !== fingerprint) throw new ApiError(409, 'idempotency_conflict', 'Этот ключ уже использован для другого запроса.');
            if (old.status === 'completed') return old.result as T;
            if (old.status === 'refused' && old.result) throw new ApiError(old.result.status, old.result.code, old.result.message);
            throw new ApiError(409, 'operation_uncertain', 'Исход операции не подтверждён. Проверь состояние аккаунта.');
        }
        try {
            const result = await work();
            await this.db.query("UPDATE kira_public_receipts SET status='completed',result=$3::jsonb WHERE account_id=$1 AND key_hash=$2", [accountId, keyHash, JSON.stringify(result)]);
            return result;
        } catch (error) {
            // Only typed domain refusals are replayable; an unexpected crash preserves uncertain intent.
            if (error instanceof ApiError && error.status < 500) await this.db.query("UPDATE kira_public_receipts SET status='refused',result=$3::jsonb WHERE account_id=$1 AND key_hash=$2",
                [accountId, keyHash, JSON.stringify({ status: error.status, code: error.code, message: error.message })]);
            throw error;
        }
    }
}
