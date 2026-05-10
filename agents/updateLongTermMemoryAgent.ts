import { BotContext } from '../types';
import { saveMemory } from '../utils/enhancedDomainMemory';
import { devLog } from '../utils';
import type { ExtractedFactAboutUser } from '../utils/studyChatFlow';
import { saveContactMemoryFactOrAsk } from '../utils/contactMemory';

const MIN_IMPORTANCE_TO_SAVE = 0.3;
/**
 * Сохранение памяти должно идти последовательно: дедупликация и проверка
 * противоречий зависят от того, что предыдущий факт уже виден в векторной базе.
 */
const SAVE_CONCURRENCY = 1;

/**
 * Агент 3: сохраняет переданные факты в долговременную память (векторная БД).
 *
 * Факты о пользователе (subject='user') сохраняются как есть.
 * Факты о собеседнике (subject='contact') сохраняются с префиксом "[Имя] ..."
 * и тегом "contact:<имя>", чтобы при поиске было понятно, о ком речь.
 *
 * Сохранение идёт последовательно, чтобы не создавать дубли гонкой vector search/upsert.
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

                if (isContactFact) {
                    const result = await saveContactMemoryFactOrAsk(ctx, {
                        contactName,
                        content: fact.content,
                        domain: fact.domain,
                        importance: fact.importance,
                        tags: fact.tags,
                    });
                    if (result.status !== 'saved') return 0;
                    devLog(`UpdateLongTermMemoryAgent: saved [contact]`, result.content?.slice(0, 60));
                    return 1;
                }

                const saved = await saveMemory(ctx, fact.domain, fact.content, fact.importance, fact.tags);
                if (!saved) return 0;
                devLog(`UpdateLongTermMemoryAgent: saved [${fact.subject}]`, fact.content.slice(0, 60));
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
