import assert from "assert";
import {
    appendPersistedHistory,
    appendPersistedSentMessageContext,
    saveProactiveInsight,
    TypeORMSessionStorage,
} from "../services/SessionStorage";
import { AppDataSource } from "../data-source";
import { SessionEntity } from "../entity/SessionEntity";
import type { SessionData } from "../types";
import { scopedBotKey } from "../utils/botIdentity";

interface StoredRow {
    key: string;
    data: Record<string, unknown> | string;
}

interface SessionRepo {
    findOne(args: { where: { key: string } }): Promise<StoredRow | null>;
    upsert(row: StoredRow, keys: string[]): Promise<void>;
    delete(args: { key: string }): Promise<void>;
}

function createInitialSession(): SessionData {
    return {
        reminders: [],
        messageHistory: [],
        dialogueSummary: "",
        lastSummarizedIndex: -1,
        domains: {},
        sentMessages: {},
    };
}

class InMemorySessionRepo implements SessionRepo {
    private rows = new Map<string, StoredRow>();

    async findOne(args: { where: { key: string } }): Promise<StoredRow | null> {
        return this.rows.get(args.where.key) ?? null;
    }

    async upsert(row: StoredRow, _keys: string[]): Promise<void> {
        this.rows.set(row.key, { ...row });
    }

    async delete(args: { key: string }): Promise<void> {
        this.rows.delete(args.key);
    }

    getRow(key: string): StoredRow | undefined {
        return this.rows.get(key);
    }
}

async function withMockedRepo(
    run: (repo: InMemorySessionRepo) => Promise<void>,
    repo: InMemorySessionRepo = new InMemorySessionRepo(),
) {
    const originalDescriptor = Object.getOwnPropertyDescriptor(AppDataSource, "getRepository");

    Object.defineProperty(AppDataSource, "getRepository", {
        configurable: true,
        value: (_entity: typeof SessionEntity) => repo,
    });

    try {
        await run(repo);
    } finally {
        if (originalDescriptor) {
            Object.defineProperty(AppDataSource, "getRepository", originalDescriptor);
        }
    }
}

class RawCapturingSessionRepo extends InMemorySessionRepo {
    readonly queries: Array<{ sql: string; parameters?: unknown[] }> = [];

    async query(sql: string, parameters?: unknown[]): Promise<unknown> {
        this.queries.push({ sql, parameters });
        return [];
    }
}

async function testPendingPostponeRoundTrip() {
    await withMockedRepo(async (repo) => {
        const storage = new TypeORMSessionStorage();
        const key = "910000006";
        const expiresAt = Date.now() + 60_000;
        const session: SessionData = {
            ...createInitialSession(),
            pendingPostpone: {
                reminderId: "reminder-1",
                messageId: 101,
                chatId: 202,
                createdAt: Date.now(),
                expiresAt,
            },
        };

        await storage.write(key, session);

        const stored = repo.getRow(scopedBotKey(key));
        assert(stored, "pendingPostpone should be written to storage");
        assert(JSON.stringify(stored.data).includes("\"pendingPostpone\""));

        const restored = await storage.read(key);
        assert(restored, "session should be restored");
        assert.deepStrictEqual(restored?.pendingPostpone, session.pendingPostpone);
    });
}

async function testPendingReminderEditRoundTrip() {
    await withMockedRepo(async (repo) => {
        const storage = new TypeORMSessionStorage();
        const key = "910000007";
        const expiresAt = Date.now() + 60_000;
        const session: SessionData = {
            ...createInitialSession(),
            pendingReminderEdit: {
                reminderId: "reminder-2",
                messageId: 303,
                chatId: 404,
                createdAt: Date.now(),
                expiresAt,
            },
        };

        await storage.write(key, session);

        const stored = repo.getRow(scopedBotKey(key));
        assert(stored, "pendingReminderEdit should be written to storage");
        assert(JSON.stringify(stored.data).includes("\"pendingReminderEdit\""));

        const restored = await storage.read(key);
        assert(restored, "session should be restored");
        assert.deepStrictEqual(restored?.pendingReminderEdit, session.pendingReminderEdit);
    });
}

async function testDialoguePendingContextsRoundTripAndExpire() {
    await withMockedRepo(async (repo) => {
        const storage = new TypeORMSessionStorage();
        const key = '910000013';
        const now = Date.now();
        const session: SessionData = {
            ...createInitialSession(),
            pendingImplicitReminder: {
                originalMessage: 'Синтетическое событие',
                eventSummary: 'синтетическое событие',
                createdAt: now,
            },
            pendingMemoryGap: {
                contactName: 'Контакт Гамма',
                createdAt: now,
                expiresAt: now + 60_000,
                messageId: 123,
            },
        };
        await storage.write(key, session);
        const restored = await storage.read(key);
        assert.deepStrictEqual(restored?.pendingImplicitReminder, session.pendingImplicitReminder);
        assert.deepStrictEqual(restored?.pendingMemoryGap, session.pendingMemoryGap);

        session.pendingImplicitReminder!.createdAt = now - 10 * 60_000;
        session.pendingMemoryGap!.expiresAt = now - 1;
        await storage.write(key, session);
        const stored = repo.getRow(scopedBotKey(key));
        assert(!JSON.stringify(stored?.data).includes('pendingImplicitReminder'));
        assert(!JSON.stringify(stored?.data).includes('pendingMemoryGap'));
    });
}

async function testExpiredPendingStatesPruned() {
    await withMockedRepo(async (repo) => {
        const storage = new TypeORMSessionStorage();
        const key = "910000008";
        const session: SessionData = {
            ...createInitialSession(),
            pendingPostpone: {
                reminderId: "expired-postpone",
                messageId: 1,
                chatId: 2,
                createdAt: Date.now() - 120_000,
                expiresAt: Date.now() - 60_000,
            },
            pendingReminderEdit: {
                reminderId: "expired-edit",
                messageId: 3,
                chatId: 4,
                createdAt: Date.now() - 120_000,
                expiresAt: Date.now() - 60_000,
            },
        };

        await storage.write(key, session);

        const stored = repo.getRow(scopedBotKey(key));
        assert(stored, "expired state should still produce a session row");
        assert(!JSON.stringify(stored.data).includes("\"pendingPostpone\""));
        assert(!JSON.stringify(stored.data).includes("\"pendingReminderEdit\""));

        await repo.upsert({
            key: scopedBotKey(key),
            data: JSON.stringify({
                messageHistory: [],
                dialogueSummary: "",
                lastSummarizedIndex: -1,
                domains: {},
                pendingPostpone: session.pendingPostpone,
                pendingReminderEdit: session.pendingReminderEdit,
            }),
        }, ["key"]);

        const restored = await storage.read(key);
        assert(restored, "session should be restored");
        assert.equal(restored?.pendingPostpone, undefined);
        assert.equal(restored?.pendingReminderEdit, undefined);
    });
}

async function testLegacyStringJsonbIsReadable() {
    await withMockedRepo(async (repo) => {
        const key = '910000010';
        await repo.upsert({
            key: scopedBotKey(key),
            data: JSON.stringify({
                messageHistory: [],
                dialogueSummary: 'legacy summary',
                lastSummarizedIndex: 2,
                domains: {},
            }),
        }, ['key']);

        const restored = await new TypeORMSessionStorage().read(key);
        assert.equal(restored?.dialogueSummary, 'legacy summary');
        assert.equal(restored?.lastSummarizedIndex, 2);
    });
}

async function testBackgroundUpdatesPreserveStructuredContext() {
    await withMockedRepo(async () => {
        const chatId = 910000011;
        const storage = new TypeORMSessionStorage();
        const session = createInitialSession();
        session.sentMessageContexts = {
            88: {
                messageId: 88,
                text: 'Синтетическая подсказка',
                kind: 'proactive',
                personId: 'synthetic-person-id',
                memoryIds: ['synthetic-memory-id'],
                createdAt: Date.now(),
            },
        };
        session.sentMessages = { 88: 'Синтетическая подсказка' };
        session.pendingContactLookup = {
            contactName: 'Тестовый Контакт',
            originalMessage: 'Синтетическая исходная реплика',
            candidateIds: [900000003],
            createdAt: Date.now(),
        };
        await storage.write(String(chatId), session);

        await appendPersistedHistory(chatId, 'bot', 'Фоновая запись');
        await saveProactiveInsight(chatId, {
            message: 'Синтетическая подсказка',
            sourceMemories: ['Синтетический факт'],
            createdAt: Date.now(),
            messageId: 88,
            kind: 'contextHint',
        });

        const restored = await storage.read(String(chatId));
        assert.equal(restored?.sentMessageContexts?.[88]?.personId, 'synthetic-person-id');
        assert.equal(restored?.pendingContactLookup?.contactName, 'Тестовый Контакт');
        assert.equal(restored?.messageHistory?.[0]?.content, 'Фоновая запись');
        assert.equal(restored?.lastProactiveInsight?.messageId, 88);
    });
}

async function testKiraLifeProvenanceDoesNotTouchMemoryHintCooldown() {
    await withMockedRepo(async () => {
        const chatId = 910000017;
        const storage = new TypeORMSessionStorage();
        const session = createInitialSession();
        session.lastProactiveHintAt = 123456;
        await storage.write(String(chatId), session);

        await saveProactiveInsight(chatId, {
            message: 'Синтетическое сообщение внутренней жизни',
            sourceMemories: ['Синтетическое self-event'],
            createdAt: Date.now(),
            messageId: 170,
            kind: 'kiraLife',
        }, { touchMemoryHintCooldown: false });

        const restored = await storage.read(String(chatId));
        assert.equal(restored?.lastProactiveHintAt, 123456);
        assert.equal(restored?.lastProactiveInsight?.kind, 'kiraLife');
        assert.equal(restored?.lastProactiveInsight?.messageId, 170);
    });
}

async function testSourceFreeKiraLifeFallbackSurvivesRestart() {
    await withMockedRepo(async () => {
        const chatId = 910000020;
        const storage = new TypeORMSessionStorage();
        const createdAt = Date.now();
        await saveProactiveInsight(chatId, {
            message: 'Синтетический нейтральный резервный текст',
            sourceMemories: [],
            webSources: [],
            createdAt,
            messageId: 173,
            kind: 'kiraLife',
            generationOutcome: 'fallback',
        }, { touchMemoryHintCooldown: false });

        const restored = await storage.read(String(chatId));
        assert.equal(restored?.lastProactiveInsight?.messageId, 173);
        assert.equal(restored?.lastProactiveInsight?.generationOutcome, 'fallback');
        assert.deepStrictEqual(restored?.lastProactiveInsight?.sourceMemories, []);
    });
}

async function testPerMessageProactiveProvenanceSurvivesRestart() {
    await withMockedRepo(async () => {
        const chatId = 910000019;
        const createdAt = Date.now();
        const firstInsight = {
            message: 'Первое синтетическое сообщение внутренней жизни',
            sourceMemories: ['Первое синтетическое self-event'],
            webSources: ['https://culture.example/synthetic-event'],
            createdAt,
            messageId: 171,
            kind: 'kiraLife' as const,
            generationOutcome: 'generated' as const,
        };
        await appendPersistedSentMessageContext(chatId, {
            messageId: 171,
            text: firstInsight.message,
            kind: 'proactive',
            proactiveInsight: firstInsight,
            createdAt,
        });
        await saveProactiveInsight(chatId, {
            message: 'Более новое синтетическое сообщение',
            sourceMemories: ['Другой синтетический источник'],
            createdAt: createdAt + 1,
            messageId: 172,
            kind: 'memoryInsight',
        });

        const restored = await new TypeORMSessionStorage().read(String(chatId));
        assert.equal(restored?.lastProactiveInsight?.messageId, 172);
        assert.equal(restored?.sentMessageContexts?.[171]?.proactiveInsight?.messageId, 171);
        assert.equal(restored?.sentMessageContexts?.[171]?.proactiveInsight?.kind, 'kiraLife');
        assert.equal(restored?.sentMessageContexts?.[171]?.proactiveInsight?.generationOutcome, 'generated');
        assert.deepStrictEqual(
            restored?.sentMessageContexts?.[171]?.proactiveInsight?.sourceMemories,
            ['Первое синтетическое self-event'],
        );
        assert.deepStrictEqual(
            restored?.sentMessageContexts?.[171]?.proactiveInsight?.webSources,
            ['https://culture.example/synthetic-event'],
        );
    });
}

async function testRawKiraLifeProvenanceSkipsCooldownField() {
    const repo = new RawCapturingSessionRepo();
    await withMockedRepo(async () => {
        await saveProactiveInsight(910000018, {
            message: 'Синтетическое фоновое сообщение',
            sourceMemories: ['Синтетический источник'],
            createdAt: Date.now(),
            messageId: 180,
            kind: 'kiraLife',
        }, { touchMemoryHintCooldown: false });
    }, repo);

    const update = repo.queries.find(item => /UPDATE bot_sessions/u.test(item.sql));
    assert(update);
    assert.doesNotMatch(update.sql, /lastProactiveHintAt/u);
    assert.match(update.sql, /lastProactiveInsight/u);
    assert.equal(update.parameters?.length, 2);
}

async function testMiddlewareFlushPreservesConcurrentBackgroundUpdates() {
    await withMockedRepo(async () => {
        const chatId = 910000014;
        const storage = new TypeORMSessionStorage();
        const session = createInitialSession();
        await storage.write(String(chatId), session);

        // Имитируем raw/background update после read/write middleware snapshot.
        await appendPersistedHistory(chatId, 'bot', 'Фоновая история');
        await appendPersistedSentMessageContext(chatId, {
            messageId: 144,
            text: 'Фоновая карточка',
            kind: 'proactive',
            createdAt: Date.now(),
        });
        await saveProactiveInsight(chatId, {
            message: 'Фоновая карточка',
            sourceMemories: ['Синтетический источник'],
            createdAt: Date.now(),
            messageId: 144,
            kind: 'contextHint',
        });

        session.dialogueSummary = 'Локальное изменение middleware';
        session.pendingMemoryGap = {
            contactName: 'Контакт Дельта',
            createdAt: Date.now(),
            expiresAt: Date.now() + 60_000,
            messageId: 145,
        };
        await storage.write(String(chatId), session);

        // Повторный flush того же in-memory ctx не должен принять неизвестные ему
        // фоновые поля за намеренное удаление.
        session.pendingMemoryGap = undefined;
        await storage.write(String(chatId), session);
        const afterCleanup = await storage.read(String(chatId));
        assert.equal(afterCleanup?.dialogueSummary, 'Локальное изменение middleware');
        assert.equal(afterCleanup?.pendingMemoryGap, undefined);
        assert.equal(afterCleanup?.messageHistory?.[0]?.content, 'Фоновая история');
        assert.equal(afterCleanup?.sentMessageContexts?.[144]?.text, 'Фоновая карточка');
        assert.equal(afterCleanup?.lastProactiveInsight?.messageId, 144);
    });
}

async function testConcurrentSessionReadsKeepIndependentSnapshots() {
    await withMockedRepo(async () => {
        const chatId = 910000015;
        const storage = new TypeORMSessionStorage();
        await storage.write(String(chatId), createInitialSession());
        const firstContext = await storage.read(String(chatId));
        assert(firstContext);

        // Второй read того же ключа не должен заменить baseline первого ctx.
        await storage.read(String(chatId));
        await appendPersistedSentMessageContext(chatId, {
            messageId: 155,
            text: 'Контекст конкурентного чтения',
            kind: 'system',
            createdAt: Date.now(),
        });
        firstContext.dialogueSummary = 'Изменение первого ctx';
        await storage.write(String(chatId), firstContext);

        const restored = await storage.read(String(chatId));
        assert.equal(restored?.dialogueSummary, 'Изменение первого ctx');
        assert.equal(restored?.sentMessageContexts?.[155]?.text, 'Контекст конкурентного чтения');
    });
}

async function testBoundedLocalHistoryKeepsConcurrentAppend() {
    await withMockedRepo(async () => {
        const chatId = 910000016;
        const storage = new TypeORMSessionStorage();
        const session = createInitialSession();
        session.messageHistory = Array.from({ length: 20 }, (_, index) => ({
            role: 'user',
            content: `Исходная запись ${index}`,
            timestamp: new Date(1_700_000_000_000 - index * 1_000),
        }));
        await storage.write(String(chatId), session);
        await appendPersistedHistory(chatId, 'bot', 'Конкурентная фоновая запись');

        session.messageHistory = [
            { role: 'user', content: 'Новая локальная запись 1', timestamp: new Date() },
            { role: 'bot', content: 'Новая локальная запись 2', timestamp: new Date() },
            ...session.messageHistory,
        ].slice(0, 20);
        await storage.write(String(chatId), session);

        const restored = await storage.read(String(chatId));
        const contents = restored?.messageHistory.map(entry => entry.content) ?? [];
        assert.equal(contents.length, 20);
        assert(contents.includes('Новая локальная запись 1'));
        assert(contents.includes('Новая локальная запись 2'));
        assert(contents.includes('Конкурентная фоновая запись'));
    });
}

async function testStructuredSentMessageRoundTrip() {
    await withMockedRepo(async () => {
        const chatId = 910000009;
        await appendPersistedSentMessageContext(chatId, {
            messageId: 77,
            text: 'Карточка тестового контакта',
            kind: 'memory_card',
            contactId: 900000001,
            contactName: 'Тестовый Контакт Альфа',
            memoryIds: ['memory-1'],
            createdAt: Date.now(),
        });
        const restored = await new TypeORMSessionStorage().read(String(chatId));
        assert.equal(restored?.sentMessages?.[77], 'Карточка тестового контакта');
        assert.equal(restored?.sentMessageContexts?.[77]?.contactId, 900000001);
        assert.deepStrictEqual(restored?.sentMessageContexts?.[77]?.memoryIds, ['memory-1']);
    });
}

async function testRawStructuredContextIsBoundedAndExpires() {
    const repo = new RawCapturingSessionRepo();
    await withMockedRepo(async () => {
        await appendPersistedSentMessageContext(910000012, {
            messageId: 99,
            text: 'Синтетическая карточка',
            kind: 'memory_card',
            personId: 'synthetic-person-bounded',
            memoryIds: ['synthetic-memory-bounded'],
            createdAt: Date.now(),
        });
    }, repo);

    const update = repo.queries.find(item => /UPDATE bot_sessions/u.test(item.sql));
    assert(update, 'production SQL update should be issued');
    assert.match(update.sql, /LIMIT 50/u);
    assert.match(update.sql, /createdAt/u);
    assert.equal(update.parameters?.length, 5);
    assert.equal(typeof update.parameters?.[4], 'number');
}

async function main() {
    await testPendingPostponeRoundTrip();
    await testPendingReminderEditRoundTrip();
    await testDialoguePendingContextsRoundTripAndExpire();
    await testExpiredPendingStatesPruned();
    await testStructuredSentMessageRoundTrip();
    await testLegacyStringJsonbIsReadable();
    await testBackgroundUpdatesPreserveStructuredContext();
    await testKiraLifeProvenanceDoesNotTouchMemoryHintCooldown();
    await testSourceFreeKiraLifeFallbackSurvivesRestart();
    await testPerMessageProactiveProvenanceSurvivesRestart();
    await testRawKiraLifeProvenanceSkipsCooldownField();
    await testMiddlewareFlushPreservesConcurrentBackgroundUpdates();
    await testConcurrentSessionReadsKeepIndependentSnapshots();
    await testBoundedLocalHistoryKeepsConcurrentAppend();
    await testRawStructuredContextIsBoundedAndExpires();
    console.log("sessionStorage reminder pending-state checks passed");
}

main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
});
