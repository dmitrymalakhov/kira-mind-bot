import { getActiveAiPresetName, getEnvAiPresetName, refreshActiveAiPresetName } from '../services/aiRuntimeConfigService';
import { getLocalModelRoutes } from '../services/localModelConfigService';
import { getModelPolicy } from '../services/modelPreferenceService';
import { roles, type LocalModelRoutes } from './localModelRouting';
import {
    aiPresets,
    type AiModelRef,
    type AiPresetName,
    type AiTaskKey,
} from './modelPresets';

export const DEFAULT_PRESET: AiPresetName = 'gpt-balanced';

export function resolveConfiguredModelRef(ref: AiModelRef, routes?: LocalModelRoutes): AiModelRef {
    const local = ref.localRole && routes?.[ref.localRole];
    if (local?.model && ref.localRole) return { ...ref, model: ref.allowFallback === false ? ref.model : local.model, generation: { maxTokens: local.maxTokens, reasoningEffort: local.reasoningEffort, temperature: roles[ref.localRole].temperature } };
    if (!ref.modelEnvKey) return ref;
    const model = process.env[ref.modelEnvKey]?.trim();
    if (!model) throw new Error(`Не задана модель: ${ref.modelEnvKey}`);
    return { ...ref, model };
}

export function getActivePresetName(): AiPresetName {
    return getEnvAiPresetName();
}

export function resolveModelForTask(taskKey: AiTaskKey): AiModelRef {
    const presetName = getActivePresetName();
    return resolveConfiguredModelRef(aiPresets[presetName].models[taskKey]);
}

export async function getActivePresetNameAsync(): Promise<AiPresetName> {
    return getActiveAiPresetName();
}

export async function resolveModelForTaskAsync(taskKey: AiTaskKey): Promise<{ presetName: AiPresetName; modelRef: AiModelRef }> {
    const policy = await getModelPolicy();
    const presetName = policy?.presetName ?? await getActivePresetNameAsync();
    const ref = policy?.models[taskKey] ?? aiPresets[presetName].models[taskKey];
    return {
        presetName,
        modelRef: resolveConfiguredModelRef(ref, ref.localRole ? await getLocalModelRoutes() : undefined),
    };
}

export async function resolveModelForTaskFreshAsync(taskKey: AiTaskKey): Promise<{ presetName: AiPresetName; modelRef: AiModelRef }> {
    const policy = await getModelPolicy(true);
    const presetName = policy?.presetName ?? await refreshActiveAiPresetName();
    const ref = policy?.models[taskKey] ?? aiPresets[presetName].models[taskKey];
    return {
        presetName,
        modelRef: resolveConfiguredModelRef(ref, ref.localRole ? await getLocalModelRoutes(true) : undefined),
    };
}
