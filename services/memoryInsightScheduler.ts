/**
 * Memory Insight Scheduler
 *
 * Периодически анализирует долговременную память пользователя и проактивно
 * пишет ему уместные подсказки, привязанные к текущему времени.
 *
 * Примеры:
 *  — Пятница вечером + в памяти "хочу сходить в бар на выходных" →
 *    "Кстати, ты говорил про бар на выходных — может забронируем столик?"
 *  — Понедельник + в памяти "отпуск через неделю" →
 *    "До твоего отпуска осталась неделя — не забудь взять солнцезащитный крем!"
 *
 * Правила:
 *  — Не более одного insight в день
 *  — Соблюдает тихий час (quiet hours)
 *  — Срабатывает только если есть ВРЕМЕННАЯ причина (скоро выходные, близится отпуск и т.д.)
 *  — Запускается каждые INTERVAL_MS (по умолчанию 3 часа)
 */

import { Bot } from 'grammy';
import { BotContext } from '../types';
import { config } from '../config';
import { getVectorService } from './VectorServiceFactory';
import { getProactiveChatId } from '../utils/allowedUserChatStore';
import openai from '../openai';
import { parseLLMJson } from '../utils';
import { getBotPersona, getCommunicationStyle } from '../persona';

/** Интервал проверки: каждые 3 часа */
const INTERVAL_MS = 3 * 60 * 60 * 1000;

/** Минимальный интервал между insight-сообщениями: 20 часов (не более раза в день) */
const MIN_BETWEEN_MS = 20 * 60 * 60 * 1000;

/** Поисковые запросы для поиска планов и желаний в памяти */
const PLAN_QUERIES = [
    'отпуск поездка путешествие',
    'планы выходные хочу сходить',
    'хочу посетить забронировать',
    'собираюсь планирую мечтаю',
    'нужно купить не забыть',
    'хотел сходить попробовать',
];

/** Поисковые запросы для поиска уже выполненных дел */
const DONE_QUERIES = [
    'купили купил оплатил заплатил',
    'уже сделал готово сделано',
    'забронировали забронировал',
    'купили билеты оформили',
    'уже решили договорились',
];

let timer: NodeJS.Timeout | undefined;
let isRunning = false;
let lastSentAt = 0;

interface DayContext {
    weekday: string;
    dayOfWeek: number; // 0=вс, 1=пн, ..., 6=сб
    hour: number;
    isWeekend: boolean;
    daysUntilWeekend: number; // 0 если уже выходной
    timeOfDay: string;
    season: string;
    formattedDate: string;
}

function getDayContext(): DayContext {
    const now = new Date();
    const day = now.getDay();
    const hour = now.getHours();
    const month = now.getMonth() + 1;

    const weekdays = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
    const isWeekend = day === 0 || day === 6;

    // Дней до выходных: сб=6, вс=0
    let daysUntilWeekend = 0;
    if (!isWeekend) {
        daysUntilWeekend = day <= 5 ? 6 - day : 0; // до субботы
    }

    let timeOfDay: string;
    if (hour >= 6 && hour < 12) timeOfDay = 'утро';
    else if (hour >= 12 && hour < 17) timeOfDay = 'день';
    else if (hour >= 17 && hour < 22) timeOfDay = 'вечер';
    else timeOfDay = 'ночь';

    let season: string;
    if (month >= 3 && month <= 5) season = 'весна';
    else if (month >= 6 && month <= 8) season = 'лето';
    else if (month >= 9 && month <= 11) season = 'осень';
    else season = 'зима';

    const formattedDate = now.toLocaleDateString('ru-RU', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
    });

    return { weekday: weekdays[day], dayOfWeek: day, hour, isWeekend, daysUntilWeekend, timeOfDay, season, formattedDate };
}

function inQuietHours(now: Date): boolean {
    if (!config.kiraLifeProactiveQuietHoursEnabled) return false;
    const hour = now.getHours();
    const start = config.kiraLifeProactiveQuietHourStart;
    const end = config.kiraLifeProactiveQuietHourEnd;
    if (start === end) return true;
    if (start < end) return hour >= start && hour < end;
    return hour >= start || hour < end;
}

async function gatherRelevantMemories(userId: string): Promise<{ plans: string[]; done: string[] }> {
    const svc = getVectorService();
    if (!svc) return { plans: [], done: [] };

    const planResults = new Map<string, string>();
    const doneResults = new Map<string, string>();

    await Promise.all([
        ...PLAN_QUERIES.map(async (query) => {
            try {
                const results = await svc.searchAllDomains(query, userId, 4);
                for (const r of results) {
                    if (r.score >= 0.55 && !planResults.has(r.id)) {
                        planResults.set(r.id, r.content);
                    }
                }
            } catch {
                // игнорируем ошибки отдельных запросов
            }
        }),
        ...DONE_QUERIES.map(async (query) => {
            try {
                const results = await svc.searchAllDomains(query, userId, 4);
                for (const r of results) {
                    if (r.score >= 0.55 && !doneResults.has(r.id)) {
                        doneResults.set(r.id, r.content);
                    }
                }
            } catch {
                // игнорируем
            }
        }),
    ]);

    // Дополнительно: temporal facts (с expiresAt в будущем)
    try {
        const recent = await svc.getRecentMemories(userId, 50);
        const now = new Date();
        for (const m of recent) {
            if (!m.expiresAt) continue;
            const daysLeft = (new Date(m.expiresAt).getTime() - now.getTime()) / 86_400_000;
            if (daysLeft >= 0 && daysLeft <= 30 && !planResults.has(m.id)) {
                planResults.set(m.id, m.content);
            }
        }
    } catch {
        // ignore
    }

    return {
        plans: Array.from(planResults.values()).slice(0, 20),
        done: Array.from(doneResults.values()).slice(0, 10),
    };
}

interface InsightDecision {
    shouldSend: boolean;
    message: string;
}

async function decideInsight(memories: { plans: string[]; done: string[] }, dayCtx: DayContext): Promise<InsightDecision> {
    if (memories.plans.length === 0) return { shouldSend: false, message: '' };

    const plansText = memories.plans.map((m, i) => `${i + 1}. ${m}`).join('\n');
    const doneText = memories.done.length > 0
        ? `\nУже сделано (НЕ напоминай об этом):\n${memories.done.map((m, i) => `${i + 1}. ${m}`).join('\n')}`
        : '';

    const weekendNote = dayCtx.isWeekend
        ? 'Сейчас выходной день.'
        : dayCtx.daysUntilWeekend <= 1
            ? `До выходных осталось ${dayCtx.daysUntilWeekend === 0 ? 'меньше дня' : '1 день'} — завтра ${dayCtx.daysUntilWeekend === 1 ? 'суббота' : 'воскресенье'}.`
            : `До выходных ${dayCtx.daysUntilWeekend} дн.`;

    const prompt = `Ты — личный ИИ-ассистент ${config.ownerName}а. Сейчас ${dayCtx.formattedDate}, ${dayCtx.timeOfDay}.
${weekendNote}
Сезон: ${dayCtx.season}.

Планы и предстоящие события из памяти:
${plansText}
${doneText}

Твоя задача: определить, есть ли среди планов что-то, о чём СЕЙЧАС (с учётом дня недели, времени, приближения выходных или отпуска) уместно напомнить пользователю ПРОАКТИВНО.

Правила:
- НИКОГДА не напоминай о том, что уже сделано (см. список "Уже сделано" выше)
- Если план уже выполнен по информации из памяти — не упоминай его
- Упоминай только если есть ВРЕМЕННАЯ ПРИЧИНА именно сейчас (выходные близко → планы на выходные; отпуск через несколько дней → напомни что взять; вечер пятницы → предложи забронировать стол и т.д.)
- Будь конкретна и полезна: не просто "помню ты говорил", а реальная подсказка или предложение действия
- Если подходящего повода нет — НЕ отправляй (shouldSend: false)
- Сообщение: 1-3 предложения, естественно и живо, в стиле ${config.characterName}
- Не упоминай что ты ИИ, не используй "напоминаю", "уведомляю" и т.п.

Ответь только JSON:
{"shouldSend": true/false, "message": "текст сообщения для пользователя или пустая строка"}`;

    const resp = await openai.chat.completions.create({
        model: 'gpt-4.1',
        messages: [
            { role: 'system', content: `${getBotPersona()}\nСтиль: ${getCommunicationStyle()}\nОтвечай только валидным JSON.` },
            { role: 'user', content: prompt },
        ],
        temperature: 0.8,
        response_format: { type: 'json_object' },
    });

    const text = resp.choices[0]?.message?.content?.trim() || '';
    const data = parseLLMJson<InsightDecision>(text);
    if (!data || !data.shouldSend || !data.message?.trim()) {
        return { shouldSend: false, message: '' };
    }
    return { shouldSend: true, message: data.message.trim() };
}

async function runCycle(bot: Bot<BotContext>): Promise<void> {
    if (isRunning) return;
    isRunning = true;

    try {
        const now = new Date();
        if (inQuietHours(now)) return;
        if (Date.now() - lastSentAt < MIN_BETWEEN_MS) return;

        const dayCtx = getDayContext();

        // Достаём userId из конфига (allowedUserId — единственный пользователь)
        const userId = String(config.allowedUserId);
        const memories = await gatherRelevantMemories(userId);

        const decision = await decideInsight(memories, dayCtx);
        if (!decision.shouldSend) {
            console.log('[memory-insight] No relevant insight to send at this time.');
            return;
        }

        const chatId = await getProactiveChatId();
        await bot.api.sendMessage(chatId, decision.message);
        lastSentAt = Date.now();
        console.log('[memory-insight] Sent proactive insight:', decision.message.slice(0, 80));
    } catch (error) {
        console.error('[memory-insight] cycle failed:', error);
    } finally {
        isRunning = false;
    }
}

export function startMemoryInsightScheduler(bot: Bot<BotContext>): void {
    if (!config.memoryInsightEnabled) return;

    if (timer) clearInterval(timer);

    timer = setInterval(() => {
        runCycle(bot);
    }, INTERVAL_MS);

    // Первый запуск через 90 секунд после старта
    setTimeout(() => {
        runCycle(bot);
    }, 90_000);

    console.log('[memory-insight] Scheduler started, interval:', INTERVAL_MS / 60_000, 'min');
}
