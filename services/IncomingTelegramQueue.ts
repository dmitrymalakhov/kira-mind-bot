import { devLog } from "../utils";

export interface IncomingTelegramQueueJob<TMessage> {
    chatId: number;
    enqueuedAt: number;
    message: TMessage;
}

interface IncomingTelegramQueueOptions<TMessage> {
    concurrency: number;
    maxAgeMs: number;
    maxPendingPerChat: number;
    maxPendingTotal: number;
    warnProcessMs: number;
    warnWaitMs: number;
    logLabel: string;
    getMessageId: (message: TMessage) => number;
    processJob: (job: IncomingTelegramQueueJob<TMessage>) => Promise<void>;
}

export interface IncomingTelegramQueue<TMessage> {
    enqueue(job: IncomingTelegramQueueJob<TMessage>): void;
}

export function createIncomingTelegramQueue<TMessage>(
    options: IncomingTelegramQueueOptions<TMessage>
): IncomingTelegramQueue<TMessage> {
    const {
        concurrency,
        maxAgeMs,
        maxPendingPerChat,
        maxPendingTotal,
        warnProcessMs,
        warnWaitMs,
        logLabel,
        getMessageId,
        processJob,
    } = options;

    const queues = new Map<number, IncomingTelegramQueueJob<TMessage>[]>();
    const activeChats = new Set<number>();
    const readyChats: number[] = [];
    const readyChatSet = new Set<number>();

    let activeWorkers = 0;
    let droppedJobs = 0;
    let expiredJobs = 0;
    let pendingJobs = 0;

    function log(event: string, payload: Record<string, unknown>): void {
        devLog(`[${logLabel}] ${event}`, payload);
    }

    function dropOldestJob(): IncomingTelegramQueueJob<TMessage> | undefined {
        let oldestChatId: number | undefined;
        let oldestJob: IncomingTelegramQueueJob<TMessage> | undefined;

        for (const [chatId, queue] of queues.entries()) {
            const candidate = queue[0];
            if (!candidate) continue;
            if (!oldestJob || candidate.enqueuedAt < oldestJob.enqueuedAt) {
                oldestChatId = chatId;
                oldestJob = candidate;
            }
        }

        if (oldestChatId === undefined || !oldestJob) {
            return undefined;
        }

        const queue = queues.get(oldestChatId);
        if (!queue || queue.length === 0) {
            return undefined;
        }

        queue.shift();
        if (queue.length === 0) {
            queues.delete(oldestChatId);
        }

        pendingJobs = Math.max(0, pendingJobs - 1);
        droppedJobs++;
        log("dropped oldest job", {
            chatId: oldestChatId,
            dropped: droppedJobs,
            messageId: getMessageId(oldestJob.message),
            pending: pendingJobs,
        });
        return oldestJob;
    }

    function dropOldestJobFromChat(chatId: number): IncomingTelegramQueueJob<TMessage> | undefined {
        const queue = queues.get(chatId);
        if (!queue || queue.length === 0) {
            return undefined;
        }

        const dropped = queue.shift();
        if (!dropped) {
            return undefined;
        }

        if (queue.length === 0) {
            queues.delete(chatId);
        }

        pendingJobs = Math.max(0, pendingJobs - 1);
        droppedJobs++;
        log("dropped oldest job from chat", {
            chatId,
            dropped: droppedJobs,
            messageId: getMessageId(dropped.message),
            pending: pendingJobs,
        });
        return dropped;
    }

    function markChatReady(chatId: number): void {
        const queue = queues.get(chatId);
        if (!queue || queue.length === 0 || activeChats.has(chatId) || readyChatSet.has(chatId)) {
            return;
        }

        readyChatSet.add(chatId);
        readyChats.push(chatId);
        void scheduleWorkers();
    }

    function takeNextReadyChat(): number | undefined {
        while (readyChats.length > 0) {
            const chatId = readyChats.shift();
            if (chatId === undefined) {
                continue;
            }

            readyChatSet.delete(chatId);
            if (activeChats.has(chatId)) {
                continue;
            }

            const queue = queues.get(chatId);
            if (queue && queue.length > 0) {
                return chatId;
            }
        }

        return undefined;
    }

    async function runChatWorker(chatId: number): Promise<void> {
        const queue = queues.get(chatId);
        const job = queue?.shift();

        if (!job) {
            queues.delete(chatId);
            return;
        }

        pendingJobs = Math.max(0, pendingJobs - 1);
        if (queue && queue.length === 0) {
            queues.delete(chatId);
        }

        const waitedMs = Date.now() - job.enqueuedAt;
        if (waitedMs > maxAgeMs) {
            expiredJobs++;
            log("skipped expired job", {
                activeWorkers,
                chatId,
                expired: expiredJobs,
                messageId: getMessageId(job.message),
                waitedMs,
            });
            return;
        }

        const startedAt = Date.now();
        try {
            await processJob(job);
        } catch (error) {
            console.error("Ошибка при обработке входящего сообщения из очереди:", error);
        } finally {
            const processMs = Date.now() - startedAt;
            if (waitedMs > warnWaitMs || processMs > warnProcessMs) {
                log("processed job", {
                    activeWorkers,
                    chatId,
                    messageId: getMessageId(job.message),
                    pending: pendingJobs,
                    processMs,
                    readyChats: readyChats.length,
                    waitedMs,
                });
            }
        }
    }

    async function scheduleWorkers(): Promise<void> {
        while (activeWorkers < concurrency) {
            const chatId = takeNextReadyChat();
            if (chatId === undefined) {
                return;
            }

            activeWorkers++;
            activeChats.add(chatId);

            void runChatWorker(chatId).finally(() => {
                activeWorkers = Math.max(0, activeWorkers - 1);
                activeChats.delete(chatId);

                const queue = queues.get(chatId);
                if (queue && queue.length > 0) {
                    markChatReady(chatId);
                }

                void scheduleWorkers();
            });
        }
    }

    function enqueue(job: IncomingTelegramQueueJob<TMessage>): void {
        let queue = queues.get(job.chatId);
        if (!queue) {
            queue = [];
            queues.set(job.chatId, queue);
        }

        while (queue.length >= maxPendingPerChat || pendingJobs >= maxPendingTotal) {
            const dropped = queue.length >= maxPendingPerChat
                ? dropOldestJobFromChat(job.chatId)
                : dropOldestJob();
            if (!dropped) {
                break;
            }
        }

        queue.push(job);
        pendingJobs++;

        const backlog = queue.length - 1;
        if (backlog > 0) {
            log("queued incoming message", {
                backlog,
                chatId: job.chatId,
                messageId: getMessageId(job.message),
                pending: pendingJobs,
            });
        }

        markChatReady(job.chatId);
    }

    return { enqueue };
}
