import assert from "node:assert/strict";
import { createIncomingTelegramQueue, type IncomingTelegramQueueJob } from "../services/IncomingTelegramQueue";

interface TestMessage {
    id: number;
    delayMs: number;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(condition: () => boolean, timeoutMs: number = 2_000): Promise<void> {
    const startedAt = Date.now();
    while (!condition()) {
        if (Date.now() - startedAt > timeoutMs) {
            throw new Error(`Timed out after ${timeoutMs}ms`);
        }
        await sleep(5);
    }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((res) => {
        resolve = res;
    });
    return { promise, resolve };
}

async function testSerializesPerChatAndLimitsConcurrency(): Promise<void> {
    const started: number[] = [];
    const finished: number[] = [];
    const startedAtByMessage = new Map<number, number>();
    const finishedAtByMessage = new Map<number, number>();
    const activeChats = new Map<number, number>();
    let activeWorkers = 0;
    let maxActiveWorkers = 0;

    const queue = createIncomingTelegramQueue<TestMessage>({
        concurrency: 2,
        maxAgeMs: 1_000,
        maxPendingPerChat: 10,
        maxPendingTotal: 10,
        warnProcessMs: 1,
        warnWaitMs: 1,
        logLabel: "test-queue",
        getMessageId: (message) => message.id,
        processJob: async (job) => {
            started.push(job.message.id);
            startedAtByMessage.set(job.message.id, Date.now());

            activeWorkers++;
            maxActiveWorkers = Math.max(maxActiveWorkers, activeWorkers);

            const activeInChat = activeChats.get(job.chatId) ?? 0;
            assert.equal(activeInChat, 0, `chat ${job.chatId} started more than one job concurrently`);
            activeChats.set(job.chatId, activeInChat + 1);

            await sleep(job.message.delayMs);

            activeChats.delete(job.chatId);
            activeWorkers--;
            finished.push(job.message.id);
            finishedAtByMessage.set(job.message.id, Date.now());
        },
    });

    const jobs: Array<IncomingTelegramQueueJob<TestMessage>> = [
        { chatId: 1, enqueuedAt: Date.now(), message: { id: 101, delayMs: 40 } },
        { chatId: 1, enqueuedAt: Date.now(), message: { id: 102, delayMs: 5 } },
        { chatId: 2, enqueuedAt: Date.now(), message: { id: 201, delayMs: 20 } },
        { chatId: 3, enqueuedAt: Date.now(), message: { id: 301, delayMs: 5 } },
    ];

    jobs.forEach((job) => queue.enqueue(job));
    await waitFor(() => finished.length === jobs.length);

    assert.equal(maxActiveWorkers <= 2, true, `expected max 2 active workers, got ${maxActiveWorkers}`);
    assert.equal(started.includes(101), true);
    assert.equal(started.includes(102), true);
    assert.equal(started.includes(201), true);
    assert.equal(started.includes(301), true);
    assert.equal((finishedAtByMessage.get(101) ?? 0) <= (startedAtByMessage.get(102) ?? Number.MAX_SAFE_INTEGER), true);
}

async function testDropsOldestPendingJobPerChat(): Promise<void> {
    const blocker = deferred();
    const finished: number[] = [];
    let firstStarted = false;

    const queue = createIncomingTelegramQueue<TestMessage>({
        concurrency: 1,
        maxAgeMs: 1_000,
        maxPendingPerChat: 2,
        maxPendingTotal: 10,
        warnProcessMs: 1,
        warnWaitMs: 1,
        logLabel: "test-queue",
        getMessageId: (message) => message.id,
        processJob: async (job) => {
            if (job.message.id === 1) {
                firstStarted = true;
                await blocker.promise;
            }
            finished.push(job.message.id);
        },
    });

    queue.enqueue({ chatId: 1, enqueuedAt: Date.now(), message: { id: 1, delayMs: 0 } });
    await waitFor(() => firstStarted);
    queue.enqueue({ chatId: 1, enqueuedAt: Date.now(), message: { id: 2, delayMs: 0 } });
    queue.enqueue({ chatId: 1, enqueuedAt: Date.now(), message: { id: 3, delayMs: 0 } });
    queue.enqueue({ chatId: 1, enqueuedAt: Date.now(), message: { id: 4, delayMs: 0 } });

    blocker.resolve();
    await waitFor(() => finished.length === 3);

    assert.deepEqual(finished, [1, 3, 4]);
}

async function testDropsOldestPendingJobGlobally(): Promise<void> {
    const blocker = deferred();
    const finished: number[] = [];
    let firstStarted = false;

    const queue = createIncomingTelegramQueue<TestMessage>({
        concurrency: 1,
        maxAgeMs: 1_000,
        maxPendingPerChat: 10,
        maxPendingTotal: 2,
        warnProcessMs: 1,
        warnWaitMs: 1,
        logLabel: "test-queue",
        getMessageId: (message) => message.id,
        processJob: async (job) => {
            if (job.message.id === 1) {
                firstStarted = true;
                await blocker.promise;
            }
            finished.push(job.message.id);
        },
    });

    queue.enqueue({ chatId: 1, enqueuedAt: Date.now(), message: { id: 1, delayMs: 0 } });
    await waitFor(() => firstStarted);
    queue.enqueue({ chatId: 2, enqueuedAt: Date.now(), message: { id: 2, delayMs: 0 } });
    queue.enqueue({ chatId: 3, enqueuedAt: Date.now(), message: { id: 3, delayMs: 0 } });
    queue.enqueue({ chatId: 4, enqueuedAt: Date.now(), message: { id: 4, delayMs: 0 } });

    blocker.resolve();
    await waitFor(() => finished.length === 3);

    assert.deepEqual(finished, [1, 3, 4]);
}

async function main(): Promise<void> {
    await testSerializesPerChatAndLimitsConcurrency();
    await testDropsOldestPendingJobPerChat();
    await testDropsOldestPendingJobGlobally();
    console.log("incomingTelegramQueue checks passed");
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
