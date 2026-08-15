import type { AiModelRef, AiPresetName, AiTaskKey } from './modelPresets';
import { classifyAiError } from './errorDiagnostics';
import { getSameProviderDegradedModel } from './runtimeSupport';
import { logDegradedFailure, logDegradedStart, logDegradedSuccess } from './degradedLogging';
import { getAiProviderAdapter } from './providers/registry';

/**
 * Callback выполнения одной degraded-модели. Caller (chat/response)
 * передаёт свою реализацию, логирующую usage и вызывающую соответствующий
 * метод адаптера. Должен бросать ошибку при отказе модели.
 */
export type ExecuteDegradedModel<T> = (
    degradedModel: AiModelRef,
    attempt: number,
) => Promise<T>;

export interface DegradationChainLogContext {
    taskKey: AiTaskKey;
    traceId: string;
    previousModel: AiModelRef;
}

/**
 * Проходит same-provider degradation chain: пока есть неиспробованные модели,
 * пробует следующее дно. При успехе возвращает результат, при отказе текущего
 * дна — логирует FAILED и переходит к следующему. Когда цепочка исчерпана —
 * пробрасывает последнюю ошибку (это дно контура для true-full пресета).
 *
 * Общий алгоритм для chat/response: устраняет копипасту и
 * гарантирует единообразное поведение (раньше только chat ходил по цепочке,
 * а response делал single-shot degradation). Transcription намеренно использует
 * отдельный ограниченный file-flow без model degradation chain.
 *
 * @returns результат успешного дна и обновлённый attempt-счётчик.
 * @throws последнюю ошибку, если вся цепочка исчерпана.
 */
export async function runSameProviderDegradationChain<T>(
    presetName: AiPresetName | string,
    previousModel: AiModelRef,
    triedModels: Set<string>,
    startAttempt: number,
    originalError: unknown,
    logContext: DegradationChainLogContext,
    executeModel: ExecuteDegradedModel<T>,
): Promise<{ result: T; attempt: number; model: AiModelRef }> {
    let lastFailedModel = previousModel;
    let attempt = startAttempt;
    let lastError = originalError;

    while (true) {
        const nextDegraded = getSameProviderDegradedModel(
            presetName,
            lastFailedModel,
            classifyAiError(lastError).retryable,
            triedModels,
        );
        if (!nextDegraded) {
            throw lastError;
        }
        triedModels.add(nextDegraded.model);
        attempt += 1;

        const stepLogContext = {
            taskKey: logContext.taskKey,
            traceId: logContext.traceId,
            previousModel: lastFailedModel,
            degradedModel: nextDegraded,
            attempt,
        };
        const previousAdapter = getAiProviderAdapter(lastFailedModel.provider);
        const previousErrorParser = previousAdapter.parseErrorIdentities?.bind(previousAdapter);
        logDegradedStart(stepLogContext, lastError, previousErrorParser);
        const startedAt = Date.now();
        try {
            const result = await executeModel(nextDegraded, attempt);
            logDegradedSuccess(stepLogContext, Date.now() - startedAt);
            return { result, attempt, model: nextDegraded };
        } catch (error) {
            const degradedAdapter = getAiProviderAdapter(nextDegraded.provider);
            const degradedErrorParser = degradedAdapter.parseErrorIdentities?.bind(degradedAdapter);
            logDegradedFailure(stepLogContext, error, Date.now() - startedAt, degradedErrorParser);
            lastFailedModel = nextDegraded;
            lastError = error;
            // Цикл продолжится: попробует следующее дно chain, либо выбросит
            // lastError, когда цепочка иссякнет.
        }
    }
}
