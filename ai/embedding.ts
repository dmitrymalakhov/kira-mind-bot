import { resolveMemoryEmbeddingConfigAsync } from './memoryEmbeddingResolver';
import { getAiProviderAdapter } from './providers/registry';
import { buildSafeAiErrorLog, classifyAiError, createAiExecutionTrace, type AiExecutionStage } from './errorDiagnostics';
import { errorToMessage } from './runtimeSupport';
import { logAiUsage } from '../services/aiUsageLogService';
import type { AiModelRef } from './modelPresets';
import type { MemoryEmbeddingProfileName } from './memoryEmbeddingProfiles';

function recordAiUsage(payload: Parameters<typeof logAiUsage>[0]): void {
    void logAiUsage(payload);
}

function buildEmbeddingParams(input: string, outputDimension: number) {
    return {
        input,
        outputDimension,
    };
}

async function createEmbeddingWithModel(
    input: string,
    profileName: MemoryEmbeddingProfileName,
    modelRef: AiModelRef,
    outputDimension: number,
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
        const result = await providerAdapter.createEmbedding(modelRef.model, buildEmbeddingParams(input, outputDimension));
        recordAiUsage({
            taskKey,
            provider: modelRef.provider,
            model: modelRef.model,
            preset: `memory:${profileName}`,
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
            preset: `memory:${profileName}`,
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

export async function createMemoryEmbedding(input: string): Promise<number[]> {
    const { profileName, config } = await resolveMemoryEmbeddingConfigAsync();
    const modelRef: AiModelRef = {
        provider: config.provider,
        model: config.model,
    };
    const trace = createAiExecutionTrace();

    try {
        return await createEmbeddingWithModel(input, profileName, modelRef, config.outputDimension, trace.traceId, 1, 'primary');
    } catch (error) {
        const diagnostics = classifyAiError(error);

        if (diagnostics.retryable) {
            try {
                return await createEmbeddingWithModel(input, profileName, modelRef, config.outputDimension, trace.traceId, 2, 'retry');
            } catch (retryError) {
                console.warn('[AI memory embedding retry failed]', {
                    traceId: trace.traceId,
                    profileName,
                    modelRef,
                    originalError: buildSafeAiErrorLog(retryError),
                });
                throw retryError;
            }
        }

        throw error;
    }
}

export async function createEmbeddingForTask(input: string): Promise<number[]> {
    return createMemoryEmbedding(input);
}
