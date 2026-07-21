import degradedModelRegistry from './degraded-models.json';
import type { AiModelRef, AiPresetName } from './modelPresets';

const registry = degradedModelRegistry as Partial<Record<AiPresetName, AiModelRef>>;

export function getDegradedModel(presetName: AiPresetName): AiModelRef | null {
    return registry[presetName] ?? null;
}
