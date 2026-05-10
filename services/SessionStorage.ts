import type { StorageAdapter } from 'grammy';
import { AppDataSource } from '../data-source';
import { SessionEntity } from '../entity/SessionEntity';
import type { SessionData } from '../types';

const MAX_HISTORY = 20;
const RECENT_FACTS_TTL_MS = 24 * 60 * 60 * 1000;

/** Подмножество SessionData, которое мы сохраняем в БД. */
interface PersistedSession {
    messageHistory: SessionData['messageHistory'];
    dialogueSummary: SessionData['dialogueSummary'];
    lastSummarizedIndex: SessionData['lastSummarizedIndex'];
    domains: SessionData['domains'];
    recentlySavedFacts?: SessionData['recentlySavedFacts'];
    pendingContactMemory?: SessionData['pendingContactMemory'];
    pendingContactLookup?: SessionData['pendingContactLookup'];
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
    };
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
            // Восстанавливаем Date-объекты в messageHistory
            if (Array.isArray(persisted.messageHistory)) {
                persisted.messageHistory = persisted.messageHistory.map((m) => ({
                    ...m,
                    timestamp: m.timestamp ? new Date(m.timestamp) : new Date(),
                }));
            }
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
