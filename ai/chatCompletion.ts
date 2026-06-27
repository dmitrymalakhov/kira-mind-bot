import { resolveModelForTaskAsync } from './modelResolver';
import type { AiModelRef, AiTaskKey } from './modelPresets';
import { logAiUsage } from '../services/aiUsageLogService';
import { getAiProviderAdapter } from './providers/registry';
import type {
    ChatCompletion,
    ChatCompletionParamsWithoutModel,
} from './providers/types';
import { parseLLMJson } from '../utils';
import { errorToMessage, getTaskFallbackModel } from './runtimeSupport';

function recordAiUsage(payload: Parameters<typeof logAiUsage>[0]): void {
    void logAiUsage(payload);
}

async function createChatCompletionWithModel(
    taskKey: AiTaskKey,
    params: ChatCompletionParamsWithoutModel,
    preset: string,
    modelRef: AiModelRef,
    fallbackUsed: boolean,
    originalError?: unknown,
): Promise<ChatCompletion> {
    const startedAt = Date.now();
    const providerAdapter = getAiProviderAdapter(modelRef.provider);

    try {
        const result = await providerAdapter.createChatCompletion(modelRef.model, params);

        recordAiUsage({
            taskKey,
            provider: modelRef.provider,
            model: modelRef.model,
            preset,
            operation: 'chat',
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
            operation: 'chat',
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
    params: ChatCompletionParamsWithoutModel,
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
    params: ChatCompletionParamsWithoutModel,
    originalError: unknown,
    preset = 'fallback',
): Promise<ChatCompletion> {
    const fallbackModel = getTaskFallbackModel(taskKey);

    console.warn('[AI fallback]', {
        taskKey,
        fallbackModel,
        originalError,
    });

    return createChatCompletionWithModel(taskKey, params, preset, fallbackModel, true, originalError);
}

export async function createJsonChatCompletionForTask<T>(
    taskKey: AiTaskKey,
    params: ChatCompletionParamsWithoutModel,
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
export { getTaskFallbackModel as getFallbackModel } from './runtimeSupport';
