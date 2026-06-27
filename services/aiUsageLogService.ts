import { AppDataSource } from '../data-source';
import { AiUsageLogEntity } from '../entity/AiUsageLogEntity';

export interface AiUsageLogPayload {
    taskKey: string;
    provider: string;
    model: string;
    preset: string;
    operation: string;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    success: boolean;
    fallbackUsed?: boolean;
    errorMessage?: string;
    latencyMs?: number;
}

export async function logAiUsage(payload: AiUsageLogPayload): Promise<void> {
    try {
        if (!AppDataSource.isInitialized) {
            console.info('[AI usage]', payload);
            return;
        }

        const repo = AppDataSource.getRepository(AiUsageLogEntity);
        await repo.save(repo.create({
            ...payload,
            fallbackUsed: payload.fallbackUsed ?? false,
        }));
    } catch (error) {
        console.warn('[AI usage] Не удалось записать usage log:', error);
    }
}
