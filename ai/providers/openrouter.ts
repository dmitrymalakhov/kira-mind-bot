import { OpenAI } from 'openai';
import type { AiProviderAdapter, AiProviderCapabilities } from './types';
import {
    applyChatTokenParamMode,
    resolveModelCapabilities,
} from './types';

const OPENROUTER_CAPABILITIES: AiProviderCapabilities = {
    supportsOpenAiCompatibleTransport: true,
    defaultModelCapabilities: {
        chatTokenParam: 'max_tokens',
        supportsResponsesApi: false,
        supportsEmbedding: false,
        supportsTranscription: false,
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
    getModelCapabilities(model) {
        return resolveModelCapabilities(OPENROUTER_CAPABILITIES, model);
    },
    normalizeChatParams(model, params) {
        const capabilities = this.getModelCapabilities(model);
        return applyChatTokenParamMode(params, capabilities.chatTokenParam);
    },
    async createResponse() {
        throw new Error(`Provider ${this.provider} does not support OpenAI Responses API`);
    },
};
