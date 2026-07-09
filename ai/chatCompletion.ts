import { resolveModelForTaskAsync, resolveModelForTaskFreshAsync } from './modelResolver';
import type { AiModelRef, AiPresetName, AiTaskKey } from './modelPresets';
import { logAiUsage } from '../services/aiUsageLogService';
import { getAiProviderAdapter } from './providers/registry';
import type {
    ChatCompletion,
    ChatCompletionParamsWithoutModel,
} from './providers/types';
import { buildSafeAiErrorLog, classifyAiError, createAiExecutionTrace, type AiExecutionStage } from './errorDiagnostics';
import { parseLLMJson } from '../utils';
import { allowsCrossProviderFallback, errorToMessage, getTaskFallbackModel } from './runtimeSupport';

const GEMINI_RETRY_BASE_DELAY_MS = 1000;
const GEMINI_RETRY_MAX_DELAY_MS = 5000;
const MAX_PRESET_REFRESHES_PER_REQUEST = 3;

function recordAiUsage(payload: Parameters<typeof logAiUsage>[0]): void {
    void logAiUsage(payload);
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function getGeminiRetryDelayMs(attempt: number): number {
    const baseDelay = Number(process.env.AI_GEMINI_RETRY_BASE_DELAY_MS) || GEMINI_RETRY_BASE_DELAY_MS;
    const maxDelay = Number(process.env.AI_GEMINI_RETRY_MAX_DELAY_MS) || GEMINI_RETRY_MAX_DELAY_MS;
    const cappedBase = Math.max(1, baseDelay);
    const cappedMax = Math.max(cappedBase, maxDelay);
    const exponentialDelay = Math.min(cappedMax, cappedBase * Math.pow(2, Math.max(0, attempt - 1)));
    const jitterMultiplier = 0.85 + Math.random() * 0.3;
    return Math.max(1, Math.round(exponentialDelay * jitterMultiplier));
}

interface AiTaskRoute {
    presetName: AiPresetName;
    modelRef: AiModelRef;
}

interface AiExecutionResult {
    response: ChatCompletion;
    route: AiTaskRoute;
    attempt: number;
    stage: AiExecutionStage;
}

function isSameRoute(left: AiTaskRoute, right: AiTaskRoute): boolean {
    return left.presetName === right.presetName
        && left.modelRef.provider === right.modelRef.provider
        && left.modelRef.model === right.modelRef.model;
}

async function maybeDelayRetry(
    presetName: string,
    taskKey: AiTaskKey,
    modelRef: AiModelRef,
    attempt: number,
    error: unknown,
): Promise<void> {
    if (presetName !== 'gemini-full' || modelRef.provider !== 'gemini') return;
    const delayMs = getGeminiRetryDelayMs(attempt);
    const diagnostics = classifyAiError(error);
    console.warn('[AI retry scheduled]', {
        taskKey,
        provider: modelRef.provider,
        model: modelRef.model,
        attempt,
        errorStatus: diagnostics.errorStatus,
        errorCategory: diagnostics.errorCategory,
        delayMs,
    });
    await sleep(delayMs);
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
): Promise<AiExecutionResult> {
    let route: AiTaskRoute = await resolveModelForTaskAsync(taskKey);
    let attempt = 1;
    let stage: AiExecutionStage = 'primary';
    let retryUsed = false;
    let presetRefreshCount = 0;

    const switchToCurrentRoute = async (): Promise<boolean> => {
        const currentRoute: AiTaskRoute = await resolveModelForTaskFreshAsync(taskKey);
        if (isSameRoute(route, currentRoute)) return false;
        if (presetRefreshCount >= MAX_PRESET_REFRESHES_PER_REQUEST) {
            throw new Error(`AI preset changed too many times during request: ${taskKey}`);
        }

        console.info('[AI retry switched to current preset]', {
            taskKey,
            traceId,
            previousPreset: route.presetName,
            previousModel: route.modelRef,
            currentPreset: currentRoute.presetName,
            currentModel: currentRoute.modelRef,
        });

        route = currentRoute;
        presetRefreshCount += 1;
        retryUsed = true;
        attempt += 1;
        stage = 'retry';
        return true;
    };

    while (true) {
        try {
            const response = await createChatCompletionWithModel(
                taskKey,
                params,
                route.presetName,
                route.modelRef,
                traceId,
                attempt,
                stage,
            );
            return { response, route, attempt, stage };
        } catch (error) {
            const diagnostics = classifyAiError(error);

            if (!diagnostics.retryable) {
                if (!allowsCrossProviderFallback(route.presetName)) throw error;
                return createFallbackExecution(taskKey, params, error, route, traceId, attempt + 1);
            }

            // Фоновая задача могла начаться до смены preset-а из админки.
            if (await switchToCurrentRoute()) continue;

            if (retryUsed) {
                if (!allowsCrossProviderFallback(route.presetName)) throw error;
                return createFallbackExecution(taskKey, params, error, route, traceId, attempt + 1);
            }

            await maybeDelayRetry(route.presetName, taskKey, route.modelRef, attempt + 1, error);

            // Preset мог измениться во время backoff-задержки.
            if (await switchToCurrentRoute()) continue;

            retryUsed = true;
            attempt += 1;
            stage = 'retry';
        }
    }
}

export async function createChatCompletionForTask(
    taskKey: AiTaskKey,
    params: ChatCompletionParamsWithoutModel,
): Promise<ChatCompletion> {
    const trace = createAiExecutionTrace();
    const execution = await createChatCompletionForTaskWithTrace(taskKey, params, trace.traceId);
    return execution.response;
}

async function createFallbackExecution(
    taskKey: AiTaskKey,
    params: ChatCompletionParamsWithoutModel,
    originalError: unknown,
    route: AiTaskRoute,
    traceId: string,
    attempt: number,
): Promise<AiExecutionResult> {
    const fallbackModel = getTaskFallbackModel(taskKey);
    const response = await createFallbackChatCompletion(
        taskKey,
        params,
        originalError,
        route.presetName,
        traceId,
        attempt,
    );
    return {
        response,
        route: { presetName: route.presetName, modelRef: fallbackModel },
        attempt,
        stage: 'fallback',
    };
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
    const execution = await createChatCompletionForTaskWithTrace(taskKey, params, trace.traceId);
    const content = execution.response.choices[0]?.message?.content || '';
    const parsed = parseLLMJson<T>(content);
    if (parsed) return parsed;

    const invalidJsonError = new Error('AI response contained invalid JSON');
    if (!allowsCrossProviderFallback(execution.route.presetName)) {
        recordJsonResolutionFailure(
            taskKey,
            execution.route.presetName,
            execution.route.modelRef,
            trace.traceId,
            execution.attempt,
            execution.stage,
            invalidJsonError,
            false,
        );
        return null;
    }

    try {
        const fallbackResponse = await createFallbackChatCompletion(
            taskKey,
            params,
            invalidJsonError,
            'json-parse-fallback',
            trace.traceId,
            execution.attempt + 1,
        );
        const fallbackParsed = parseLLMJson<T>(fallbackResponse.choices[0]?.message?.content || '');
        if (fallbackParsed) {
            return fallbackParsed;
        }

        const fallbackModel = getTaskFallbackModel(taskKey);
        recordJsonResolutionFailure(
            taskKey,
            execution.route.presetName,
            fallbackModel,
            trace.traceId,
            execution.attempt + 1,
            'fallback',
            invalidJsonError,
            true,
        );
        return null;
    } catch (error) {
        console.warn('[AI JSON fallback failed]', { taskKey, error });
        return null;
    }
}
export { getTaskFallbackModel as getFallbackModel } from './runtimeSupport';
