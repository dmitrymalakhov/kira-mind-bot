import { BotContext } from '../types';
import { searchAllDomainsMemories, getAnchorMemories } from './enhancedDomainMemory';
import { devLog } from '../utils';
import openai from '../openai';
import { getVectorService } from '../services/VectorServiceFactory';
import { llmCache, LLM_CACHE_TTL } from './llmCache';

const MAX_QUERIES = 6;
const RESULTS_PER_QUERY = 4;
const MAX_TOTAL_FACTS = 25;

/**
 * Разбирает запрос пользователя на интенты/аспекты и для каждого генерирует поисковую фразу к долговременной памяти.
 */
export async function generateMemoryQueries(userMessage: string): Promise<string[]> {
    const cacheKey = `queries:${userMessage.slice(0, 200)}`;
    const cached = llmCache.get<string[]>(cacheKey);
    if (cached) {
        devLog('generateMemoryQueries: cache hit');
        return cached;
    }

    const prompt = `Запрос пользователя: "${userMessage}"

Разбей запрос на интенты и аспекты (о чём пользователь говорит или что ему может понадобиться: семья, работа, предпочтения, здоровье, хобби, даты, места, люди и т.п.). Для каждого интента/аспекта сформулируй одну короткую поисковую фразу на русском для поиска в долговременной памяти пользователя.
От 3 до ${MAX_QUERIES} фраз, 1–4 слова каждая. Только фразы, по одной на строку, без нумерации и пояснений.`;

    try {
        const resp = await openai.chat.completions.create({
            model: 'gpt-5-nano',
            messages: [
                {
                    role: 'system',
                    content: 'Ты извлекаешь интенты из запроса и генерируешь только короткие поисковые фразы для памяти, по одной на строку, без пояснений и нумерации.',
                },
                { role: 'user', content: prompt },
            ],
            temperature: 1, // модель поддерживает только default (1)
        });
        const text = resp.choices[0]?.message?.content?.trim() || '';
        const queries = text
            .split(/\n+/)
            .map((q) => q.replace(/^[\d.)\-\s]+/, '').trim())
            .filter((q) => q.length > 1 && q.length < 80)
            .slice(0, MAX_QUERIES);
        if (queries.length === 0) {
            return [
                'семья и близкие',
                'работа и карьера',
                'предпочтения и привычки',
                'хобби и интересы',
                'личная информация',
            ];
        }
        devLog('Generated memory queries:', queries);
        llmCache.set(cacheKey, queries, LLM_CACHE_TTL.MEMORY_QUERIES);
        return queries;
    } catch (e) {
        console.error('generateMemoryQueries error:', e);
        return [
            'семья и близкие',
            'работа',
            'предпочтения',
            'хобби',
            'личное',
        ];
    }
}

export interface SearchResultLike {
    id: string;
    content: string;
    score: number;
    importance?: number;
    timestamp?: Date;
    confidence?: number;
    domain?: string;
    previousVersions?: Array<{ content: string; timestamp: Date; confidence: number }>;
}

/**
 * Форматирует факт для вставки в LLM-контекст.
 * Если факт имеет историю изменений — добавляет последнюю версию как "(ранее: ...)".
 * Это даёт модели понимание эволюции: "переехал из Москвы в Питер (ранее: живёт в Москве)".
 */
function formatFactWithHistory(r: SearchResultLike): string {
    if (!r.previousVersions || r.previousVersions.length === 0) return r.content;
    const prev = r.previousVersions[0];
    return `${r.content} (ранее: ${prev.content})`;
}

/**
 * По запросу «что знаешь обо мне» генерирует несколько поисковых запросов, тянет факты по каждому из памяти и возвращает объединённый контекст для ответа.
 */
export async function getMultiQueryMemoryContext(ctx: BotContext, userMessage: string): Promise<string> {
    const queries = await generateMemoryQueries(userMessage);
    const seen = new Map<string, SearchResultLike>();
    const anchorResults = await getAnchorMemories(ctx, 5);
    for (const r of anchorResults) {
        if (!seen.has(r.id)) seen.set(r.id, { ...r, importance: r.importance ?? 0.5, confidence: r.confidence ?? 0.6, domain: r.domain });
    }
    for (const query of queries) {
        const results = await searchAllDomainsMemories(ctx, query, RESULTS_PER_QUERY);
        for (const r of results) {
            if (seen.has(r.id)) {
                const existing = seen.get(r.id)!;
                if (r.score > existing.score) seen.set(r.id, { ...r, importance: r.importance ?? 0.5, confidence: r.confidence ?? 0.6, domain: r.domain });
            } else {
                seen.set(r.id, { ...r, importance: r.importance ?? 0.5, confidence: r.confidence ?? 0.6, domain: r.domain });
            }
        }
    }
    // 1-hop graph expansion: для топовых результатов подгружаем связанные факты
    const svcForGraph = getVectorService();
    if (svcForGraph) {
        const primaryResults = Array.from(seen.values()).sort((a, b) => b.score - a.score).slice(0, 8);
        const graphExpansions: SearchResultLike[] = [];
        await Promise.all(
            primaryResults.map(async (fact) => {
                if (!fact.domain) return;
                try {
                    const related = await svcForGraph.getRelatedFacts(fact.id, fact.domain);
                    await Promise.all(
                        related.map(async ({ id, domain }) => {
                            if (seen.has(id)) return;
                            const fetched = await svcForGraph.fetchMemoryById(id, domain);
                            if (fetched) {
                                graphExpansions.push({
                                    ...fetched,
                                    score: fetched.score * 0.8, // дисконт за косвенность
                                    importance: fetched.importance ?? 0.5,
                                    confidence: fetched.confidence ?? 0.6,
                                    domain: fetched.domain,
                                });
                            }
                        })
                    );
                } catch {
                    // игнорируем ошибки graph expansion
                }
            })
        );
        for (const exp of graphExpansions) {
            if (!seen.has(exp.id)) seen.set(exp.id, exp);
        }
    }

    const sorted = Array.from(seen.values()).sort((a, b) => {
        // Учитываем confidence в ранжировании мульти-запросного контекста
        const confA = (a as any).confidence ?? 0.6;
        const confB = (b as any).confidence ?? 0.6;
        const scoreA = a.score * (0.6 + 0.2 * (a.importance ?? 0.5) + 0.1 * confA);
        const scoreB = b.score * (0.6 + 0.2 * (b.importance ?? 0.5) + 0.1 * confB);
        return scoreB - scoreA;
    });
    const top = sorted.slice(0, MAX_TOTAL_FACTS).map((r) => formatFactWithHistory(r));

    // Буст важности + сброс кривой забывания для фактов, которые оказались релевантны (fire & forget)
    const svc = getVectorService();
    if (svc) {
        for (const fact of sorted.slice(0, MAX_TOTAL_FACTS)) {
            const boosted = Math.min(1.0, (fact.importance ?? 0.5) + 0.03);
            if (boosted > (fact.importance ?? 0.5)) {
                svc.updateImportance(fact.id, boosted).catch(() => {});
            }
            // Сбрасываем кривую забывания: факт снова "вспомнили"
            if (fact.domain) {
                svc.updateMemoryAccess(fact.id, fact.domain).catch(() => {});
            }
        }
    }

    const factsBlock = top.join('\n');
    const preamble =
        'Ниже — факты из долговременной памяти о пользователе. Ответь на его вопрос только на основе этих фактов. Если спрашивает конкретное (кто жена, как зовут, имя) — дай краткий прямой ответ из фактов. Если «что знаешь обо мне» — перечисли в формате «Вот что я знаю о тебе:». Если подходящих фактов нет — честно скажи, что в памяти этого нет.\n\nФакты из памяти:\n';
    const context = preamble + (factsBlock || '(пока нет сохранённых фактов)');
    devLog('Multi-query memory context:', { queries: queries.length, uniqueFacts: top.length });
    return context;
}
