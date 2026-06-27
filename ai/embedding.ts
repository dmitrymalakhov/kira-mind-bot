import { resolveModelForTaskAsync } from './modelResolver';
import type { AiModelRef } from './modelPresets';
import { getAiProviderAdapter } from './providers/registry';
import { getTransitionalTaskFallbackModel, errorToMessage } from './runtimeSupport';
import { logAiUsage } from '../services/aiUsageLogService';

function recordAiUsage(payload: Parameters<typeof logAiUsage>[0]): void {
    void logAiUsage(payload);
}

async function createEmbeddingWithModel(
    input: string,
    preset: string,
    modelRef: AiModelRef,
    fallbackUsed: boolean,
    originalError?: unknown,
): Promise<number[]> {
    const taskKey = 'embedding';
    const startedAt = Date.now();
    const providerAdapter = getAiProviderAdapter(modelRef.provider);

    if (!providerAdapter.createEmbedding || !providerAdapter.getModelCapabilities(modelRef.model).supportsEmbedding) {
        throw new Error(`Provider ${modelRef.provider} does not support embeddings for model ${modelRef.model}`);
    }

    try {
        const result = await providerAdapter.createEmbedding(modelRef.model, { input });
        recordAiUsage({
            taskKey,
            provider: modelRef.provider,
            model: modelRef.model,
            preset,
            success: true,
            fallbackUsed,
            inputTokens: result.rawUsage?.inputTokens,
            outputTokens: result.rawUsage?.outputTokens,
            totalTokens: result.rawUsage?.totalTokens,
            latencyMs: Date.now() - startedAt,
        });
        return result.embedding;
    } catch (error) {
        recordAiUsage({
            taskKey,
            provider: modelRef.provider,
            model: modelRef.model,
            preset,
            success: false,
            fallbackUsed,
            errorMessage: errorToMessage(error),
            latencyMs: Date.now() - startedAt,
        });

        if (originalError) {
            console.warn('[AI embedding fallback failed]', {
                fallbackModel: modelRef,
                originalError,
                fallbackError: error,
            });
        }

        throw error;
    }
}

export async function createEmbeddingForTask(input: string): Promise<number[]> {
    const { presetName, modelRef } = await resolveModelForTaskAsync('embedding');

    try {
        return await createEmbeddingWithModel(input, presetName, modelRef, false);
    } catch (error) {
        const fallbackModel = getTransitionalTaskFallbackModel('embedding');
        console.warn('[AI embedding fallback]', { fallbackModel, originalError: error });
        return createEmbeddingWithModel(input, presetName, fallbackModel, true, error);
    }
}
