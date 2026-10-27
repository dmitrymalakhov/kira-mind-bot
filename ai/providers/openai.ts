import { OpenAI } from 'openai';
import { config } from '../../config';
import { getAiProviderDescriptor } from '../providerMetadata';
import type { AiProviderAdapter, AiProviderCapabilities } from './types';
import { gpt6Family, normalizeGpt6Chat, normalizeGpt6Response } from './openaiCompatibility';
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
        'gpt-6-luna': {
            chatTokenParam: 'max_completion_tokens',
            supportsReasoningEffort: true,
            supportsEmbedding: false,
            supportsTranscription: false,
        },
        'gpt-6.1-sol': {
            chatTokenParam: 'max_completion_tokens',
            supportsReasoningEffort: true,
            supportsEmbedding: false,
            supportsTranscription: false,
        },
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
    baseURL: process.env.OPENAI_BASE_URL || undefined,
    maxRetries: 0,
});

export const openaiProviderAdapter: AiProviderAdapter = {
    provider: 'openai',
    client: openaiClient,
    async createDecision(params) {
        return this.client.post('/decisions', { body: params, timeout: 5_000, maxRetries: 0 });
    },
    capabilities: OPENAI_CAPABILITIES,
    descriptor: getAiProviderDescriptor('openai'),
    getModelCapabilities(model) {
        const family = gpt6Family(model);
        return resolveModelCapabilities(OPENAI_CAPABILITIES, family === 'luna' ? 'gpt-6-luna' : family === 'sol' ? 'gpt-6.1-sol' : model);
    },
    normalizeChatParams(model, params) {
        const capabilities = this.getModelCapabilities(model);
        return applyChatTokenParamMode(normalizeGpt6Chat(model, params), capabilities.chatTokenParam);
    },
    async createChatCompletion(model, params, generation) {
        return this.client.chat.completions.create({
            ...this.normalizeChatParams(model, normalizeGpt6Chat(model, params, generation?.reasoningEffort)),
            model,
        });
    },
    async createResponse(model, params, generation) {
        const capabilities = this.getModelCapabilities(model);

        if (!capabilities.supportsResponsesApi) {
            throw new Error(`Provider ${this.provider} does not support OpenAI Responses API`);
        }

        return this.client.responses.create({
            ...normalizeGpt6Response(model, params, generation?.reasoningEffort),
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
