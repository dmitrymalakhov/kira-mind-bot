import fallbackModelRegistry from './fallback-models.json';
import type { AiModelRef, AiTaskKey } from './modelPresets';

const registry = fallbackModelRegistry as Record<AiTaskKey, AiModelRef>;

export function getFallbackModel(taskKey: AiTaskKey): AiModelRef {
    return registry[taskKey];
}
