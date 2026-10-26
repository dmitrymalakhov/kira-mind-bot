import { aiPresets, parseAiPresetName, type AiProvider, type AiTaskKey } from './modelPresets';
import type { ChatCompletionParamsWithoutModel, ResponseCreateParams } from './providers/types';

function outputLimit(preset: string, task: AiTaskKey, provider: AiProvider): number | undefined {
    // The local model's role configuration is authoritative, including explicit owner overrides.
    if (provider === 'lmstudio') return undefined;
    const name = parseAiPresetName(preset);
    return name ? aiPresets[name].outputTokenLimits?.[task] : undefined;
}

function bounded(limit: number, ...values: unknown[]): number {
    return Math.min(limit, ...values.filter((value): value is number =>
        typeof value === 'number' && Number.isFinite(value) && value > 0));
}

/** Applied on every attempt, including retries, provider degradation and JSON fallback. */
export function limitChatGeneration(preset: string, task: AiTaskKey, provider: AiProvider,
    params: ChatCompletionParamsWithoutModel, modelLimit?: number): ChatCompletionParamsWithoutModel {
    const presetLimit = outputLimit(preset, task, provider);
    const limit = provider === 'lmstudio' ? undefined : modelLimit === undefined ? presetLimit : Math.min(modelLimit, presetLimit ?? modelLimit);
    if (limit === undefined) return params;
    const result = { ...params, max_completion_tokens: bounded(limit, params.max_completion_tokens, params.max_tokens) };
    // Adapters normalize the canonical key to the wire format supported by their model.
    delete result.max_tokens;
    return result;
}

export function limitResponseGeneration(preset: string, task: AiTaskKey, provider: AiProvider,
    params: ResponseCreateParams, modelLimit?: number): ResponseCreateParams {
    const presetLimit = outputLimit(preset, task, provider);
    const limit = provider === 'lmstudio' ? undefined : modelLimit === undefined ? presetLimit : Math.min(modelLimit, presetLimit ?? modelLimit);
    return limit === undefined ? params : { ...params, max_output_tokens: bounded(limit, params.max_output_tokens) };
}
