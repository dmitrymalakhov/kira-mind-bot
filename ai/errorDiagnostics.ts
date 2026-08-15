import { randomUUID } from 'crypto';

export type AiExecutionStage = 'primary' | 'retry' | 'fallback';

export type AiErrorCategory =
    | 'rate_limit'
    | 'authentication'
    | 'permission'
    | 'invalid_request'
    | 'timeout'
    | 'network'
    | 'provider_unavailable'
    | 'invalid_response'
    | 'unknown';

export interface AiErrorDiagnostics {
    errorStatus?: number;
    errorCode?: string;
    errorType?: string;
    errorCategory: AiErrorCategory;
    providerRequestId?: string;
    retryable: boolean;
}

export interface AiExecutionTrace {
    traceId: string;
}

const RETRYABLE_HTTP_STATUSES = new Set([408, 409, 429, 500, 502, 503, 504]);
const NON_RETRYABLE_HTTP_STATUSES = new Set([400, 401, 403, 404, 422]);
const NETWORK_ERROR_CODES = new Set([
    'ECONNRESET',
    'ECONNREFUSED',
    'ENOTFOUND',
    'EAI_AGAIN',
    'EPIPE',
    'ECONNABORTED',
    'UND_ERR_CONNECT_TIMEOUT',
]);
const TIMEOUT_ERROR_CODES = new Set([
    'ETIMEDOUT',
    'ESOCKETTIMEDOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT',
    'ABORT_ERR',
]);

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function pickString(...values: unknown[]): string | undefined {
    for (const value of values) {
        if (typeof value === 'string' && value.trim()) return value.trim();
        if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    }
    return undefined;
}

function pickNumber(...values: unknown[]): number | undefined {
    for (const value of values) {
        if (typeof value === 'number' && Number.isFinite(value)) return value;
        if (typeof value === 'string' && value.trim()) {
            const parsed = Number(value);
            if (Number.isFinite(parsed)) return parsed;
        }
    }
    return undefined;
}

function getHeaderValue(headers: unknown, key: string): string | undefined {
    if (!headers) return undefined;

    const normalizedKey = key.toLowerCase();
    const headersRecord = asRecord(headers);
    if (headersRecord) {
        for (const [headerKey, headerValue] of Object.entries(headersRecord)) {
            if (headerKey.toLowerCase() === normalizedKey) {
                return pickString(headerValue);
            }
        }
    }

    const headerGetter = asRecord(headers)?.get;
    if (typeof headerGetter === 'function') {
        try {
            return pickString(headerGetter.call(headers, key));
        } catch {
            return undefined;
        }
    }

    return undefined;
}

function detectInvalidResponse(message: string, errorType?: string): boolean {
    const normalized = `${errorType || ''} ${message}`.toLowerCase();
    return normalized.includes('invalid json')
        || normalized.includes('unexpected token')
        || normalized.includes('json parse')
        || normalized.includes('invalid response');
}

function classifyByStatus(status?: number): AiErrorCategory | null {
    if (status === 429) return 'rate_limit';
    if (status === 401) return 'authentication';
    if (status === 403) return 'permission';
    if (status === 400 || status === 404 || status === 422) return 'invalid_request';
    if (status === 408) return 'timeout';
    if (status === 500 || status === 502 || status === 503 || status === 504) return 'provider_unavailable';
    return null;
}

/**
 * Синтетический код ошибки для 5xx-ответов «no body», когда провайдер не вернул
 * ни `code`, ни `type` (типично для Gemini 503 через OpenAI-совместимый
 * endpoint: `503 status code (no body)`). Без этого аналитика AI usage
 * показывала `errorCode = NULL` и не различала такие ошибки.
 *
 * Не влияет на retry/fallback-решения: они опираются на `errorStatus` и
 * `retryable`, а не на `errorCode`.
 */
function inferErrorCodeFromStatus(status?: number): string | undefined {
    if (status === 429) return 'http_429';
    if (status === 500) return 'http_500';
    if (status === 502) return 'http_502';
    if (status === 503) return 'http_503';
    if (status === 504) return 'http_504';
    return undefined;
}

export function createAiExecutionTrace(): AiExecutionTrace {
    return {
        traceId: randomUUID(),
    };
}

export function classifyAiError(error: unknown): AiErrorDiagnostics {
    const record = asRecord(error);
    const nestedError = asRecord(record?.error);
    const response = asRecord(record?.response);

    const errorStatus = pickNumber(
        record?.status,
        record?.statusCode,
        nestedError?.status,
        response?.status,
    );
    const errorCode = pickString(
        record?.code,
        nestedError?.code,
    ) ?? inferErrorCodeFromStatus(errorStatus);
    const errorType = pickString(
        record?.type,
        nestedError?.type,
        record?.name,
    );
    // Универсальные идентификаторы запроса. Провайдер-специфичные заголовки
    // (например, `x-goog-request-id` у Gemini) НЕ захардкожены здесь: их извлекает
    // сам провайдер через `AiProviderAdapter.parseErrorIdentities`, а общий
    // классификатор вызывает `classifyAiErrorForProvider`, чтобы их смержить.
    const providerRequestId = pickString(
        record?.request_id,
        record?.requestId,
        nestedError?.request_id,
        nestedError?.requestId,
        getHeaderValue(record?.headers, 'x-request-id'),
        getHeaderValue(response?.headers, 'x-request-id'),
    );
    const message = pickString(
        record?.message,
        nestedError?.message,
        error instanceof Error ? error.message : undefined,
    ) ?? String(error);

    const normalizedMessage = message.toLowerCase();
    const normalizedCode = (errorCode || '').toUpperCase();
    const normalizedType = (errorType || '').toLowerCase();

    let errorCategory = classifyByStatus(errorStatus) ?? 'unknown';

    if (detectInvalidResponse(message, errorType)) {
        errorCategory = 'invalid_response';
    } else if (TIMEOUT_ERROR_CODES.has(normalizedCode)
        || normalizedType.includes('timeout')
        || normalizedMessage.includes('timed out')
        || normalizedMessage.includes('timeout')) {
        errorCategory = 'timeout';
    } else if (NETWORK_ERROR_CODES.has(normalizedCode)
        || normalizedMessage.includes('fetch failed')
        || normalizedMessage.includes('network')
        || normalizedMessage.includes('socket hang up')
        || normalizedMessage.includes('connection reset')
        || normalizedMessage.includes('connection refused')) {
        errorCategory = 'network';
    }

    const retryable = errorStatus
        ? RETRYABLE_HTTP_STATUSES.has(errorStatus)
        : errorCategory === 'timeout' || errorCategory === 'network';

    if (errorStatus && NON_RETRYABLE_HTTP_STATUSES.has(errorStatus)) {
        return {
            errorStatus,
            errorCode,
            errorType,
            errorCategory,
            providerRequestId,
            retryable: false,
        };
    }

    if (errorCategory === 'invalid_response') {
        return {
            errorStatus,
            errorCode,
            errorType,
            errorCategory,
            providerRequestId,
            retryable: false,
        };
    }

    return {
        errorStatus,
        errorCode,
        errorType,
        errorCategory,
        providerRequestId,
        retryable,
    };
}

export function buildSafeAiErrorLog(error: unknown): Record<string, unknown> {
    const diagnostics = classifyAiError(error);
    return {
        errorStatus: diagnostics.errorStatus,
        errorCode: diagnostics.errorCode,
        errorType: diagnostics.errorType,
        errorCategory: diagnostics.errorCategory,
        providerRequestId: diagnostics.providerRequestId,
        retryable: diagnostics.retryable,
    };
}

/**
 * Классификация ошибки с учётом провайдера.
 *
 * Сначала выполняется универсальная классификация (HTTP-статусы, коды, типы,
 * универсальные идентификаторы запроса), затем — если передан
 * `parseErrorIdentities` адаптера — идентификатор запроса дополняется
 * провайдер-специфичными заголовками (например, `x-goog-request-id` у Gemini).
 * Так общий классификатор не знает имён заголовков конкретных провайдеров и не
 * создаёт цикла импортов: caller передаёт саму функцию адаптера.
 *
 * Функция-парсер опциональна: если не передана или адаптер её не реализовал,
 * поведение идентично {@link classifyAiError}.
 */
export function classifyAiErrorForProvider(
    error: unknown,
    parseErrorIdentities?: (error: unknown) => { providerRequestId?: string },
): AiErrorDiagnostics {
    const diagnostics = classifyAiError(error);
    if (!parseErrorIdentities || diagnostics.providerRequestId) return diagnostics;

    let identities: { providerRequestId?: string } = {};
    try {
        const result = parseErrorIdentities(error);
        identities = result && typeof result === 'object' ? result : {};
    } catch {
        identities = {};
    }
    if (identities.providerRequestId) {
        return { ...diagnostics, providerRequestId: identities.providerRequestId };
    }
    return diagnostics;
}

/**
 * Безопасный лог ошибки с учётом провайдера (см. {@link classifyAiErrorForProvider}).
 */
export function buildSafeAiErrorLogForProvider(
    error: unknown,
    parseErrorIdentities?: (error: unknown) => { providerRequestId?: string },
): Record<string, unknown> {
    const diagnostics = classifyAiErrorForProvider(error, parseErrorIdentities);
    return {
        errorStatus: diagnostics.errorStatus,
        errorCode: diagnostics.errorCode,
        errorType: diagnostics.errorType,
        errorCategory: diagnostics.errorCategory,
        providerRequestId: diagnostics.providerRequestId,
        retryable: diagnostics.retryable,
    };
}
