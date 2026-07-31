import type { AiModelRef } from '../modelPresets';

/**
 * Политика повторов, которую провайдер возвращает через
 * {@link AiProviderAdapter.getRetryPolicy}.
 *
 * Общий execution-flow спрашивает политику у адаптера, а не ветвится по
 * пресету/провайдеру в общем коде. Если адаптер не переопределяет метод,
 * используется {@link DEFAULT_RETRY_POLICY} (повторы выключены).
 */
export interface RetryPolicy {
    /** Включены ли провайдерные повторные попытки перед degradation/fallback. */
    enabled: boolean;
    /** Число повторов основной модели перед переходом на degradation chain. */
    maxAttempts: number;
    /** Задержка перед повтором с указанным номером попытки (1-индексация). */
    getDelayMs(attempt: number): number;
}

export interface ErrorIdentities {
    /** Идентификатор запроса у провайдера (заголовок/поле), если удалось извлечь. */
    providerRequestId?: string;
}

export interface DegradationContext {
    /** Текущая модель, которая только что упала. */
    currentModel: string;
    /** Категория ошибки из classifyAiError, если нужна для решения. */
    retryable: boolean;
}

/**
 * Политика по умолчанию: повторные попытки выключены.
 *
 * Так ведут себя провайдеры, не переопределяющие `getRetryPolicy` (OpenAI,
 * OpenRouter, Z.ai) — их текущее поведение сохраняется без изменений.
 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
    enabled: false,
    maxAttempts: 0,
    getDelayMs: () => 0,
};

/** Реализация `parseErrorIdentities` по умолчанию: ничего не извлекает. */
export function noopErrorIdentities(): ErrorIdentities {
    return {};
}

/**
 * Безопасно читает retry-политику адаптера с fallback на дефолтную.
 *
 * Возвращает дефолт, если адаптер не реализовал `getRetryPolicy` или
 * реализация выбросила исключение.
 */
export function resolveRetryPolicy(
    getPolicy: (() => RetryPolicy) | undefined,
    receiver?: unknown,
): RetryPolicy {
    if (typeof getPolicy !== 'function') return DEFAULT_RETRY_POLICY;
    try {
        const policy = getPolicy.call(receiver);
        if (!policy || typeof policy !== 'object') return DEFAULT_RETRY_POLICY;
        if (typeof policy.enabled !== 'boolean') return DEFAULT_RETRY_POLICY;
        if (!Number.isFinite(policy.maxAttempts) || policy.maxAttempts < 0) return DEFAULT_RETRY_POLICY;
        if (typeof policy.getDelayMs !== 'function') return DEFAULT_RETRY_POLICY;
        return {
            enabled: policy.enabled,
            maxAttempts: Math.floor(policy.maxAttempts),
            getDelayMs(attempt) {
                try {
                    const delayMs = policy.getDelayMs.call(policy, attempt);
                    return Number.isFinite(delayMs) && delayMs >= 0 ? Math.floor(delayMs) : 0;
                } catch {
                    return 0;
                }
            },
        };
    } catch {
        return DEFAULT_RETRY_POLICY;
    }
}

/**
 * Безопасно читает same-provider degradation chain адаптера.
 *
 * Возвращает пустой массив (нет chain), если адаптер не реализовал метод.
 */
export function resolveDegradationChain(
    getChain: ((context: DegradationContext) => AiModelRef[] | null | undefined) | undefined,
    context: DegradationContext,
    receiver?: unknown,
): AiModelRef[] {
    if (typeof getChain !== 'function') return [];
    try {
        const chain = getChain.call(receiver, context);
        return Array.isArray(chain) ? chain : [];
    } catch {
        return [];
    }
}

/**
 * Безопасно извлекает идентичность ошибки из адаптера.
 */
export function resolveErrorIdentities(
    parseIdentities: ((error: unknown) => ErrorIdentities) | undefined,
    error: unknown,
    receiver?: unknown,
): ErrorIdentities {
    if (typeof parseIdentities !== 'function') return noopErrorIdentities();
    try {
        const identities = parseIdentities.call(receiver, error);
        return identities && typeof identities === 'object'
            ? identities
            : noopErrorIdentities();
    } catch {
        return noopErrorIdentities();
    }
}
