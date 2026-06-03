import openai, { openAiModels } from "../openai";
import { Reminder, ReminderStatus, rescheduleReminder } from "../reminder";
import { ReminderRepository } from "../services/ReminderRepository";
import { ReminderRegistry } from "../stores/ReminderRegistry";
import { USER_TIMEZONE } from "../constants";
import { parseLLMJson, processReminderTime } from "../utils";

interface ReminderEditExtraction {
    newDueDate?: string | null;
    newText?: string | null;
}

export interface ReminderEditResult {
    ok: boolean;
    reminder?: Reminder;
    changedText?: boolean;
    changedTime?: boolean;
    responseText: string;
}

function compactText(text: string | undefined | null): string | undefined {
    if (!text) return undefined;
    const cleaned = text
        .replace(/^["'«“”]+|["'«“”]+$/g, "")
        .replace(/\s+/g, " ")
        .trim();
    return cleaned || undefined;
}

function isMeaningfulDateChange(before: Date, after: Date): boolean {
    return Math.abs(after.getTime() - before.getTime()) > 30 * 1000;
}

function formatDueDate(date: Date): string {
    return date.toLocaleString("ru-RU", {
        timeZone: USER_TIMEZONE,
        day: "numeric",
        month: "long",
        hour: "numeric",
        minute: "numeric",
    });
}

async function extractReminderEdit(reminder: Reminder, userInput: string): Promise<ReminderEditExtraction | null> {
    const now = new Date();
    const currentDueDate = new Date(reminder.dueDate).toLocaleString("ru-RU", {
        timeZone: USER_TIMEZONE,
        day: "numeric",
        month: "long",
        year: "numeric",
        hour: "numeric",
        minute: "numeric",
        weekday: "long",
    });
    const currentDate = now.toLocaleString("ru-RU", {
        timeZone: USER_TIMEZONE,
        day: "numeric",
        month: "long",
        year: "numeric",
        hour: "numeric",
        minute: "numeric",
        weekday: "long",
    });

    const resp = await openai.chat.completions.create({
        model: openAiModels.memoryExtractionModel,
        messages: [
            {
                role: "system",
                content:
                    `Текущая дата и время: ${currentDate} (${USER_TIMEZONE}).\n` +
                    `Существующее напоминание: "${reminder.displayText || reminder.text}".\n` +
                    `Текущее время срабатывания: ${currentDueDate}.\n\n` +
                    `Пользователь редактирует ИМЕННО ЭТО напоминание. Извлеки новое время и/или новый текст.\n` +
                    `Правила:\n` +
                    `- Если пользователь написал только время/дату ("завтра в 10", "через час"), меняй только newDueDate.\n` +
                    `- Если пользователь написал "текст: ..." или явно переформулировал задачу, верни newText без служебных слов.\n` +
                    `- Если пользователь не меняет время, newDueDate = null.\n` +
                    `- Если пользователь не меняет текст, newText = null.\n` +
                    `- Для относительного времени рассчитай абсолютную дату в ISO 8601 с часовым поясом ${USER_TIMEZONE}.\n` +
                    `Верни только JSON: {"newDueDate": "ISO 8601 или null", "newText": "строка или null"}`,
            },
            { role: "user", content: userInput.slice(0, 700) },
        ],
        temperature: 1,
    });

    return parseLLMJson<ReminderEditExtraction>(resp.choices[0]?.message?.content || "");
}

export async function applyReminderEditInput(reminder: Reminder, userInput: string): Promise<ReminderEditResult> {
    let extracted: ReminderEditExtraction | null = null;

    try {
        extracted = await extractReminderEdit(reminder, userInput);
    } catch (error) {
        console.error("[reminder_edit] extraction failed:", error);
    }

    if (!extracted) {
        return {
            ok: false,
            responseText:
                "Не смогла понять, что изменить. Напиши, например: «завтра в 11», «через 2 часа» или «текст: позвонить маме».",
        };
    }

    const updated: Reminder = { ...reminder };
    const beforeDueDate = new Date(reminder.dueDate);
    let changedTime = false;
    let changedText = false;

    const newDueDateRaw = typeof extracted.newDueDate === "string"
        ? extracted.newDueDate.trim()
        : "";
    if (newDueDateRaw && newDueDateRaw.toLowerCase() !== "null") {
        const parsed = new Date(processReminderTime(newDueDateRaw));
        if (!isNaN(parsed.getTime()) && isMeaningfulDateChange(beforeDueDate, parsed)) {
            updated.dueDate = parsed;
            updated.remindAgainAt = parsed;
            changedTime = true;
        }
    }

    const newText = compactText(
        typeof extracted.newText === "string" && extracted.newText.trim().toLowerCase() === "null"
            ? undefined
            : extracted.newText
    );
    const oldText = compactText(reminder.displayText || reminder.text);
    if (newText && newText !== oldText) {
        updated.text = newText;
        updated.displayText = newText;
        changedText = true;
    }

    if (!changedTime && !changedText) {
        return {
            ok: false,
            responseText:
                "Не увидела изменений. Можно написать так: «перенеси на пятницу в 10» или «текст: оплатить счёт».",
        };
    }

    const dueDate = new Date(updated.dueDate);
    if (dueDate.getTime() > Date.now()) {
        updated.status = ReminderStatus.Pending;
        updated.messageId = undefined;
        rescheduleReminder(updated);
    }

    ReminderRegistry.getInstance().add(updated);
    await ReminderRepository.update(updated).catch((error) =>
        console.error("[reminder_edit] DB update failed:", error)
    );

    const changedParts = [
        changedTime ? "время" : "",
        changedText ? "текст" : "",
    ].filter(Boolean);

    return {
        ok: true,
        reminder: updated,
        changedText,
        changedTime,
        responseText:
            `✅ Обновила ${changedParts.join(" и ")} напоминания:\n` +
            `«${updated.displayText || updated.text}»\n\n` +
            `🗓 ${formatDueDate(dueDate)}`,
    };
}
