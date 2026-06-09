import { getActiveAiPresetName, getEnvAiPresetName } from '../services/aiRuntimeConfigService';
import { getFallbackModel } from './fallbackModels';
import {
    aiPresets,
    type AiModelRef,
    type AiPresetName,
    type AiTaskKey,
} from './modelPresets';

export const DEFAULT_PRESET: AiPresetName = 'gpt-balanced';

export function getActivePresetName(): AiPresetName {
    return getEnvAiPresetName();
}

export function resolveModelForTask(taskKey: AiTaskKey): AiModelRef {
    const presetName = getActivePresetName();
    return aiPresets[presetName].models[taskKey];
}

export async function getActivePresetNameAsync(): Promise<AiPresetName> {
    return getActiveAiPresetName();
}

export async function resolveModelForTaskAsync(taskKey: AiTaskKey): Promise<{ presetName: AiPresetName; modelRef: AiModelRef }> {
    const presetName = await getActivePresetNameAsync();
    return {
        presetName,
        modelRef: aiPresets[presetName].models[taskKey],
    };
}

export async function resolveOpenAiModelForTaskAsync(taskKey: AiTaskKey): Promise<string> {
    const { modelRef } = await resolveModelForTaskAsync(taskKey);
    return modelRef.provider === 'openai'
        ? modelRef.model
        : getFallbackModel(taskKey).model;
}
