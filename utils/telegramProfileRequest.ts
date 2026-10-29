import type { MessageClassification } from '../orchestrator';

/** Reuses the existing semantic pass, including independent secondary actions. */
export function requiresTelegramProfile(classification: MessageClassification): boolean {
    return [classification, ...(classification.subIntents ?? [])].some(item => item.details?.telegramProfile === true);
}
