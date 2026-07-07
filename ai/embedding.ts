import { resolveModelForTaskAsync } from './modelResolver';
import type { AiModelRef } from './modelPresets';
import { getAiProviderAdapter } from './providers/registry';
import { buildSafeAiErrorLog, classifyAiError, createAiExecutionTrace, type AiExecutionStage } from './errorDiagnostics';
import { allowsCrossProviderFallback, getTransitionalTaskFallbackModel, errorToMessage } from './runtimeSupport';
import { logAiUsage } from '../services/aiUsageLogService';

function recordAiUsage(payload: Parameters<typeof logAiUsage>[0]): void {
    void logAiUsage(payload);
}

async function createEmbeddingWithModel(
    input: string,
    preset: string,
    modelRef: AiModelRef,
    traceId: string,
    attempt: number,
    stage: AiExecutionStage,
    originalError?: unknown,
): Promise<number[]> {
    const taskKey = 'embedding';
    const startedAt = Date.now();
    const providerAdapter = getAiProviderAdapter(modelRef.provider);
    const fallbackUsed = stage === 'fallback';

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
            operation: 'embedding',
            traceId,
            attempt,
            stage,
            success: true,
            fallbackUsed,
            inputTokens: result.rawUsage?.inputTokens,
            outputTokens: result.rawUsage?.outputTokens,
            totalTokens: result.rawUsage?.totalTokens,
            latencyMs: Date.now() - startedAt,
        });
        return result.embedding;
    } catch (error) {
        const diagnostics = classifyAiError(error);
        recordAiUsage({
            taskKey,
            provider: modelRef.provider,
            model: modelRef.model,
            preset,
            operation: 'embedding',
            traceId,
            attempt,
            stage,
            success: false,
            fallbackUsed,
            errorMessage: errorToMessage(error),
            errorStatus: diagnostics.errorStatus,
            errorCode: diagnostics.errorCode,
            errorType: diagnostics.errorType,
            errorCategory: diagnostics.errorCategory,
            providerRequestId: diagnostics.providerRequestId,
            retryable: diagnostics.retryable,
            latencyMs: Date.now() - startedAt,
        });

        if (originalError) {
            console.warn('[AI embedding fallback failed]', {
                fallbackModel: modelRef,
                originalError: buildSafeAiErrorLog(originalError),
                fallbackError: buildSafeAiErrorLog(error),
            });
        }

        throw error;
    }
}

export async function createEmbeddingForTask(input: string): Promise<number[]> {
    const { presetName, modelRef } = await resolveModelForTaskAsync('embedding');
    const trace = createAiExecutionTrace();

    try {
        return await createEmbeddingWithModel(input, presetName, modelRef, trace.traceId, 1, 'primary');
    } catch (error) {
        const diagnostics = classifyAiError(error);

        if (diagnostics.retryable) {
            try {
                return await createEmbeddingWithModel(input, presetName, modelRef, trace.traceId, 2, 'retry');
            } catch (retryError) {
                if (!allowsCrossProviderFallback(presetName)) {
                    throw retryError;
                }
                const fallbackModel = getTransitionalTaskFallbackModel('embedding');
                console.warn('[AI embedding fallback]', {
                    traceId: trace.traceId,
                    fallbackModel,
                    originalError: buildSafeAiErrorLog(retryError),
                });
                return createEmbeddingWithModel(input, presetName, fallbackModel, trace.traceId, 3, 'fallback', retryError);
            }
        }

        if (!allowsCrossProviderFallback(presetName)) {
            throw error;
        }
        const fallbackModel = getTransitionalTaskFallbackModel('embedding');
        console.warn('[AI embedding fallback]', {
            traceId: trace.traceId,
            fallbackModel,
            originalError: buildSafeAiErrorLog(error),
        });
        return createEmbeddingWithModel(input, presetName, fallbackModel, trace.traceId, 2, 'fallback', error);
    }
}
