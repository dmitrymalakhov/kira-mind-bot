import { AppDataSource } from '../data-source';
import { ApiOperationEntity } from '../entity/ApiOperationEntity';
import { ApiError, ApiOperationStore, ApiReply } from './contracts';
import { scopedBotKey } from '../utils/botIdentity';

export class PersistentApiOperations implements ApiOperationStore {
    async run(key: string, fingerprint: string, work: () => Promise<ApiReply>): Promise<ApiReply> {
        key = scopedBotKey(key);
        const repo = AppDataSource.getRepository(ApiOperationEntity);
        const inserted = await repo.createQueryBuilder().insert().values({
            key, fingerprint, status: 'pending', result: null,
        }).orIgnore().returning('key').execute();
        if (!inserted.raw.length) {
            const existing = await repo.findOneByOrFail({ key });
            if (existing.fingerprint !== fingerprint) {
                throw new ApiError(409, 'idempotency_conflict', 'Этот ключ уже использован с другим запросом.');
            }
            if (existing.status === 'completed' && existing.result) return existing.result;
            throw new ApiError(409, 'operation_uncertain',
                'Запрос выполняется или его результат не подтверждён. Проверь историю перед новым запросом.');
        }
        try {
            const result = await work();
            await repo.update({ key }, { status: 'completed', result });
            return result;
        } catch (error) {
            await repo.update({ key }, { status: 'failed' }).catch(() => {});
            throw error;
        }
    }
}
