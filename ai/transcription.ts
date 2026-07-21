import fs from 'fs';
import { resolveModelForTaskAsync } from './modelResolver';
import type { AiModelRef } from './modelPresets';
import { getAiProviderAdapter } from './providers/registry';
import { buildSafeAiErrorLog, classifyAiError, createAiExecutionTrace, type AiExecutionStage } from './errorDiagnostics';
import { allowsCrossProviderFallback, getTransitionalTaskFallbackModel, errorToMessage } from './runtimeSupport';
import { logAiUsage } from '../services/aiUsageLogService';

function recordAiUsage(payload: Parameters<typeof logAiUsage>[0]): void {
    void logAiUsage(payload);
}

async function createTranscriptionWithModel(
    audioFilePath: string,
    preset: string,
    modelRef: AiModelRef,
    traceId: string,
    attempt: number,
    stage: AiExecutionStage,
    originalError?: unknown,
): Promise<string> {
    const taskKey = 'transcription';
    const startedAt = Date.now();
    const providerAdapter = getAiProviderAdapter(modelRef.provider);
    const fallbackUsed = stage === 'fallback';

    if (!providerAdapter.createTranscription || !providerAdapter.getModelCapabilities(modelRef.model).supportsTranscription) {
        throw new Error(`Provider ${modelRef.provider} does not support transcription for model ${modelRef.model}`);
    }

    const fileStream = fs.createReadStream(audioFilePath);

    try {
        const result = await providerAdapter.createTranscription(modelRef.model, {
            file: fileStream,
            language: 'ru',
            response_format: 'text',
        });
        recordAiUsage({
            taskKey,
            provider: modelRef.provider,
            model: modelRef.model,
            preset,
            operation: 'transcription',
            traceId,
            attempt,
            stage,
            success: true,
            fallbackUsed,
            latencyMs: Date.now() - startedAt,
        });
        return result.text;
    } catch (error) {
        const diagnostics = classifyAiError(error);
        recordAiUsage({
            taskKey,
            provider: modelRef.provider,
            model: modelRef.model,
            preset,
            operation: 'transcription',
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
            console.warn('[AI transcription fallback failed]', {
                fallbackModel: modelRef,
                originalError: buildSafeAiErrorLog(originalError),
                fallbackError: buildSafeAiErrorLog(error),
            });
        }

        throw error;
    } finally {
        fileStream.destroy();
    }
}

export async function createTranscriptionForTask(audioFilePath: string): Promise<string> {
    const { presetName, modelRef } = await resolveModelForTaskAsync('transcription');
    const trace = createAiExecutionTrace();

    try {
        return await createTranscriptionWithModel(audioFilePath, presetName, modelRef, trace.traceId, 1, 'primary');
    } catch (error) {
        const diagnostics = classifyAiError(error);

        if (diagnostics.retryable) {
            try {
                return await createTranscriptionWithModel(audioFilePath, presetName, modelRef, trace.traceId, 2, 'retry');
            } catch (retryError) {
                if (!allowsCrossProviderFallback(presetName)) {
                    throw retryError;
                }
                const fallbackModel = getTransitionalTaskFallbackModel('transcription');
                console.warn('[AI transcription fallback]', {
                    traceId: trace.traceId,
                    fallbackModel,
                    originalError: buildSafeAiErrorLog(retryError),
                });
                return createTranscriptionWithModel(audioFilePath, presetName, fallbackModel, trace.traceId, 3, 'fallback', retryError);
            }
        }

        if (!allowsCrossProviderFallback(presetName)) {
            throw error;
        }
        const fallbackModel = getTransitionalTaskFallbackModel('transcription');
        console.warn('[AI transcription fallback]', {
            traceId: trace.traceId,
            fallbackModel,
            originalError: buildSafeAiErrorLog(error),
        });
        return createTranscriptionWithModel(audioFilePath, presetName, fallbackModel, trace.traceId, 2, 'fallback', error);
    }
}
