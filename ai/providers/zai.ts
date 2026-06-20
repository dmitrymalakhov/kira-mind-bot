import { OpenAI } from 'openai';
import { getAiProviderDescriptor } from '../providerMetadata';
import type { AiProviderAdapter, AiProviderCapabilities } from './types';
import {
    applyChatTokenParamMode,
    resolveModelCapabilities,
} from './types';

const ZAI_CAPABILITIES: AiProviderCapabilities = {
    supportsOpenAiCompatibleTransport: true,
    defaultModelCapabilities: {
        chatTokenParam: 'max_tokens',
        supportsChatCompletions: true,
        supportsResponsesApi: false,
        supportsEmbedding: false,
        supportsTranscription: false,
        supportsVision: false,
        supportsFunctionCalling: true,
        supportsThinkingMode: true,
        supportsReasoningEffort: true,
        supportsPromptCaching: true,
        supportsOpenAiCompatibleTransport: true,
    },
};

const zaiClient = new OpenAI({
    apiKey: process.env.ZAI_API_KEY || 'missing-zai-api-key',
    baseURL: 'https://api.z.ai/api/paas/v4/',
});

export const zaiProviderAdapter: AiProviderAdapter = {
    provider: 'zai',
    descriptor: getAiProviderDescriptor('zai'),
    client: zaiClient,
    capabilities: ZAI_CAPABILITIES,
    getModelCapabilities(model) {
        return resolveModelCapabilities(ZAI_CAPABILITIES, model);
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
