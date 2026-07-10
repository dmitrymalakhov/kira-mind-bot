import { OpenAI } from 'openai';
import { config } from '../../config';
import { getAiProviderDescriptor } from '../providerMetadata';
import type { AiProviderAdapter, AiProviderCapabilities } from './types';
import {
    applyChatTokenParamMode,
    resolveModelCapabilities,
} from './types';

const OPENAI_CAPABILITIES: AiProviderCapabilities = {
    supportsOpenAiCompatibleTransport: true,
    defaultModelCapabilities: {
        chatTokenParam: 'max_tokens',
        supportsChatCompletions: true,
        supportsResponsesApi: true,
        supportsEmbedding: true,
        supportsTranscription: true,
        supportsVision: true,
        supportsFunctionCalling: true,
        supportsThinkingMode: false,
        supportsReasoningEffort: false,
        supportsPromptCaching: true,
        supportsOpenAiCompatibleTransport: true,
    },
    modelCapabilityOverrides: {
        'gpt-5.4': {
            chatTokenParam: 'max_completion_tokens',
        },
        'gpt-5.4-mini': {
            chatTokenParam: 'max_completion_tokens',
        },
        'gpt-5.4-nano': {
            chatTokenParam: 'max_completion_tokens',
        },
    },
};

const openaiClient = new OpenAI({
    apiKey: config.openAiApiKey || process.env.OPENAI_API_KEY,
});

export const openaiProviderAdapter: AiProviderAdapter = {
    provider: 'openai',
    client: openaiClient,
    capabilities: OPENAI_CAPABILITIES,
    descriptor: getAiProviderDescriptor('openai'),
    getModelCapabilities(model) {
        return resolveModelCapabilities(OPENAI_CAPABILITIES, model);
    },
    normalizeChatParams(model, params) {
        const capabilities = this.getModelCapabilities(model);
        return applyChatTokenParamMode(params, capabilities.chatTokenParam);
    },
    async createChatCompletion(model, params) {
        return this.client.chat.completions.create({
            ...this.normalizeChatParams(model, params),
            model,
        });
    },
    async createResponse(model, params) {
        const capabilities = this.getModelCapabilities(model);

        if (!capabilities.supportsResponsesApi) {
            throw new Error(`Provider ${this.provider} does not support OpenAI Responses API`);
        }

        return this.client.responses.create({
            ...params,
            model,
        });
    },
    async createEmbedding(model, params) {
        const capabilities = this.getModelCapabilities(model);
        if (!capabilities.supportsEmbedding) {
            throw new Error(`Provider ${this.provider} does not support embeddings`);
        }

        const body: Record<string, unknown> = {
            model,
            input: params.input,
        };
        if (typeof params.outputDimension === 'number' && Number.isFinite(params.outputDimension)) {
            body.dimensions = Math.round(params.outputDimension);
        }

        const result = await this.client.embeddings.create(body as any);

        return {
            embedding: result.data[0]?.embedding ?? [],
            rawUsage: {
                inputTokens: result.usage?.prompt_tokens,
                totalTokens: result.usage?.total_tokens,
            },
        };
    },
    async createTranscription(model, params) {
        const capabilities = this.getModelCapabilities(model);
        if (!capabilities.supportsTranscription) {
            throw new Error(`Provider ${this.provider} does not support transcription`);
        }

        const text = await this.client.audio.transcriptions.create({
            file: params.file as any,
            model,
            language: params.language,
            response_format: params.response_format ?? 'text',
        });

        return { text };
    },
};
