import { OpenAI } from 'openai';
import { aiRequestOptions } from '../executionScope';
import { getAiProviderDescriptor } from '../providerMetadata';
import { applyChatTokenParamMode, resolveModelCapabilities, type AiProviderAdapter, type AiProviderCapabilities } from './types';

const capabilities: AiProviderCapabilities = {
    supportsOpenAiCompatibleTransport: true,
    defaultModelCapabilities: { ...getAiProviderDescriptor('kimi').capabilities, chatTokenParam: 'max_tokens' },
};

/** K3 always reasons; none/medium from the shared UI map to the supported low/high levels. */
export const kimiProviderAdapter: AiProviderAdapter = {
    provider: 'kimi', descriptor: getAiProviderDescriptor('kimi'), capabilities,
    client: new OpenAI({ apiKey: process.env.KIMI_API_KEY || 'missing-kimi-api-key',
        baseURL: 'https://api.moonshot.ai/v1', maxRetries: 0 }),
    getModelCapabilities(model) { return resolveModelCapabilities(capabilities, model); },
    normalizeChatParams(model, params) {
        const normalized = applyChatTokenParamMode(params, 'max_tokens');
        // K3 fixes these parameters; passing a different value is rejected by the API.
        for (const name of ['temperature', 'top_p', 'n', 'presence_penalty', 'frequency_penalty', 'thinking', 'reasoning']) delete normalized[name];
        const effort = (params as Record<string, unknown>).reasoning_effort;
        normalized.reasoning_effort = effort === 'high' || effort === 'medium' || effort === 'max' ? 'high' : 'low';
        return normalized;
    },
    async createChatCompletion(model, params, generation) {
        const normalized = this.normalizeChatParams(model, params);
        if (generation) normalized.reasoning_effort = generation.reasoningEffort === 'high' || generation.reasoningEffort === 'medium' ? 'high' : 'low';
        return this.client.chat.completions.create({ ...normalized, model }, aiRequestOptions());
    },
    async createResponse() { throw new Error('Kimi Responses is not configured in this adapter'); },
};
