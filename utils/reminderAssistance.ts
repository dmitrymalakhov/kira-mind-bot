import { InlineKeyboard } from "grammy";
import type { InlineKeyboardButton } from "grammy/types";
import type { Reminder } from "../reminder";

export const REMINDER_ASSIST_CALLBACK_PREFIX = "reminder_assist_";

function reminderTaskText(reminder: Pick<Reminder, "text" | "displayText">): string {
    const source = reminder.displayText || reminder.text;
    return source
        .replace(/\s+/g, " ")
        .replace(/^напоминание\s*:\s*/iu, "")
        .trim();
}

export function buildReminderAssistanceRequest(
    reminder: Pick<Reminder, "text" | "displayText">,
): string {
    const task = reminderTaskText(reminder);
    return [
        `Помоги мне выполнить эту задачу прямо сейчас: «${task}».`,
        "Используй доступные инструменты и самостоятельно сделай всё, что можно сделать без внешних последствий.",
        "Если для покупки, отправки, выбора или другого внешнего действия нужны мои данные или подтверждение, сначала задай один конкретный вопрос.",
        "Не планируй задачу повторно и не считай её завершённой автоматически.",
    ].join(" ");
}

export function getReminderAssistanceKnowledgeSourceText(
    reminder: Pick<Reminder, "text" | "displayText">,
): string {
    return reminderTaskText(reminder);
}

export function buildReminderNotificationKeyboard(reminder: Pick<Reminder, "id">): InlineKeyboard {
    return new InlineKeyboard()
        .text("🤖 Помоги выполнить", `${REMINDER_ASSIST_CALLBACK_PREFIX}${reminder.id}`)
        .row()
        .text("✅ Выполнено", `reminder_complete_${reminder.id}`)
        .text("⏰ Напомнить позже", `reminder_postpone_${reminder.id}`)
        .row()
        .text("✏️ Изменить", `reminder_edit_${reminder.id}`)
        .text("❌ Отменить", `reminder_cancel_${reminder.id}`);
}

export function removeReminderAssistanceButton(
    inlineKeyboard: InlineKeyboardButton[][] | undefined,
    reminderId: string,
): InlineKeyboardButton[][] {
    if (!inlineKeyboard) return [];
    const callbackData = `${REMINDER_ASSIST_CALLBACK_PREFIX}${reminderId}`;
    return inlineKeyboard
        .map((row) => row.filter((button) => !(
            "callback_data" in button && button.callback_data === callbackData
        )))
        .filter((row) => row.length > 0);
}
