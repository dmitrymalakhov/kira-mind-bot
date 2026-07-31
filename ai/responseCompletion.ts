import { resolveModelForTaskAsync, resolveModelForTaskFreshAsync } from './modelResolver';
import type { AiModelRef, AiTaskKey } from './modelPresets';
import { getAiProviderAdapter } from './providers/registry';
import type {
    ResponseCreateParams,
    ResponseResult,
} from './providers/types';
import { logAiUsage } from '../services/aiUsageLogService';
import { classifyAiErrorForProvider, buildSafeAiErrorLogForProvider, createAiExecutionTrace, type AiExecutionStage } from './errorDiagnostics';
import { allowsCrossProviderFallback, errorToMessage, getTaskFallbackModel } from './runtimeSupport';
import { resolveRetryPolicy } from './providers/policyDefaults';
import { runSameProviderDegradationChain } from './executionPolicy';

const MAX_PRESET_REFRESHES_PER_REQUEST = 3;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function recordAiUsage(payload: Parameters<typeof logAiUsage>[0]): void {
    void logAiUsage(payload);
}

type ErrorIdentityParser = (error: unknown) => { providerRequestId?: string };

function getErrorIdentityParser(modelRef: AiModelRef): ErrorIdentityParser | undefined {
    const adapter = getAiProviderAdapter(modelRef.provider);
    return adapter.parseErrorIdentities?.bind(adapter);
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
    originalErrorParser?: ErrorIdentityParser,
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
        const parseErrorIdentities = providerAdapter.parseErrorIdentities?.bind(providerAdapter);
        const diagnostics = classifyAiErrorForProvider(error, parseErrorIdentities);
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
                originalError: buildSafeAiErrorLogForProvider(originalError, originalErrorParser),
                fallbackError: buildSafeAiErrorLogForProvider(error, parseErrorIdentities),
            });
        }
        throw error;
    }
}

export async function createResponseForTask(
    taskKey: AiTaskKey,
    params: ResponseCreateParams,
): Promise<ResponseResult> {
    let route = await resolveModelForTaskAsync(taskKey);
    const trace = createAiExecutionTrace();

    let attempt = 1;
    let primaryRetriesUsed = 0;
    let presetRefreshCount = 0;
    // Модели, уже испробованные в same-provider degradation chain.
    const triedModels = new Set<string>([route.modelRef.model]);

    const switchToCurrentRoute = async (): Promise<boolean> => {
        const currentRoute = await resolveModelForTaskFreshAsync(taskKey);
        if (currentRoute.presetName === route.presetName
            && currentRoute.modelRef.provider === route.modelRef.provider
            && currentRoute.modelRef.model === route.modelRef.model) {
            return false;
        }
        if (presetRefreshCount >= MAX_PRESET_REFRESHES_PER_REQUEST) {
            throw new Error(`AI preset changed too many times during request: ${taskKey}`);
        }
        route = currentRoute;
        primaryRetriesUsed = 0;
        triedModels.clear();
        triedModels.add(route.modelRef.model);
        attempt += 1;
        presetRefreshCount += 1;
        return true;
    };

    while (true) {
        try {
            return await createResponseWithModel(
                taskKey,
                params,
                route.presetName,
                route.modelRef,
                trace.traceId,
                attempt,
                attempt === 1 ? 'primary' : 'retry',
            );
        } catch (error) {
            const parseErrorIdentities = getErrorIdentityParser(route.modelRef);
            const diagnostics = classifyAiErrorForProvider(error, parseErrorIdentities);

            // Non-retryable: либо проброс (true-full), либо cross-provider fallback.
            if (!diagnostics.retryable) {
                if (!allowsCrossProviderFallback(route.presetName)) throw error;
                const fallbackModel = getTaskFallbackModel(taskKey);
                console.warn('[AI responses fallback]', {
                    taskKey,
                    traceId: trace.traceId,
                    fallbackModel,
                    originalError: buildSafeAiErrorLogForProvider(error, parseErrorIdentities),
                });
                return createResponseWithModel(
                    taskKey,
                    params,
                    route.presetName,
                    fallbackModel,
                    trace.traceId,
                    attempt + 1,
                    'fallback',
                    error,
                    parseErrorIdentities,
                );
            }

            if (await switchToCurrentRoute()) continue;

            const providerAdapter = getAiProviderAdapter(route.modelRef.provider);
            const policy = allowsCrossProviderFallback(route.presetName)
                ? resolveRetryPolicy(undefined)
                : resolveRetryPolicy(providerAdapter.getRetryPolicy, providerAdapter);

            // Retry primary. Базовое поведение — 1 повтор для всех пресетов (legacy).
            const baselineRetries = 1;
            // Включённая policy является авторитетной, в том числе при нуле.
            const maxPrimaryRetries = policy.enabled ? policy.maxAttempts : baselineRetries;
            const primaryRetriesRemaining = Math.max(0, maxPrimaryRetries - primaryRetriesUsed);
            if (primaryRetriesRemaining > 0) {
                if (policy.enabled) await sleep(policy.getDelayMs(primaryRetriesUsed + 1));
                if (await switchToCurrentRoute()) continue;
                primaryRetriesUsed += 1;
                attempt += 1;
                continue;
            }

            // Попытки primary исчерпаны → same-provider degradation chain (true-full)
            // либо cross-provider fallback на GPT (остальные пресеты).
            if (!allowsCrossProviderFallback(route.presetName)) {
                const { result } = await runSameProviderDegradationChain<ResponseResult>(
                    route.presetName,
                    route.modelRef,
                    triedModels,
                    attempt,
                    error,
                    { taskKey, traceId: trace.traceId, previousModel: route.modelRef },
                    (degradedModel, degradedAttempt) => createResponseWithModel(
                        taskKey,
                        params,
                        route.presetName,
                        degradedModel,
                        trace.traceId,
                        degradedAttempt,
                        'fallback',
                    ),
                );
                return result;
            }

            const fallbackModel = getTaskFallbackModel(taskKey);
            console.warn('[AI responses fallback]', {
                taskKey,
                traceId: trace.traceId,
                fallbackModel,
                originalError: buildSafeAiErrorLogForProvider(error, parseErrorIdentities),
            });
            return createResponseWithModel(
                taskKey,
                params,
                route.presetName,
                fallbackModel,
                trace.traceId,
                attempt + 1,
                'fallback',
                error,
                parseErrorIdentities,
            );
        }
    }
}
