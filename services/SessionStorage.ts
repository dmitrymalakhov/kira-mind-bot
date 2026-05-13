import type { StorageAdapter } from 'grammy';
import { AppDataSource } from '../data-source';
import { SessionEntity } from '../entity/SessionEntity';
import type { BotContext, SessionData } from '../types';

const MAX_HISTORY = 20;
const RECENT_FACTS_TTL_MS = 24 * 60 * 60 * 1000;
const STUDY_CHAT_REQUEST_FALLBACK_TTL_MS = 15 * 60 * 1000;

/** Подмножество SessionData, которое мы сохраняем в БД. */
interface PersistedSession {
    messageHistory: SessionData['messageHistory'];
    dialogueSummary: SessionData['dialogueSummary'];
    lastSummarizedIndex: SessionData['lastSummarizedIndex'];
    domains: SessionData['domains'];
    recentlySavedFacts?: SessionData['recentlySavedFacts'];
    pendingContactMemory?: SessionData['pendingContactMemory'];
    pendingContactLookup?: SessionData['pendingContactLookup'];
    pendingBrowserTask?: SessionData['pendingBrowserTask'];
    activeBrowserTask?: SessionData['activeBrowserTask'];
    lastBrowserTask?: SessionData['lastBrowserTask'];
    pendingQuickChoices?: SessionData['pendingQuickChoices'];
    studyChatRequest?: SessionData['studyChatRequest'];
}

function extract(data: SessionData): PersistedSession {
    const now = Date.now();
    return {
        // messageHistory is stored newest-first; keep the head or we persist the oldest messages.
        messageHistory: (data.messageHistory ?? []).slice(0, MAX_HISTORY),
        dialogueSummary: data.dialogueSummary ?? '',
        lastSummarizedIndex: data.lastSummarizedIndex ?? -1,
        domains: data.domains ?? {},
        recentlySavedFacts: (data.recentlySavedFacts ?? []).filter(
            (f) => now - f.savedAt < RECENT_FACTS_TTL_MS
        ),
        pendingContactMemory: data.pendingContactMemory,
        pendingContactLookup: data.pendingContactLookup,
        pendingBrowserTask: data.pendingBrowserTask && data.pendingBrowserTask.expiresAt > now
            ? data.pendingBrowserTask
            : undefined,
        activeBrowserTask: data.activeBrowserTask && data.activeBrowserTask.expiresAt > now
            ? data.activeBrowserTask
            : undefined,
        lastBrowserTask: data.lastBrowserTask && data.lastBrowserTask.expiresAt > now
            ? data.lastBrowserTask
            : undefined,
        pendingQuickChoices: prunePendingQuickChoices(data.pendingQuickChoices, now),
        studyChatRequest: pruneStudyChatRequest(data.studyChatRequest, now),
    };
}

function merge(initial: SessionData, persisted: PersistedSession): SessionData {
    return {
        ...initial,
        messageHistory: persisted.messageHistory ?? initial.messageHistory,
        dialogueSummary: persisted.dialogueSummary ?? initial.dialogueSummary,
        lastSummarizedIndex: persisted.lastSummarizedIndex ?? initial.lastSummarizedIndex,
        domains: persisted.domains ?? initial.domains,
        recentlySavedFacts: persisted.recentlySavedFacts ?? initial.recentlySavedFacts,
        pendingContactMemory: persisted.pendingContactMemory ?? initial.pendingContactMemory,
        pendingContactLookup: persisted.pendingContactLookup ?? initial.pendingContactLookup,
        pendingBrowserTask: persisted.pendingBrowserTask ?? initial.pendingBrowserTask,
        activeBrowserTask: persisted.activeBrowserTask ?? initial.activeBrowserTask,
        lastBrowserTask: persisted.lastBrowserTask ?? initial.lastBrowserTask,
        pendingQuickChoices: persisted.pendingQuickChoices ?? initial.pendingQuickChoices,
        studyChatRequest: persisted.studyChatRequest ?? initial.studyChatRequest,
    };
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

/**
 * Grammy StorageAdapter backed by PostgreSQL via TypeORM.
 * Persists only the context-critical subset of SessionData (history, summary, domain facts).
 * Non-serializable fields (Map, timers) and reminders are excluded — reminders live in ReminderRegistry/DB.
 */
export class TypeORMSessionStorage implements StorageAdapter<SessionData> {
    private get repo() {
        return AppDataSource.getRepository(SessionEntity);
    }

    async read(key: string): Promise<SessionData | undefined> {
        try {
            const row = await this.repo.findOne({ where: { key } });
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
            if (persisted.pendingBrowserTask?.expiresAt && persisted.pendingBrowserTask.expiresAt <= now) {
                persisted.pendingBrowserTask = undefined;
            }
            if (persisted.activeBrowserTask?.expiresAt && persisted.activeBrowserTask.expiresAt <= now) {
                persisted.activeBrowserTask = undefined;
            }
            if (persisted.lastBrowserTask?.expiresAt && persisted.lastBrowserTask.expiresAt <= now) {
                persisted.lastBrowserTask = undefined;
            }
            persisted.pendingQuickChoices = prunePendingQuickChoices(persisted.pendingQuickChoices, now);
            persisted.studyChatRequest = pruneStudyChatRequest(persisted.studyChatRequest, now);
            // Возвращаем PersistedSession — Grammy session.initial() объединится с ним через Object.assign
            return persisted as unknown as SessionData;
        } catch (e) {
            console.error('[SessionStorage] read error:', e);
            return undefined;
        }
    }

    async write(key: string, value: SessionData): Promise<void> {
        try {
            const persisted = extract(value);
            const data = JSON.stringify(persisted);
            await this.repo.upsert({ key, data }, ['key']);
        } catch (e) {
            console.error('[SessionStorage] write error:', e);
        }
    }

    async delete(key: string): Promise<void> {
        try {
            await this.repo.delete({ key });
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
        const key = String(chatId);
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
            recentlySavedFacts: persisted.recentlySavedFacts,
            pendingContactMemory: persisted.pendingContactMemory,
            pendingContactLookup: persisted.pendingContactLookup,
            pendingBrowserTask: persisted.pendingBrowserTask?.expiresAt && persisted.pendingBrowserTask.expiresAt <= now
                ? undefined
                : persisted.pendingBrowserTask,
            activeBrowserTask: persisted.activeBrowserTask?.expiresAt && persisted.activeBrowserTask.expiresAt <= now
                ? undefined
                : persisted.activeBrowserTask,
            lastBrowserTask: persisted.lastBrowserTask?.expiresAt && persisted.lastBrowserTask.expiresAt <= now
                ? undefined
                : persisted.lastBrowserTask,
            pendingQuickChoices: prunePendingQuickChoices(persisted.pendingQuickChoices, now),
            studyChatRequest: pruneStudyChatRequest(persisted.studyChatRequest, now),
        };

        await repo.upsert({ key, data: JSON.stringify(next) }, ['key']);
    } catch (e) {
        console.error('[SessionStorage] append history failed:', e);
    }
}
