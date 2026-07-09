import path from 'path';
import { readFile, stat } from 'fs/promises';
import { OpenAI } from 'openai';
import { getAiProviderDescriptor } from '../providerMetadata';
import type { AiProviderAdapter, AiProviderCapabilities, EmbeddingResult, ResponseResult } from './types';
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

const geminiClient = new OpenAI({
    apiKey: process.env.GEMINI_API_KEY || 'missing-gemini-api-key',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
});

const DEFAULT_GEMINI_MAX_CONCURRENT = 2;
const DEFAULT_GEMINI_MAX_QUEUE = 100;
let activeGeminiRequests = 0;
const queuedGeminiRequests: Array<{
    resolve: () => void;
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

async function acquireGeminiRequestSlot(): Promise<() => void> {
    const maxConcurrent = getGeminiMaxConcurrent();
    // Не пропускаем новые запросы перед уже ожидающими в очереди: иначе при
    // постоянном потоке вызовов старые задачи могли голодать.
    if (activeGeminiRequests < maxConcurrent && queuedGeminiRequests.length === 0) {
        activeGeminiRequests += 1;
    } else {
        if (queuedGeminiRequests.length >= getGeminiMaxQueue()) {
            const error = new Error('Gemini request queue is full') as Error & { code?: string };
            error.code = 'AI_GEMINI_QUEUE_FULL';
            throw error;
        }
        await new Promise<void>((resolve) => queuedGeminiRequests.push({ resolve }));
        activeGeminiRequests += 1;
    }

    let released = false;
    return () => {
        if (released) return;
        released = true;
        activeGeminiRequests = Math.max(0, activeGeminiRequests - 1);
        const next = queuedGeminiRequests.shift();
        if (next) next.resolve();
    };
}

async function withGeminiRequestSlot<T>(operation: () => Promise<T>): Promise<T> {
    const release = await acquireGeminiRequestSlot();
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

async function uploadGeminiFile(filePath: string, mimeType: string): Promise<{ name?: string; uri: string; mimeType: string }> {
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
    }));

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

    const bytes = await readFile(filePath);
    const finalizeResponse = await withGeminiRequestSlot(() => fetch(uploadUrl, {
        method: 'POST',
        headers: {
            'Content-Length': String(bytes.byteLength),
            'X-Goog-Upload-Offset': '0',
            'X-Goog-Upload-Command': 'upload, finalize',
        },
        body: new Uint8Array(bytes),
    }));

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

async function deleteGeminiFile(fileName: string | undefined): Promise<void> {
    if (!fileName) {
        return;
    }

    const encodedSegments = fileName
        .split('/')
        .map((segment) => encodeURIComponent(segment))
        .join('/');
    const response = await withGeminiRequestSlot(() => fetch(`https://generativelanguage.googleapis.com/v1beta/${encodedSegments}`, {
        method: 'DELETE',
        headers: {
            'x-goog-api-key': getGeminiApiKey(),
        },
    }));

    if (!response.ok && response.status !== 404) {
        throw await parseGeminiError(response, `Gemini file delete failed with status ${response.status}`);
    }
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

        return filterAllowedChatParams(normalized, this.capabilities.allowedChatParams);
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

            if (typeof params.temperature === 'number') {
                generationConfig.temperature = params.temperature;
            }
            if (typeof params.top_p === 'number') {
                generationConfig.top_p = params.top_p;
            }
            if (typeof params.max_output_tokens === 'number') {
                generationConfig.max_output_tokens = params.max_output_tokens;
            }

            const response = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-goog-api-key': apiKey,
                },
                body: JSON.stringify({
                    model,
                    input: interactionInput,
                    ...(systemInstruction ? { system_instruction: systemInstruction } : {}),
                    ...(tools ? { tools } : {}),
                    ...(Object.keys(generationConfig).length > 0 ? { generation_config: generationConfig } : {}),
                }),
            });

            if (!response.ok) {
                throw await parseGeminiError(response, `Gemini interactions failed with status ${response.status}`);
            }

            const payload = await response.json() as Record<string, any>;

            return {
                id: payload.id || payload.name || 'gemini-interaction',
                object: 'response',
                model,
                output_text: extractGeminiInteractionText(payload),
                usage: payload.usage_metadata ? {
                    input_tokens: payload.usage_metadata.prompt_token_count,
                    output_tokens: payload.usage_metadata.candidates_token_count,
                    total_tokens: payload.usage_metadata.total_token_count,
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
        const uploadedFile = await uploadGeminiFile(filePath, mimeType);
        try {
            const languageHint = params.language ? ` in ${params.language}` : '';
            const response = await withGeminiRequestSlot(() => fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-goog-api-key': getGeminiApiKey(),
                },
                body: JSON.stringify({
                    model,
                    input: [
                        {
                            type: 'text',
                            text: `Transcribe this audio file${languageHint}. Return only the transcript text without commentary.`,
                        },
                        {
                            type: 'audio',
                            uri: uploadedFile.uri,
                            mime_type: uploadedFile.mimeType,
                        },
                    ],
                }),
            }));

                if (!response.ok) {
                    throw await parseGeminiError(response, `Gemini transcription failed with status ${response.status}`);
                }

            const payload = await response.json() as Record<string, any>;
            return {
                text: extractGeminiInteractionText(payload).trim(),
            };
        } finally {
            try {
                await deleteGeminiFile(uploadedFile.name);
            } catch (cleanupError) {
                console.warn('[AI Gemini file cleanup failed]', {
                    fileName: uploadedFile.name,
                    cleanupError: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
                });
            }
        }
    },
};
