import * as dotenv from "dotenv";
import { MessageHistory } from "../types";
import { ProcessingResult } from "../orchestrator";
import { devLog, processReminderTime } from "../utils";
import { getBotPersona, getCommunicationStyle } from "../persona";
import openai from "../openai";
import { USER_TIMEZONE } from "../constants";
import type { ReminderTargetChat } from "../reminder";

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
        ${memoryContext ? `Контекст из долговременной памяти (используй для определения чатов по описанию, например "чат с лидами" → название группы или контакт):\n${memoryContext}` : ""}

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
        - Если время не указано явно, используй контекст для определения
        - Если нельзя определить время, используй значение по умолчанию - через 30 минут
        - Формат времени должен быть строго ISO и включать таймзону (например, 2026-05-20T15:00:00+03:00)

        Если в сообщении несколько напоминаний, выдели каждое в отдельный объект массива.
        Ответ предоставь в формате JSON:
        {
          "reminders": [
            {
              "reminderText": "краткий текст о чем напомнить (для внутреннего использования)",
              "reminderTime": "время в ISO формате",
              "exactTimeSpecified": true/false,
              "confirmationMessage": "естественное сообщение для подтверждения создания напоминания",
              "reminderMessage": "текст самого напоминания (то, что пользователь получит в указанное время)",
              "targetChat": null или { "type": "group", "groupName": "название группы" } или { "type": "contact", "contactQuery": "имя/ник контакта" }
            }
          ]
        }
        `;

        const response = await openai.chat.completions.create({
            model: "gpt-4.1",
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
            return buildFallbackResponse();
        }

        let analysis: MultiReminderAnalysis;
        try {
            analysis = JSON.parse(jsonMatch[0]);
        } catch (_error) {
            return buildFallbackResponse();
        }

        if (!analysis?.reminders || !Array.isArray(analysis.reminders) || analysis.reminders.length === 0) {
            return buildFallbackResponse();
        }

        const validReminders = analysis.reminders.filter((r) => {
            if (!r?.reminderText || !r?.reminderMessage || !r?.reminderTime) return false;
            const parsed = new Date(processReminderTime(r.reminderTime));
            return !isNaN(parsed.getTime());
        });

        if (validReminders.length === 0) {
            return buildFallbackResponse();
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

        const detailsList = validReminders.map((r, idx) => {
            const due = new Date(processReminderTime(r.reminderTime));
            return {
                id: `${Date.now()}-${idx}-${Math.floor(Math.random() * 1_000_000)}`,
                text: r.reminderText,
                reminderMessage: r.reminderMessage,
                dueDate: due,
                targetChat: normalizeTargetChat(r.targetChat)
            };
        });

        const responseText = validReminders.map((r) => {
            const displayTime = new Date(processReminderTime(r.reminderTime)).toLocaleString('ru-RU', {
                timeZone: userTimezone,
                day: 'numeric',
                month: 'long',
                year: 'numeric',
                hour: 'numeric',
                minute: 'numeric'
            });
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
