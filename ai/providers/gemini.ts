import path from 'path';
import { readFile, stat } from 'fs/promises';
import { OpenAI } from 'openai';
import { getAiProviderDescriptor } from '../providerMetadata';
import type { AiModelRef } from '../modelPresets';
import type { AiProviderAdapter, AiProviderCapabilities, EmbeddingResult, ResponseResult, RetryPolicy } from './types';
import providerCapabilityOverrides from '../provider-capability-overrides.json';
import {
    applyChatTokenParamMode,
    filterAllowedChatParams,
    resolveModelCapabilities,
    type ResponseCreateParams,
} from './types';
import {
    buildFlattenedPromptFromResponsesInput,
    convertResponsesInputToChatMessages,
    extractSystemInstructionFromResponsesInput,
} from '../responseCompat';

const GEMINI_CHAT_COMPLETION_ALLOWED_PARAMS = new Set([
    'messages',
    'temperature',
    'top_p',
    'max_tokens',
    'n',
    'stop',
    'stream',
    'response_format',
    'tools',
    'tool_choice',
    'seed',
    'presence_penalty',
    'frequency_penalty',
]);

const GEMINI_MODELS_WITHOUT_SAMPLING_PARAMS = new Set([
    'gemini-3.5-flash',
    'gemini-3.6-flash',
    'gemini-3.5-flash-lite',
]);

const GEMINI_CAPABILITIES: AiProviderCapabilities = {
    supportsOpenAiCompatibleTransport: false,
    defaultModelCapabilities: {
        chatTokenParam: 'max_tokens',
        supportsChatCompletions: true,
        supportsResponsesApi: true,
        supportsEmbedding: false,
        supportsTranscription: false,
        supportsVision: true,
        supportsFunctionCalling: true,
        supportsThinkingMode: false,
        supportsReasoningEffort: false,
        supportsPromptCaching: false,
        supportsOpenAiCompatibleTransport: false,
    },
    modelCapabilityOverrides: providerCapabilityOverrides.gemini,
    allowedChatParams: GEMINI_CHAT_COMPLETION_ALLOWED_PARAMS,
};

const DEFAULT_GEMINI_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_GEMINI_FILE_TIMEOUT_MS = 300_000;
const GEMINI_FILE_CLEANUP_RECOVERY_TIMEOUT_MS = 5_000;
const DEFAULT_GEMINI_QUEUE_TIMEOUT_MS = 20_000;
// Base64 увеличивает payload примерно на треть. 12 MiB оставляют запас до
// документированного лимита 20 MB на весь inline-запрос вместе с prompt.
const GEMINI_INLINE_AUDIO_MAX_BYTES = 12 * 1024 * 1024;

function getGeminiRequestTimeoutMs(): number {
    const configured = Number(process.env.AI_GEMINI_REQUEST_TIMEOUT_MS);
    return Number.isFinite(configured) && configured >= 1_000
        ? Math.floor(configured)
        : DEFAULT_GEMINI_REQUEST_TIMEOUT_MS;
}

function getGeminiFileTimeoutMs(): number {
    const configured = Number(process.env.AI_GEMINI_FILE_TIMEOUT_MS);
    return Number.isFinite(configured) && configured >= 1_000
        ? Math.floor(configured)
        : DEFAULT_GEMINI_FILE_TIMEOUT_MS;
}

function getGeminiQueueTimeoutMs(): number {
    const configured = Number(process.env.AI_GEMINI_QUEUE_TIMEOUT_MS);
    return Number.isFinite(configured) && configured >= 10
        ? Math.floor(configured)
        : DEFAULT_GEMINI_QUEUE_TIMEOUT_MS;
}

function getGeminiAbortSignal(timeoutMs = getGeminiRequestTimeoutMs()): AbortSignal {
    return AbortSignal.timeout(timeoutMs);
}

const geminiClient = new OpenAI({
    apiKey: process.env.GEMINI_API_KEY || 'missing-gemini-api-key',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    maxRetries: 0,
    timeout: getGeminiRequestTimeoutMs(),
});

const DEFAULT_GEMINI_MAX_CONCURRENT = 8;
const DEFAULT_GEMINI_MAX_QUEUE = 100;
let activeGeminiRequests = 0;
const queuedGeminiRequests: Array<{
    resolve: () => void;
    reject: (error: unknown) => void;
    timeoutId: ReturnType<typeof setTimeout>;
    operationSignal?: AbortSignal;
    abortListener?: () => void;
}> = [];

function getGeminiMaxConcurrent(): number {
    const configured = Number(process.env.AI_GEMINI_MAX_CONCURRENT);
    return Number.isFinite(configured) && configured > 0
        ? Math.max(1, Math.floor(configured))
        : DEFAULT_GEMINI_MAX_CONCURRENT;
}

function getGeminiMaxQueue(): number {
    const configured = Number(process.env.AI_GEMINI_MAX_QUEUE);
    return Number.isFinite(configured) && configured >= 0
        ? Math.floor(configured)
        : DEFAULT_GEMINI_MAX_QUEUE;
}

// ─── Retry-политика Gemini ───────────────────────────────────────────────────
// Gemini периодически возвращает 503 (перегрузка) и 429. Несколько повторов с
// экспоненциальным backoff сглаживают краткие сбои; конкретные rate limits
// зависят от модели и usage tier. Значения живут здесь, в провайдере, а не в
// общем execution-flow через ветвление по пресету.
const DEFAULT_GEMINI_RETRY_BASE_DELAY_MS = 1000;
const DEFAULT_GEMINI_RETRY_MAX_DELAY_MS = 15_000;
const DEFAULT_GEMINI_RETRY_MAX_ATTEMPTS = 3;

function getGeminiRetryBaseDelayMs(): number {
    const configured = Number(process.env.AI_GEMINI_RETRY_BASE_DELAY_MS);
    return Number.isFinite(configured) && configured >= 1
        ? Math.floor(configured)
        : DEFAULT_GEMINI_RETRY_BASE_DELAY_MS;
}

function getGeminiRetryMaxDelayMs(): number {
    const configured = Number(process.env.AI_GEMINI_RETRY_MAX_DELAY_MS);
    return Number.isFinite(configured) && configured >= 1
        ? Math.floor(configured)
        : DEFAULT_GEMINI_RETRY_MAX_DELAY_MS;
}

function getGeminiRetryMaxAttempts(): number {
    const configured = Number(process.env.AI_GEMINI_RETRY_MAX_ATTEMPTS);
    return Number.isFinite(configured) && configured >= 0
        ? Math.floor(configured)
        : DEFAULT_GEMINI_RETRY_MAX_ATTEMPTS;
}

function getGeminiRetryDelayMs(attempt: number): number {
    const baseDelay = getGeminiRetryBaseDelayMs();
    const maxDelay = Math.max(baseDelay, getGeminiRetryMaxDelayMs());
    const exponentialDelay = Math.min(maxDelay, baseDelay * Math.pow(2, Math.max(0, attempt - 1)));
    const jitterMultiplier = 0.85 + Math.random() * 0.3;
    return Math.max(1, Math.round(exponentialDelay * jitterMultiplier));
}

function buildGeminiRetryPolicy(): RetryPolicy {
    return {
        enabled: true,
        maxAttempts: getGeminiRetryMaxAttempts(),
        getDelayMs: getGeminiRetryDelayMs,
    };
}

// ─── Same-provider degradation chain ─────────────────────────────────────────
// При отказе модели Gemini execution-flow спрашивает у провайдера цепочку
// моделей того же провайдера: heavy → flash-lite → более дешёвая flash-lite.
// Все модели GA и подтверждены актуальными на июль 2026.
const GEMINI_DEGRADATION_CHAIN: ReadonlyArray<AiModelRef> = [
    { provider: 'gemini', model: 'gemini-3.5-flash-lite' },
    { provider: 'gemini', model: 'gemini-3.1-flash-lite' },
    { provider: 'gemini', model: 'gemini-2.5-flash-lite' },
];

function getGeminiDegradationChain(currentModel: string): AiModelRef[] {
    const currentIndex = GEMINI_DEGRADATION_CHAIN.findIndex((entry) => entry.model === currentModel);
    return currentIndex === -1
        ? [...GEMINI_DEGRADATION_CHAIN]
        : GEMINI_DEGRADATION_CHAIN.slice(currentIndex + 1);
}

function omitUnsupportedGeminiParams<T extends Record<string, any>>(
    model: string,
    params: T,
): T {
    if (!GEMINI_MODELS_WITHOUT_SAMPLING_PARAMS.has(model)) {
        return params;
    }

    const normalized = { ...params } as T;
    delete normalized.temperature;
    delete normalized.top_p;
    delete normalized.top_k;
    // OpenAI `n` преобразуется в Gemini candidate_count; новые Gemini 3.x
    // не поддерживают несколько кандидатов и отвечают 400 при значении > 1.
    delete normalized.n;
    return normalized;
}

// ─── Error identity parsing ──────────────────────────────────────────────────
// Gemini шлёт `x-goog-request-id`; общий классификатор ошибок не должен знать
// это имя, поэтому извлечение идентичности запроса живёт в провайдере.
function parseGeminiErrorIdentities(error: unknown): { providerRequestId?: string } {
    const record = error && typeof error === 'object' ? error as Record<string, unknown> : null;
    if (!record) return {};
    const response = record.response && typeof record.response === 'object'
        ? record.response as Record<string, unknown>
        : null;
    const headers = record.headers ?? response?.headers;
    if (!headers || typeof headers !== 'object') return {};
    const headersRecord = headers as Record<string, unknown>;
    const getHeaderValue = (key: string): string | undefined => {
        if (typeof headersRecord.get === 'function') {
            const value = headersRecord.get.call(headers, key);
            if (typeof value === 'string' && value.trim()) return value.trim();
        }
        for (const [headerKey, headerValue] of Object.entries(headersRecord)) {
            if (headerKey.toLowerCase() === key.toLowerCase()) {
                return typeof headerValue === 'string' && headerValue.trim()
                    ? headerValue.trim()
                    : undefined;
            }
        }
        return undefined;
    };
    const providerRequestId = getHeaderValue('x-goog-request-id') ?? getHeaderValue('x-request-id');
    return providerRequestId ? { providerRequestId } : {};
}

async function acquireGeminiRequestSlot(operationSignal?: AbortSignal): Promise<() => void> {
    operationSignal?.throwIfAborted();
    const maxConcurrent = getGeminiMaxConcurrent();
    // Не пропускаем новые запросы перед уже ожидающими в очереди: иначе при
    // постоянном потоке вызовов старые задачи могли голодать.
    if (activeGeminiRequests < maxConcurrent && queuedGeminiRequests.length === 0) {
        activeGeminiRequests += 1;
    } else {
        if (queuedGeminiRequests.length >= getGeminiMaxQueue()) {
            const error = new Error('Gemini request queue is full') as Error & { code?: string; status?: number };
            error.code = 'AI_GEMINI_QUEUE_FULL';
            error.status = 503;
            throw error;
        }
        await new Promise<void>((resolve, reject) => {
            const cleanupWaiter = () => {
                clearTimeout(waiter.timeoutId);
                if (waiter.operationSignal && waiter.abortListener) {
                    waiter.operationSignal.removeEventListener('abort', waiter.abortListener);
                }
            };
            const waiter = {
                resolve: () => {
                    cleanupWaiter();
                    resolve();
                },
                reject: (error: unknown) => {
                    cleanupWaiter();
                    reject(error);
                },
                timeoutId: undefined as unknown as ReturnType<typeof setTimeout>,
                operationSignal,
                abortListener: undefined as (() => void) | undefined,
            };
            waiter.timeoutId = setTimeout(() => {
                const waiterIndex = queuedGeminiRequests.indexOf(waiter);
                if (waiterIndex < 0) return;
                queuedGeminiRequests.splice(waiterIndex, 1);
                const error = new Error('Gemini request queue timed out') as Error & { code?: string; status?: number };
                error.code = 'AI_GEMINI_QUEUE_TIMEOUT';
                error.status = 503;
                waiter.reject(error);
            }, getGeminiQueueTimeoutMs());
            if (operationSignal) {
                waiter.abortListener = () => {
                    const waiterIndex = queuedGeminiRequests.indexOf(waiter);
                    if (waiterIndex < 0) return;
                    queuedGeminiRequests.splice(waiterIndex, 1);
                    waiter.reject(operationSignal.reason);
                };
                operationSignal.addEventListener('abort', waiter.abortListener, { once: true });
            }
            queuedGeminiRequests.push(waiter);
        });
    }

    let released = false;
    return () => {
        if (released) return;
        released = true;
        const next = queuedGeminiRequests.shift();
        if (next) {
            // Передаём уже занятый slot напрямую следующему waiter-у. Если
            // сначала уменьшить active, новый запрос может вклиниться до
            // пробуждения waiter-а и временно превысить concurrency limit.
            next.resolve();
            return;
        }
        activeGeminiRequests = Math.max(0, activeGeminiRequests - 1);
    };
}

async function withGeminiRequestSlot<T>(operation: () => Promise<T>, operationSignal?: AbortSignal): Promise<T> {
    const release = await acquireGeminiRequestSlot(operationSignal);
    try {
        return await operation();
    } finally {
        release();
    }
}

function getGeminiApiKey(): string {
    return process.env.GEMINI_API_KEY || 'missing-gemini-api-key';
}

function buildGeminiError(
    status: number,
    statusText: string,
    responseHeaders: Headers,
    message: string,
): Error & {
    status?: number;
    request_id?: string | null;
    code?: string;
    type?: string;
} {
    const error = new Error(message) as Error & {
        status?: number;
        request_id?: string | null;
        code?: string;
        type?: string;
    };
    error.status = status;
    error.request_id = responseHeaders.get('x-request-id') || responseHeaders.get('x-goog-request-id');
    error.code = status === 503 ? 'service_unavailable' : undefined;
    error.type = statusText || 'GeminiApiError';
    return error;
}

async function parseGeminiError(response: Response, fallbackMessage: string) {
    const body = await response.text().catch(() => '');
    return buildGeminiError(response.status, response.statusText, response.headers, body || fallbackMessage);
}

function extractGeminiInteractionText(payload: Record<string, any>): string {
    if (typeof payload.output_text === 'string') {
        return payload.output_text;
    }

    if (!Array.isArray(payload.steps)) {
        return '';
    }

    return payload.steps
        .flatMap((step: Record<string, any>) => Array.isArray(step.content) ? step.content : [])
        .map((item: Record<string, any>) => typeof item.text === 'string' ? item.text : '')
        .filter(Boolean)
        .join('\n');
}

function buildGeminiInteractionInput(params: ResponseCreateParams): string {
    const messages = convertResponsesInputToChatMessages(params)
        .filter((message) => message.role !== 'system' && message.role !== 'developer');

    if (messages.length === 0) {
        return buildFlattenedPromptFromResponsesInput(params);
    }

    if (messages.length === 1 && messages[0]?.role === 'user' && typeof messages[0].content === 'string') {
        return messages[0].content;
    }

    return messages
        .map((message) => `${message.role.toUpperCase()}:\n${typeof message.content === 'string' ? message.content : ''}`)
        .join('\n\n')
        .trim();
}

function buildGeminiSearchTools(params: ResponseCreateParams): Array<Record<string, unknown>> | undefined {
    if (!Array.isArray(params.tools)) {
        return undefined;
    }

    const hasWebSearchTool = params.tools.some((tool: unknown) => {
        return Boolean(tool && typeof tool === 'object' && (tool as Record<string, unknown>).type === 'web_search_preview');
    });

    return hasWebSearchTool ? [{ type: 'google_search' }] : undefined;
}

function normalizeGeminiEmbeddingDimension(value: number | undefined): number | undefined {
    if (!Number.isFinite(value)) return undefined;
    const normalized = Math.round(Number(value));
    return normalized > 0 ? normalized : undefined;
}

function inferAudioMimeType(filePath: string): string {
    switch (path.extname(filePath).toLowerCase()) {
        case '.wav':
            return 'audio/wav';
        case '.mp3':
        case '.mpeg':
            return 'audio/mpeg';
        case '.aif':
        case '.aiff':
            return 'audio/aiff';
        case '.aac':
            return 'audio/aac';
        case '.ogg':
        case '.oga':
            return 'audio/ogg';
        case '.flac':
            return 'audio/flac';
        default:
            return 'audio/ogg';
    }
}

async function uploadGeminiFile(
    filePath: string,
    mimeType: string,
    operationSignal: AbortSignal,
): Promise<{ name?: string; uri: string; mimeType: string }> {
    const apiKey = getGeminiApiKey();
    const fileStats = await stat(filePath);
    const startResponse = await withGeminiRequestSlot(() => fetch('https://generativelanguage.googleapis.com/upload/v1beta/files', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey,
            'X-Goog-Upload-Protocol': 'resumable',
            'X-Goog-Upload-Command': 'start',
            'X-Goog-Upload-Header-Content-Length': String(fileStats.size),
            'X-Goog-Upload-Header-Content-Type': mimeType,
        },
        body: JSON.stringify({
            file: {
                display_name: path.basename(filePath),
            },
        }),
        signal: operationSignal,
    }), operationSignal);

    if (!startResponse.ok) {
        throw await parseGeminiError(startResponse, 'Gemini file upload start failed');
    }

    const uploadUrl = startResponse.headers.get('x-goog-upload-url');
    if (!uploadUrl) {
        throw buildGeminiError(
            startResponse.status,
            startResponse.statusText,
            startResponse.headers,
            'Gemini file upload did not return x-goog-upload-url',
        );
    }

    const bytes = await readFile(filePath, { signal: operationSignal });
    const finalizeResponse = await withGeminiRequestSlot(() => fetch(uploadUrl, {
        method: 'POST',
        headers: {
            'Content-Length': String(bytes.byteLength),
            'X-Goog-Upload-Offset': '0',
            'X-Goog-Upload-Command': 'upload, finalize',
        },
        body: new Uint8Array(bytes),
        signal: operationSignal,
    }), operationSignal);

    if (!finalizeResponse.ok) {
        throw await parseGeminiError(finalizeResponse, 'Gemini file upload finalize failed');
    }

    const payload = await finalizeResponse.json() as Record<string, any>;
    const filePayload = payload.file as Record<string, any> | undefined;
    const uri = typeof filePayload?.uri === 'string' ? filePayload.uri : null;
    const uploadedMimeType = typeof filePayload?.mimeType === 'string'
        ? filePayload.mimeType
        : typeof filePayload?.mime_type === 'string'
            ? filePayload.mime_type
            : mimeType;

    if (!uri) {
        throw buildGeminiError(
            finalizeResponse.status,
            finalizeResponse.statusText,
            finalizeResponse.headers,
            'Gemini file upload did not return file.uri',
        );
    }

    return {
        name: typeof filePayload?.name === 'string' ? filePayload.name : undefined,
        uri,
        mimeType: uploadedMimeType,
    };
}

async function deleteGeminiFile(fileName: string | undefined, operationSignal: AbortSignal): Promise<void> {
    if (!fileName) {
        return;
    }

    const encodedSegments = fileName
        .split('/')
        .map((segment) => encodeURIComponent(segment))
        .join('/');
    // Тот же signal ограничивает и ожидание slot, и DELETE: queue timeout не
    // может растянуть cleanup дольше короткого recovery deadline.
    const response = await withGeminiRequestSlot(() => fetch(`https://generativelanguage.googleapis.com/v1beta/${encodedSegments}`, {
        method: 'DELETE',
        headers: {
            'x-goog-api-key': getGeminiApiKey(),
        },
        signal: operationSignal,
    }), operationSignal);

    if (!response.ok && response.status !== 404) {
        throw await parseGeminiError(response, `Gemini file delete failed with status ${response.status}`);
    }
}

async function requestGeminiTranscription(
    model: string,
    audio: { data: string; mime_type: string } | { uri: string; mime_type: string },
    language: string | undefined,
    operationSignal: AbortSignal,
): Promise<{ text: string }> {
    const languageHint = language ? ` in ${language}` : '';
    const response = await fetch('https://generativelanguage.googleapis.com/v1/interactions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': getGeminiApiKey(),
        },
        body: JSON.stringify({
            model,
            store: false,
            input: [
                {
                    type: 'text',
                    text: `Transcribe this audio file${languageHint}. Return only the transcript text without commentary.`,
                },
                { type: 'audio', ...audio },
            ],
        }),
        signal: operationSignal,
    });

    if (!response.ok) {
        throw await parseGeminiError(response, `Gemini transcription failed with status ${response.status}`);
    }

    const payload = await response.json() as Record<string, any>;
    return { text: extractGeminiInteractionText(payload).trim() };
}

export const geminiProviderAdapter: AiProviderAdapter = {
    provider: 'gemini',
    client: geminiClient,
    capabilities: GEMINI_CAPABILITIES,
    descriptor: getAiProviderDescriptor('gemini'),
    getModelCapabilities(model) {
        return resolveModelCapabilities(GEMINI_CAPABILITIES, model);
    },
    normalizeChatParams(model, params) {
        const capabilities = this.getModelCapabilities(model);
        const normalized = applyChatTokenParamMode(params, capabilities.chatTokenParam);

        if (!this.capabilities.allowedChatParams) {
            return normalized;
        }

        return omitUnsupportedGeminiParams(
            model,
            filterAllowedChatParams(normalized, this.capabilities.allowedChatParams),
        );
    },
    async createChatCompletion(model, params) {
        return withGeminiRequestSlot(() => this.client.chat.completions.create({
            ...this.normalizeChatParams(model, params),
            model,
        }));
    },
    async createResponse(model, params) {
        return withGeminiRequestSlot(async () => {
            const apiKey = getGeminiApiKey();
            const interactionInput = buildGeminiInteractionInput(params);
            const systemInstruction = extractSystemInstructionFromResponsesInput(params);
            const tools = buildGeminiSearchTools(params);
            const generationConfig: Record<string, unknown> = {};

            const normalizedGenerationParams = omitUnsupportedGeminiParams(model, params);
            if (typeof normalizedGenerationParams.temperature === 'number') {
                generationConfig.temperature = normalizedGenerationParams.temperature;
            }
            if (typeof normalizedGenerationParams.top_p === 'number') {
                generationConfig.top_p = normalizedGenerationParams.top_p;
            }
            if (typeof params.max_output_tokens === 'number') {
                generationConfig.max_output_tokens = params.max_output_tokens;
            }

            const response = await fetch('https://generativelanguage.googleapis.com/v1/interactions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-goog-api-key': apiKey,
                },
                body: JSON.stringify({
                    model,
                    store: false,
                    input: interactionInput,
                    ...(systemInstruction ? { system_instruction: systemInstruction } : {}),
                    ...(tools ? { tools } : {}),
                    ...(Object.keys(generationConfig).length > 0 ? { generation_config: generationConfig } : {}),
                }),
                signal: getGeminiAbortSignal(),
            });

            if (!response.ok) {
                throw await parseGeminiError(response, `Gemini interactions failed with status ${response.status}`);
            }

            const payload = await response.json() as Record<string, any>;
            const interactionUsage = payload.usage as Record<string, any> | undefined;
            const legacyUsage = payload.usage_metadata as Record<string, any> | undefined;

            return {
                id: payload.id || payload.name || 'gemini-interaction',
                object: 'response',
                model,
                output_text: extractGeminiInteractionText(payload),
                usage: interactionUsage ? {
                    input_tokens: interactionUsage.total_input_tokens,
                    output_tokens: interactionUsage.total_output_tokens,
                    total_tokens: interactionUsage.total_tokens,
                } : legacyUsage ? {
                    input_tokens: legacyUsage.prompt_token_count,
                    output_tokens: legacyUsage.candidates_token_count,
                    total_tokens: legacyUsage.total_token_count,
                } : undefined,
            } as ResponseResult;
        });
    },
    async createEmbedding(model, params) {
        const capabilities = this.getModelCapabilities(model);
        if (!capabilities.supportsEmbedding) {
            throw new Error(`Provider ${this.provider} does not support embeddings`);
        }

        if (Array.isArray(params.input)) {
            throw new Error('Gemini embedding adapter expects a single input string in this runtime');
        }

        const response = await withGeminiRequestSlot(() => fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-goog-api-key': getGeminiApiKey(),
            },
            body: JSON.stringify({
                model: `models/${model}`,
                content: {
                    parts: [{ text: params.input }],
                },
                output_dimensionality: normalizeGeminiEmbeddingDimension(params.outputDimension),
            }),
            signal: getGeminiAbortSignal(),
        }));

        if (!response.ok) {
            throw await parseGeminiError(response, `Gemini embeddings failed with status ${response.status}`);
        }

        const payload = await response.json() as Record<string, any>;
        const values = Array.isArray(payload.embedding?.values)
            ? payload.embedding.values
            : Array.isArray(payload.embeddings?.[0]?.values)
                ? payload.embeddings[0].values
                : [];

        return {
            embedding: values,
            rawUsage: payload.usage_metadata ? {
                inputTokens: payload.usage_metadata.prompt_token_count,
                outputTokens: payload.usage_metadata.candidates_token_count,
                totalTokens: payload.usage_metadata.total_token_count,
            } : undefined,
        } as EmbeddingResult;
    },
    async createTranscription(model, params) {
        const capabilities = this.getModelCapabilities(model);
        if (!capabilities.supportsTranscription) {
            throw new Error(`Provider ${this.provider} does not support transcription`);
        }

        const filePath = typeof params.file.path === 'string' ? params.file.path : null;
        if (!filePath) {
            throw new Error('Gemini transcription expects a file path-backed stream');
        }

        const mimeType = inferAudioMimeType(filePath);
        // Один signal ограничивает upload + inference, а не каждый HTTP-шаг
        // отдельно. Cleanup ниже получает собственное короткое recovery-окно.
        const operationSignal = getGeminiAbortSignal(getGeminiFileTimeoutMs());
        const fileStats = await stat(filePath);
        if (fileStats.size <= GEMINI_INLINE_AUDIO_MAX_BYTES) {
            // Чтение и base64 живут внутри semaphore slot: очередь из коротких
            // файлов не должна одновременно занимать память до допуска к HTTP.
            return withGeminiRequestSlot(async () => {
                const bytes = await readFile(filePath, { signal: operationSignal });
                return requestGeminiTranscription(model, {
                    data: bytes.toString('base64'),
                    mime_type: mimeType,
                }, params.language, operationSignal);
            }, operationSignal);
        }

        const uploadedFile = await uploadGeminiFile(filePath, mimeType, operationSignal);
        try {
            return await withGeminiRequestSlot(() => requestGeminiTranscription(model, {
                uri: uploadedFile.uri,
                mime_type: uploadedFile.mimeType,
            }, params.language, operationSignal), operationSignal);
        } finally {
            try {
                // Cleanup всегда получает независимое короткое окно: основной
                // signal может истечь уже во время DELETE, а не до его начала.
                const cleanupSignal = getGeminiAbortSignal(GEMINI_FILE_CLEANUP_RECOVERY_TIMEOUT_MS);
                await deleteGeminiFile(uploadedFile.name, cleanupSignal);
            } catch (cleanupError) {
                console.warn('[AI Gemini file cleanup failed]', {
                    fileName: uploadedFile.name,
                    cleanupError: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
                });
            }
        }
    },
    getRetryPolicy: buildGeminiRetryPolicy,
    getSameProviderDegradationChain(context) {
        return getGeminiDegradationChain(context.currentModel);
    },
    parseErrorIdentities: parseGeminiErrorIdentities,
};
