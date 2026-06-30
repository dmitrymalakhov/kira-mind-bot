import { Bot } from "grammy";
import { BotContext } from "../types";
import { config } from "../config";
import { ReminderRegistry } from "../stores/ReminderRegistry";
import { USER_TIMEZONE } from "../constants";
import { getProactiveChatId } from "../utils/allowedUserChatStore";
import { getBotPersona, getCommunicationStyle } from "../persona";
import { createChatCompletionForTask } from "../ai/chatCompletion";
import { getZonedDateKey, getZonedDateTimeParts } from "../utils/time";

let timer: NodeJS.Timeout | undefined;
let lastSentDate = "";

function todayDateKey(): string {
    return getZonedDateKey(new Date(), USER_TIMEZONE);
}

function getRemindersForToday(chatId: number) {
    const now = new Date();

    return ReminderRegistry.getInstance()
        .getActiveByChatId(chatId)
        .filter(r => {
            const due = new Date(r.dueDate);
            return getZonedDateKey(due, USER_TIMEZONE) === getZonedDateKey(now, USER_TIMEZONE);
        })
        .sort((a, b) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime());
}

function formatDigestReminders(reminders: ReturnType<typeof getRemindersForToday>): string {
    return reminders.map(r => {
        const time = new Date(r.dueDate).toLocaleTimeString("ru-RU", {
            timeZone: USER_TIMEZONE,
            hour: "numeric",
            minute: "numeric",
        });
        const body = r.displayText || r.text;
        return `• ${time} — ${body}`;
    }).join("\n");
}

async function buildDigestGreeting(reminderCount: number): Promise<string> {
    try {
        const response = await createChatCompletionForTask('messageAnalysis', {
            messages: [
                {
                    role: "system",
                    content: `${getBotPersona()} Стиль: ${getCommunicationStyle()}`,
                },
                {
                    role: "user",
                    content:
                        `Напиши короткое утреннее приветствие (1–2 предложения) для ${config.ownerName} в начале дня. ` +
                        `${reminderCount > 0 ? `Сегодня у него ${reminderCount} напомин${reminderCount === 1 ? "ание" : reminderCount < 5 ? "ания" : "ий"}.` : "Сегодня нет запланированных напоминаний."} ` +
                        `Тон — тёплый но не слащавый, живой. Без штампов типа "Доброе утро!". Только само сообщение.`,
                },
            ],
            temperature: 0.85,
        });
        return response.choices[0]?.message?.content?.trim() || "Привет! Начинаем день.";
    } catch {
        return "Привет! Вот что у тебя сегодня:";
    }
}

async function runDigest(bot: Bot<BotContext>): Promise<void> {
    const dateKey = todayDateKey();
    if (lastSentDate === dateKey) return;

    const chatId = await getProactiveChatId();
    const todayReminders = getRemindersForToday(chatId);
    const greeting = await buildDigestGreeting(todayReminders.length);

    let text = greeting;
    if (todayReminders.length > 0) {
        text += `\n\n📋 На сегодня:\n${formatDigestReminders(todayReminders)}`;
    }

    await bot.api.sendMessage(chatId, text);
    lastSentDate = dateKey;
    console.info("[morning-digest] sent");
}

export function startMorningDigestScheduler(bot: Bot<BotContext>): void {
    if (!config.morningDigestEnabled) return;

    if (timer) clearInterval(timer);

    // Проверяем каждую минуту — если час совпал и дайджест ещё не отправлялся сегодня
    timer = setInterval(() => {
        const now = new Date();
        const { hour, minute } = getZonedDateTimeParts(now, USER_TIMEZONE);
        if (hour === config.morningDigestHour && minute < 5) {
            runDigest(bot).catch(e => console.error("[morning-digest] failed:", e));
        }
    }, 60_000);

    console.info(`[morning-digest] scheduler started, fires at ${config.morningDigestHour}:00 ${USER_TIMEZONE}`);
}
