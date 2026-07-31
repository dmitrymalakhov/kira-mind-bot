import { resolveModelForTaskAsync, resolveModelForTaskFreshAsync } from './modelResolver';
import type { AiModelRef, AiPresetName, AiTaskKey } from './modelPresets';
import { logAiUsage } from '../services/aiUsageLogService';
import { getAiProviderAdapter } from './providers/registry';
import type {
    ChatCompletion,
    ChatCompletionParamsWithoutModel,
    RetryPolicy,
} from './providers/types';
import { classifyAiError, classifyAiErrorForProvider, buildSafeAiErrorLog, buildSafeAiErrorLogForProvider, createAiExecutionTrace, type AiExecutionStage } from './errorDiagnostics';
import { parseLLMJson } from '../utils';
import { allowsCrossProviderFallback, errorToMessage, getTaskFallbackModel } from './runtimeSupport';
import { resolveRetryPolicy } from './providers/policyDefaults';
import { runSameProviderDegradationChain } from './executionPolicy';

const MAX_PRESET_REFRESHES_PER_REQUEST = 3;

function recordAiUsage(payload: Parameters<typeof logAiUsage>[0]): void {
    void logAiUsage(payload);
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
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

type ErrorIdentityParser = (error: unknown) => { providerRequestId?: string };

function getErrorIdentityParser(modelRef: AiModelRef): ErrorIdentityParser | undefined {
    const adapter = getAiProviderAdapter(modelRef.provider);
    return adapter.parseErrorIdentities?.bind(adapter);
}

function isSameRoute(left: AiTaskRoute, right: AiTaskRoute): boolean {
    return left.presetName === right.presetName
        && left.modelRef.provider === right.modelRef.provider
        && left.modelRef.model === right.modelRef.model;
}

async function maybeDelayRetry(
    policy: RetryPolicy,
    taskKey: AiTaskKey,
    modelRef: AiModelRef,
    retryOrdinal: number,
    executionAttempt: number,
    error: unknown,
): Promise<void> {
    if (!policy.enabled) return;
    const delayMs = policy.getDelayMs(retryOrdinal);
    const diagnostics = classifyAiError(error);
    // Первый retry (попытка 2) — штатная ситуация: провайдер может кратковременно
    // вернуть 503/429/timeout, и короткий backoff её переваривает. Не пишем его
    // в лог: Docker всё равно показывает console.debug. Начиная с попытки 3
    // оставляем warn как индикатор затяжной проблемы провайдера.
    const payload = {
        taskKey,
        provider: modelRef.provider,
        model: modelRef.model,
        attempt: executionAttempt,
        errorStatus: diagnostics.errorStatus,
        errorCategory: diagnostics.errorCategory,
        delayMs,
    };
    // `console.debug` также попадает в docker logs, поэтому первый штатный
    // retry не должен создавать отдельную запись на каждый временный 503.
    // Если ошибка пережила retry, попытка 3 уже остаётся видимой как warn.
    if (executionAttempt >= 3) console.warn('[AI retry scheduled]', payload);
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
    const diagnostics = classifyAiErrorForProvider(error, getErrorIdentityParser(modelRef));
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
    originalErrorParser?: ErrorIdentityParser,
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
        const parseErrorIdentities = providerAdapter.parseErrorIdentities?.bind(providerAdapter);
        const diagnostics = classifyAiErrorForProvider(error, parseErrorIdentities);
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
                originalError: buildSafeAiErrorLogForProvider(originalError, originalErrorParser),
                fallbackError: buildSafeAiErrorLogForProvider(error, parseErrorIdentities),
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
    let presetRefreshCount = 0;
    let primaryRetriesUsed = 0;
    // Модели, уже испробованные в same-provider degradation chain. Защищает от
    // зацикливания и позволяет дойти до следующего дна chain при отказе lite.
    const triedModels = new Set<string>([route.modelRef.model]);
    let lastFailedModel = route.modelRef;

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
        primaryRetriesUsed = 0;
        triedModels.clear();
        triedModels.add(currentRoute.modelRef.model);
        lastFailedModel = currentRoute.modelRef;
        presetRefreshCount += 1;
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
            const diagnostics = classifyAiErrorForProvider(error, getErrorIdentityParser(route.modelRef));

            if (!diagnostics.retryable) {
                if (!allowsCrossProviderFallback(route.presetName)) throw error;
                return createFallbackExecution(taskKey, params, error, route, traceId, attempt + 1);
            }

            // Фоновая задача могла начаться до смены preset-а из админки.
            if (await switchToCurrentRoute()) continue;

            // Retry primary. Базовое поведение — 1 повтор для всех пресетов (legacy).
            // Провайдерная multi-retry-политика применяется только для true-full
            // (без cross-provider подушки) и увеличивает число попыток: так временную
            // перегрузку Gemini можно пережить без немедленного fallback на GPT.
            const crossProviderAllowed = allowsCrossProviderFallback(route.presetName);
            const providerAdapter = getAiProviderAdapter(route.modelRef.provider);
            const policy = crossProviderAllowed
                ? resolveRetryPolicy(undefined)
                : resolveRetryPolicy(providerAdapter.getRetryPolicy, providerAdapter);
            const baselineRetries = 1;
            // Включённая policy является авторитетной, в том числе при нуле:
            // AI_GEMINI_RETRY_MAX_ATTEMPTS=0 должен действительно отключать retry.
            const maxPrimaryRetries = policy.enabled ? policy.maxAttempts : baselineRetries;
            const primaryRetriesRemaining = Math.max(0, maxPrimaryRetries - primaryRetriesUsed);

            if (primaryRetriesRemaining <= 0) {
                if (!allowsCrossProviderFallback(route.presetName)) {
                    // Same-provider degradation: проходим по цепочке моделей того же
                    // провайдера, пока одна не ответит или цепочка не иссякнет.
                    const { result, attempt: degradedAttempt, model: degradedModel } = await runSameProviderDegradationChain<ChatCompletion>(
                        route.presetName,
                        lastFailedModel,
                        triedModels,
                        attempt,
                        error,
                        { taskKey, traceId, previousModel: route.modelRef },
                        (degradedModel, degradedAttempt) => createChatCompletionWithModel(
                            taskKey,
                            params,
                            route.presetName,
                            degradedModel,
                            traceId,
                            degradedAttempt,
                            'fallback',
                        ).then((response) => response),
                    );
                    return {
                        response: result,
                        route: { presetName: route.presetName, modelRef: degradedModel },
                        attempt: degradedAttempt,
                        stage: 'fallback',
                    };
                }
                return createFallbackExecution(taskKey, params, error, route, traceId, attempt + 1);
            }

            await maybeDelayRetry(
                policy,
                taskKey,
                route.modelRef,
                primaryRetriesUsed + 1,
                attempt + 1,
                error,
            );

            // Preset мог измениться во время backoff-задержки.
            if (await switchToCurrentRoute()) continue;

            primaryRetriesUsed += 1;
            attempt += 1;
            stage = 'retry';
            lastFailedModel = route.modelRef;
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
        route.modelRef,
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
    originalModelRef?: AiModelRef,
): Promise<ChatCompletion> {
    const fallbackModel = getTaskFallbackModel(taskKey);
    const originalErrorParser = originalModelRef
        ? getErrorIdentityParser(originalModelRef)
        : undefined;

    console.warn('[AI fallback]', {
        taskKey,
        traceId,
        fallbackModel,
        originalError: originalErrorParser
            ? buildSafeAiErrorLogForProvider(originalError, originalErrorParser)
            : buildSafeAiErrorLog(originalError),
    });

    return createChatCompletionWithModel(
        taskKey,
        params,
        preset,
        fallbackModel,
        traceId,
        attempt,
        'fallback',
        originalError,
        originalErrorParser,
    );
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
