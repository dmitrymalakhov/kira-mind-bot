import type OpenAI from 'openai';
import type { ReadStream } from 'fs';
import type { AiProvider } from '../modelPresets';
import type { AiCapabilityMap, AiProviderDescriptor } from '../providerMetadata';

export type ChatCompletionCreateParams = OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;
export type ChatCompletion = OpenAI.Chat.Completions.ChatCompletion;
export type ChatCompletionParamsWithoutModel = Omit<ChatCompletionCreateParams, 'model'> & Record<string, unknown>;
export type ChatCompletionCreateParamsWithLegacyMaxTokens = ChatCompletionCreateParams & {
    max_tokens?: number;
    max_completion_tokens?: number;
};
export type ProviderNormalizedChatParams = ChatCompletionCreateParamsWithLegacyMaxTokens & Record<string, unknown>;

export type ResponseCreateParams = Omit<OpenAI.Responses.ResponseCreateParamsNonStreaming, 'model'> & Record<string, unknown>;
export type ResponseResult = OpenAI.Responses.Response;
export type EmbeddingCreateParams = {
    input: string | string[];
    outputDimension?: number;
};
export type EmbeddingResult = {
    embedding: number[];
    rawUsage?: {
        inputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
    };
};
export type TranscriptionCreateParams = {
    file: ReadStream;
    language?: string;
    response_format?: 'text';
};
export type TranscriptionResult = {
    text: string;
};

export type AiTokenParamMode = 'max_tokens' | 'max_completion_tokens';

export interface AiModelCapabilities extends AiCapabilityMap {
    chatTokenParam: AiTokenParamMode;
}

export interface AiProviderCapabilities {
    supportsOpenAiCompatibleTransport: boolean;
    defaultModelCapabilities: AiModelCapabilities;
    modelCapabilityOverrides?: Readonly<Record<string, Partial<AiModelCapabilities>>>;
    allowedChatParams?: ReadonlySet<string>;
}

export interface AiProviderAdapter {
    provider: AiProvider;
    descriptor: AiProviderDescriptor;
    client: OpenAI;
    capabilities: AiProviderCapabilities;
    getModelCapabilities(model: string): AiModelCapabilities;
    normalizeChatParams(
        model: string,
        params: ChatCompletionParamsWithoutModel,
    ): ProviderNormalizedChatParams;
    createChatCompletion(
        model: string,
        params: ChatCompletionParamsWithoutModel,
    ): Promise<ChatCompletion>;
    createResponse(
        model: string,
        params: ResponseCreateParams,
    ): Promise<ResponseResult>;
    createEmbedding?(
        model: string,
        params: EmbeddingCreateParams,
    ): Promise<EmbeddingResult>;
    createTranscription?(
        model: string,
        params: TranscriptionCreateParams,
    ): Promise<TranscriptionResult>;
}

export function resolveModelCapabilities(
    capabilities: AiProviderCapabilities,
    model: string,
): AiModelCapabilities {
    const override = capabilities.modelCapabilityOverrides?.[model];
    return {
        ...capabilities.defaultModelCapabilities,
        ...override,
    };
}

export function applyChatTokenParamMode(
    params: ChatCompletionParamsWithoutModel,
    tokenParamMode: AiTokenParamMode,
): ProviderNormalizedChatParams {
    const normalized = { ...params } as ProviderNormalizedChatParams;

    if (tokenParamMode === 'max_completion_tokens') {
        if (normalized.max_completion_tokens === undefined && normalized.max_tokens !== undefined) {
            normalized.max_completion_tokens = normalized.max_tokens;
        }
        delete normalized.max_tokens;
        return normalized;
    }

    if (normalized.max_tokens === undefined && normalized.max_completion_tokens !== undefined) {
        normalized.max_tokens = normalized.max_completion_tokens;
    }
    delete normalized.max_completion_tokens;
    return normalized;
}

export function filterAllowedChatParams(
    params: ProviderNormalizedChatParams,
    allowedChatParams: ReadonlySet<string>,
): ProviderNormalizedChatParams {
    const filtered = { ...params } as ProviderNormalizedChatParams;

    for (const key of Object.keys(filtered)) {
        if (!allowedChatParams.has(key)) {
            delete filtered[key];
        }
    }

    return filtered;
}
