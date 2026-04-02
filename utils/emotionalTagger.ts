import openai from '../openai';
import { llmCache, LLM_CACHE_TTL } from './llmCache';
import { parseLLMJson } from '../utils';
import { EmotionalTag } from '../types';

/**
 * Определяет эмоциональную окраску факта о пользователе.
 *
 * Используется для двух целей:
 * 1. Флэшбалб-факты (arousal > 0.7 + |valence| > 0.5) автоматически становятся anchor
 *    и получают буст к importance — такие воспоминания человек помнит всю жизнь.
 * 2. Эмоционально окрашенные факты ранжируются выше при retrieval (arousal-буст).
 *
 * Вызывается fire-and-forget только для фактов с importance >= 0.5,
 * чтобы не тратить LLM на обыденные факты типа "любит кофе".
 */
export async function detectEmotionalTag(content: string): Promise<EmotionalTag | null> {
    const cacheKey = `emotional_v1:${content.slice(0, 120)}`;
    const cached = llmCache.get<EmotionalTag>(cacheKey);
    if (cached) return cached;

    try {
        const resp = await openai.chat.completions.create({
            model: 'gpt-5-nano',
            messages: [
                { role: 'system', content: 'Отвечай только валидным JSON без пояснений.' },
                {
                    role: 'user',
                    content: `Факт о человеке: "${content}"

Оцени эмоциональную нагрузку:
- valence: -1 (очень негативное) .. 0 (нейтральное) .. +1 (очень позитивное)
- arousal: 0 (обыденное, нейтральное) .. 1 (очень эмоционально значимое)

Ориентиры arousal:
  0.0–0.1: "работает программистом", "любит горы", "живёт в Москве"
  0.2–0.4: "сменил работу", "завёл кота", "начал учить язык"
  0.5–0.6: "переехал в другой город", "расстался с партнёром", "потерял работу"
  0.7–0.8: "развод", "потеря близкого питомца", "тяжёлый конфликт с семьёй"
  0.9–1.0: "смерть близкого", "рождение ребёнка", "свадьба", "тяжёлая болезнь"

Ориентиры valence:
  -1: смерть, болезнь, расставание, увольнение, конфликт
   0: нейтральный факт
  +1: свадьба, рождение ребёнка, большая победа, мечта сбылась

JSON: {"valence": число, "arousal": число}`,
                },
            ],
            temperature: 0,
        });

        const text = resp.choices[0]?.message?.content?.trim() || '';
        const data = parseLLMJson<{ valence?: number; arousal?: number }>(text);
        if (!data) return null;

        const valence = typeof data.valence === 'number' ? Math.min(1, Math.max(-1, data.valence)) : 0;
        const arousal = typeof data.arousal === 'number' ? Math.min(1, Math.max(0, data.arousal)) : 0;

        // Флэшбалб: высокая интенсивность + выраженная валентность
        // Нейробиология: эмоционально заряженные события запоминаются навсегда
        const isFlashbulb = arousal > 0.7 && Math.abs(valence) > 0.5;

        const result: EmotionalTag = { valence, arousal, isFlashbulb };
        llmCache.set(cacheKey, result, LLM_CACHE_TTL.CONTRADICTION); // 60 мин
        return result;
    } catch {
        return null;
    }
}
