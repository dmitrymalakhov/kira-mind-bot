import { AppDataSource } from '../data-source';
import { ApiOperationEntity } from '../entity/ApiOperationEntity';
import { ApiError, ApiOperationStore, ApiReply } from './contracts';
import { scopedBotKey } from '../utils/botIdentity';
import type { DataSource } from 'typeorm';

export class PersistentApiOperations implements ApiOperationStore {
    constructor(private readonly source: DataSource = AppDataSource) {}
    async run(key: string, fingerprint: string, work: () => Promise<ApiReply>, options: { releaseRefusals?: boolean } = {}): Promise<ApiReply> {
        return this.execute(key, fingerprint, work, options);
    }
    async runJson<T extends object>(key: string, fingerprint: string, work: () => Promise<T>): Promise<T> {
        return this.execute(key, fingerprint, work);
    }
    private async execute<T extends object>(key: string, fingerprint: string, work: () => Promise<T>, options: { releaseRefusals?: boolean } = {}): Promise<T> {
        key = scopedBotKey(key);
        const repo = this.source.getRepository(ApiOperationEntity);
        const inserted = await repo.createQueryBuilder().insert().values({
            key, fingerprint, status: 'pending', result: null,
        }).orIgnore().returning('key').execute();
        if (!inserted.raw.length) {
            const existing = await repo.findOneByOrFail({ key });
            if (existing.fingerprint !== fingerprint) {
                throw new ApiError(409, 'idempotency_conflict', 'Этот ключ уже использован с другим запросом.');
            }
            if (existing.status === 'completed' && existing.result) {
                if ((existing.result as any).workoutDataErased === true) throw new ApiError(410, 'operation_result_erased', 'Результат удалён вместе с синхронизированными данными. Прочитай текущее состояние.');
                return existing.result as unknown as T;
            }
            throw new ApiError(409, 'operation_uncertain',
                'Запрос выполняется или его результат не подтверждён. Проверь историю перед новым запросом.');
        }
        try {
            const result = await work();
            await repo.update({ key }, { status: 'completed', result: result as any });
            return result;
        } catch (error) {
            // refused before anything ran: no receipt is kept, a corrected retry may run; otherwise the outcome is
            // unknown and never replayed blindly
            if (options.releaseRefusals && error instanceof ApiError && error.released) await repo.delete({ key }).catch(() => {});
            else await repo.update({ key }, { status: 'failed' }).catch(() => {});
            throw error;
        }
    }
}
