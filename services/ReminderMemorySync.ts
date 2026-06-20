import { PREDEFINED_DOMAINS } from '../constants/domains';
import { getVectorService } from './VectorServiceFactory';
import type { BotContext, MemoryEntry, SearchResult, MemoryStatus } from '../types';
import type { Reminder } from '../reminder';
import { buildReminderSourceTag } from '../utils/enhancedDomainMemory';
import { getActiveMemoryBotId } from '../utils/botIdentity';

const REMINDER_MEMORY_TAG = 'reminder-memory';
const REMINDER_MEMORY_SOURCE_TAG = 'source:reminder';
const LEGACY_SUPERSEDED_TAG = 'reminder-legacy-superseded';

type ReminderSyncAction = 'create' | 'update' | 'postpone' | 'cancel' | 'complete';

function reminderBody(reminder: Reminder): string {
    return (reminder.displayText || reminder.text || '').replace(/\s+/g, ' ').trim();
}

function reminderDateLabel(date: Date): string {
    return date.toLocaleString('ru-RU', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    });
}

function reminderMemoryContent(reminder: Reminder): string {
    return `Напоминание: ${reminderBody(reminder)} — ${reminderDateLabel(new Date(reminder.dueDate))}.`;
}

function buildReminderMemoryEntry(userId: string, reminder: Reminder, status: MemoryStatus): Omit<MemoryEntry, 'id'> {
    const now = new Date();
    return {
        content: reminderMemoryContent(reminder),
        domain: PREDEFINED_DOMAINS.GENERAL,
        botId: getActiveMemoryBotId(),
        timestamp: now,
        importance: 0.82,
        tags: reminderMemoryTags(reminder, status),
        userId,
        confidence: 0.9,
        memoryKind: 'open_loop',
        subject: 'user',
        predicate: 'reminder',
        object: reminderBody(reminder),
        validFrom: now,
        validTo: new Date(reminder.dueDate),
        status,
        extractionMethod: 'manual',
    };
}

function reminderMemoryTags(reminder: Reminder, status: MemoryStatus): string[] {
    const tags = [
        REMINDER_MEMORY_TAG,
        REMINDER_MEMORY_SOURCE_TAG,
        buildReminderSourceTag(reminder.id),
        'temporal_scope:future_plan',
        `status:${status}`,
    ];
    if (reminder.recurrence) tags.push('reminder-recurring');
    return [...new Set(tags)];
}

function cloneVersions(memory: Pick<SearchResult, 'content' | 'timestamp' | 'confidence' | 'previousVersions'>) {
    return [
        {
            content: memory.content,
            timestamp: new Date(memory.timestamp),
            confidence: memory.confidence ?? 0.6,
        },
        ...(memory.previousVersions ?? []).map((version) => ({
            content: version.content,
            timestamp: new Date(version.timestamp),
            confidence: version.confidence,
        })),
    ].slice(0, 10);
}

function reminderStatusForAction(action: ReminderSyncAction): MemoryStatus {
    switch (action) {
        case 'cancel':
            return 'superseded';
        case 'complete':
            return 'done';
        default:
            return 'planned';
    }
}

function patchReminderMemory(memory: SearchResult, reminder: Reminder, action: ReminderSyncAction): Omit<MemoryEntry, 'id'> {
    const nextStatus = reminderStatusForAction(action);
    const now = new Date();
    const botId = getActiveMemoryBotId();
    const tags = new Set([
        ...(memory.tags ?? []),
        ...reminderMemoryTags(reminder, nextStatus),
    ]);
    if (nextStatus !== 'planned') {
        tags.add(`reminder-${action}`);
    }

    return {
        content: reminderMemoryContent(reminder),
        domain: memory.domain,
        botId,
        timestamp: now,
        importance: Math.max(memory.importance ?? 0.8, 0.82),
        tags: [...tags],
        userId: '',
        isAnchor: memory.isAnchor,
        expiresAt: nextStatus === 'planned' ? memory.expiresAt : now,
        confidence: Math.max(memory.confidence ?? 0.7, 0.88),
        lastAccessedAt: memory.lastAccessedAt,
        retrievalCount: memory.retrievalCount,
        lastRetrievedAt: memory.lastRetrievedAt,
        retrievalCues: memory.retrievalCues,
        previousVersions: cloneVersions(memory),
        relatedIds: memory.relatedIds,
        memoryKind: 'open_loop',
        strength: memory.strength,
        vividness: memory.vividness,
        specificity: memory.specificity,
        emotionalTag: memory.emotionalTag,
        sourceEpisodeId: memory.sourceEpisodeId,
        sourceContext: `Синхронизировано из reminder-flow (${action}). Reminder ID: ${reminder.id}.`,
        sourceMessageIds: memory.sourceMessageIds,
        sourceMemoryIds: memory.sourceMemoryIds,
        extractionMethod: memory.extractionMethod,
        subject: memory.subject,
        predicate: memory.predicate,
        object: reminderBody(reminder),
        validFrom: now,
        validTo: nextStatus === 'planned' ? new Date(reminder.dueDate) : now,
        status: nextStatus,
        confirmationCount: memory.confirmationCount,
        lastConfirmedAt: now,
    };
}

function tokenizeReminderText(value: string): string[] {
    return value
        .toLowerCase()
        .replace(/["«»“”'.,:;!?()[\]{}]/g, ' ')
        .split(/\s+/)
        .map((token) => token.trim())
        .filter((token) => token.length >= 4)
        .filter((token) => !/^\d+$/.test(token))
        .filter((token) => !['встреча', 'напоминание', 'сегодня', 'завтра', 'через', 'нужно'].includes(token));
}

function tokenOverlapRatio(left: string, right: string): number {
    const leftTokens = new Set(tokenizeReminderText(left));
    const rightTokens = new Set(tokenizeReminderText(right));
    if (!leftTokens.size || !rightTokens.size) return 0;
    let overlap = 0;
    for (const token of leftTokens) {
        if (rightTokens.has(token)) overlap++;
    }
    return overlap / Math.max(leftTokens.size, rightTokens.size);
}

function dateVariants(date: Date): string[] {
    const dd = String(date.getDate()).padStart(2, '0');
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const yyyy = String(date.getFullYear());
    const hh = String(date.getHours()).padStart(2, '0');
    const min = String(date.getMinutes()).padStart(2, '0');
    return [
        `${dd}.${mm}.${yyyy}`,
        `${dd}.${mm}`,
        `${hh}:${min}`,
        date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }).toLowerCase(),
        date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' }).toLowerCase(),
    ];
}

function containsAnyDateVariant(text: string, date: Date): boolean {
    const haystack = text.toLowerCase();
    return dateVariants(date).some((variant) => haystack.includes(variant));
}

function isSyntheticMemory(memory: Pick<SearchResult, 'content' | 'tags'>): boolean {
    return memory.content.startsWith('[ЭПИЗОД ПАМЯТИ:') ||
        memory.content.startsWith('[ГЛАВА ПАМЯТИ:') ||
        memory.content.startsWith('[МОДЕЛЬ ПАМЯТИ:') ||
        (memory.tags ?? []).some((tag) =>
            ['memory-episode', 'memory-chapter', 'memory-schema', 'sleep_open_loop_index', 'sleep_uncertainty_index'].includes(String(tag))
        );
}

function isLegacyReminderCandidate(memory: SearchResult, previous: Reminder, next: Reminder): boolean {
    if (isSyntheticMemory(memory)) return false;
    if (memory.status === 'superseded' || memory.status === 'expired' || memory.status === 'done') return false;
    const overlap = tokenOverlapRatio(memory.content, reminderBody(previous));
    if (overlap < 0.4) return false;

    const sourceText = [memory.content, memory.sourceContext ?? '', memory.object ?? ''].join('\n');
    const matchesPreviousDate = containsAnyDateVariant(sourceText, new Date(previous.dueDate));
    const matchesNextDate = containsAnyDateVariant(sourceText, new Date(next.dueDate));
    return matchesPreviousDate && !matchesNextDate;
}

function patchLegacyMemory(memory: SearchResult, reminder: Reminder, action: ReminderSyncAction): Omit<MemoryEntry, 'id'> {
    const now = new Date();
    const botId = getActiveMemoryBotId();
    const tags = new Set([
        ...(memory.tags ?? []),
        LEGACY_SUPERSEDED_TAG,
        `reminder-${action}`,
    ]);
    if (action === 'complete') {
        tags.add('status:done');
    } else {
        tags.add('status:superseded');
    }

    return {
        content: memory.content,
        domain: memory.domain,
        botId,
        timestamp: now,
        importance: memory.importance,
        tags: [...tags],
        userId: '',
        isAnchor: memory.isAnchor,
        expiresAt: now,
        confidence: Math.min(memory.confidence ?? 0.65, 0.72),
        lastAccessedAt: memory.lastAccessedAt,
        retrievalCount: memory.retrievalCount,
        lastRetrievedAt: memory.lastRetrievedAt,
        retrievalCues: memory.retrievalCues,
        previousVersions: memory.previousVersions,
        relatedIds: memory.relatedIds,
        memoryKind: memory.memoryKind,
        strength: memory.strength,
        vividness: memory.vividness,
        specificity: memory.specificity,
        emotionalTag: memory.emotionalTag,
        sourceEpisodeId: memory.sourceEpisodeId,
        sourceContext: `${memory.sourceContext || ''}\nСнято reminder-sync (${action}) для reminder ${reminder.id}.`.trim(),
        sourceMessageIds: memory.sourceMessageIds,
        sourceMemoryIds: memory.sourceMemoryIds,
        extractionMethod: memory.extractionMethod,
        subject: memory.subject,
        predicate: memory.predicate,
        object: memory.object,
        validFrom: memory.validFrom,
        validTo: now,
        status: action === 'complete' ? 'done' : 'superseded',
        confirmationCount: memory.confirmationCount,
        lastConfirmedAt: now,
    };
}

async function findReminderMemoriesByTag(userId: string, reminderId: string): Promise<SearchResult[]> {
    const svc = getVectorService();
    if (!svc) return [];
    return svc.getMemoriesByTag(userId, buildReminderSourceTag(reminderId)).catch(() => []);
}

async function findLegacyReminderMemories(userId: string, previous: Reminder, next: Reminder, excludeIds: Set<string>): Promise<SearchResult[]> {
    const svc = getVectorService();
    if (!svc) return [];
    const results = await svc.searchAllDomains(reminderBody(previous), userId, 16).catch(() => []);
    return results.filter((memory) => !excludeIds.has(memory.id) && isLegacyReminderCandidate(memory, previous, next));
}

export async function createOrRefreshReminderMemory(ctx: BotContext, reminder: Reminder): Promise<void> {
    if (!ctx.from?.id) return;
    await createOrRefreshReminderMemoryForUserId(String(ctx.from.id), reminder);
}

export async function createOrRefreshReminderMemoryForUserId(userId: string, reminder: Reminder): Promise<void> {
    const existing = await findReminderMemoriesByTag(userId, reminder.id);
    if (existing.length > 0) {
        const svc = getVectorService();
        if (!svc) return;
        const canonical = existing[0];
        await svc.updateMemory(canonical.id, canonical.domain, {
            ...patchReminderMemory(canonical, reminder, 'update'),
            userId,
        }).catch(() => {});
        return;
    }

    const svc = getVectorService();
    if (!svc) return;
    await svc.saveMemory(buildReminderMemoryEntry(userId, reminder, 'planned')).catch(() => {});
}

export async function syncReminderMemoryMutation(
    ctx: BotContext,
    previous: Reminder,
    next: Reminder,
    action: ReminderSyncAction
): Promise<void> {
    if (!ctx.from?.id) return;

    const userId = String(ctx.from.id);
    const svc = getVectorService();
    if (!svc) return;

    const directMatches = await findReminderMemoriesByTag(userId, previous.id);
    const directIds = new Set(directMatches.map((memory) => memory.id));
    const legacyMatches = await findLegacyReminderMemories(userId, previous, next, directIds);

    if (directMatches.length > 0) {
        const [canonical, ...duplicates] = directMatches;
        await svc.updateMemory(canonical.id, canonical.domain, {
            ...patchReminderMemory(canonical, next, action),
            userId,
        }).catch(() => {});
        for (const duplicate of duplicates) {
            await svc.updateMemory(duplicate.id, duplicate.domain, {
                ...patchLegacyMemory(duplicate, next, action),
                userId,
            }).catch(() => {});
        }
    } else if (action === 'update' || action === 'postpone' || action === 'create') {
        await createOrRefreshReminderMemory(ctx, next);
    }

    for (const legacy of legacyMatches) {
        await svc.updateMemory(legacy.id, legacy.domain, {
            ...patchLegacyMemory(legacy, next, action),
            userId,
        }).catch(() => {});
    }
}

export function reminderMemoryMatchesReminderText(memory: Pick<SearchResult, 'content' | 'sourceContext' | 'object'>, reminderText: string): boolean {
    return tokenOverlapRatio([memory.content, memory.sourceContext ?? '', memory.object ?? ''].join('\n'), reminderText) >= 0.4;
}
