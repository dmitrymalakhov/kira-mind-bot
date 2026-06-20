import { OpenAI } from 'openai';
import { getAiProviderDescriptor } from '../providerMetadata';
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
        supportsChatCompletions: true,
        supportsResponsesApi: false,
        supportsEmbedding: false,
        supportsTranscription: false,
        supportsVision: true,
        supportsFunctionCalling: true,
        supportsThinkingMode: false,
        supportsReasoningEffort: false,
        supportsPromptCaching: false,
        supportsOpenAiCompatibleTransport: false,
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
        return this.client.chat.completions.create({
            ...this.normalizeChatParams(model, params),
            model,
        });
    },
    async createResponse() {
        throw new Error(`Provider ${this.provider} does not support OpenAI Responses API`);
    },
};
