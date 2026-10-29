import { randomUUID } from 'crypto';
import { createChatCompletionForTask } from './chatCompletion';
import { resolveModelForTaskAsync } from './modelResolver';
import { getAiProviderAdapter } from './providers/registry';
import { logAiUsage } from '../services/aiUsageLogService';
import { parseLLMJson } from '../utils';
import { REFLECTION_TRIAGE_INSTRUCTIONS, REFLECTION_TRIAGE_THRESHOLD, reflectionTriageInput } from './reflectionTriagePolicy';
export { REFLECTION_TRIAGE_INSTRUCTIONS, REFLECTION_TRIAGE_THRESHOLD } from './reflectionTriagePolicy';

/** Replace an existing Boolean call only when the configured model itself supports Decisions. */
export async function needsPriorityReflection(senderName: string, text: string): Promise<boolean> {
    const input = reflectionTriageInput(senderName, text);
    if (process.env.KIRA_REFLECTION_TRIAGE_DECISIONS_ENABLED !== 'false') {
        const route = await resolveModelForTaskAsync('lightweightText');
        const adapter = getAiProviderAdapter(route.modelRef.provider);
        const reasoning = route.modelRef.generation?.reasoningEffort;
        // Same model, provider and account client, including pinned routes. Never substitute Luna for another model.
        if (route.modelRef.provider === 'openai' && route.modelRef.model === 'gpt-6-luna' && (!reasoning || reasoning === 'none') && adapter.createDecision) {
            const startedAt = Date.now(); const traceId = randomUUID();
            try {
                const result = await adapter.createDecision({ model: route.modelRef.model,
                    input: [{ role: 'user', content: [{ type: 'input_text', text: REFLECTION_TRIAGE_INSTRUCTIONS }, { type: 'input_json', data: input }] }],
                    questions: [{ type: 'predicate', name: 'urgent', instructions: REFLECTION_TRIAGE_INSTRUCTIONS }],
                });
                const answer = result.answers?.[0];
                if (result.model !== route.modelRef.model || result.answers?.length !== 1 || answer?.name !== 'urgent' || answer.type !== 'predicate' ||
                    typeof answer.probability !== 'number' || !Number.isFinite(answer.probability) || answer.probability < 0 || answer.probability > 1) throw new Error('Invalid reflection predicate');
                void logAiUsage({ taskKey: 'lightweightText', provider: route.modelRef.provider, model: route.modelRef.model, preset: route.presetName,
                    operation: 'decisions', traceId, success: true, inputTokens: result.usage?.input_tokens, outputTokens: result.usage?.output_tokens,
                    totalTokens: result.usage?.total_tokens, latencyMs: Date.now() - startedAt });
                return answer.probability >= REFLECTION_TRIAGE_THRESHOLD;
            } catch {
                void logAiUsage({ taskKey: 'lightweightText', provider: route.modelRef.provider, model: route.modelRef.model, preset: route.presetName,
                    operation: 'decisions', traceId, success: false, errorMessage: 'Reflection predicate unavailable; using configured JSON route', latencyMs: Date.now() - startedAt });
            }
        }
    }
    const result = await createChatCompletionForTask('lightweightText', {
        messages: [{ role: 'system', content: `${REFLECTION_TRIAGE_INSTRUCTIONS}\nВерни только JSON {"urgent":true|false}.` },
            { role: 'user', content: JSON.stringify(input) }], temperature: 0, max_completion_tokens: 32,
    });
    return parseLLMJson<{ urgent?: boolean }>(result.choices[0]?.message?.content?.trim() || '')?.urgent === true;
}
