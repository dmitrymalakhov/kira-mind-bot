import { resolveModelForTaskAsync } from './modelResolver';
import type { AiModelRef, AiTaskKey } from './modelPresets';
import { logAiUsage } from '../services/aiUsageLogService';
import { getAiProviderAdapter } from './providers/registry';
import type {
    ChatCompletion,
    ChatCompletionParamsWithoutModel,
} from './providers/types';
import { buildSafeAiErrorLog, classifyAiError, createAiExecutionTrace, type AiExecutionStage } from './errorDiagnostics';
import { parseLLMJson } from '../utils';
import { allowsCrossProviderFallback, errorToMessage, getTaskFallbackModel } from './runtimeSupport';

function recordAiUsage(payload: Parameters<typeof logAiUsage>[0]): void {
    void logAiUsage(payload);
}

function recordJsonResolutionFailure(
    taskKey: AiTaskKey,
    preset: string,
    modelRef: AiModelRef,
    traceId: string,
    attempt: number,
    stage: AiExecutionStage,
    error: Error,
    fallbackUsed: boolean,
): void {
    const diagnostics = classifyAiError(error);
    recordAiUsage({
        taskKey,
        provider: modelRef.provider,
        model: modelRef.model,
        preset,
        operation: 'chat',
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
    });
}

async function createChatCompletionWithModel(
    taskKey: AiTaskKey,
    params: ChatCompletionParamsWithoutModel,
    preset: string,
    modelRef: AiModelRef,
    traceId: string,
    attempt: number,
    stage: AiExecutionStage,
    originalError?: unknown,
): Promise<ChatCompletion> {
    const startedAt = Date.now();
    const providerAdapter = getAiProviderAdapter(modelRef.provider);
    const fallbackUsed = stage === 'fallback';

    try {
        const result = await providerAdapter.createChatCompletion(modelRef.model, params);

        recordAiUsage({
            taskKey,
            provider: modelRef.provider,
            model: modelRef.model,
            preset,
            operation: 'chat',
            traceId,
            attempt,
            stage,
            inputTokens: result.usage?.prompt_tokens,
            outputTokens: result.usage?.completion_tokens,
            totalTokens: result.usage?.total_tokens,
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
            operation: 'chat',
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
            console.warn('[AI fallback failed]', {
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

async function createChatCompletionForTaskWithTrace(
    taskKey: AiTaskKey,
    params: ChatCompletionParamsWithoutModel,
    traceId: string,
): Promise<ChatCompletion> {
    const { presetName, modelRef } = await resolveModelForTaskAsync(taskKey);

    try {
        return await createChatCompletionWithModel(taskKey, params, presetName, modelRef, traceId, 1, 'primary');
    } catch (error) {
        const diagnostics = classifyAiError(error);

        if (diagnostics.retryable) {
            try {
                return await createChatCompletionWithModel(taskKey, params, presetName, modelRef, traceId, 2, 'retry');
            } catch (retryError) {
                if (!allowsCrossProviderFallback(presetName)) {
                    throw retryError;
                }
                return createFallbackChatCompletion(taskKey, params, retryError, presetName, traceId, 3);
            }
        }

        if (!allowsCrossProviderFallback(presetName)) {
            throw error;
        }
        return createFallbackChatCompletion(taskKey, params, error, presetName, traceId, 2);
    }
}

export async function createChatCompletionForTask(
    taskKey: AiTaskKey,
    params: ChatCompletionParamsWithoutModel,
): Promise<ChatCompletion> {
    const trace = createAiExecutionTrace();
    return createChatCompletionForTaskWithTrace(taskKey, params, trace.traceId);
}

export async function createFallbackChatCompletion(
    taskKey: AiTaskKey,
    params: ChatCompletionParamsWithoutModel,
    originalError: unknown,
    preset = 'fallback',
    traceId = createAiExecutionTrace().traceId,
    attempt = 1,
): Promise<ChatCompletion> {
    const fallbackModel = getTaskFallbackModel(taskKey);

    console.warn('[AI fallback]', {
        taskKey,
        traceId,
        fallbackModel,
        originalError: buildSafeAiErrorLog(originalError),
    });

    return createChatCompletionWithModel(taskKey, params, preset, fallbackModel, traceId, attempt, 'fallback', originalError);
}

export async function createJsonChatCompletionForTask<T>(
    taskKey: AiTaskKey,
    params: ChatCompletionParamsWithoutModel,
): Promise<T | null> {
    const trace = createAiExecutionTrace();
    const { presetName, modelRef } = await resolveModelForTaskAsync(taskKey);
    const response = await createChatCompletionForTaskWithTrace(taskKey, params, trace.traceId);
    const content = response.choices[0]?.message?.content || '';
    const parsed = parseLLMJson<T>(content);
    if (parsed) return parsed;

    const invalidJsonError = new Error('AI response contained invalid JSON');
    if (!allowsCrossProviderFallback(presetName)) {
        recordJsonResolutionFailure(taskKey, presetName, modelRef, trace.traceId, 1, 'primary', invalidJsonError, false);
        return null;
    }

    try {
        const fallbackResponse = await createFallbackChatCompletion(
            taskKey,
            params,
            invalidJsonError,
            'json-parse-fallback',
            trace.traceId,
            2,
        );
        const fallbackParsed = parseLLMJson<T>(fallbackResponse.choices[0]?.message?.content || '');
        if (fallbackParsed) {
            return fallbackParsed;
        }

        const fallbackModel = getTaskFallbackModel(taskKey);
        recordJsonResolutionFailure(taskKey, presetName, fallbackModel, trace.traceId, 2, 'fallback', invalidJsonError, true);
        return null;
    } catch (error) {
        console.warn('[AI JSON fallback failed]', { taskKey, error });
        return null;
    }
}
export { getTaskFallbackModel as getFallbackModel } from './runtimeSupport';
