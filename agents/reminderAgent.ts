import * as dotenv from "dotenv";
import { MessageHistory } from "../types";
import { ProcessingResult } from "../orchestrator";
import { devLog, processReminderTime } from "../utils";
import { getBotPersona, getCommunicationStyle } from "../persona";
import openai from "../openai";
import { USER_TIMEZONE } from "../constants";
import type { ReminderTargetChat, RecurrenceRule } from "../reminder";

// Загрузка переменных окружения
dotenv.config({ path: `.env.${process.env.NODE_ENV}` });

interface ReminderAnalysis {
    reminderText: string;
    reminderTime: string;
    exactTimeSpecified: boolean;
    confirmationMessage: string;
    reminderMessage: string;
    /** Если пользователь просит напомнить "в чате с X" / "в группе Y" — куда отправить напоминание (резолвится из памяти) */
    targetChat?: ReminderTargetChat;
    /** Правило повторения, если пользователь просит напоминать регулярно */
    recurrence?: RecurrenceRule | null;
}

interface MultiReminderAnalysis {
    reminders: ReminderAnalysis[];
}

function buildFallbackResponse(): ProcessingResult {
    return {
        responseText: "Я пыталась создать напоминание, но не смогла точно определить, о чем и когда вам напомнить. Можете, пожалуйста, сформулировать вашу просьбу более конкретно? Например: \"Напомни мне завтра в 15:00 о встрече\". 🙏",
        reminderCreated: false
    };
}

const TEMPORAL_REFERENCE_RE = /(\d{1,2}[:.]\d{2}|(?:^|\s)(?:в|к)\s+\d{1,2}(?=\s|$|[,.!?;:])|сегодня|завтра|послезавтра|через\s+\d+|утром|вечером|ночью|дн[её]м|выходн|понедельник|вторник|сред[ау]|четверг|пятниц[ау]|суббот[ау]|воскресенье|январ|феврал|март|апрел|ма[йяе]|июн|июл|август|сентябр|октябр|ноябр|декабр|\d{1,2}[./-]\d{1,2}|после\s+\S+|перед\s+\S+|до\s+\S+|когда\s+\S+)/iu;

function hasTemporalReference(text: string): boolean {
    return TEMPORAL_REFERENCE_RE.test(text);
}

function getZonedParts(date: Date, timeZone: string): {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
} {
    const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
    }).formatToParts(date);
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
    return {
        year: get("year"),
        month: get("month"),
        day: get("day"),
        hour: get("hour"),
        minute: get("minute"),
        second: get("second"),
    };
}

function getTimeZoneOffsetMs(date: Date, timeZone: string): number {
    const p = getZonedParts(date, timeZone);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second, 0);
    return asUtc - date.getTime();
}

function zonedDateTimeToDate(
    year: number,
    month: number,
    day: number,
    hour: number,
    minute: number,
    timeZone: string
): Date {
    let utcMs = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
    for (let i = 0; i < 3; i++) {
        utcMs = Date.UTC(year, month - 1, day, hour, minute, 0, 0) - getTimeZoneOffsetMs(new Date(utcMs), timeZone);
    }
    return new Date(utcMs);
}

function getDefaultReminderDueDate(currentDate: Date, userTimezone: string): Date {
    const today = getZonedParts(currentDate, userTimezone);
    const tomorrow = new Date(Date.UTC(today.year, today.month - 1, today.day + 1, 0, 0, 0, 0));
    return zonedDateTimeToDate(
        tomorrow.getUTCFullYear(),
        tomorrow.getUTCMonth() + 1,
        tomorrow.getUTCDate(),
        10,
        0,
        userTimezone
    );
}

function formatReminderDueDate(dueDate: Date, userTimezone: string): string {
    return dueDate.toLocaleString("ru-RU", {
        timeZone: userTimezone,
        day: "numeric",
        month: "long",
        year: "numeric",
        hour: "numeric",
        minute: "numeric",
    });
}

function extractFallbackReminderText(message: string): string {
    const sourceMatch = message.match(/Исходный запрос:\s*([\s\S]+)$/im);
    const source = (sourceMatch?.[1] ?? message).split(/\r?\n/)[0].trim();
    const cleaned = source
        .replace(/^(да,\s*)?(пожалуйста,\s*)?(напомни|напоминай)\s+(мне\s+)?(о\s+том,\s+что\s+|об\s+этом\s*)?/iu, "")
        .replace(/^(не\s+дай\s+забыть|не\s+забудь)\s+(мне\s+)?/iu, "")
        .replace(/^(создай|поставь|добавь)(?:\s+\S+){0,3}\s+напоминание\s+(о\s+|про\s+)?/iu, "")
        .trim();
    return cleaned || source || "напоминание";
}

function buildFallbackReminderResponse(message: string, currentDate: Date, userTimezone: string): ProcessingResult {
    if (hasTemporalReference(message)) return buildFallbackResponse();

    const dueDate = getDefaultReminderDueDate(currentDate, userTimezone);
    const text = extractFallbackReminderText(message);
    const displayTime = formatReminderDueDate(dueDate, userTimezone);
    const id = `${Date.now()}-fallback-${Math.floor(Math.random() * 1_000_000)}`;
    return {
        responseText: `✅ Напомню: ${text} — ${displayTime}.`,
        reminderCreated: true,
        reminderDetails: {
            id,
            text,
            reminderMessage: `Напоминаю: ${text}`,
            dueDate,
        },
        reminderDetailsList: [
            {
                id,
                text,
                reminderMessage: `Напоминаю: ${text}`,
                dueDate,
            },
        ],
    };
}

export async function reminderAgent(
    message: string,
    isForwarded: boolean = false,
    forwardFrom: string = "",
    messageHistory: MessageHistory[] = [],
    memoryContext: string = "",
    userTimezone: string = USER_TIMEZONE
): Promise<ProcessingResult> {
    try {
        let historyContext = "";
        if (messageHistory.length > 0) {
            historyContext = "\nИстория переписки (от старых к новым):\n";
            messageHistory.forEach((item, index) => {
                historyContext += `${index + 1}. ${item.role === 'user' ? 'Пользователь' : 'Бот'}: ${item.content}\n`;
            });
        }

        const currentDate = new Date();
        const noTemporalReference = !hasTemporalReference(message);
        const defaultDueDate = getDefaultReminderDueDate(currentDate, userTimezone);
        const defaultDueText = formatReminderDueDate(defaultDueDate, userTimezone);
        const formattedDateTime = currentDate.toLocaleString('ru-RU', {
            timeZone: userTimezone,
            day: 'numeric',
            month: 'long',
            year: 'numeric',
            hour: 'numeric',
            minute: 'numeric',
            weekday: 'long'
        });

        const prompt = `
        Текущая дата и время в часовом поясе пользователя (${userTimezone}): ${formattedDateTime}

        Проанализируй следующее сообщение${isForwarded ? `, пересланное от ${forwardFrom}` : ""}:

        "${message}"
        ${historyContext}
        ${memoryContext ? `Контекст из долговременной памяти (используй для определения чатов по описанию, например "чат с лидами" → название группы или контакт; А ТАКЖЕ для вычисления дат из событий — например, "после отпуска" → найди даты отпуска в памяти и вычисли конкретную дату; "когда вернусь" → найди дату возвращения; "после встречи с X" → найди дату события в памяти):\n${memoryContext}` : ""}

        Я считаю, что в этом сообщении пользователь просит создать НАПОМИНАНИЕ.

        Твоя задача:
        1. Точно определить, о чём нужно напомнить
        2. Определить, когда нужно напомнить (дата и время)
        3. Создать естественное сообщение для подтверждения создания напоминания
        4. Создать текст для самого напоминания, который будет отправлен в указанное время
        5. Если пользователь просит напомнить "в чате с X", "в группе Y", "в чате с лидами" и т.п. — определить targetChat по контексту и памяти:
           - targetType "group": если имеется в виду группа/чат по названию — укажи в groupName точное или подходящее название (например из памяти: "чат с лидами" → "Каркас: Leads")
           - targetType "contact": если имеется в виду личная переписка с контактом — укажи в contactQuery имя/ник для поиска контакта
           - Если напоминание только "мне" (в личку с ботом) — не указывай targetChat

        ВАЖНО для определения времени:
        - Интерпретируй выражения вида "в 15:00", "завтра утром" и т.п. строго в часовом поясе пользователя: ${userTimezone}
        - Если указано конкретное время (например, "в 15:00"), используй его
        - Если указано относительное время (например, "через час"), рассчитай точное время
        - Если время привязано к событию из памяти ("после отпуска", "когда вернусь", "после поездки") — найди даты этого события в контексте памяти и вычисли конкретную дату (например, день после окончания отпуска в 10:00)
        - Если время не указано явно, используй контекст для определения
        - Если пользователь явно просит напомнить, но не указывает дату/время, НЕ задавай уточняющий вопрос и НЕ используй "через 30 минут". Используй дефолт: ${defaultDueDate.toISOString()} (${defaultDueText} в ${userTimezone})
        - Формат времени должен быть строго ISO и включать таймзону (например, 2026-05-20T15:00:00+03:00)

        6. Если пользователь просит напоминать РЕГУЛЯРНО ("каждый день", "каждую неделю", "каждый понедельник", "раз в месяц", "каждые 2 дня" и т.п.) — укажи recurrence:
           - "каждый день" / "ежедневно" → { "type": "daily", "interval": 1 }
           - "каждые 2 дня" → { "type": "daily", "interval": 2 }
           - "каждый час" → { "type": "hourly", "interval": 1 }
           - "каждую неделю" / "еженедельно" → { "type": "weekly", "interval": 1 }
           - "каждый понедельник" → { "type": "weekly", "interval": 1, "daysOfWeek": [1] }
           - "каждый вторник и четверг" → { "type": "weekly", "interval": 1, "daysOfWeek": [2, 4] }
           - "каждые 2 недели" → { "type": "weekly", "interval": 2 }
           - "каждый месяц" / "ежемесячно" → { "type": "monthly", "interval": 1 }
           - "каждый год" / "ежегодно" → { "type": "yearly", "interval": 1 }
           - Если повторение не указано → "recurrence": null
           Дни недели: 0=вс, 1=пн, 2=вт, 3=ср, 4=чт, 5=пт, 6=сб

        Если в сообщении несколько напоминаний, выдели каждое в отдельный объект массива.
        Ответ предоставь в формате JSON:
        {
          "reminders": [
            {
              "reminderText": "краткий текст о чем напомнить (для внутреннего использования)",
              "reminderTime": "время первого срабатывания в ISO формате",
              "exactTimeSpecified": true/false,
              "confirmationMessage": "естественное сообщение для подтверждения (упомяни повторение, если оно есть)",
              "reminderMessage": "текст самого напоминания (то, что пользователь получит в указанное время)",
              "targetChat": null или { "type": "group", "groupName": "название группы" } или { "type": "contact", "contactQuery": "имя/ник контакта" },
              "recurrence": null или { "type": "daily"|"weekly"|"monthly"|"yearly"|"hourly", "interval": N, "daysOfWeek": [0-6] }
            }
          ]
        }
        `;

        const response = await openai.chat.completions.create({
            model: "gpt-5.4",
            messages: [
                {
                    role: "system",
                    content: `${getBotPersona()} Стиль общения: ${getCommunicationStyle()} Ты - специализированный агент, который обрабатывает запросы на создание напоминаний.
                    Ты умеешь точно извлекать информацию о том, что и когда нужно напомнить.
                    Ты очень внимательно относишься к деталям времени и контексту.
                    Ты формируешь естественные, человечные формулировки для подтверждений и напоминаний.`
                },
                { role: "user", content: prompt }
            ],
            temperature: 0.3,
        });

        const aiResponse = response.choices[0]?.message?.content || "";
        devLog("Reminder Analysis Response:", aiResponse);

        const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            return buildFallbackReminderResponse(message, currentDate, userTimezone);
        }

        let analysis: MultiReminderAnalysis;
        try {
            analysis = JSON.parse(jsonMatch[0]);
        } catch (_error) {
            return buildFallbackReminderResponse(message, currentDate, userTimezone);
        }

        if (!analysis?.reminders || !Array.isArray(analysis.reminders) || analysis.reminders.length === 0) {
            return buildFallbackReminderResponse(message, currentDate, userTimezone);
        }

        const validReminders = analysis.reminders.filter((r) => {
            if (!r?.reminderText) return false;
            if (!r.reminderMessage) r.reminderMessage = r.reminderText;
            if (noTemporalReference && !r.reminderTime) return true;
            if (!r.reminderTime) return false;
            const parsed = new Date(processReminderTime(r.reminderTime));
            return !isNaN(parsed.getTime());
        });

        if (validReminders.length === 0) {
            return buildFallbackReminderResponse(message, currentDate, userTimezone);
        }

        const normalizeTargetChat = (t: ReminderAnalysis["targetChat"]): ReminderTargetChat | undefined => {
            if (!t || typeof t !== "object") return undefined;
            if (t.type === "group" && typeof t.groupName === "string" && t.groupName.trim()) {
                return { type: "group", groupName: t.groupName.trim() };
            }
            if (t.type === "contact" && typeof t.contactQuery === "string" && t.contactQuery.trim()) {
                return { type: "contact", contactQuery: t.contactQuery.trim() };
            }
            return undefined;
        };

        const normalizeRecurrence = (rec: ReminderAnalysis["recurrence"]): RecurrenceRule | undefined => {
            if (!rec || typeof rec !== "object") return undefined;
            const validTypes = ["hourly", "daily", "weekly", "monthly", "yearly"];
            if (!validTypes.includes(rec.type)) return undefined;
            const interval = typeof rec.interval === "number" && rec.interval > 0 ? rec.interval : 1;
            const daysOfWeek = Array.isArray(rec.daysOfWeek)
                ? rec.daysOfWeek.filter((d: number) => d >= 0 && d <= 6)
                : undefined;
            return { type: rec.type, interval, ...(daysOfWeek && daysOfWeek.length > 0 ? { daysOfWeek } : {}) };
        };

        const detailsList = validReminders.map((r, idx) => {
            const due = noTemporalReference
                ? new Date(defaultDueDate)
                : new Date(processReminderTime(r.reminderTime));
            return {
                id: `${Date.now()}-${idx}-${Math.floor(Math.random() * 1_000_000)}`,
                text: r.reminderText,
                reminderMessage: r.reminderMessage,
                dueDate: due,
                targetChat: normalizeTargetChat(r.targetChat),
                recurrence: normalizeRecurrence(r.recurrence),
            };
        });

        const responseText = validReminders.map((r) => {
            const due = noTemporalReference
                ? new Date(defaultDueDate)
                : new Date(processReminderTime(r.reminderTime));
            const displayTime = formatReminderDueDate(due, userTimezone);
            if (noTemporalReference) {
                return `✅ Напомню: ${r.reminderText} — ${displayTime}.`;
            }
            return r.confirmationMessage || `✅ Отлично! Я напомню тебе о "${r.reminderText}" ${displayTime}`;
        }).join('\n');

        return {
            responseText,
            reminderCreated: true,
            reminderDetails: detailsList[0],
            reminderDetailsList: detailsList
        };
    } catch (error) {
        console.error("Error in reminder agent:", error);
        return buildFallbackResponse();
    }
}
