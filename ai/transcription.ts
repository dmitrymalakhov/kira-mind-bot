import fs from 'fs';
import { resolveModelForTaskAsync, resolveModelForTaskFreshAsync } from './modelResolver';
import type { AiModelRef } from './modelPresets';
import { getAiProviderAdapter } from './providers/registry';
import { classifyAiErrorForProvider, buildSafeAiErrorLogForProvider, createAiExecutionTrace, type AiExecutionStage } from './errorDiagnostics';
import { allowsCrossProviderFallback, getTransitionalTaskFallbackModel, errorToMessage } from './runtimeSupport';
import { resolveRetryPolicy } from './providers/policyDefaults';
import { logAiUsage } from '../services/aiUsageLogService';

const MAX_PRESET_REFRESHES_PER_REQUEST = 3;

function recordAiUsage(payload: Parameters<typeof logAiUsage>[0]): void {
    void logAiUsage(payload);
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

type ErrorIdentityParser = (error: unknown) => { providerRequestId?: string };

function getErrorIdentityParser(modelRef: AiModelRef): ErrorIdentityParser | undefined {
    const adapter = getAiProviderAdapter(modelRef.provider);
    return adapter.parseErrorIdentities?.bind(adapter);
}

async function createTranscriptionWithModel(
    audioFilePath: string,
    preset: string,
    modelRef: AiModelRef,
    traceId: string,
    attempt: number,
    stage: AiExecutionStage,
    originalError?: unknown,
    originalErrorParser?: ErrorIdentityParser,
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
        const parseErrorIdentities = providerAdapter.parseErrorIdentities?.bind(providerAdapter);
        const diagnostics = classifyAiErrorForProvider(error, parseErrorIdentities);
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
                originalError: buildSafeAiErrorLogForProvider(originalError, originalErrorParser),
                fallbackError: buildSafeAiErrorLogForProvider(error, parseErrorIdentities),
            });
        }

        throw error;
    } finally {
        fileStream.destroy();
    }
}

export async function createTranscriptionForTask(audioFilePath: string): Promise<string> {
    let route = await resolveModelForTaskAsync('transcription');
    const trace = createAiExecutionTrace();

    let attempt = 1;
    let primaryRetriesUsed = 0;
    let presetRefreshCount = 0;

    const switchToCurrentRoute = async (): Promise<boolean> => {
        const currentRoute = await resolveModelForTaskFreshAsync('transcription');
        if (currentRoute.presetName === route.presetName
            && currentRoute.modelRef.provider === route.modelRef.provider
            && currentRoute.modelRef.model === route.modelRef.model) {
            return false;
        }
        if (presetRefreshCount >= MAX_PRESET_REFRESHES_PER_REQUEST) {
            throw new Error('AI preset changed too many times during request: transcription');
        }
        route = currentRoute;
        primaryRetriesUsed = 0;
        attempt += 1;
        presetRefreshCount += 1;
        return true;
    };

    while (true) {
        try {
            return await createTranscriptionWithModel(
                audioFilePath,
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
                const fallbackModel = getTransitionalTaskFallbackModel('transcription');
                console.warn('[AI transcription fallback]', {
                    traceId: trace.traceId,
                    fallbackModel,
                    originalError: buildSafeAiErrorLogForProvider(error, parseErrorIdentities),
                });
                return createTranscriptionWithModel(
                    audioFilePath,
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

            // File-flow сохраняет один управляемый retry: повторные upload с
            // пятиминутным file timeout не должны умножать пользовательский deadline.
            const baselineRetries = 1;
            // Истёкший файловый deadline повторять нельзя: это удвоило бы самое
            // длинное ожидание. Быстрые 429/5xx/network-сбои всё ещё получают retry.
            const configuredRetries = policy.enabled
                ? Math.min(baselineRetries, policy.maxAttempts)
                : baselineRetries;
            const maxPrimaryRetries = diagnostics.errorCategory === 'timeout' ? 0 : configuredRetries;
            const primaryRetriesRemaining = Math.max(0, maxPrimaryRetries - primaryRetriesUsed);
            if (primaryRetriesRemaining > 0) {
                if (policy.enabled) await sleep(policy.getDelayMs(primaryRetriesUsed + 1));
                if (await switchToCurrentRoute()) continue;
                primaryRetriesUsed += 1;
                attempt += 1;
                continue;
            }

            // Попытки primary исчерпаны → cross-provider fallback на GPT (true-full
            // для transcription не имеет same-provider degradation: смена модели
            // транскрибации внутри одного провайдера не предусмотрена chain-ом).
            if (!allowsCrossProviderFallback(route.presetName)) {
                throw error;
            }
            const fallbackModel = getTransitionalTaskFallbackModel('transcription');
            console.warn('[AI transcription fallback]', {
                traceId: trace.traceId,
                fallbackModel,
                originalError: buildSafeAiErrorLogForProvider(error, parseErrorIdentities),
            });
            return createTranscriptionWithModel(
                audioFilePath,
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
