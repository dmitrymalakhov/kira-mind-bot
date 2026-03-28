import { BotContext } from '../types';
import { getVectorService } from '../services/VectorServiceFactory';
import openai from '../openai';
import { devLog, parseLLMJson } from '../utils';
import { config } from '../config';

/** Минимальный интервал между проактивными подсказками (20 минут) */
const HINT_COOLDOWN_MS = 20 * 60 * 1000;

/** Горизонт срочности для временных фактов (в днях) */
const TEMPORAL_URGENCY_DAYS = 3;

/** In-process Set для дедупликации: один и тот же факт не всплывает дважды подряд */
const recentlyHintedIds = new Set<string>();

/**
 * Проверяет память на наличие уместного проактивного напоминания и отправляет его пользователю.
 * Вызывается fire-and-forget после основного ответа бота.
 *
 * Два сценария:
 *  1. СРОЧНЫЙ ФАКТ — временный факт (expiresAt) истекает в ближайшие TEMPORAL_URGENCY_DAYS дней
 *  2. КОНТЕКСТНАЯ СВЯЗЬ — факт семантически близок к текущему сообщению пользователя
 *     и ещё не упомянут в ответе бота
 *
 * Cooldown: не чаще одного раза в 20 минут; один факт не повторяется (recentlyHintedIds).
 */
export async function maybeProactiveHint(
    ctx: BotContext,
    userMessage: string,
    botResponse: string
): Promise<void> {
    const svc = getVectorService();
    if (!svc) return;

    // Проактивные подсказки из личной памяти не отправляем в групповых чатах
    const chatType = ctx.chat?.type;
    if (config.proactiveOnlyPrivateChat && (chatType === 'group' || chatType === 'supergroup')) return;

    const userId = String(ctx.from?.id);

    // Cooldown check
    const lastHintAt = ctx.session.lastProactiveHintAt ?? 0;
    if (Date.now() - lastHintAt < HINT_COOLDOWN_MS) return;

    try {
        // 1. Ищем срочные временные факты
        const recentMemories = await svc.getRecentMemories(userId, 30);
        const now = new Date();
        const urgentFacts = recentMemories.filter((m) => {
            if (!m.expiresAt) return false;
            if (recentlyHintedIds.has(m.id)) return false;
            const daysLeft = (new Date(m.expiresAt).getTime() - now.getTime()) / 86_400_000;
            return daysLeft >= 0 && daysLeft <= TEMPORAL_URGENCY_DAYS;
        });

        // 2. Ищем контекстно-близкие факты (score ≥ 0.65), которых нет в recentlyHinted
        const relatedFacts = await svc.searchAllDomains(userMessage, userId, 6);
        const topRelated = relatedFacts.filter(
            (f) => f.score >= 0.65 && !recentlyHintedIds.has(f.id)
        ).slice(0, 3);

        if (urgentFacts.length === 0 && topRelated.length === 0) return;

        // Формируем список кандидатов для LLM
        type Candidate = { id: string; content: string; isUrgent: boolean; expiresAt?: Date };
        const candidates: Candidate[] = [
            ...urgentFacts.map((f) => ({ id: f.id, content: f.content, isUrgent: true, expiresAt: f.expiresAt })),
            ...topRelated.map((f) => ({ id: f.id, content: f.content, isUrgent: false })),
        ];

        const factsText = candidates.map((c, i) => {
            const urgencyTag = c.isUrgent
                ? ` [СРОЧНО, истекает ${new Date(c.expiresAt!).toLocaleDateString('ru-RU')}]`
                : '';
            return `${i}. ${c.content}${urgencyTag}`;
        }).join('\n');

        const prompt = `Ты — личный ИИ-ассистент. Ты только что ответила пользователю.

Сообщение пользователя: "${userMessage.slice(0, 300)}"
Твой ответ (кратко): "${botResponse.slice(0, 200)}"

Факты из долговременной памяти о пользователе:
${factsText}

Стоит ли тебе добавить КОРОТКУЮ проактивную реплику — уместное замечание или вопрос, основанный на одном из этих фактов?

Правила:
- Упоминай только если это уместно в контексте разговора ИЛИ факт помечен [СРОЧНО]
- Не навязывайся и не дублируй то, что уже сказала в ответе
- Реплика должна быть естественной (1–2 предложения), как будто ты вспомнила что-то важное
- Если ни один факт не уместен — верни shouldHint: false

Ответь только JSON:
{"shouldHint": true/false, "hint": "текст реплики на русском", "factIndex": число}`;

        const resp = await openai.chat.completions.create({
            model: 'gpt-5-nano',
            messages: [
                { role: 'system', content: 'Отвечай только валидным JSON.' },
                { role: 'user', content: prompt },
            ],
            temperature: 1,
        });

        const text = resp.choices[0]?.message?.content?.trim() || '';
        const data = parseLLMJson<{ shouldHint?: boolean; hint?: string; factIndex?: number }>(text);

        if (!data?.shouldHint || !data.hint) return;

        const hint = data.hint.trim();
        if (!hint) return;

        // Обновляем cooldown и трекинг факта
        ctx.session.lastProactiveHintAt = Date.now();
        const usedFact = candidates[data.factIndex ?? 0];
        if (usedFact) {
            recentlyHintedIds.add(usedFact.id);
            // Ограничиваем размер Set
            if (recentlyHintedIds.size > 100) {
                const oldest = recentlyHintedIds.values().next().value;
                if (oldest !== undefined) recentlyHintedIds.delete(oldest);
            }
        }

        // Небольшая задержка для естественности — бот "вспомнил" после паузы
        await new Promise((res) => setTimeout(res, 1500));
        await ctx.reply(hint);
        devLog('🔔 Proactive hint sent:', hint.slice(0, 80));
    } catch (e) {
        devLog('maybeProactiveHint error (ignored):', e);
    }
}
