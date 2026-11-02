import { getImageRecognitionSettings } from '../services/imageRecognitionConfigService';
import { AsyncLocalStorage } from 'node:async_hooks';
import { getModelPolicy } from '../services/modelPreferenceService';
import { getActivePresetNameAsync, resolveModelForTaskAsync, resolveModelForTaskFreshAsync, type AiResolvedTaskRoute } from './modelResolver';

export interface ImageRecognitionRoute extends AiResolvedTaskRoute { imageRecognitionOverride?: boolean }
const frameRoute = new AsyncLocalStorage<ImageRecognitionRoute>();

/** All readers of one AR frame share a recipient, even if settings change between localization and description. */
export async function runWithImageRecognitionRoute<T>(work: () => Promise<T>): Promise<T> {
    if (frameRoute.getStore()) return work();
    return frameRoute.run(await resolveImageRecognitionRoute(), work);
}

/** Used by inference, photo preflight and AR. Capability is verified against LM Studio's catalog on save. */
export async function resolveImageRecognitionRoute(fresh = false): Promise<ImageRecognitionRoute> {
    const scoped = frameRoute.getStore();
    if (scoped && !fresh) return scoped;
    const settings = await getImageRecognitionSettings();
    if (!settings) return fresh ? resolveModelForTaskFreshAsync('conversation') : resolveModelForTaskAsync('conversation');
    const policy = await getModelPolicy(fresh);
    return {
        presetName: policy?.presetName ?? await getActivePresetNameAsync(),
        imageRecognitionOverride: true,
        modelRef: { provider: settings.provider, model: settings.model, allowFallback: false,
            generation: { maxTokens: settings.maxTokens, reasoningEffort: settings.reasoningEffort } },
    };
}
