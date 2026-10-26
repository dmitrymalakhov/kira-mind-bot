import { OpenAI } from 'openai';
import { getAiProviderDescriptor } from '../providerMetadata';
import type { AiProviderAdapter, AiProviderCapabilities } from './types';
import { applyChatTokenParamMode, resolveModelCapabilities } from './types';

const descriptor = getAiProviderDescriptor('lmstudio');
const capabilities: AiProviderCapabilities = {
    supportsOpenAiCompatibleTransport: true,
    defaultModelCapabilities: {
        ...descriptor.capabilities,
        chatTokenParam: 'max_tokens',
    },
};

export const lmstudioProviderAdapter: AiProviderAdapter = {
    provider: 'lmstudio',
    descriptor,
    capabilities,
    client: new OpenAI({
        baseURL: process.env.LM_STUDIO_BASE_URL || descriptor.baseURL!,
        apiKey: process.env.LM_STUDIO_API_KEY || 'lm-studio',
        maxRetries: 0,
        timeout: 180_000,
    }),
    getModelCapabilities(model) {
        return resolveModelCapabilities(capabilities, model);
    },
    normalizeChatParams(model, params) {
        const normalized = applyChatTokenParamMode(params, this.getModelCapabilities(model).chatTokenParam);
        // LM Studio forwards this switch to the model template. Omitting it can
        // spend the entire output budget on invisible thinking, even for JSON.
        if (!normalized.reasoning_effort) (normalized as Record<string, unknown>).reasoning_effort = 'none';
        delete normalized.prompt_cache_key;
        delete normalized.prompt_cache_retention;
        delete normalized.store;
        if (normalized.response_format?.type === 'json_object') {
            normalized.response_format = {
                type: 'json_schema',
                json_schema: { name: 'result', schema: { type: 'object', additionalProperties: true } },
            };
        }
        return normalized;
    },
    async createChatCompletion(model, params, generation) {
        const normalized = this.normalizeChatParams(model, params);
        if (generation) {
            if (generation.maxTokens !== undefined) normalized.max_tokens = Math.min(normalized.max_tokens ?? generation.maxTokens, generation.maxTokens);
            (normalized as Record<string, unknown>).reasoning_effort = generation.reasoningEffort;
            if (generation.temperature !== undefined) normalized.temperature = generation.temperature;
        }
        const result = await this.client.chat.completions.create({ ...normalized, model });
        if (!result.choices[0]?.message?.content?.trim() && !result.choices[0]?.message?.tool_calls?.length) {
            throw new Error('LM Studio не вернула текст ответа. Увеличьте лимит токенов или отключите рассуждения для этой роли в админке.');
        }
        return result;
    },
    async createResponse() {
        // Built-in web search is an OpenAI service, not an LM Studio capability.
        throw new Error('LM Studio не поддерживает облачный web search; выберите маршрут OpenAI для этой задачи');
    },
    getRetryPolicy() {
        return { enabled: false, maxAttempts: 0, getDelayMs: () => 0 };
    },
    getSameProviderDegradationChain() {
        return [];
    },
};
