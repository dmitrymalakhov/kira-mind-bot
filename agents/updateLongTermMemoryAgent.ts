import { BotContext } from '../types';
import { saveMemory } from '../utils/enhancedDomainMemory';
import { devLog } from '../utils';
import type { ExtractedFactAboutUser } from '../utils/studyChatFlow';

const MIN_IMPORTANCE_TO_SAVE = 0.3;
/** Максимум параллельных сохранений — ограничиваем нагрузку на Qdrant и OpenAI */
const SAVE_CONCURRENCY = 3;

/**
 * Агент 3: сохраняет переданные факты в долговременную память (векторная БД).
 *
 * Факты о пользователе (subject='user') сохраняются как есть.
 * Факты о собеседнике (subject='contact') сохраняются с префиксом "[Имя] ..."
 * и тегом "contact:<имя>", чтобы при поиске было понятно, о ком речь.
 *
 * Сохранение идёт пачками по SAVE_CONCURRENCY для скорости без перегрузки API.
 */
export async function runUpdateLongTermMemoryAgent(
    ctx: BotContext,
    facts: ExtractedFactAboutUser[]
): Promise<number> {
    const eligible = facts.filter(f => f.importance >= MIN_IMPORTANCE_TO_SAVE);

    let savedCount = 0;

    // Обрабатываем пачками
    for (let i = 0; i < eligible.length; i += SAVE_CONCURRENCY) {
        const batch = eligible.slice(i, i + SAVE_CONCURRENCY);

        const results = await Promise.allSettled(
            batch.map(async (fact) => {
                const isContactFact = fact.subject === 'contact';
                const contactName = fact.contactName ?? 'Собеседник';

                const content = isContactFact
                    ? `[${contactName}] ${fact.content}`
                    : fact.content;

                const tags = isContactFact
                    ? [...fact.tags, `contact:${contactName}`]
                    : fact.tags;

                await saveMemory(ctx, fact.domain, content, fact.importance, tags);
                devLog(`UpdateLongTermMemoryAgent: saved [${fact.subject}]`, content.slice(0, 60));
                return 1;
            })
        );

        for (const r of results) {
            if (r.status === 'fulfilled') savedCount += r.value;
            else console.error('UpdateLongTermMemoryAgent: save fact error', r.reason);
        }
    }

    devLog('UpdateLongTermMemoryAgent: total saved', savedCount, 'of', eligible.length);
    return savedCount;
}
