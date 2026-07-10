import { resolveModelForTaskAsync } from './modelResolver';
import type { AiModelRef, AiTaskKey } from './modelPresets';
import { getAiProviderAdapter } from './providers/registry';
import type {
    ResponseCreateParams,
    ResponseResult,
} from './providers/types';
import { logAiUsage } from '../services/aiUsageLogService';
import { buildSafeAiErrorLog, classifyAiError, createAiExecutionTrace, type AiExecutionStage } from './errorDiagnostics';
import { allowsCrossProviderFallback, errorToMessage, getSameProviderDegradedModel, getTaskFallbackModel } from './runtimeSupport';
import { logDegradedFailure, logDegradedStart, logDegradedSuccess } from './degradedLogging';

function recordAiUsage(payload: Parameters<typeof logAiUsage>[0]): void {
    void logAiUsage(payload);
}

function getUsageTokens(result: ResponseResult): {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
} {
    const usage = result.usage as Record<string, unknown> | undefined;
    return {
        inputTokens: typeof usage?.input_tokens === 'number'
            ? usage.input_tokens as number
            : typeof usage?.prompt_tokens === 'number'
                ? usage.prompt_tokens as number
                : undefined,
        outputTokens: typeof usage?.output_tokens === 'number'
            ? usage.output_tokens as number
            : typeof usage?.completion_tokens === 'number'
                ? usage.completion_tokens as number
                : undefined,
        totalTokens: typeof usage?.total_tokens === 'number' ? usage.total_tokens as number : undefined,
    };
}

async function createResponseWithModel(
    taskKey: AiTaskKey,
    params: ResponseCreateParams,
    preset: string,
    modelRef: AiModelRef,
    traceId: string,
    attempt: number,
    stage: AiExecutionStage,
    originalError?: unknown,
): Promise<ResponseResult> {
    const startedAt = Date.now();
    const providerAdapter = getAiProviderAdapter(modelRef.provider);
    const fallbackUsed = stage === 'fallback';

    try {
        const result = await providerAdapter.createResponse(modelRef.model, params);
        const usage = getUsageTokens(result);

        recordAiUsage({
            taskKey,
            provider: modelRef.provider,
            model: modelRef.model,
            preset,
            operation: 'response',
            traceId,
            attempt,
            stage,
            ...usage,
            success: true,
            fallbackUsed,
            latencyMs: Date.now() - startedAt,
        });

        return result;
    } catch (error) {
        const diagnostics = classifyAiError(error);
        recordAiUsage({
            taskKey,
            provider: modelRef.provider,
            model: modelRef.model,
            preset,
            operation: 'response',
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
            console.warn('[AI responses fallback failed]', {
                taskKey,
                traceId,
                fallbackModel: modelRef,
                originalError: buildSafeAiErrorLog(originalError),
                fallbackError: buildSafeAiErrorLog(error),
            });
        }
        throw error;
    }
}

export async function createResponseForTask(
    taskKey: AiTaskKey,
    params: ResponseCreateParams,
): Promise<ResponseResult> {
    const { presetName, modelRef } = await resolveModelForTaskAsync(taskKey);
    const trace = createAiExecutionTrace();

    try {
        return await createResponseWithModel(taskKey, params, presetName, modelRef, trace.traceId, 1, 'primary');
    } catch (error) {
        const diagnostics = classifyAiError(error);

        if (diagnostics.retryable) {
            try {
                return await createResponseWithModel(taskKey, params, presetName, modelRef, trace.traceId, 2, 'retry');
            } catch (retryError) {
                const retryDiagnostics = classifyAiError(retryError);
                if (!allowsCrossProviderFallback(presetName)) {
                    const degradedModel = getSameProviderDegradedModel(presetName, modelRef, retryDiagnostics.retryable);
                    if (!degradedModel) throw retryError;
                    const logContext = {
                        taskKey,
                        traceId: trace.traceId,
                        previousModel: modelRef,
                        degradedModel,
                        attempt: 3,
                    };
                    logDegradedStart(logContext, retryError);
                    const startedAt = Date.now();
                    let result: ResponseResult;
                    try {
                        result = await createResponseWithModel(
                            taskKey,
                            params,
                            presetName,
                            degradedModel,
                            trace.traceId,
                            3,
                            'fallback',
                        );
                    } catch (error) {
                        logDegradedFailure(logContext, error, Date.now() - startedAt);
                        throw error;
                    }
                    logDegradedSuccess(logContext, Date.now() - startedAt);
                    return result;
                }
                const fallbackModel = getTaskFallbackModel(taskKey);
                console.warn('[AI responses fallback]', {
                    taskKey,
                    traceId: trace.traceId,
                    fallbackModel,
                    originalError: buildSafeAiErrorLog(retryError),
                });
                return createResponseWithModel(taskKey, params, presetName, fallbackModel, trace.traceId, 3, 'fallback', retryError);
            }
        }

        if (!allowsCrossProviderFallback(presetName)) {
            throw error;
        }
        const fallbackModel = getTaskFallbackModel(taskKey);
        console.warn('[AI responses fallback]', {
            taskKey,
            traceId: trace.traceId,
            fallbackModel,
            originalError: buildSafeAiErrorLog(error),
        });
        return createResponseWithModel(taskKey, params, presetName, fallbackModel, trace.traceId, 2, 'fallback', error);
    }
}
