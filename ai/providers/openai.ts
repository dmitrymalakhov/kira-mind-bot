import { OpenAI } from 'openai';
import { config } from '../../config';
import type { AiProviderAdapter, AiProviderCapabilities } from './types';
import {
    applyChatTokenParamMode,
    resolveModelCapabilities,
} from './types';

const OPENAI_CAPABILITIES: AiProviderCapabilities = {
    supportsOpenAiCompatibleTransport: true,
    defaultModelCapabilities: {
        chatTokenParam: 'max_tokens',
        supportsResponsesApi: true,
        supportsEmbedding: true,
        supportsTranscription: true,
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
    getModelCapabilities(model) {
        return resolveModelCapabilities(OPENAI_CAPABILITIES, model);
    },
    normalizeChatParams(model, params) {
        const capabilities = this.getModelCapabilities(model);
        return applyChatTokenParamMode(params, capabilities.chatTokenParam);
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
};
