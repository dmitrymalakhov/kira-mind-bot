export type RecurringTaskStatus = "active" | "paused";

export interface RecurringTaskSchedule {
    type: "interval" | "daily" | "weekly" | "monthly";
    /** Для interval — шаг в минутах. */
    intervalMinutes?: number;
    /** Для календарных расписаний — шаг в днях/неделях/месяцах. */
    interval?: number;
    /** Локальное время запуска в timezone задачи. */
    hour?: number;
    minute?: number;
    /** Для weekly: 1=пн, ..., 7=вс. */
    daysOfWeek?: number[];
    /** Для monthly: число месяца. */
    dayOfMonth?: number;
    /** Локальная дата-якорь YYYY-MM-DD для корректного шага N. */
    anchorDate: string;
}

export interface RecurringTask {
    id: string;
    profile: string;
    chatId: number;
    chatType: "private" | "group" | "supergroup";
    chatTitle?: string;
    userId: number;
    title: string;
    prompt: string;
    /** Контекст до исходного запроса, от старых сообщений к новым. */
    contextHistory?: Array<{
        role: string;
        content: string;
    }>;
    originalMessageId?: number;
    schedule: RecurringTaskSchedule;
    timezone: string;
    status: RecurringTaskStatus;
    nextRunAt: Date;
    lastRunAt?: Date;
    lastCompletedAt?: Date;
    lockedAt?: Date;
    lastResult?: string;
    lastError?: string;
    consecutiveFailures: number;
    runCount: number;
    createdAt: Date;
    updatedAt: Date;
}
