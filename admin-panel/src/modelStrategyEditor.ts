import { getCustomPresetName, TEXT_TASKS, type CustomStrategy, type ModelPreferences } from '../../ai/modelPreferences';
import type { AiModelRef, AiPresetConfig, AiPresetName, AiProvider, AiTaskKey } from '../../ai/modelPresets';
import type { LocalModelRoutes } from '../../ai/localModelRouting';
import rawRegistry from './ai-model-presets.json';

const presets = rawRegistry.presets as unknown as Record<AiPresetName, AiPresetConfig>;
export function inferCustomProvider(models: Record<AiTaskKey, AiModelRef>): AiProvider | null {
  const selected = new Set(TEXT_TASKS.map(task => models[task].provider));
  return selected.size === 1 ? models.conversation.provider : null;
}

export function customDraftFromModels(models: Record<AiTaskKey, AiModelRef>, quality: ModelPreferences['quality'],
  routes: LocalModelRoutes, caps: Partial<Record<AiTaskKey, number>> = {}): CustomStrategy | null {
  const provider = inferCustomProvider(models);
  if (!provider) return null;
  return { mode: 'custom', quality, provider, routes: Object.fromEntries(TEXT_TASKS.map(task => {
    const ref = models[task];
    const role = ref.localRole && routes[ref.localRole];
    return [task, { model: ref.allowFallback === false ? ref.model : role?.model || ref.model,
      maxTokens: ref.generation?.maxTokens ?? (role ? role.maxTokens : caps[task]) ?? 2048,
      reasoningEffort: ref.generation?.reasoningEffort ?? (role ? role.reasoningEffort : 'none') }];
  })) };
}

export function customDraftForProvider(provider: AiProvider, quality: ModelPreferences['quality'],
  catalog: Array<Pick<AiModelRef, 'provider'|'model'>>, localRoutes: LocalModelRoutes): CustomStrategy {
  const base = presets[getCustomPresetName(provider, quality)];
  const choices = catalog.filter(ref => ref.provider === provider);
  return { mode: 'custom', quality, provider, routes: Object.fromEntries(TEXT_TASKS.map(task => {
    const ref = base.models[task];
    const role = ref.localRole && localRoutes[ref.localRole];
    const candidate = ref.provider === provider ? role ? role.model : ref.model : '';
    return [task, { model: choices.some(ref => ref.model === candidate) ? candidate : choices[0]?.model || '',
      maxTokens: (role ? role.maxTokens : ref.generation?.maxTokens) ?? base.outputTokenLimits?.[task] ?? 2048,
      reasoningEffort: (role ? role.reasoningEffort : ref.generation?.reasoningEffort) ?? 'none' }];
  })) };
}
