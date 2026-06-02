import { Bot } from "grammy";
import openai from "../openai";
import { USER_TIMEZONE } from "../constants";
import { devLog, processReminderTime } from "../utils";
import { getBotPersona, getCommunicationStyle } from "../persona";
import { config } from "../config";
import type { NegotiationSession } from "../stores/NegotiationStore";
import { Reminder, ReminderStatus, scheduleReminder } from "../reminder";
import { ReminderRegistry } from "../stores/ReminderRegistry";
import { ReminderRepository } from "../services/ReminderRepository";
import type { BotContext } from "../types";

const MAX_REMINDERS = 5;

interface ExtractedAgreementReminder {
    reminderText: string;
    reminderTime: string;
    reminderMessage: string;
}

interface ExtractResponse {
    reminders: ExtractedAgreementReminder[];
}

function formatHistory(session: NegotiationSession): string {
    return session.history
        .map((h) => {
            const label = h.role === "bot" ? "Мы" : h.role === "contact" ? "Контакт" : "Ты";
            return `${label}: ${h.text}`;
        })
        .join("\n");
}

/**
 * После завершения переговоров извлекает из переписки договорённости и создаёт напоминания владельцу.
 */
export async function scheduleNegotiationAgreementReminders(
    ctx: BotContext,
    bot: Bot<BotContext>,
    session: NegotiationSession
): Promise<void> {
    try {
        if (session.history.length < 2) return;

        if (!ctx.session.reminders) ctx.session.reminders = [];

        const now = new Date();
        const formattedDateTime = now.toLocaleString("ru-RU", {
            timeZone: USER_TIMEZONE,
            day: "numeric",
            month: "long",
            year: "numeric",
            hour: "numeric",
            minute: "numeric",
            weekday: "long",
        });

        const historyText = formatHistory(session);
        const prompt = `
Текущие дата и время в часовом поясе пользователя (${USER_TIMEZONE}): ${formattedDateTime}

Переговоры с контактом: ${session.contactName}
Исходная задача переговоров: ${session.taskDescription}

Текст переписки (Мы / Контакт / Ты — роли в сессии бота):
${historyText}

Проанализируй, были ли достигнуты конкретные договорённости, обязательства или следующие шаги (кто что сделает, к какому сроку, что обсудить снова, когда написать, перевести деньги, встретиться и т.п.).

Если явных или неявных договорённостей с привязкой к действию НЕТ (только болтовня, переговоры оборвались, отказ) — верни пустой массив reminders.

Если договорённости ЕСТЬ:
- Для каждой логической договорённости создай ОДНО напоминание.
- Не дублируй одно и то же разными формулировками.
- reminderText — короткая внутренняя метка (до 80 символов).
- reminderTime — время срабатывания в ISO 8601 с часовым поясом (${USER_TIMEZONE}). Если в переписке названа дата/время — соблюдай их. Если указано только "завтра", "в пятницу", "через неделю" — вычисли конкретное время (для дня без времени используй 10:00). Если срок не сказан, но нужно не забыть выполнить договорённость — поставь напоминание на завтра в 10:00 по ${USER_TIMEZONE}.
- reminderMessage — текст, который увидит ${config.ownerName} в уведомлении: кратко, по делу, с именем контакта «${session.contactName}» и сутью договорённости (1–3 предложения).

Максимум ${MAX_REMINDERS} напоминаний.

Ответь только JSON:
{
  "reminders": [
    {
      "reminderText": "…",
      "reminderTime": "2026-04-21T10:00:00+03:00",
      "reminderMessage": "…"
    }
  ]
}
`;

        const resp = await openai.chat.completions.create({
            model: "gpt-5.4",
            messages: [
                {
                    role: "system",
                    content: `${getBotPersona()} Стиль: ${getCommunicationStyle()}. Ты извлекаешь из переписки только реальные договорённости и превращаешь их в напоминания. Отвечай только валидным JSON.`,
                },
                { role: "user", content: prompt },
            ],
            temperature: 0.2,
        });

        const raw = (resp.choices[0]?.message?.content || "").trim();
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return;

        let parsed: ExtractResponse;
        try {
            parsed = JSON.parse(jsonMatch[0]);
        } catch {
            return;
        }

        const items = Array.isArray(parsed.reminders) ? parsed.reminders.slice(0, MAX_REMINDERS) : [];
        const saved: string[] = [];

        for (let idx = 0; idx < items.length; idx++) {
            const r = items[idx];
            if (!r?.reminderText?.trim() || !r?.reminderMessage?.trim() || !r?.reminderTime?.trim()) continue;

            const due = new Date(processReminderTime(r.reminderTime));
            if (isNaN(due.getTime())) continue;

            const id = `${Date.now()}-${idx}-${Math.floor(Math.random() * 1_000_000)}`;
            const reminder: Reminder = {
                id,
                text: r.reminderText.trim(),
                displayText: r.reminderMessage.trim(),
                dueDate: due,
                chatId: ctx.chat!.id,
                status: ReminderStatus.Pending,
                createdAt: new Date(),
            };

            ctx.session.reminders.push(reminder);
            ReminderRegistry.getInstance().add(reminder);
            await ReminderRepository.save(reminder).catch((e) =>
                console.error("[negotiation reminders] DB save failed:", e)
            );
            scheduleReminder(bot, reminder);

            const displayTime = due.toLocaleString("ru-RU", {
                timeZone: USER_TIMEZONE,
                day: "numeric",
                month: "short",
                hour: "numeric",
                minute: "numeric",
            });
            saved.push(`• ${displayTime} — ${r.reminderText.trim()}`);
            devLog(`Negotiation agreement reminder scheduled id=${id} due=${due.toISOString()}`);
        }

        if (saved.length > 0 && ctx.chat?.id) {
            await bot.api.sendMessage(
                ctx.chat.id,
                `📌 По итогам переговоров с ${session.contactName} создала напоминания:\n\n${saved.join("\n")}`
            );
        }
    } catch (e) {
        console.error("scheduleNegotiationAgreementReminders:", e);
    }
}
