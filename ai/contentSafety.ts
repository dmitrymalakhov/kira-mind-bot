/** A refusal is terminal for every provider, including local models and JSON repair. */
export const AI_CONTENT_SAFETY_REPLY = 'Запрос остановлен ограничениями безопасности модели.';
interface RefusalUsage { inputTokens?: number; outputTokens?: number; totalTokens?: number }
export class AiContentSafetyError extends Error {
    readonly code = 'content_policy_violation';
    constructor(readonly usage?: RefusalUsage) { super(AI_CONTENT_SAFETY_REPLY); }
}

export function isAiContentSafetyError(error: unknown): boolean {
    if (error instanceof AiContentSafetyError) return true;
    if (!error || typeof error !== 'object') return false;
    const value = error as Record<string, any>;
    const nested = value.error ?? value.response?.data?.error;
    return [value.code, value.type, nested?.code, nested?.type].some(code => typeof code === 'string'
        && /content[_-]?(?:filter|policy)|moderation|safety|responsibleai|prohibited_content/i.test(code));
}

export function assertAiResponseAllowed(result: unknown): void {
    const value = result as Record<string, any>;
    const blocks = [value?.output, value?.steps].flatMap(items => Array.isArray(items) ? items : []);
    if (isAiContentSafetyError(value)
        || value?.choices?.some((choice: any) => choice.finish_reason === 'content_filter' || choice.message?.refusal)
        || value?.incomplete_details?.reason === 'content_filter'
        || blocks.some((item: any) => item?.type === 'refusal'
            || Array.isArray(item?.content) && item.content.some((part: any) => part?.type === 'refusal'))) {
        const usage = value?.usage || value?.usage_metadata || {};
        const numeric = (...values: unknown[]) => values.find((token): token is number => typeof token === 'number' && Number.isFinite(token) && token >= 0);
        // Compatibility adapters may detect a refusal before converting their response.
        throw new AiContentSafetyError({
            inputTokens: numeric(usage.input_tokens, usage.prompt_tokens, usage.total_input_tokens, usage.prompt_token_count),
            outputTokens: numeric(usage.output_tokens, usage.completion_tokens, usage.total_output_tokens, usage.candidates_token_count),
            totalTokens: numeric(usage.total_tokens, usage.total_token_count),
        });
    }
}
