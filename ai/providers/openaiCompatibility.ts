import type { AiModelRef } from '../modelPresets';
import type { ChatCompletionParamsWithoutModel, ResponseCreateParams } from './types';

type Effort = NonNullable<AiModelRef['generation']>['reasoningEffort'];

export function gpt6Family(model: string): 'luna' | 'sol' | undefined {
    if (model === 'gpt-6-luna' || model.startsWith('gpt-6-luna-')) return 'luna';
    if (model === 'gpt-6.1-sol' || model.startsWith('gpt-6.1-sol-')) return 'sol';
    return undefined;
}

function resolveEffort(model: string, explicit: unknown, configured?: Effort): unknown {
    const effort = explicit ?? configured ?? (gpt6Family(model) === 'sol' ? 'low' : 'none');
    // Sol cannot turn reasoning off; low is the documented migration baseline.
    return effort === 'minimal' || gpt6Family(model) === 'sol' && effort === 'none' ? 'low' : effort;
}

function normalizeShared(params: Record<string, unknown>, effort: unknown): Record<string, unknown> {
    const result = { ...params };
    if (effort !== 'none') {
        delete result.temperature;
        delete result.top_p;
        delete result.top_logprobs;
    }
    if (result.prompt_cache_retention !== undefined) {
        result.prompt_cache_options ??= { ttl: '30m' };
        delete result.prompt_cache_retention;
    }
    return result;
}

/** Existing models keep their original contract; GPT-6 never inherits its paid medium default accidentally. */
export function normalizeGpt6Chat(model: string, params: ChatCompletionParamsWithoutModel, configured?: Effort): ChatCompletionParamsWithoutModel {
    if (!gpt6Family(model)) return params;
    const effort = resolveEffort(model, params.reasoning_effort, configured);
    const result = normalizeShared(params, effort);
    result.reasoning_effort = effort;
    if (effort !== 'none') delete result.logprobs;
    const hasTools = Boolean(params.tools?.length || params.functions?.length || params.tool_choice && params.tool_choice !== 'none'
        || params.function_call && params.function_call !== 'none');
    if (hasTools && (gpt6Family(model) === 'sol' || effort !== 'none')) {
        throw new Error(`${model}: tool calling with reasoning requires the Responses API`);
    }
    return result as ChatCompletionParamsWithoutModel;
}

export function normalizeGpt6Response(model: string, params: ResponseCreateParams, configured?: Effort): ResponseCreateParams {
    if (!gpt6Family(model)) return params;
    const effort = resolveEffort(model, params.reasoning?.effort, configured);
    const result = normalizeShared(params, effort);
    result.reasoning = { ...params.reasoning, effort };
    if (effort !== 'none' && Array.isArray(params.include)) {
        result.include = params.include.filter(value => String(value) !== 'message.output_text.logprobs');
    }
    return result as ResponseCreateParams;
}
