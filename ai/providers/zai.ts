import { OpenAI } from 'openai';
import { getAiProviderDescriptor } from '../providerMetadata';
import type { AiProviderAdapter, AiProviderCapabilities, ResponseResult } from './types';
import providerCapabilityOverrides from '../provider-capability-overrides.json';
import {
    applyChatTokenParamMode,
    resolveModelCapabilities,
} from './types';
import {
    buildZaiWebSearchTool,
    convertResponsesInputToChatMessages,
    hasWebSearchPreviewTool,
    extractSystemInstructionFromResponsesInput,
} from '../responseCompat';

const ZAI_CAPABILITIES: AiProviderCapabilities = {
    supportsOpenAiCompatibleTransport: true,
    defaultModelCapabilities: {
        chatTokenParam: 'max_tokens',
        supportsChatCompletions: true,
        supportsResponsesApi: true,
        supportsEmbedding: false,
        supportsTranscription: false,
        supportsVision: false,
        supportsFunctionCalling: true,
        supportsThinkingMode: true,
        supportsReasoningEffort: true,
        supportsPromptCaching: true,
        supportsOpenAiCompatibleTransport: true,
    },
    modelCapabilityOverrides: providerCapabilityOverrides.zai,
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
    async createResponse(model, params) {
        const messages = convertResponsesInputToChatMessages(params)
            .filter((message) => message.role !== 'system' && message.role !== 'developer');
        const systemInstruction = extractSystemInstructionFromResponsesInput(params);
        const tools = hasWebSearchPreviewTool(params)
            ? buildZaiWebSearchTool(systemInstruction)
            : undefined;
        const result = await this.client.chat.completions.create({
            model,
            messages,
            tools: tools as OpenAI.Chat.Completions.ChatCompletionTool[] | undefined,
            temperature: typeof params.temperature === 'number' ? params.temperature : undefined,
            top_p: typeof params.top_p === 'number' ? params.top_p : undefined,
            max_tokens: typeof params.max_output_tokens === 'number' ? params.max_output_tokens : undefined,
        });

        return {
            id: result.id,
            object: 'response',
            model: result.model,
            output_text: result.choices[0]?.message?.content || '',
            usage: result.usage ? {
                input_tokens: result.usage.prompt_tokens,
                output_tokens: result.usage.completion_tokens,
                total_tokens: result.usage.total_tokens,
            } : undefined,
        } as ResponseResult;
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
