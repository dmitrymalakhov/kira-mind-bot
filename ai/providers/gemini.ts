import { OpenAI } from 'openai';
import type { AiProviderAdapter, AiProviderCapabilities } from './types';
import {
    applyChatTokenParamMode,
    filterAllowedChatParams,
    resolveModelCapabilities,
} from './types';

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
        supportsResponsesApi: false,
        supportsEmbedding: false,
        supportsTranscription: false,
    },
    allowedChatParams: GEMINI_CHAT_COMPLETION_ALLOWED_PARAMS,
};

const geminiClient = new OpenAI({
    apiKey: process.env.GEMINI_API_KEY || 'missing-gemini-api-key',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
});

export const geminiProviderAdapter: AiProviderAdapter = {
    provider: 'gemini',
    client: geminiClient,
    capabilities: GEMINI_CAPABILITIES,
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
    async createResponse() {
        throw new Error(`Provider ${this.provider} does not support OpenAI Responses API`);
    },
};
