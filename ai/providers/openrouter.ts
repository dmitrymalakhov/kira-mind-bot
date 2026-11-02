import { OpenAI } from 'openai';
import { aiRequestOptions } from '../executionScope';
import { getAiProviderDescriptor } from '../providerMetadata';
import type { AiProviderAdapter, AiProviderCapabilities } from './types';
import capabilityOverrides from '../provider-capability-overrides.json';
import { AiContentSafetyError } from '../contentSafety';
import {
    applyChatTokenParamMode,
    resolveModelCapabilities,
} from './types';

const OPENROUTER_CAPABILITIES: AiProviderCapabilities = {
    supportsOpenAiCompatibleTransport: true,
    modelCapabilityOverrides: capabilityOverrides.openrouter,
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
    maxRetries: 0,
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
    async createChatCompletion(model, params, generation) {
        const normalized = this.normalizeChatParams(model, params);
        // OpenRouter expects unified reasoning, and K3 fixes its sampling parameters.
        const kimi = model.startsWith('moonshotai/kimi-k3');
        const effort = generation?.reasoningEffort;
        if (kimi || effort && effort !== 'none') {
            normalized.reasoning = { effort: kimi ? effort === 'high' || effort === 'medium' ? 'high' : 'low' : effort };
            for (const key of ['temperature', 'top_p', 'n', 'presence_penalty', 'frequency_penalty']) delete normalized[key];
        }
        delete normalized.reasoning_effort;
        const routing = normalized.provider && typeof normalized.provider === 'object' ? normalized.provider as Record<string, unknown> : {};
        normalized.provider = { ...routing, require_parameters: true,
            sort: routing.sort ?? (model.endsWith('flash-lite') ? 'price' : normalized.reasoning ? 'throughput' : 'latency') };
        try {
            return await this.client.chat.completions.create({ ...normalized, model }, aiRequestOptions());
        } catch (error) {
            // OpenRouter can report upstream moderation as a numeric HTTP 403 with text metadata.
            // It is terminal, unlike a key's ordinary model-access restriction.
            const record = error as { status?: number; message?: string; error?: { message?: string; metadata?: { raw?: string } } };
            const identity = [record?.message, record?.error?.message, record?.error?.metadata?.raw]
                .filter(value => typeof value === 'string').join(' ').slice(0, 4096);
            if (record?.status === 403 && /moderation|content[_ -]?(?:filter|policy)|safety (?:system|policy)|responsibleai/i.test(identity)) throw new AiContentSafetyError();
            throw error;
        }
    },
    async createResponse() {
        throw new Error(`Provider ${this.provider} does not support OpenAI Responses API`);
    },
};
