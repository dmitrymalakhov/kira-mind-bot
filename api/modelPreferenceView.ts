import { aiPresets, parseAiPresetName, type AiModelRef, type AiPresetName, type AiTaskKey } from '../ai/modelPresets';
import { QUALITY_LEVELS, TEXT_TASKS, type ModelPolicy } from '../ai/modelPreferences';
import { resolveConfiguredModelRef } from '../ai/modelResolver';
import { getAiProviderAdapter } from '../ai/providers/registry';
import { allowsCrossProviderFallback, getSameProviderDegradedModel, getTaskFallbackModel } from '../ai/runtimeSupport';
import { getEnvAiPresetName } from '../services/aiRuntimeConfigService';
import { getMemoryEmbeddingProfile, type MemoryEmbeddingProfileName } from '../ai/memoryEmbeddingProfiles';
import type { ApiModelSelection } from './modelSettings';
import type { LocalModelRoutes } from '../ai/localModelRouting';

const unavailable = { unavailableCode: 'model_connection_unavailable', unavailableReason: 'Для этого выбора недоступно одно из подключений моделей. Проверь подключённые сервисы.' };
function recipient(ref: AiModelRef) {
    const descriptor = getAiProviderAdapter(ref.provider).descriptor;
    const available = Boolean(descriptor.optionalApiKey || process.env[descriptor.envKey]?.trim());
    return { provider: ref.provider, providerLabel: descriptor.label, available,
        model: ref.model, location: ref.provider === 'lmstudio' ? 'server-local' : 'cloud', ...(available ? {} : unavailable) };
}
function describe(task: AiTaskKey, preset: AiPresetName, ref: AiModelRef, localRoutes: LocalModelRoutes, candidates?: AiModelRef[]) {
    try {
        const primary = resolveConfiguredModelRef(ref, localRoutes);
        const fallbacks: ReturnType<typeof recipient>[] = [];
        const crossProvider = candidates ? new Set(candidates.map(ref => ref.provider)).size > 1 : allowsCrossProviderFallback(preset, primary);
        if (candidates) {
            fallbacks.push(...candidates.slice(1).map(recipient));
        } else if (crossProvider) {
            const fallback = getTaskFallbackModel(task);
            if (fallback.provider !== primary.provider || fallback.model !== primary.model) fallbacks.push(recipient(fallback));
        } else {
            const seen = new Set([primary.model]);
            let current = primary;
            for (let n = 0; n < 16; n++) {
                const next = getSameProviderDegradedModel(preset, current, true, seen);
                if (!next) break;
                seen.add(next.model); fallbacks.push(recipient(next)); current = next;
            }
        }
        return { ...recipient(primary), crossProviderFallback: crossProvider, fallbacks,
            ...(candidates ? { selection: 'automatic-pool', candidates: candidates.map(recipient) } : {}) };
    } catch { return { available: false, ...unavailable }; }
}

/** Additive mobile metadata over the admin's actual state; never recompile a saved manual/custom choice on GET.
 * Provider/model/fallbacks describe task routes, not a complete data processing/retention consent descriptor. */
export function publicModelPreferences(state: Record<string, any>, selection: ApiModelSelection, memoryProfile: MemoryEmbeddingProfileName) {
    const policy = state.activePlan as ModelPolicy | null;
    const accountPreset = policy?.presetName ?? parseAiPresetName(state.manualPreset) ?? getEnvAiPresetName();
    const appPreset = selection.preset ?? accountPreset;
    const accountModels = policy?.models ?? aiPresets[accountPreset].models;
    const appModels = selection.preset ? aiPresets[selection.preset].models : accountModels;
    const routes = (models: typeof accountModels, preset: AiPresetName, pool?: ModelPolicy['routing']) => Object.fromEntries(TEXT_TASKS.map(task => [task, describe(task, preset, models[task], state.localRoutes, pool?.[task])]));
    const safePlans = (plans: any[]) => plans.map(plan => plan.available === false ? { ...plan, ...unavailable } : plan);
    const embedding = getMemoryEmbeddingProfile(memoryProfile);
    return { ...state, qualityLevels: QUALITY_LEVELS, textTasks: TEXT_TASKS,
        plans: safePlans(state.plans), providerPlans: safePlans(state.providerPlans),
        poolPlans: safePlans(state.poolPlans || []),
        appOverride: selection,
        effectivePlan: { account: { preset: accountPreset, routes: routes(accountModels, accountPreset, policy?.routing) },
            app: { preset: appPreset, overridden: selection.preset !== null, routes: routes(appModels, appPreset, selection.preset ? undefined : policy?.routing) },
            memoryEmbedding: { profile: memoryProfile, ...recipient(embedding) } },
        recipientDisclosure: { complete: false, scope: 'configured-text-routes-and-memory-embedding',
            missing: ['resolved-endpoint-identity', 'non-text-processing', 'provider-data-retention'] },
    };
}
