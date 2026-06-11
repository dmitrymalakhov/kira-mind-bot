import assert from "assert";
import { TypeORMSessionStorage } from "../services/SessionStorage";
import { AppDataSource } from "../data-source";
import { SessionEntity } from "../entity/SessionEntity";
import type { SessionData } from "../types";
import { scopedBotKey } from "../utils/botIdentity";

interface StoredRow {
    key: string;
    data: string;
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

async function withMockedRepo(run: (repo: InMemorySessionRepo) => Promise<void>) {
    const repo = new InMemorySessionRepo();
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

async function testPendingPostponeRoundTrip() {
    await withMockedRepo(async (repo) => {
        const storage = new TypeORMSessionStorage();
        const key = "176779906";
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
        assert(stored.data.includes("\"pendingPostpone\""));

        const restored = await storage.read(key);
        assert(restored, "session should be restored");
        assert.deepStrictEqual(restored?.pendingPostpone, session.pendingPostpone);
    });
}

async function testPendingReminderEditRoundTrip() {
    await withMockedRepo(async (repo) => {
        const storage = new TypeORMSessionStorage();
        const key = "176779907";
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
        assert(stored.data.includes("\"pendingReminderEdit\""));

        const restored = await storage.read(key);
        assert(restored, "session should be restored");
        assert.deepStrictEqual(restored?.pendingReminderEdit, session.pendingReminderEdit);
    });
}

async function testExpiredPendingStatesPruned() {
    await withMockedRepo(async (repo) => {
        const storage = new TypeORMSessionStorage();
        const key = "176779908";
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
        assert(!stored.data.includes("\"pendingPostpone\""));
        assert(!stored.data.includes("\"pendingReminderEdit\""));

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

async function main() {
    await testPendingPostponeRoundTrip();
    await testPendingReminderEditRoundTrip();
    await testExpiredPendingStatesPruned();
    console.log("sessionStorage reminder pending-state checks passed");
}

main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
});
