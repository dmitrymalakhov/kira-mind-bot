import fs from "fs";
import path from "path";
import { Bot, InputFile } from "grammy";
import type { BotContext, SessionData } from "../types";
import type { RecurringTask } from "../types/recurringTaskTypes";
import { processMessage } from "../orchestrator";
import { RecurringTaskRepository } from "./RecurringTaskRepository";
import {
    TypeORMSessionStorage,
    appendPersistedHistory,
    appendPersistedSentMessageContext,
    mergePersistedBackgroundContinuation,
} from "./SessionStorage";
import { saveRemindersFromResult } from "../handlers/shared";
import { computeFollowingRecurringRun, formatRecurringSchedule } from "../utils/recurringTaskSchedule";
import { splitRecurringResultText } from "../utils/recurringTaskResult";
import { buildRecurringKnowledgeSourceText } from "../utils/recurringTaskPrompt";
import { esc, footer, heading, paragraph, sendStructured } from "../utils/richMessage";

const POLL_INTERVAL_MS = 30_000;
const MAX_RESULT_LENGTH = 20_000;
const MAX_STORED_RESULT_LENGTH = 8_000;
const MAX_STORED_ERROR_LENGTH = 2_000;
const FAILURE_PAUSE_THRESHOLD = 3;
const LOCK_HEARTBEAT_MS = 60_000;
const MAX_CONCURRENT_TASKS = 3;

let timer: NodeJS.Timeout | undefined;
let polling = false;
const runningTaskIds = new Set<string>();

function initialSession(): SessionData {
    return {
        reminders: [],
        messageHistory: [],
        dialogueSummary: "",
        lastSummarizedIndex: -1,
        domains: {},
        sentMessages: {},
        isAllowedUser: true,
    };
}

async function buildBackgroundContext(
    bot: Bot<BotContext>,
    task: RecurringTask,
): Promise<BotContext> {
    const persisted = await new TypeORMSessionStorage().read(String(task.chatId));
    const contextHistory = (task.contextHistory ?? []).map((item) => ({
        ...item,
        timestamp: new Date(task.createdAt),
    }));
    const session: SessionData = {
        ...initialSession(),
        ...(persisted ?? {}),
        messageHistory: contextHistory.slice().reverse(),
        dialogueSummary: "",
        lastSummarizedIndex: -1,
        workingMemory: undefined,
        reminders: [],
        isAllowedUser: true,
        lastIntentDedup: undefined,
        activePersonContext: undefined,
        pendingImplicitReminder: undefined,
        pendingMemoryGap: undefined,
        pendingBrowserTask: undefined,
        activeBrowserTask: undefined,
        lastBrowserTask: undefined,
        pendingContactMemory: undefined,
        pendingContactLookup: undefined,
        pendingReminderEdit: undefined,
        pendingPostpone: undefined,
        pendingRecurringTaskEdit: undefined,
        pendingHealthLog: undefined,
        pendingHealthDiscomfort: undefined,
        pendingQuickChoices: undefined,
        studyChatRequest: undefined,
        chatAnalysisPeriodRequest: undefined,
        chatPromptWatchState: undefined,
    };

    const api = bot.api;
    const chat = task.chatType === "group" || task.chatType === "supergroup"
        ? {
            id: task.chatId,
            type: task.chatType,
            title: task.chatTitle || "Группа",
        }
        : {
            id: task.chatId,
            type: "private" as const,
            first_name: "Владелец",
        };
    return {
        chat,
        from: {
            id: task.userId,
            is_bot: false,
            first_name: "Владелец",
        },
        session,
        api,
        reply: (text: string, options?: any) => api.sendMessage(task.chatId, text, options),
        replyWithPhoto: (photo: any, options?: any) => api.sendPhoto(task.chatId, photo, options),
        replyWithDocument: (document: any, options?: any) => api.sendDocument(task.chatId, document, options),
        replyWithVoice: (voice: any, options?: any) => api.sendVoice(task.chatId, voice, options),
        react: async () => true,
    } as unknown as BotContext;
}

async function sendRecurringResult(
    bot: Bot<BotContext>,
    task: RecurringTask,
    result: Awaited<ReturnType<typeof processMessage>>,
): Promise<void> {
    const rawResponseText = result.responseText || "Задача выполнилась без текстового ответа.";
    const truncationNotice = "\n\n…Ответ сокращён до лимита регулярной задачи.";
    const responseText = rawResponseText.length > MAX_RESULT_LENGTH
        ? `${rawResponseText.slice(0, MAX_RESULT_LENGTH - truncationNotice.length)}${truncationNotice}`
        : rawResponseText;
    const responseBlocks = splitRecurringResultText(responseText)
        .map((chunk) => paragraph(esc(chunk)));
    const sent = await sendStructured(bot.api as any, task.chatId, [
        heading(`🔁 ${esc(task.title)}`, 3),
        ...responseBlocks,
        footer(`Регулярная задача · ${esc(formatRecurringSchedule(task.schedule))}`),
    ], result.keyboard ? { replyMarkup: result.keyboard } : undefined);
    const messageId = (sent as { message_id?: number } | undefined)?.message_id;
    if (messageId) {
        const storedText = `Регулярная задача «${task.title}»:\n${responseText}`.slice(0, 8_000);
        await appendPersistedSentMessageContext(task.chatId, {
            messageId,
            text: storedText,
            kind: "system",
            delivery: "text",
            createdAt: Date.now(),
        });
    }

    if (result.imageGenerated && result.generatedImageUrl) {
        await bot.api.sendPhoto(task.chatId, result.generatedImageUrl);
    }
    if (result.documentFilePath) {
        const filename = result.documentFilename || path.basename(result.documentFilePath);
        try {
            await bot.api.sendDocument(
                task.chatId,
                new InputFile(result.documentFilePath, filename),
                result.documentCaption ? { caption: result.documentCaption } : undefined,
            );
        } finally {
            fs.promises.unlink(result.documentFilePath).catch(() => {});
        }
    }
    if (result.icsFilePath) {
        try {
            await bot.api.sendDocument(
                task.chatId,
                new InputFile(result.icsFilePath, path.basename(result.icsFilePath)),
                { caption: "Файл события из регулярной задачи." },
            );
        } finally {
            fs.promises.unlink(result.icsFilePath).catch(() => {});
        }
    }
}

async function sendRecurringFailure(
    bot: Bot<BotContext>,
    task: RecurringTask,
    error: string,
    paused: boolean,
    autoPaused: boolean,
): Promise<void> {
    await sendStructured(bot.api as any, task.chatId, [
        heading(`⚠️ ${esc(task.title)}`, 3),
        paragraph(autoPaused
            ? "Регулярная задача три раза подряд завершилась ошибкой и поставлена на паузу."
            : "Не получилось выполнить регулярную задачу в этот раз."),
        paragraph(`<b>Ошибка:</b> ${esc(error)}`),
        footer(paused
            ? "Задача на паузе. Исправь её или возобнови через /tasks."
            : "Следующая попытка останется в обычном расписании."),
    ]);
}

export async function executeRecurringTask(
    bot: Bot<BotContext>,
    task: RecurringTask,
): Promise<void> {
    const scheduledFor = new Date(task.nextRunAt);
    const startedAt = Date.now();
    const heartbeat = setInterval(() => {
        void RecurringTaskRepository.refreshLock(task.id).catch((error) => {
            console.error(`[recurring-task] lock heartbeat failed id=${task.id}:`, error);
        });
    }, LOCK_HEARTBEAT_MS);
    heartbeat.unref?.();
    try {
        const ctx = await buildBackgroundContext(bot, task);
        const result = await processMessage(
            ctx,
            task.prompt,
            false,
            "",
            (task.contextHistory ?? []).map((item) => ({
                ...item,
                timestamp: new Date(task.createdAt),
            })),
            undefined,
            {
                turn: { userText: task.prompt },
                knowledgeSourceText: buildRecurringKnowledgeSourceText(task.prompt),
            },
        );
        await mergePersistedBackgroundContinuation(task.chatId, ctx.session, startedAt);
        await saveRemindersFromResult(ctx, result);
        await sendRecurringResult(bot, task, result);
        await appendPersistedHistory(
            task.chatId,
            "bot",
            `[Регулярная задача «${task.title}»]: ${(result.responseText || "").slice(0, MAX_STORED_RESULT_LENGTH)}`,
        );

        const completedAt = new Date();
        const nextRunAt = computeFollowingRecurringRun(task.schedule, scheduledFor, completedAt, task.timezone);
        await RecurringTaskRepository.completeRun(task.id, {
            scheduledFor,
            completedAt,
            nextRunAt,
            lastResult: (result.responseText || "").slice(0, MAX_STORED_RESULT_LENGTH),
            runCount: task.runCount + 1,
        });
        console.info(`[recurring-task] event=completed id=${task.id} next=${nextRunAt.toISOString()}`);
    } catch (cause) {
        const error = cause instanceof Error ? cause.message : String(cause);
        const consecutiveFailures = task.consecutiveFailures + 1;
        const autoPaused = consecutiveFailures >= FAILURE_PAUSE_THRESHOLD;
        let nextRunAt: Date;
        try {
            nextRunAt = computeFollowingRecurringRun(task.schedule, scheduledFor, new Date(), task.timezone);
        } catch (scheduleError) {
            nextRunAt = new Date(Date.now() + 24 * 60 * 60 * 1_000);
            console.error(`[recurring-task] invalid schedule fallback id=${task.id}:`, scheduleError);
        }
        const failedTask = await RecurringTaskRepository.failRun(task.id, {
            scheduledFor,
            nextRunAt,
            error: error.slice(0, MAX_STORED_ERROR_LENGTH),
            consecutiveFailures,
            pauseAfterFailure: autoPaused,
        });
        const paused = autoPaused || failedTask?.status === "paused";
        await sendRecurringFailure(bot, task, error.slice(0, 500), paused, autoPaused).catch((notifyError) => {
            console.error("[recurring-task] failure notification failed:", notifyError);
        });
        console.error(`[recurring-task] event=failed id=${task.id} failures=${consecutiveFailures}`, cause);
    } finally {
        clearInterval(heartbeat);
    }
}

async function poll(bot: Bot<BotContext>): Promise<void> {
    if (polling) return;
    polling = true;
    try {
        const availableSlots = Math.max(0, MAX_CONCURRENT_TASKS - runningTaskIds.size);
        if (availableSlots === 0) return;
        const tasks = await RecurringTaskRepository.claimDue(new Date(), availableSlots);
        for (const task of tasks) {
            runningTaskIds.add(task.id);
            void executeRecurringTask(bot, task)
                .catch((error) => {
                    console.error(`[recurring-task] unhandled execution failure id=${task.id}:`, error);
                })
                .finally(() => {
                    runningTaskIds.delete(task.id);
                    void poll(bot);
                });
        }
    } catch (error) {
        console.error("[recurring-task] scheduler poll failed:", error);
    } finally {
        polling = false;
    }
}

export function startRecurringTaskScheduler(bot: Bot<BotContext>): void {
    if (timer) return;
    void poll(bot);
    timer = setInterval(() => void poll(bot), POLL_INTERVAL_MS);
    timer.unref?.();
    console.log("✅ Планировщик регулярных задач запущен");
}
