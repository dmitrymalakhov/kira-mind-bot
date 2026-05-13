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

export interface MemoryUpdateOptions {
    source?: string;
    sourceContactName?: string;
}

export interface MemoryUpdateDetailedResult {
    totalCount: number;
    eligibleCount: number;
    savedCount: number;
    savedFacts: ExtractedFactAboutUser[];
    pendingFacts: ExtractedFactAboutUser[];
    skippedFacts: ExtractedFactAboutUser[];
    errors: string[];
}

function isContactScopeTag(tag: string): boolean {
    return tag.startsWith('contact:') ||
        tag.startsWith('contact_name:') ||
        tag.startsWith('contact_alias:') ||
        tag.startsWith('contact_id:') ||
        tag.startsWith('contact_key:');
}

function buildFactTags(
    fact: ExtractedFactAboutUser,
    subject: 'user' | 'contact',
    options: MemoryUpdateOptions = {}
): string[] {
    const cleaned = (fact.tags ?? [])
        .map(tag => String(tag).trim())
        .filter(Boolean)
        .filter(tag => !tag.startsWith('subject:'))
        .filter(tag => !isContactScopeTag(tag));

    const systemTags = [`subject:${subject}`];
    if (options.source) systemTags.push(`source:${options.source}`);
    if (options.sourceContactName) {
        systemTags.push(`source_contact:${options.sourceContactName}`);
    }

    return [...new Set([...cleaned, ...systemTags])];
}

/**
 * Агент 3: сохраняет переданные факты в долговременную память (векторная БД).
 *
 * Факты о пользователе (subject='user') сохраняются с явным тегом subject:user.
 * Факты о собеседнике (subject='contact') сохраняются с префиксом "[Имя] ..."
 * и тегами subject:contact/contact:<имя>, чтобы при поиске было понятно, о ком речь.
 *
 * Сохранение идёт последовательно, чтобы не создавать дубли гонкой vector search/upsert.
 */
export async function runUpdateLongTermMemoryAgent(
    ctx: BotContext,
    facts: ExtractedFactAboutUser[],
    options: MemoryUpdateOptions = {}
): Promise<number> {
    const result = await runUpdateLongTermMemoryAgentDetailed(ctx, facts, options);
    return result.savedCount;
}

export async function runUpdateLongTermMemoryAgentDetailed(
    ctx: BotContext,
    facts: ExtractedFactAboutUser[],
    options: MemoryUpdateOptions = {}
): Promise<MemoryUpdateDetailedResult> {
    const eligible = facts.filter(f => f.importance >= MIN_IMPORTANCE_TO_SAVE);

    const savedFacts: ExtractedFactAboutUser[] = [];
    const pendingFacts: ExtractedFactAboutUser[] = [];
    const skippedFacts: ExtractedFactAboutUser[] = facts.filter(f => f.importance < MIN_IMPORTANCE_TO_SAVE);
    const errors: string[] = [];

    // Обрабатываем пачками
    for (let i = 0; i < eligible.length; i += SAVE_CONCURRENCY) {
        const batch = eligible.slice(i, i + SAVE_CONCURRENCY);

        const results = await Promise.allSettled(
            batch.map(async (fact) => {
                const isContactFact = fact.subject === 'contact';
                const contactName = fact.contactName ?? 'Собеседник';
                const expectedSubject = isContactFact ? 'contact' : 'user';
                const tags = buildFactTags(fact, expectedSubject, options);

                if (isContactFact) {
                    const result = await saveContactMemoryFactOrAsk(ctx, {
                        contactName,
                        content: fact.content,
                        domain: fact.domain,
                        importance: fact.importance,
                        tags,
                    });
                    if (result.status === 'pending') return { status: 'pending' as const, fact };
                    if (result.status !== 'saved') return { status: 'skipped' as const, fact };
                    devLog(`UpdateLongTermMemoryAgent: saved [contact]`, result.content?.slice(0, 60));
                    return { status: 'saved' as const, fact: { ...fact, tags } };
                }

                const saved = await saveMemory(ctx, fact.domain, fact.content, fact.importance, tags);
                if (!saved) return { status: 'skipped' as const, fact };
                devLog(`UpdateLongTermMemoryAgent: saved [${fact.subject}]`, fact.content.slice(0, 60));
                return { status: 'saved' as const, fact: { ...fact, tags } };
            })
        );

        for (const r of results) {
            if (r.status === 'fulfilled') {
                if (r.value.status === 'saved') savedFacts.push(r.value.fact);
                else if (r.value.status === 'pending') pendingFacts.push(r.value.fact);
                else skippedFacts.push(r.value.fact);
            } else {
                const reason = r.reason?.message || String(r.reason);
                errors.push(reason);
                console.error('UpdateLongTermMemoryAgent: save fact error', r.reason);
            }
        }
    }

    devLog('UpdateLongTermMemoryAgent: total saved', savedFacts.length, 'of', eligible.length);
    return {
        totalCount: facts.length,
        eligibleCount: eligible.length,
        savedCount: savedFacts.length,
        savedFacts,
        pendingFacts,
        skippedFacts,
        errors,
    };
}
