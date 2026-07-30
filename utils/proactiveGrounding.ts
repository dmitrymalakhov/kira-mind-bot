import type { MemoryKind, MemoryStatus, MemorySubject } from '../types';

const SYNTHETIC_MEMORY_TAGS = new Set([
    'memory-episode',
    'memory-chapter',
    'memory-schema',
    'sleep_open_loop_index',
    'sleep_uncertainty_index',
]);

const UNCONFIRMED_MEMORY_TAGS = new Set([
    'unconfirmed',
    'needs-clarification',
    'evidence-only',
    'assistant-claim-unconfirmed',
]);

const NON_USER_SUBJECT_TAGS = new Set([
    'subject:bot',
    'subject:system',
    'subject:contact',
    'subject:third_party',
    'subject:unknown',
]);

const UNSUPPORTED_OWNER_OBLIGATION_PATTERNS = [
    /(?:^|[^\p{L}\p{N}_])ты\s+(?:обещал[а-яё]*|собирал[а-яё]*|забыл[а-яё]*|забил[а-яё]*|не\s+(?:сделал[а-яё]*|доделал[а-яё]*|закончил[а-яё]*))(?![\p{L}\p{N}_])/iu,
];

export interface ProactiveMemoryCandidate {
    tags?: string[];
    memoryKind?: MemoryKind;
    subject?: MemorySubject;
    status?: MemoryStatus;
    negated?: boolean;
}

export const CONVERSATION_EPISODE_TRUST = {
    subject: 'system' as const,
    tags: ['conversation-episode', 'subject:system'] as const,
};

export interface KiraLifeGroundingDecision {
    safe?: boolean;
    attributesOwnerObligation?: boolean;
}

export type KiraLifeReviewStatus =
    | 'safe'
    | 'semantic_rejection'
    | 'review_error'
    | 'invalid_review'
    | 'empty_candidate'
    | 'local_guard';

/** Semantic-review считается успешным только при двух согласованных явных полях. */
export function acceptsKiraLifeGroundingDecision(
    decision: KiraLifeGroundingDecision | null | undefined,
): boolean {
    return decision?.safe === true && decision.attributesOwnerObligation === false;
}

export function classifyKiraLifeGroundingDecision(
    decision: KiraLifeGroundingDecision | null | undefined,
): Extract<KiraLifeReviewStatus, 'safe' | 'semantic_rejection' | 'invalid_review'> {
    if (typeof decision?.safe !== 'boolean' || typeof decision.attributesOwnerObligation !== 'boolean') {
        return 'invalid_review';
    }
    return acceptsKiraLifeGroundingDecision(decision) ? 'safe' : 'semantic_rejection';
}

/** Дешёвый high-confidence барьер; неоднозначные формулировки проверяются semantic-review. */
export function hasUnsupportedKiraLifeOwnerClaim(message: string): boolean {
    const normalized = message.trim();
    if (!normalized) return false;
    return UNSUPPORTED_OWNER_OBLIGATION_PATTERNS.some(pattern => pattern.test(normalized));
}

export function safeKiraLifeFallback(gender: string | undefined): string {
    if (gender !== undefined && gender !== 'мужской' && gender !== 'женский') {
        console.warn('[kira-life] Unknown eventDescriptionGender, using feminine fallback:', gender);
    }
    return gender === 'мужской'
        ? 'Сегодня я поймал себя на мысли, что хочется немного выдохнуть и переключиться. Решил сохранить эту мысль здесь.'
        : 'Сегодня я поймала себя на мысли, что хочется немного выдохнуть и переключиться. Решила сохранить эту мысль здесь.';
}

export function chooseGroundedKiraLifeMessage(
    candidate: string | null | undefined,
    eventFallback: string | null | undefined,
    gender: string | undefined,
    reviewStatus: KiraLifeReviewStatus = 'safe',
): {
    message: string;
    usedFallback: boolean;
    fallbackReason?: Exclude<KiraLifeReviewStatus, 'safe'>;
    fallbackSource?: 'event' | 'static';
} {
    const normalized = candidate?.trim();
    const rejectedByLocalGuard = Boolean(normalized && hasUnsupportedKiraLifeOwnerClaim(normalized));
    if (normalized && reviewStatus === 'safe' && !rejectedByLocalGuard) {
        return { message: normalized, usedFallback: false };
    }

    const fallbackReason: Exclude<KiraLifeReviewStatus, 'safe'> = !normalized
        ? 'empty_candidate'
        : rejectedByLocalGuard
            ? 'local_guard'
            : reviewStatus === 'safe' ? 'local_guard' : reviewStatus;

    const normalizedEvent = eventFallback?.trim();
    if (normalizedEvent && !hasUnsupportedKiraLifeOwnerClaim(normalizedEvent)) {
        return {
            message: normalizedEvent,
            usedFallback: true,
            fallbackReason,
            fallbackSource: 'event',
        };
    }

    return {
        message: safeKiraLifeFallback(gender),
        usedFallback: true,
        fallbackReason,
        fallbackSource: 'static',
    };
}

/** Только подтверждённые пользовательские утверждения могут запускать memory-insight. */
export function isEligibleMemoryInsightSource(
    memory: ProactiveMemoryCandidate,
    purpose: 'plan' | 'done' = 'plan',
): boolean {
    const tags = new Set(memory.tags ?? []);
    if ([...SYNTHETIC_MEMORY_TAGS].some(tag => tags.has(tag))) return false;
    if ([...UNCONFIRMED_MEMORY_TAGS].some(tag => tags.has(tag))) return false;
    if ([...NON_USER_SUBJECT_TAGS].some(tag => tags.has(tag))) return false;
    if (memory.memoryKind === 'episode' || memory.memoryKind === 'chapter' || memory.memoryKind === 'portrait') return false;
    if (memory.subject && memory.subject !== 'user') return false;
    if (memory.negated) return false;
    if (memory.status === 'superseded' || memory.status === 'expired') return false;
    if (purpose === 'plan' && memory.status === 'done') return false;
    return true;
}

export function normalizeInsightSourceIndexes(indexes: unknown, planCount: number): number[] {
    if (!Array.isArray(indexes)) return [];
    return [...new Set(indexes
        .map(value => Number(value))
        .filter(value => Number.isInteger(value) && value >= 1 && value <= planCount))]
        .sort((left, right) => left - right);
}
