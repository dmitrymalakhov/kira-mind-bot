import { InlineKeyboard } from "grammy";
import type { RecurringTask } from "../types/recurringTaskTypes";
import { USER_TIMEZONE } from "../constants";
import { esc, footer, heading, paragraph, type RichBlock } from "./richMessage";
import { formatRecurringSchedule } from "./recurringTaskSchedule";

function truncate(text: string, max = 700): string {
    const normalized = text.replace(/\s+/g, " ").trim();
    return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1).trimEnd()}…`;
}

function formatDateTime(date: Date, timezone: string): string {
    return new Date(date).toLocaleString("ru-RU", {
        timeZone: timezone || USER_TIMEZONE,
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
    });
}

export function buildRecurringTaskCard(
    tasks: RecurringTask[],
    requestedIndex = 0,
): { blocks: RichBlock[]; keyboard: InlineKeyboard; index: number } {
    if (tasks.length === 0) {
        return {
            index: 0,
            blocks: [
                heading("🔁 Регулярные задачи", 3),
                paragraph("Пока нет задач, которые повторно запускают запросы."),
                footer("Сначала отправь мне запрос, а затем напиши: «Теперь присылай это каждое утро»."),
            ],
            keyboard: new InlineKeyboard(),
        };
    }

    const index = Math.min(Math.max(0, requestedIndex), tasks.length - 1);
    const task = tasks[index];
    const isRunning = Boolean(task.lockedAt && Date.now() - task.lockedAt.getTime() < 30 * 60 * 1000);
    const status = isRunning ? "🔵 выполняется" : task.status === "active" ? "🟢 активна" : "⏸ на паузе";
    const lastRun = task.lastCompletedAt
        ? formatDateTime(task.lastCompletedAt, task.timezone)
        : "ещё не запускалась";

    const blocks: RichBlock[] = [
        heading(`🔁 ${esc(task.title)}`, 3),
        paragraph(`<b>Статус:</b> ${status}`),
        paragraph(`<b>Запрос:</b>\n${esc(truncate(task.prompt))}`),
        paragraph(`<b>Расписание:</b> ${esc(formatRecurringSchedule(task.schedule))}`),
        paragraph(`<b>Следующий запуск:</b> ${esc(formatDateTime(task.nextRunAt, task.timezone))}`),
        footer(`Последний запуск: ${lastRun} · Задача ${index + 1} из ${tasks.length}`),
    ];

    const keyboard = new InlineKeyboard()
        .text(task.status === "active" ? "⏸ Пауза" : "▶️ Возобновить", `rt:${task.status === "active" ? "pause" : "resume"}:${task.id}`)
        .text("▶️ Запустить", `rt:run:${task.id}`)
        .row()
        .text("✏️ Изменить", `rt:edit:${task.id}`)
        .text("🗑 Удалить", `rt:delete:${task.id}`);

    if (tasks.length > 1) {
        keyboard.row()
            .text("‹", `rt:nav:${index === 0 ? tasks.length - 1 : index - 1}`)
            .text(`${index + 1}/${tasks.length}`, "rt:noop")
            .text("›", `rt:nav:${index === tasks.length - 1 ? 0 : index + 1}`);
    }

    return { blocks, keyboard, index };
}
