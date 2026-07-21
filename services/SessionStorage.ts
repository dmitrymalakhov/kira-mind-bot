import type { StorageAdapter } from 'grammy';
import type { Repository } from 'typeorm';
import { AppDataSource } from '../data-source';
import { SessionEntity } from '../entity/SessionEntity';
import type { BotContext, SentMessageContext, SessionData } from '../types';
import { scopedBotKey } from '../utils/botIdentity';

const MAX_HISTORY = 20;
export const MAX_SENT_MESSAGE_CONTEXTS = 50;
const SENT_MESSAGE_CONTEXT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RECENT_FACTS_TTL_MS = 24 * 60 * 60 * 1000;
const STUDY_CHAT_REQUEST_FALLBACK_TTL_MS = 15 * 60 * 1000;
const PENDING_DIALOGUE_CONTEXT_TTL_MS = 5 * 60 * 1000;
const SESSION_SNAPSHOT = Symbol('persistedSessionSnapshot');

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
    sentMessages?: SessionData['sentMessages'];
    sentMessageContexts?: SessionData['sentMessageContexts'];
    activePersonContext?: SessionData['activePersonContext'];
    lastMemoryGapAt?: SessionData['lastMemoryGapAt'];
    lastImplicitReminderAt?: SessionData['lastImplicitReminderAt'];
    pendingImplicitReminder?: SessionData['pendingImplicitReminder'];
    pendingMemoryGap?: SessionData['pendingMemoryGap'];
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

type SessionWithSnapshot = SessionData & {
    [SESSION_SNAPSHOT]?: Partial<PersistedSession>;
};

type SessionRepository = Repository<SessionEntity>;
type RawQuery = (sql: string, parameters?: unknown[]) => Promise<unknown>;

const NORMALIZED_SESSION_DATA_SQL = `CASE
    WHEN jsonb_typeof(data) = 'string' THEN (data #>> '{}')::jsonb
    WHEN jsonb_typeof(data) = 'object' THEN data
    ELSE '{}'::jsonb
END`;

function parsePersistedSession(value: unknown): Partial<PersistedSession> {
    if (typeof value === 'string') {
        const parsed = JSON.parse(value) as unknown;
        return parsed && typeof parsed === 'object'
            ? parsed as Partial<PersistedSession>
            : {};
    }
    return value && typeof value === 'object'
        ? value as Partial<PersistedSession>
        : {};
}

function clonePersistedSession<T extends Partial<PersistedSession>>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

function attachSessionSnapshot(value: SessionData, snapshot: Partial<PersistedSession>): void {
    Object.defineProperty(value, SESSION_SNAPSHOT, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: clonePersistedSession(snapshot),
    });
}

function jsonEquals(left: unknown, right: unknown): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);
}

function applyJsonDelta(base: unknown, current: unknown, latest: unknown): unknown {
    if (jsonEquals(base, current)) return latest;
    if (!isJsonObject(current)) return current;

    const baseObject = isJsonObject(base) ? base : {};
    const merged: Record<string, unknown> = isJsonObject(latest) ? { ...latest } : {};
    for (const key of new Set([...Object.keys(baseObject), ...Object.keys(current)])) {
        if (!(key in current)) {
            delete merged[key];
            continue;
        }
        merged[key] = applyJsonDelta(baseObject[key], current[key], merged[key]);
    }
    return merged;
}

function historyEntryKey(entry: unknown): string {
    if (!isJsonObject(entry)) return JSON.stringify(entry);
    const timestamp = entry.timestamp instanceof Date
        ? entry.timestamp.toISOString()
        : String(entry.timestamp ?? '');
    return JSON.stringify([entry.role, entry.content, timestamp]);
}

function splitPrependedHistory(base: unknown[], changed: unknown[]): {
    additions: unknown[];
    retained: unknown[];
} | undefined {
    const baseKeys = base.map(historyEntryKey);
    const changedKeys = changed.map(historyEntryKey);
    for (let additionCount = 0; additionCount <= changed.length; additionCount += 1) {
        const retainedKeys = changedKeys.slice(additionCount);
        if (base.length > 0 && changed.length > 0 && retainedKeys.length === 0) continue;
        if (retainedKeys.every((key, index) => key === baseKeys[index])) {
            return {
                additions: changed.slice(0, additionCount),
                retained: changed.slice(additionCount),
            };
        }
    }
    return undefined;
}

function mergeMessageHistoryDelta(base: unknown, current: unknown, latest: unknown): unknown {
    if (jsonEquals(base, current)) return latest;
    if (!Array.isArray(current) || !Array.isArray(latest)) return current;

    const baseHistory = Array.isArray(base) ? base : [];
    const localDelta = splitPrependedHistory(baseHistory, current);
    if (!localDelta) return current;
    const latestDelta = splitPrependedHistory(baseHistory, latest);
    const backgroundAdditions = latestDelta
        ? latestDelta.additions
        : latest.filter(entry => !baseHistory.some(baseEntry => historyEntryKey(baseEntry) === historyEntryKey(entry)));

    const seen = new Set<string>();
    return [...localDelta.additions, ...backgroundAdditions, ...localDelta.retained]
        .filter(entry => {
            const key = historyEntryKey(entry);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        })
        .slice(0, MAX_HISTORY);
}

function applyPersistedSessionDelta(
    base: Partial<PersistedSession>,
    current: PersistedSession,
    latest: Partial<PersistedSession>,
): PersistedSession {
    const merged = { ...latest } as Record<string, unknown>;
    const baseRecord = base as Record<string, unknown>;
    const currentRecord = current as unknown as Record<string, unknown>;
    for (const key of new Set([...Object.keys(baseRecord), ...Object.keys(currentRecord)])) {
        if (jsonEquals(baseRecord[key], currentRecord[key])) continue;
        if (!(key in currentRecord) || currentRecord[key] === undefined) {
            delete merged[key];
            continue;
        }
        merged[key] = key === 'messageHistory'
            ? mergeMessageHistoryDelta(baseRecord[key], currentRecord[key], merged[key])
            : applyJsonDelta(baseRecord[key], currentRecord[key], merged[key]);
    }
    return {
        messageHistory: Array.isArray(merged.messageHistory) ? merged.messageHistory as PersistedSession['messageHistory'] : [],
        dialogueSummary: typeof merged.dialogueSummary === 'string' ? merged.dialogueSummary : '',
        lastSummarizedIndex: typeof merged.lastSummarizedIndex === 'number' ? merged.lastSummarizedIndex : -1,
        domains: isJsonObject(merged.domains) ? merged.domains as PersistedSession['domains'] : {},
        ...merged,
    } as PersistedSession;
}

function repositoryRawQuery(repo: SessionRepository): RawQuery | undefined {
    const query = (repo as SessionRepository & { query?: RawQuery }).query;
    return typeof query === 'function' ? query.bind(repo) : undefined;
}

async function ensureSessionRow(rawQuery: RawQuery, key: string): Promise<void> {
    const emptySession = JSON.stringify({
        messageHistory: [],
        dialogueSummary: '',
        lastSummarizedIndex: -1,
        domains: {},
    });
    await rawQuery(`
        INSERT INTO bot_sessions (key, data)
        VALUES ($1, $2::jsonb)
        ON CONFLICT (key) DO NOTHING
    `, [key, emptySession]);
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
        sentMessages: pruneSentMessages(data.sentMessages),
        sentMessageContexts: pruneSentMessageContexts(data.sentMessageContexts, now),
        activePersonContext: data.activePersonContext && data.activePersonContext.expiresAt > now
            ? data.activePersonContext
            : undefined,
        lastMemoryGapAt: data.lastMemoryGapAt,
        lastImplicitReminderAt: data.lastImplicitReminderAt,
        pendingImplicitReminder: data.pendingImplicitReminder && now - data.pendingImplicitReminder.createdAt <= PENDING_DIALOGUE_CONTEXT_TTL_MS
            ? data.pendingImplicitReminder
            : undefined,
        pendingMemoryGap: data.pendingMemoryGap && data.pendingMemoryGap.expiresAt > now
            ? data.pendingMemoryGap
            : undefined,
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
        sentMessages: persisted.sentMessages ?? initial.sentMessages,
        sentMessageContexts: persisted.sentMessageContexts ?? initial.sentMessageContexts,
        activePersonContext: persisted.activePersonContext ?? initial.activePersonContext,
        lastMemoryGapAt: persisted.lastMemoryGapAt ?? initial.lastMemoryGapAt,
        lastImplicitReminderAt: persisted.lastImplicitReminderAt ?? initial.lastImplicitReminderAt,
        pendingImplicitReminder: persisted.pendingImplicitReminder ?? initial.pendingImplicitReminder,
        pendingMemoryGap: persisted.pendingMemoryGap ?? initial.pendingMemoryGap,
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

function pruneSentMessages(messages: SessionData['sentMessages']): SessionData['sentMessages'] {
    if (!messages) return undefined;
    const entries = Object.entries(messages)
        .sort(([left], [right]) => Number(right) - Number(left))
        .slice(0, 50);
    return entries.length ? Object.fromEntries(entries) as Record<number, string> : undefined;
}

function pruneSentMessageContexts(
    contexts: SessionData['sentMessageContexts'],
    now: number,
): SessionData['sentMessageContexts'] {
    if (!contexts) return undefined;
    const entries = Object.entries(contexts)
        .filter(([, context]) => context.createdAt > 0 && now - context.createdAt <= SENT_MESSAGE_CONTEXT_TTL_MS)
        .sort(([left], [right]) => Number(right) - Number(left))
        .slice(0, MAX_SENT_MESSAGE_CONTEXTS);
    return entries.length
        ? Object.fromEntries(entries) as SessionData['sentMessageContexts']
        : undefined;
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
            const scopedKey = scopedBotKey(key);
            const row = await this.repo.findOne({ where: { key: scopedKey } });
            if (!row) return undefined;
            const persisted = parsePersistedSession(row.data) as PersistedSession;
            attachSessionSnapshot(persisted as unknown as SessionData, persisted);
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
            const current = extract(value);
            const base = (value as SessionWithSnapshot)[SESSION_SNAPSHOT] ?? {};
            const manager = this.repo.manager;

            if (manager?.transaction) {
                await manager.transaction(async transactionManager => {
                    const repo = transactionManager.getRepository(SessionEntity);
                    await transactionManager.query(`
                        INSERT INTO bot_sessions (key, data)
                        VALUES ($1, '{}'::jsonb)
                        ON CONFLICT (key) DO NOTHING
                    `, [scopedKey]);
                    const row = await repo.findOne({
                        where: { key: scopedKey },
                        lock: { mode: 'pessimistic_write' },
                    });
                    const latest = row ? parsePersistedSession(row.data) : {};
                    const next = applyPersistedSessionDelta(base, current, latest);
                    await repo.upsert({ key: scopedKey, data: next as unknown as Record<string, any> }, ['key']);
                });
            } else {
                // Упрощённый путь используется unit-тестами без TypeORM EntityManager.
                const row = await this.repo.findOne({ where: { key: scopedKey } });
                const latest = row ? parsePersistedSession(row.data) : {};
                const next = applyPersistedSessionDelta(base, current, latest);
                await this.repo.upsert({ key: scopedKey, data: next as unknown as Record<string, any> }, ['key']);
            }
            // Snapshot отражает только увиденное middleware состояние. Фоновые поля,
            // подмешанные из latest, не должны считаться локально удалёнными на следующем flush.
            attachSessionSnapshot(value, current);
        } catch (e) {
            console.error('[SessionStorage] write error:', e);
        }
    }

    async delete(key: string): Promise<void> {
        try {
            const scopedKey = scopedBotKey(key);
            await this.repo.delete({ key: scopedKey });
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

/**
 * Сохраняет метаданные сообщения, отправленного вне middleware-контекста
 * (например, планировщиком reflection). Это позволяет корректно восстановить
 * reply на rich-карточку, которая в Telegram иначе выглядит как `[Сообщение]`.
 */
export async function appendPersistedSentMessageContext(
    chatId: number,
    context: SentMessageContext,
): Promise<void> {
    const repo = AppDataSource.getRepository(SessionEntity);
    const key = scopedBotKey(chatId);
    const rawQuery = repositoryRawQuery(repo);
    if (rawQuery) {
        await ensureSessionRow(rawQuery, key);
        const contextCutoff = Date.now() - SENT_MESSAGE_CONTEXT_TTL_MS;
        await rawQuery(`
            UPDATE bot_sessions
            SET data = jsonb_set(
                jsonb_set(
                    ${NORMALIZED_SESSION_DATA_SQL},
                    '{sentMessageContexts}',
                    (
                        SELECT COALESCE(jsonb_object_agg(pruned.key, pruned.value), '{}'::jsonb)
                        FROM (
                            SELECT entry.key, entry.value
                            FROM jsonb_each(
                                COALESCE((${NORMALIZED_SESSION_DATA_SQL})->'sentMessageContexts', '{}'::jsonb)
                                    || jsonb_build_object($2::text, $3::jsonb)
                            ) AS entry(key, value)
                            WHERE (entry.value->>'createdAt') ~ '^[0-9]+$'
                                AND (entry.value->>'createdAt')::bigint >= $5::bigint
                            ORDER BY CASE WHEN entry.key ~ '^[0-9]+$' THEN entry.key::bigint ELSE 0 END DESC
                            LIMIT ${MAX_SENT_MESSAGE_CONTEXTS}
                        ) AS pruned
                    ),
                    true
                ),
                '{sentMessages}',
                (
                    SELECT COALESCE(jsonb_object_agg(pruned.key, pruned.value), '{}'::jsonb)
                    FROM (
                        SELECT entry.key, entry.value
                        FROM jsonb_each(
                            COALESCE((${NORMALIZED_SESSION_DATA_SQL})->'sentMessages', '{}'::jsonb)
                                || jsonb_build_object($2::text, to_jsonb($4::text))
                        ) AS entry(key, value)
                        ORDER BY CASE WHEN entry.key ~ '^[0-9]+$' THEN entry.key::bigint ELSE 0 END DESC
                        LIMIT ${MAX_SENT_MESSAGE_CONTEXTS}
                    ) AS pruned
                ),
                true
            )
            WHERE key = $1
        `, [key, String(context.messageId), JSON.stringify(context), context.text, contextCutoff]);
        return;
    }

    // Упрощённый fallback нужен только in-memory репозиторию unit-тестов.
    const row = await repo.findOne({ where: { key } });
    const persisted = row ? parsePersistedSession(row.data) : {};
    const contexts = {
        ...(persisted.sentMessageContexts ?? {}),
        [context.messageId]: context,
    };
    const sentMessages = {
        ...(persisted.sentMessages ?? {}),
        [context.messageId]: context.text,
    };
    const next: PersistedSession = {
        messageHistory: persisted.messageHistory ?? [],
        dialogueSummary: persisted.dialogueSummary ?? '',
        lastSummarizedIndex: persisted.lastSummarizedIndex ?? -1,
        domains: persisted.domains ?? {},
        ...persisted,
        sentMessages: pruneSentMessages(sentMessages),
        sentMessageContexts: pruneSentMessageContexts(contexts, Date.now()),
    };
    await repo.upsert({ key, data: next as unknown as Record<string, any> }, ['key']);
}

export async function appendPersistedHistory(
    chatId: number,
    role: string,
    content: string
): Promise<void> {
    try {
        const repo = AppDataSource.getRepository(SessionEntity);
        const key = scopedBotKey(chatId);
        const rawQuery = repositoryRawQuery(repo);
        if (rawQuery) {
            await ensureSessionRow(rawQuery, key);
            const historyEntry = JSON.stringify({ role, content, timestamp: new Date() });
            await rawQuery(`
                UPDATE bot_sessions
                SET data = jsonb_set(
                    ${NORMALIZED_SESSION_DATA_SQL},
                    '{messageHistory}',
                    (
                        SELECT COALESCE(jsonb_agg(item ORDER BY ord), '[]'::jsonb)
                        FROM jsonb_array_elements(
                            jsonb_build_array($2::jsonb)
                                || COALESCE((${NORMALIZED_SESSION_DATA_SQL})->'messageHistory', '[]'::jsonb)
                        ) WITH ORDINALITY AS history(item, ord)
                        WHERE ord <= ${MAX_HISTORY}
                    ),
                    true
                )
                WHERE key = $1
            `, [key, historyEntry]);
            return;
        }
        const row = await repo.findOne({ where: { key } });
        const persisted = row ? parsePersistedSession(row.data) : {};
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
            ...persisted,
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

        await repo.upsert({ key, data: next as unknown as Record<string, any> }, ['key']);
    } catch (e) {
        console.error('[SessionStorage] append history failed:', e);
    }
}

export async function saveProactiveInsight(
    chatId: number,
    insight: NonNullable<SessionData['lastProactiveInsight']>,
    options: { touchMemoryHintCooldown?: boolean } = {},
): Promise<void> {
    try {
        const repo = AppDataSource.getRepository(SessionEntity);
        const key = scopedBotKey(chatId);
        const rawQuery = repositoryRawQuery(repo);
        const now = Date.now();
        const touchMemoryHintCooldown = options.touchMemoryHintCooldown !== false;
        if (rawQuery) {
            await ensureSessionRow(rawQuery, key);
            if (touchMemoryHintCooldown) {
                await rawQuery(`
                    UPDATE bot_sessions
                    SET data = jsonb_set(
                        jsonb_set(
                            ${NORMALIZED_SESSION_DATA_SQL},
                            '{lastProactiveHintAt}',
                            to_jsonb($2::bigint),
                            true
                        ),
                        '{lastProactiveInsight}',
                        $3::jsonb,
                        true
                    )
                    WHERE key = $1
                `, [key, now, JSON.stringify(insight)]);
            } else {
                await rawQuery(`
                    UPDATE bot_sessions
                    SET data = jsonb_set(
                        ${NORMALIZED_SESSION_DATA_SQL},
                        '{lastProactiveInsight}',
                        $2::jsonb,
                        true
                    )
                    WHERE key = $1
                `, [key, JSON.stringify(insight)]);
            }
            return;
        }
        const row = await repo.findOne({ where: { key } });
        const persisted = row ? parsePersistedSession(row.data) : {};

        const next: PersistedSession = {
            ...persisted,
            messageHistory: Array.isArray(persisted.messageHistory) ? persisted.messageHistory : [],
            dialogueSummary: persisted.dialogueSummary ?? '',
            lastSummarizedIndex: persisted.lastSummarizedIndex ?? -1,
            domains: persisted.domains ?? {},
            workingMemory: persisted.workingMemory,
            recentlySavedFacts: persisted.recentlySavedFacts,
            lastProactiveHintAt: touchMemoryHintCooldown ? now : persisted.lastProactiveHintAt,
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

        await repo.upsert({ key, data: next as unknown as Record<string, any> }, ['key']);
    } catch (e) {
        console.error('[SessionStorage] save proactive insight failed:', e);
    }
}
