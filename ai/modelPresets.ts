import modelPresetRegistry from '../admin-panel/src/ai-model-presets.json';

export type AiProvider = 'openai' | 'deepseek' | 'gemini';

export type AiTaskKey =
    | 'defaultText'
    | 'intentClassification'
    | 'intentDedup'
    | 'conversation'
    | 'memoryExtraction'
    | 'memoryConsolidation'
    | 'messageAnalysis'
    | 'webSearchReasoning'
    | 'browserPlanning'
    | 'browserVision'
    | 'embedding'
    | 'transcription';

export interface AiModelRef {
    provider: AiProvider;
    model: string;
}

export type AiPresetName =
    | 'gpt-max'
    | 'gpt-balanced'
    | 'gpt-lean'
    | 'hybrid-deepseek-gpt'
    | 'hybrid-gemini-gpt';

export interface AiPresetConfig {
    name: AiPresetName;
    title: string;
    description: string;
    models: Record<AiTaskKey, AiModelRef>;
}

interface AiPresetRegistry {
    presetNames: AiPresetName[];
    presets: Record<AiPresetName, AiPresetConfig>;
}

const registry = modelPresetRegistry as AiPresetRegistry;

export const AI_PRESET_NAMES = registry.presetNames;
export const aiPresets = registry.presets;

export const gptMaxPreset = aiPresets['gpt-max'];
export const gptBalancedPreset = aiPresets['gpt-balanced'];
export const gptLeanPreset = aiPresets['gpt-lean'];
export const hybridDeepSeekGptPreset = aiPresets['hybrid-deepseek-gpt'];
export const hybridGeminiGptPreset = aiPresets['hybrid-gemini-gpt'];

export function parseAiPresetName(raw: string | undefined | null): AiPresetName | null {
    if (!raw) return null;
    return AI_PRESET_NAMES.includes(raw as AiPresetName) ? raw as AiPresetName : null;
}
