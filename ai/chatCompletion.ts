import { resolveModelForTaskAsync } from './modelResolver';
import type { AiModelRef, AiTaskKey } from './modelPresets';
import { getFallbackModel } from './fallbackModels';
import { logAiUsage } from '../services/aiUsageLogService';
import { getAiProviderAdapter } from './providers/registry';
import type {
    ChatCompletion,
    ChatCompletionParamsWithoutModel,
} from './providers/types';
import { parseLLMJson } from '../utils';

function recordAiUsage(payload: Parameters<typeof logAiUsage>[0]): void {
    void logAiUsage(payload);
}

const MAX_AI_ERROR_MESSAGE_LENGTH = 320;

function truncateErrorMessage(message: string): string {
    const normalized = message.replace(/\s+/g, ' ').trim();
    if (normalized.length <= MAX_AI_ERROR_MESSAGE_LENGTH) return normalized;
    return `${normalized.slice(0, MAX_AI_ERROR_MESSAGE_LENGTH - 1)}…`;
}

function getRecordValue(record: Record<string, unknown>, key: string): unknown {
    return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

function stringifyErrorValue(value: unknown): string | null {
    if (typeof value === 'string') {
        const normalized = value.trim();
        return normalized.length > 0 ? normalized : null;
    }

    if (typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
    }

    return null;
}

function summarizeErrorDetails(error: unknown): string | null {
    if (!error || typeof error !== 'object') return null;

    const record = error as Record<string, unknown>;
    const details: string[] = [];

    const status = stringifyErrorValue(getRecordValue(record, 'status'));
    const code = stringifyErrorValue(getRecordValue(record, 'code'));
    const type = stringifyErrorValue(getRecordValue(record, 'type'));
    const requestId = stringifyErrorValue(getRecordValue(record, 'request_id'))
        ?? stringifyErrorValue(getRecordValue(record, 'requestId'));

    const nestedError = getRecordValue(record, 'error');
    const nestedErrorRecord = nestedError && typeof nestedError === 'object'
        ? nestedError as Record<string, unknown>
        : null;

    const nestedCode = nestedErrorRecord
        ? stringifyErrorValue(getRecordValue(nestedErrorRecord, 'code'))
        : null;
    const nestedType = nestedErrorRecord
        ? stringifyErrorValue(getRecordValue(nestedErrorRecord, 'type'))
        : null;
    const nestedMessage = nestedErrorRecord
        ? stringifyErrorValue(getRecordValue(nestedErrorRecord, 'message'))
        : null;

    if (status) details.push(`status=${status}`);
    if (code) details.push(`code=${code}`);
    if (type) details.push(`type=${type}`);
    if (nestedCode && nestedCode !== code) details.push(`provider_code=${nestedCode}`);
    if (nestedType && nestedType !== type) details.push(`provider_type=${nestedType}`);
    if (requestId) details.push(`request_id=${requestId}`);
    if (nestedMessage) details.push(`provider_message=${nestedMessage}`);

    return details.length > 0 ? details.join('; ') : null;
}

function errorToMessage(error: unknown): string {
    const baseMessage = error instanceof Error
        ? error.message
        : (() => {
            try {
                return JSON.stringify(error);
            } catch {
                return String(error);
            }
        })();

    const details = summarizeErrorDetails(error);
    if (details && !baseMessage.includes(details)) {
        return truncateErrorMessage(`${baseMessage}; ${details}`);
    }

    return truncateErrorMessage(baseMessage);
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
    const normalizedParams = providerAdapter.normalizeChatParams(modelRef.model, params);

    try {
        const result = await providerAdapter.client.chat.completions.create({
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

export { getFallbackModel } from './fallbackModels';
