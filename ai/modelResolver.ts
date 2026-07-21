import { getActiveAiPresetName, getEnvAiPresetName, refreshActiveAiPresetName } from '../services/aiRuntimeConfigService';
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

export async function resolveModelForTaskFreshAsync(taskKey: AiTaskKey): Promise<{ presetName: AiPresetName; modelRef: AiModelRef }> {
    const presetName = await refreshActiveAiPresetName();
    return {
        presetName,
        modelRef: aiPresets[presetName].models[taskKey],
    };
}
