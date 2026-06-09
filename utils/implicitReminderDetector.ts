import type { BotContext } from '../types';
import { InlineKeyboard } from 'grammy';
import { createChatCompletionForTask } from '../ai/chatCompletion';
import { parseLLMJson } from '../utils';

/** Минимальный интервал между предложениями (15 минут) */
const COOLDOWN_MS = 15 * 60 * 1000;

/** Время жизни pending-предложения в сессии (5 минут) */
const PENDING_TTL_MS = 5 * 60 * 1000;

/**
 * Временные маркеры: хотя бы один из них должен быть в сообщении,
 * чтобы оно вообще проверялось LLM.
 */
const TEMPORAL_RE =
    /\b(завтра|послезавтра|сегодня|через\s+\d+\s+(?:час|день|дня|дней|неделю|месяц)|на\s+следующей\s+неделе|в\s+понедельник|во\s+вторник|в\s+среду|в\s+четверг|в\s+пятницу|в\s+субботу|в\s+воскресенье|в\s+\d{1,2}[:.]\d{2}|в\s+\d{1,2}\s+(?:часов?|утра|вечера|ночи)|утром|вечером|к\s+(?:вечеру|обеду|утру)|после\s+обеда)\b/i;

/**
 * Событийные маркеры: хотя бы один из них должен быть в сообщении.
 */
const EVENT_RE =
    /\b(встреча|собрание|совещание|переговоры|звонок|конференц|вылет|рейс|поезд|приём|запись|дедлайн|deadline|презентация|защита|экзамен|урок|тренировка|игра|матч|свидание|день\s+рождения|годовщина|праздник|вебинар|конференция|встретиться|позвонить|съездить|прилететь|поехать)\b/i;

interface LLMCheckResult {
    shouldSuggest: boolean;
    eventSummary?: string;
}

/**
 * После РАЗГОВОР-ответа проверяет, не упомянул ли пользователь конкретное
 * событие с временной привязкой, и предлагает создать напоминание.
 * Вызывается fire-and-forget.
 */
export async function maybeDetectImplicitReminder(
    ctx: BotContext,
    userMessage: string,
    wasConversationIntent: boolean
): Promise<void> {
    if (!wasConversationIntent) return;
    if (ctx.chat?.type !== 'private') return;

    // Быстрый pre-filter: оба маркера должны быть в сообщении
    if (!TEMPORAL_RE.test(userMessage) || !EVENT_RE.test(userMessage)) return;

    // Cooldown: не предлагаем чаще раза в 15 минут
    const lastAt = ctx.session.lastImplicitReminderAt ?? 0;
    if (Date.now() - lastAt < COOLDOWN_MS) return;

    try {
        const resp = await createChatCompletionForTask('memoryExtraction', {
            messages: [
                {
                    role: 'system',
                    content:
                        'Определи: содержит ли сообщение конкретное событие с временной привязкой, о котором пользователь вероятно хотел бы получить напоминание? ' +
                        'Напоминание уместно, если есть КОНКРЕТНОЕ время или дата + КОНКРЕТНОЕ событие (встреча, звонок, вылет, запись и т.п.). ' +
                        'НЕ предлагай напоминание для расплывчатых упоминаний без чёткого времени. ' +
                        'Верни только JSON: {"shouldSuggest": true/false, "eventSummary": "краткое описание события 3-5 слов"}',
                },
                { role: 'user', content: userMessage.slice(0, 400) },
            ],
            temperature: 1,
        });

        const content = resp.choices[0]?.message?.content || '';
        const parsed = parseLLMJson<LLMCheckResult>(content);
        if (!parsed?.shouldSuggest || !parsed.eventSummary) return;

        ctx.session.lastImplicitReminderAt = Date.now();
        ctx.session.pendingImplicitReminder = {
            originalMessage: userMessage,
            eventSummary: parsed.eventSummary,
            createdAt: Date.now(),
        };

        const keyboard = new InlineKeyboard()
            .text('⏰ Создать напоминание', 'implicit_reminder_yes')
            .text('❌ Нет, спасибо', 'implicit_reminder_no');

        await new Promise((res) => setTimeout(res, 1200));
        await ctx.reply(
            `📅 Хочешь, поставлю напоминание на «${parsed.eventSummary}»?`,
            { reply_markup: keyboard }
        );
    } catch {
        // Не критично — молча игнорируем
    }
}

/**
 * Проверяет, не устарело ли pending-предложение (TTL 5 минут).
 */
export function hasFreshPendingReminder(ctx: BotContext): boolean {
    const p = ctx.session.pendingImplicitReminder;
    if (!p) return false;
    return Date.now() - p.createdAt < PENDING_TTL_MS;
}
