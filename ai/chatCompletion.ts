import type OpenAI from 'openai';
import { getAiClient } from './aiClients';
import { resolveModelForTaskAsync } from './modelResolver';
import type { AiModelRef, AiTaskKey } from './modelPresets';
import { getFallbackModel } from './fallbackModels';
import { logAiUsage } from '../services/aiUsageLogService';
import { parseLLMJson } from '../utils';

type ChatCompletionCreateParams = OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;
type ChatCompletion = OpenAI.Chat.Completions.ChatCompletion;

type ParamsWithoutModel = Omit<ChatCompletionCreateParams, 'model'>;
type ChatCompletionCreateParamsWithLegacyMaxTokens = ChatCompletionCreateParams & {
    max_tokens?: number;
    max_completion_tokens?: number;
};


function recordAiUsage(payload: Parameters<typeof logAiUsage>[0]): void {
    void logAiUsage(payload);
}

function errorToMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    try {
        return JSON.stringify(error);
    } catch {
        return String(error);
    }
}

function normalizeOpenAiChatParams(
    provider: AiModelRef['provider'],
    model: string,
    params: ParamsWithoutModel,
): ChatCompletionCreateParamsWithLegacyMaxTokens {
    const normalized = { ...params } as ChatCompletionCreateParamsWithLegacyMaxTokens;

    if (provider !== 'openai' || !model.startsWith('gpt-5')) {
        return normalized;
    }

    if (normalized.max_completion_tokens === undefined && normalized.max_tokens !== undefined) {
        normalized.max_completion_tokens = normalized.max_tokens;
    }

    delete normalized.max_tokens;
    return normalized;
}

async function createChatCompletionWithModel(
    taskKey: AiTaskKey,
    params: ParamsWithoutModel,
    preset: string,
    modelRef: AiModelRef,
    fallbackUsed: boolean,
    originalError?: unknown,
): Promise<ChatCompletion> {
    const startedAt = Date.now();
    const client = getAiClient(modelRef.provider);
    const normalizedParams = normalizeOpenAiChatParams(modelRef.provider, modelRef.model, params);

    try {
        const result = await client.chat.completions.create({
            ...normalizedParams,
            model: modelRef.model,
        });

        recordAiUsage({
            taskKey,
            provider: modelRef.provider,
            model: modelRef.model,
            preset,
            inputTokens: result.usage?.prompt_tokens,
            outputTokens: result.usage?.completion_tokens,
            totalTokens: result.usage?.total_tokens,
            success: true,
            fallbackUsed,
            latencyMs: Date.now() - startedAt,
        });

        return result;
    } catch (error) {
        recordAiUsage({
            taskKey,
            provider: modelRef.provider,
            model: modelRef.model,
            preset,
            success: false,
            fallbackUsed,
            errorMessage: errorToMessage(error),
            latencyMs: Date.now() - startedAt,
        });

        if (originalError) {
            console.warn('[AI fallback failed]', {
                taskKey,
                fallbackModel: modelRef,
                originalError,
                fallbackError: error,
            });
        }

        throw error;
    }
}

export async function createChatCompletionForTask(
    taskKey: AiTaskKey,
    params: ParamsWithoutModel,
): Promise<ChatCompletion> {
    const { presetName, modelRef } = await resolveModelForTaskAsync(taskKey);

    try {
        return await createChatCompletionWithModel(taskKey, params, presetName, modelRef, false);
    } catch (error) {
        return createFallbackChatCompletion(taskKey, params, error, presetName);
    }
}

export async function createFallbackChatCompletion(
    taskKey: AiTaskKey,
    params: ParamsWithoutModel,
    originalError: unknown,
    preset = 'fallback',
): Promise<ChatCompletion> {
    const fallbackModel = getFallbackModel(taskKey);

    console.warn('[AI fallback]', {
        taskKey,
        fallbackModel,
        originalError,
    });

    return createChatCompletionWithModel(taskKey, params, preset, fallbackModel, true, originalError);
}

export async function createJsonChatCompletionForTask<T>(
    taskKey: AiTaskKey,
    params: ParamsWithoutModel,
): Promise<T | null> {
    const response = await createChatCompletionForTask(taskKey, params);
    const content = response.choices[0]?.message?.content || '';
    const parsed = parseLLMJson<T>(content);
    if (parsed) return parsed;

    try {
        const fallbackResponse = await createFallbackChatCompletion(
            taskKey,
            params,
            new Error('AI response contained invalid JSON'),
            'json-parse-fallback',
        );
        return parseLLMJson<T>(fallbackResponse.choices[0]?.message?.content || '');
    } catch (error) {
        console.warn('[AI JSON fallback failed]', { taskKey, error });
        return null;
    }
}

export { getFallbackModel } from './fallbackModels';
