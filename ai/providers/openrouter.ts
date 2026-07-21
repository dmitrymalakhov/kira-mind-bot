import { OpenAI } from 'openai';
import { getAiProviderDescriptor } from '../providerMetadata';
import type { AiProviderAdapter, AiProviderCapabilities } from './types';
import {
    applyChatTokenParamMode,
    resolveModelCapabilities,
} from './types';

const OPENROUTER_CAPABILITIES: AiProviderCapabilities = {
    supportsOpenAiCompatibleTransport: true,
    defaultModelCapabilities: {
        chatTokenParam: 'max_tokens',
        supportsChatCompletions: true,
        supportsResponsesApi: false,
        supportsEmbedding: false,
        supportsTranscription: false,
        supportsVision: false,
        supportsFunctionCalling: true,
        supportsThinkingMode: false,
        supportsReasoningEffort: false,
        supportsPromptCaching: false,
        supportsOpenAiCompatibleTransport: true,
    },
};

const openrouterClient = new OpenAI({
    apiKey: process.env.OPENROUTER_API_KEY || 'missing-openrouter-api-key',
    baseURL: 'https://openrouter.ai/api/v1',
});

export const openrouterProviderAdapter: AiProviderAdapter = {
    provider: 'openrouter',
    client: openrouterClient,
    capabilities: OPENROUTER_CAPABILITIES,
    descriptor: getAiProviderDescriptor('openrouter'),
    getModelCapabilities(model) {
        return resolveModelCapabilities(OPENROUTER_CAPABILITIES, model);
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
    async createResponse() {
        throw new Error(`Provider ${this.provider} does not support OpenAI Responses API`);
    },
};
