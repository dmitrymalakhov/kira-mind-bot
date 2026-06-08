import { getAiClient } from './aiClients';
import { getFallbackModel } from './fallbackModels';
import { resolveModelForTaskAsync } from './modelResolver';
import type { AiModelRef, AiTaskKey } from './modelPresets';
import { logAiUsage } from '../services/aiUsageLogService';

type ResponseCreateParams = Record<string, unknown>;
type ResponseResult = any;

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

function getUsageTokens(result: ResponseResult) {
    return {
        inputTokens: result?.usage?.input_tokens ?? result?.usage?.prompt_tokens,
        outputTokens: result?.usage?.output_tokens ?? result?.usage?.completion_tokens,
        totalTokens: result?.usage?.total_tokens,
    };
}

async function createResponseWithModel(
    taskKey: AiTaskKey,
    params: ResponseCreateParams,
    preset: string,
    modelRef: AiModelRef,
    fallbackUsed: boolean,
): Promise<ResponseResult> {
    const startedAt = Date.now();
    const client = getAiClient(modelRef.provider) as any;

    try {
        if (!client.responses?.create) {
            throw new Error(`Provider ${modelRef.provider} does not support Responses API`);
        }

        const result = await client.responses.create({
            ...params,
            model: modelRef.model,
        });
        const usage = getUsageTokens(result);

        recordAiUsage({
            taskKey,
            provider: modelRef.provider,
            model: modelRef.model,
            preset,
            ...usage,
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
        throw error;
    }
}

export async function createResponseForTask(
    taskKey: AiTaskKey,
    params: ResponseCreateParams,
): Promise<ResponseResult> {
    const { presetName, modelRef } = await resolveModelForTaskAsync(taskKey);

    try {
        return await createResponseWithModel(taskKey, params, presetName, modelRef, false);
    } catch (error) {
        const fallbackModel = getFallbackModel(taskKey);
        console.warn('[AI responses fallback]', { taskKey, fallbackModel, originalError: error });
        return createResponseWithModel(taskKey, params, presetName, fallbackModel, true);
    }
}
