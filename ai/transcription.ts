import fs from 'fs';
import { resolveModelForTaskAsync } from './modelResolver';
import type { AiModelRef } from './modelPresets';
import { getAiProviderAdapter } from './providers/registry';
import { getTransitionalTaskFallbackModel, errorToMessage } from './runtimeSupport';
import { logAiUsage } from '../services/aiUsageLogService';

function recordAiUsage(payload: Parameters<typeof logAiUsage>[0]): void {
    void logAiUsage(payload);
}

async function createTranscriptionWithModel(
    audioFilePath: string,
    preset: string,
    modelRef: AiModelRef,
    fallbackUsed: boolean,
    originalError?: unknown,
): Promise<string> {
    const taskKey = 'transcription';
    const startedAt = Date.now();
    const providerAdapter = getAiProviderAdapter(modelRef.provider);

    if (!providerAdapter.createTranscription || !providerAdapter.getModelCapabilities(modelRef.model).supportsTranscription) {
        throw new Error(`Provider ${modelRef.provider} does not support transcription for model ${modelRef.model}`);
    }

    const fileStream = fs.createReadStream(audioFilePath);

    try {
        const result = await providerAdapter.createTranscription(modelRef.model, {
            file: fileStream,
            language: 'ru',
            response_format: 'text',
        });
        recordAiUsage({
            taskKey,
            provider: modelRef.provider,
            model: modelRef.model,
            preset,
            success: true,
            fallbackUsed,
            latencyMs: Date.now() - startedAt,
        });
        return result.text;
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
            console.warn('[AI transcription fallback failed]', {
                fallbackModel: modelRef,
                originalError,
                fallbackError: error,
            });
        }

        throw error;
    } finally {
        fileStream.destroy();
    }
}

export async function createTranscriptionForTask(audioFilePath: string): Promise<string> {
    const { presetName, modelRef } = await resolveModelForTaskAsync('transcription');

    try {
        return await createTranscriptionWithModel(audioFilePath, presetName, modelRef, false);
    } catch (error) {
        const fallbackModel = getTransitionalTaskFallbackModel('transcription');
        console.warn('[AI transcription fallback]', { fallbackModel, originalError: error });
        return createTranscriptionWithModel(audioFilePath, presetName, fallbackModel, true, error);
    }
}
