import type { AiTaskKey } from './modelPresets';

export interface ReasoningSignals {
    details?: { responseComplexity?: 'routine' | 'complex' };
    subIntents?: readonly unknown[];
}

/** Reuse the intent classifier's semantic assessment; routing adds no API call. */
export function selectConversationTask(
    classification?: ReasoningSignals,
    requiresCarefulReasoning = false,
): AiTaskKey {
    if (requiresCarefulReasoning
        || classification?.details?.responseComplexity === 'complex'
        || (classification?.subIntents?.length ?? 0) > 0) {
        return 'complexReasoning';
    }
    return 'conversation';
}
