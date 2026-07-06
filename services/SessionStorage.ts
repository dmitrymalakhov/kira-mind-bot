import type { StorageAdapter } from 'grammy';
import { AppDataSource } from '../data-source';
import { SessionEntity } from '../entity/SessionEntity';
import type { BotContext, SessionData } from '../types';
import { scopedBotKey } from '../utils/botIdentity';

const MAX_HISTORY = 20;
const RECENT_FACTS_TTL_MS = 24 * 60 * 60 * 1000;
const STUDY_CHAT_REQUEST_FALLBACK_TTL_MS = 15 * 60 * 1000;

/** Подмножество SessionData, которое мы сохраняем в БД. */
interface PersistedSession {
    messageHistory: SessionData['messageHistory'];
    dialogueSummary: SessionData['dialogueSummary'];
    lastSummarizedIndex: SessionData['lastSummarizedIndex'];
    domains: SessionData['domains'];
    workingMemory?: SessionData['workingMemory'];
    recentlySavedFacts?: SessionData['recentlySavedFacts'];
    lastProactiveHintAt?: SessionData['lastProactiveHintAt'];
    lastProactiveInsight?: SessionData['lastProactiveInsight'];
    pendingContactMemory?: SessionData['pendingContactMemory'];
    pendingContactLookup?: SessionData['pendingContactLookup'];
    pendingPostpone?: SessionData['pendingPostpone'];
    pendingReminderEdit?: SessionData['pendingReminderEdit'];
    pendingBrowserTask?: SessionData['pendingBrowserTask'];
    pendingHealthLog?: SessionData['pendingHealthLog'];
    pendingHealthDiscomfort?: SessionData['pendingHealthDiscomfort'];
    activeBrowserTask?: SessionData['activeBrowserTask'];
    lastBrowserTask?: SessionData['lastBrowserTask'];
    pendingQuickChoices?: SessionData['pendingQuickChoices'];
    studyChatRequest?: SessionData['studyChatRequest'];
    chatAnalysisPeriodRequest?: SessionData['chatAnalysisPeriodRequest'];
    chatPromptWatchState?: SessionData['chatPromptWatchState'];
}

function extract(data: SessionData): PersistedSession {
    const now = Date.now();
    return {
        // messageHistory is stored newest-first; keep the head or we persist the oldest messages.
        messageHistory: (data.messageHistory ?? []).slice(0, MAX_HISTORY),
        dialogueSummary: data.dialogueSummary ?? '',
        lastSummarizedIndex: data.lastSummarizedIndex ?? -1,
        domains: data.domains ?? {},
        workingMemory: data.workingMemory,
        recentlySavedFacts: (data.recentlySavedFacts ?? []).filter(
            (f) => now - f.savedAt < RECENT_FACTS_TTL_MS
        ),
        lastProactiveHintAt: data.lastProactiveHintAt,
        lastProactiveInsight: pruneLastProactiveInsight(data.lastProactiveInsight, now),
        pendingContactMemory: data.pendingContactMemory,
        pendingContactLookup: data.pendingContactLookup,
        pendingPostpone: data.pendingPostpone && (data.pendingPostpone.expiresAt ?? 0) > now
            ? data.pendingPostpone
            : undefined,
        pendingReminderEdit: data.pendingReminderEdit && data.pendingReminderEdit.expiresAt > now
            ? data.pendingReminderEdit
            : undefined,
        pendingBrowserTask: data.pendingBrowserTask && data.pendingBrowserTask.expiresAt > now
            ? data.pendingBrowserTask
            : undefined,
        pendingHealthLog: data.pendingHealthLog && data.pendingHealthLog.expiresAt > now
            ? data.pendingHealthLog
            : undefined,
        pendingHealthDiscomfort: data.pendingHealthDiscomfort && data.pendingHealthDiscomfort.expiresAt > now
            ? data.pendingHealthDiscomfort
            : undefined,
        activeBrowserTask: data.activeBrowserTask && data.activeBrowserTask.expiresAt > now
            ? data.activeBrowserTask
            : undefined,
        lastBrowserTask: data.lastBrowserTask && data.lastBrowserTask.expiresAt > now
            ? data.lastBrowserTask
            : undefined,
        pendingQuickChoices: prunePendingQuickChoices(data.pendingQuickChoices, now),
        studyChatRequest: pruneStudyChatRequest(data.studyChatRequest, now),
        chatAnalysisPeriodRequest: pruneChatAnalysisPeriodRequest(data.chatAnalysisPeriodRequest, now),
        chatPromptWatchState: pruneChatPromptWatchState(data.chatPromptWatchState, now),
    };
}

function merge(initial: SessionData, persisted: PersistedSession): SessionData {
    return {
        ...initial,
        messageHistory: persisted.messageHistory ?? initial.messageHistory,
        dialogueSummary: persisted.dialogueSummary ?? initial.dialogueSummary,
        lastSummarizedIndex: persisted.lastSummarizedIndex ?? initial.lastSummarizedIndex,
        domains: persisted.domains ?? initial.domains,
        workingMemory: persisted.workingMemory ?? initial.workingMemory,
        recentlySavedFacts: persisted.recentlySavedFacts ?? initial.recentlySavedFacts,
        lastProactiveHintAt: persisted.lastProactiveHintAt ?? initial.lastProactiveHintAt,
        lastProactiveInsight: persisted.lastProactiveInsight ?? initial.lastProactiveInsight,
        pendingContactMemory: persisted.pendingContactMemory ?? initial.pendingContactMemory,
        pendingContactLookup: persisted.pendingContactLookup ?? initial.pendingContactLookup,
        pendingPostpone: persisted.pendingPostpone ?? initial.pendingPostpone,
        pendingReminderEdit: persisted.pendingReminderEdit ?? initial.pendingReminderEdit,
        pendingBrowserTask: persisted.pendingBrowserTask ?? initial.pendingBrowserTask,
        pendingHealthLog: persisted.pendingHealthLog ?? initial.pendingHealthLog,
        pendingHealthDiscomfort: persisted.pendingHealthDiscomfort ?? initial.pendingHealthDiscomfort,
        activeBrowserTask: persisted.activeBrowserTask ?? initial.activeBrowserTask,
        lastBrowserTask: persisted.lastBrowserTask ?? initial.lastBrowserTask,
        pendingQuickChoices: persisted.pendingQuickChoices ?? initial.pendingQuickChoices,
        studyChatRequest: persisted.studyChatRequest ?? initial.studyChatRequest,
        chatAnalysisPeriodRequest: persisted.chatAnalysisPeriodRequest ?? initial.chatAnalysisPeriodRequest,
        chatPromptWatchState: persisted.chatPromptWatchState ?? initial.chatPromptWatchState,
    };
}

function pruneLastProactiveInsight(
    insight: SessionData['lastProactiveInsight'],
    now: number
): SessionData['lastProactiveInsight'] {
    if (!insight) return undefined;
    const ttlMs = 3 * 24 * 60 * 60 * 1000;
    if (!insight.createdAt || now - insight.createdAt > ttlMs) return undefined;
    if (!Array.isArray(insight.sourceMemories) || insight.sourceMemories.length === 0) return undefined;
    return insight;
}

function prunePendingQuickChoices(
    pending: SessionData['pendingQuickChoices'],
    now: number
): SessionData['pendingQuickChoices'] {
    if (!pending) return undefined;
    const fresh = Object.fromEntries(
        Object.entries(pending).filter(([, choice]) => choice.expiresAt > now)
    );
    return Object.keys(fresh).length ? fresh : undefined;
}

function pruneStudyChatRequest(
    request: SessionData['studyChatRequest'],
    now: number
): SessionData['studyChatRequest'] {
    if (!request) return undefined;
    if (request.expiresAt && request.expiresAt <= now) return undefined;
    if (!request.expiresAt && request.createdAt && now - request.createdAt > STUDY_CHAT_REQUEST_FALLBACK_TTL_MS) {
        return undefined;
    }
    if (!request.expiresAt && !request.createdAt) return undefined;
    return request;
}

function pruneChatAnalysisPeriodRequest(
    request: SessionData['chatAnalysisPeriodRequest'],
    now: number
): SessionData['chatAnalysisPeriodRequest'] {
    if (!request) return undefined;
    if (request.expiresAt && request.expiresAt <= now) return undefined;
    if (!request.expiresAt && !request.createdAt) return undefined;
    if (request.createdAt && now - request.createdAt > STUDY_CHAT_REQUEST_FALLBACK_TTL_MS) return undefined;
    return request;
}

function pruneChatPromptWatchState(
    state: SessionData['chatPromptWatchState'],
    now: number
): SessionData['chatPromptWatchState'] {
    if (!state) return undefined;
    if (!state.expiresAt || state.expiresAt <= now) return undefined;
    return state;
}

/**
 * Grammy StorageAdapter backed by PostgreSQL via TypeORM.
 * Persists only the context-critical subset of SessionData (history, summary, domain facts).
 * The stored key is namespaced by the active bot profile to keep session data stable.
 * Non-serializable fields (Map, timers) and reminders are excluded — reminders live in ReminderRegistry/DB.
 */
export class TypeORMSessionStorage implements StorageAdapter<SessionData> {
    private get repo() {
        return AppDataSource.getRepository(SessionEntity);
    }

    async read(key: string): Promise<SessionData | undefined> {
        try {
            const row = await this.repo.findOne({ where: { key: scopedBotKey(key) } });
            if (!row) return undefined;
            const persisted: PersistedSession = JSON.parse(row.data);
            const now = Date.now();
            // Восстанавливаем Date-объекты в messageHistory
            if (Array.isArray(persisted.messageHistory)) {
                persisted.messageHistory = persisted.messageHistory.map((m) => ({
                    ...m,
                    timestamp: m.timestamp ? new Date(m.timestamp) : new Date(),
                }));
            }
            if (persisted.workingMemory?.lastUpdatedAt) {
                persisted.workingMemory = {
                    ...persisted.workingMemory,
                    lastUpdatedAt: new Date(persisted.workingMemory.lastUpdatedAt),
                };
            }
            if (persisted.pendingPostpone?.expiresAt && persisted.pendingPostpone.expiresAt <= now) {
                persisted.pendingPostpone = undefined;
            }
            if (persisted.pendingReminderEdit?.expiresAt && persisted.pendingReminderEdit.expiresAt <= now) {
                persisted.pendingReminderEdit = undefined;
            }
            if (persisted.pendingBrowserTask?.expiresAt && persisted.pendingBrowserTask.expiresAt <= now) {
                persisted.pendingBrowserTask = undefined;
            }
            if (persisted.pendingHealthLog?.expiresAt && persisted.pendingHealthLog.expiresAt <= now) {
                persisted.pendingHealthLog = undefined;
            }
            if (persisted.pendingHealthDiscomfort?.expiresAt && persisted.pendingHealthDiscomfort.expiresAt <= now) {
                persisted.pendingHealthDiscomfort = undefined;
            }
            if (persisted.activeBrowserTask?.expiresAt && persisted.activeBrowserTask.expiresAt <= now) {
                persisted.activeBrowserTask = undefined;
            }
            if (persisted.lastBrowserTask?.expiresAt && persisted.lastBrowserTask.expiresAt <= now) {
                persisted.lastBrowserTask = undefined;
            }
            persisted.pendingQuickChoices = prunePendingQuickChoices(persisted.pendingQuickChoices, now);
            persisted.studyChatRequest = pruneStudyChatRequest(persisted.studyChatRequest, now);
            persisted.chatAnalysisPeriodRequest = pruneChatAnalysisPeriodRequest(persisted.chatAnalysisPeriodRequest, now);
            persisted.chatPromptWatchState = pruneChatPromptWatchState(persisted.chatPromptWatchState, now);
            persisted.lastProactiveInsight = pruneLastProactiveInsight(persisted.lastProactiveInsight, now);
            // Возвращаем PersistedSession — Grammy session.initial() объединится с ним через Object.assign
            return persisted as unknown as SessionData;
        } catch (e) {
            console.error('[SessionStorage] read error:', e);
            return undefined;
        }
    }

    async write(key: string, value: SessionData): Promise<void> {
        try {
            const scopedKey = scopedBotKey(key);
            const persisted = extract(value);
            const data = JSON.stringify(persisted);
            await this.repo.upsert({ key: scopedKey, data }, ['key']);
        } catch (e) {
            console.error('[SessionStorage] write error:', e);
        }
    }

    async delete(key: string): Promise<void> {
        try {
            await this.repo.delete({ key: scopedBotKey(key) });
        } catch (e) {
            console.error('[SessionStorage] delete error:', e);
        }
    }
}

export async function persistSessionNow(ctx: BotContext): Promise<void> {
    const key = ctx.chat?.id != null ? String(ctx.chat.id) : undefined;
    if (!key || !ctx.session) return;
    await new TypeORMSessionStorage().write(key, ctx.session);
}

export async function appendPersistedHistory(
    chatId: number,
    role: string,
    content: string
): Promise<void> {
    try {
        const repo = AppDataSource.getRepository(SessionEntity);
        const key = scopedBotKey(chatId);
        const row = await repo.findOne({ where: { key } });
        const persisted: Partial<PersistedSession> = row ? JSON.parse(row.data) : {};
        const now = Date.now();
        const messageHistory = Array.isArray(persisted.messageHistory)
            ? persisted.messageHistory
            : [];

        messageHistory.unshift({
            role,
            content,
            timestamp: new Date(),
        });

        const next: PersistedSession = {
            messageHistory: messageHistory.slice(0, MAX_HISTORY),
            dialogueSummary: persisted.dialogueSummary ?? '',
            lastSummarizedIndex: persisted.lastSummarizedIndex ?? -1,
            domains: persisted.domains ?? {},
            workingMemory: persisted.workingMemory,
            recentlySavedFacts: persisted.recentlySavedFacts,
            lastProactiveHintAt: persisted.lastProactiveHintAt,
            lastProactiveInsight: pruneLastProactiveInsight(persisted.lastProactiveInsight, now),
            pendingContactMemory: persisted.pendingContactMemory,
            pendingContactLookup: persisted.pendingContactLookup,
            pendingBrowserTask: persisted.pendingBrowserTask?.expiresAt && persisted.pendingBrowserTask.expiresAt <= now
                ? undefined
                : persisted.pendingBrowserTask,
            pendingHealthLog: persisted.pendingHealthLog?.expiresAt && persisted.pendingHealthLog.expiresAt <= now
                ? undefined
                : persisted.pendingHealthLog,
            pendingHealthDiscomfort: persisted.pendingHealthDiscomfort?.expiresAt && persisted.pendingHealthDiscomfort.expiresAt <= now
                ? undefined
                : persisted.pendingHealthDiscomfort,
            activeBrowserTask: persisted.activeBrowserTask?.expiresAt && persisted.activeBrowserTask.expiresAt <= now
                ? undefined
                : persisted.activeBrowserTask,
            lastBrowserTask: persisted.lastBrowserTask?.expiresAt && persisted.lastBrowserTask.expiresAt <= now
                ? undefined
                : persisted.lastBrowserTask,
            pendingQuickChoices: prunePendingQuickChoices(persisted.pendingQuickChoices, now),
            studyChatRequest: pruneStudyChatRequest(persisted.studyChatRequest, now),
            chatAnalysisPeriodRequest: pruneChatAnalysisPeriodRequest(persisted.chatAnalysisPeriodRequest, now),
            chatPromptWatchState: pruneChatPromptWatchState(persisted.chatPromptWatchState, now),
        };

        await repo.upsert({ key, data: JSON.stringify(next) }, ['key']);
    } catch (e) {
        console.error('[SessionStorage] append history failed:', e);
    }
}

export async function saveProactiveInsight(
    chatId: number,
    insight: NonNullable<SessionData['lastProactiveInsight']>
): Promise<void> {
    try {
        const repo = AppDataSource.getRepository(SessionEntity);
        const key = scopedBotKey(chatId);
        const row = await repo.findOne({ where: { key } });
        const persisted: Partial<PersistedSession> = row ? JSON.parse(row.data) : {};
        const now = Date.now();

        const next: PersistedSession = {
            messageHistory: Array.isArray(persisted.messageHistory) ? persisted.messageHistory : [],
            dialogueSummary: persisted.dialogueSummary ?? '',
            lastSummarizedIndex: persisted.lastSummarizedIndex ?? -1,
            domains: persisted.domains ?? {},
            workingMemory: persisted.workingMemory,
            recentlySavedFacts: persisted.recentlySavedFacts,
            lastProactiveHintAt: now,
            lastProactiveInsight: insight,
            pendingContactMemory: persisted.pendingContactMemory,
            pendingContactLookup: persisted.pendingContactLookup,
            pendingBrowserTask: persisted.pendingBrowserTask?.expiresAt && persisted.pendingBrowserTask.expiresAt <= now
                ? undefined
                : persisted.pendingBrowserTask,
            pendingHealthLog: persisted.pendingHealthLog?.expiresAt && persisted.pendingHealthLog.expiresAt <= now
                ? undefined
                : persisted.pendingHealthLog,
            pendingHealthDiscomfort: persisted.pendingHealthDiscomfort?.expiresAt && persisted.pendingHealthDiscomfort.expiresAt <= now
                ? undefined
                : persisted.pendingHealthDiscomfort,
            activeBrowserTask: persisted.activeBrowserTask?.expiresAt && persisted.activeBrowserTask.expiresAt <= now
                ? undefined
                : persisted.activeBrowserTask,
            lastBrowserTask: persisted.lastBrowserTask?.expiresAt && persisted.lastBrowserTask.expiresAt <= now
                ? undefined
                : persisted.lastBrowserTask,
            pendingQuickChoices: prunePendingQuickChoices(persisted.pendingQuickChoices, now),
            studyChatRequest: pruneStudyChatRequest(persisted.studyChatRequest, now),
            chatAnalysisPeriodRequest: pruneChatAnalysisPeriodRequest(persisted.chatAnalysisPeriodRequest, now),
            chatPromptWatchState: pruneChatPromptWatchState(persisted.chatPromptWatchState, now),
        };

        await repo.upsert({ key, data: JSON.stringify(next) }, ['key']);
    } catch (e) {
        console.error('[SessionStorage] save proactive insight failed:', e);
    }
}
