import { BotContext } from '../types';
import { searchAllDomainsMemories, getAnchorMemories } from './enhancedDomainMemory';
import { devLog } from '../utils';
import openai from '../openai';
import { getVectorService } from '../services/VectorServiceFactory';
import { llmCache, LLM_CACHE_TTL } from './llmCache';

const ANSWER_RESULTS_PER_QUERY = 5;
const CONTEXT_RESULTS_PER_QUERY = 2;
const MAX_TOTAL_FACTS = 25;
/** Дисконт для контекстных запросов при ранжировании */
const CONTEXT_QUERY_SCORE_DISCOUNT = 0.8;

interface GeneratedQueries {
    /** Запросы для поиска фактов, НАПРЯМУЮ отвечающих на вопрос */
    answerQueries: string[];
    /** Запросы для фонового контекста (люди, места, отношения) */
    contextQueries: string[];
}

interface RecentMessage {
    role: string;
    content: string;
}

/**
 * Разбивает запрос пользователя на два уровня поисковых фраз:
 * - answerQueries: что нужно найти чтобы прямо ответить на вопрос
 * - contextQueries: фоновый контекст для понимания запроса
 *
 * @param recentHistory последние 2-3 сообщения разговора для резолвинга местоимений и контекстных отсылок
 */
export async function generateMemoryQueries(userMessage: string, recentHistory?: RecentMessage[]): Promise<GeneratedQueries> {
    const historySnippet = recentHistory?.map((m) => `${m.role}: ${m.content.slice(0, 80)}`).join('|') ?? '';
    const cacheKey = `queries_v2:${historySnippet.slice(0, 100)}|${userMessage.slice(0, 200)}`;
    const cached = llmCache.get<GeneratedQueries>(cacheKey);
    if (cached) {
        devLog('generateMemoryQueries: cache hit');
        return cached;
    }

    const historyBlock =
        recentHistory && recentHistory.length > 0
            ? `Контекст разговора (предыдущие сообщения):\n${recentHistory
                  .map((m) => `${m.role === 'user' ? 'Пользователь' : 'Ассистент'}: ${m.content.slice(0, 120)}`)
                  .join('\n')}\n\n`
            : '';

    const prompt = `${historyBlock}Текущий запрос пользователя: "${userMessage}"

Тебе нужно найти факты в долговременной памяти пользователя чтобы ответить на этот запрос.
${recentHistory && recentHistory.length > 0 ? 'Учти контекст разговора: местоимения («он», «она», «это», «там» и т.п.) относятся к предыдущим сообщениям — раскрой их в конкретные имена/объекты.\n' : ''}
Сформулируй поисковые фразы в 2 группах:

ANSWER: 2-3 короткие фразы (1-4 слова), которые НАПРЯМУЮ находят факты для ответа на вопрос
CONTEXT: 1-2 короткие фразы для фонового контекста (люди, отношения, места)

Формат ответа (строго):
ANSWER:
<фраза 1>
<фраза 2>
CONTEXT:
<фраза 1>

Только фразы на русском, без нумерации и пояснений.`;

    try {
        const resp = await openai.chat.completions.create({
            model: 'gpt-5-nano',
            messages: [
                {
                    role: 'system',
                    content: 'Ты генерируешь поисковые фразы для RAG-поиска по долговременной памяти. Только фразы, без пояснений.',
                },
                { role: 'user', content: prompt },
            ],
            temperature: 1, // модель поддерживает только default (1)
        });
        const text = resp.choices[0]?.message?.content?.trim() || '';

        const parseLines = (block: string): string[] =>
            block
                .split(/\n+/)
                .map((q) => q.replace(/^[\d.)\-\s]+/, '').trim())
                .filter((q) => q.length > 1 && q.length < 80)
                .slice(0, 3);

        const answerMatch = text.match(/ANSWER:\n([\s\S]*?)(?=CONTEXT:|$)/);
        const contextMatch = text.match(/CONTEXT:\n([\s\S]*?)$/);

        const answerQueries = answerMatch ? parseLines(answerMatch[1]) : [];
        const contextQueries = contextMatch ? parseLines(contextMatch[1]) : [];

        if (answerQueries.length === 0) {
            devLog('generateMemoryQueries: empty parse, using fallback');
            return getFallbackQueries(userMessage);
        }

        const result: GeneratedQueries = { answerQueries, contextQueries };
        devLog('Generated memory queries:', result);
        llmCache.set(cacheKey, result, LLM_CACHE_TTL.MEMORY_QUERIES);
        return result;
    } catch (e) {
        console.error('generateMemoryQueries error:', e);
        return getFallbackQueries(userMessage);
    }
}

function getFallbackQueries(userMessage: string): GeneratedQueries {
    return {
        answerQueries: [userMessage.slice(0, 60), 'даты события', 'планы поездка'],
        contextQueries: ['семья и близкие', 'личная информация'],
    };
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
 * Двухуровневый поиск по долговременной памяти:
 * 1. Answer-запросы — ищут факты, прямо отвечающие на вопрос (больше результатов, выше вес)
 * 2. Context-запросы — ищут фоновый контекст (меньше результатов, score дисконтируется)
 * 3. 1-hop graph expansion для топовых результатов
 * 4. Объединение, дедупликация, ранжирование с учётом importance и confidence
 */
/** Количество предыдущих сообщений для резолвинга местоимений */
const HISTORY_CONTEXT_MESSAGES = 3;

export async function getMultiQueryMemoryContext(ctx: BotContext, userMessage: string): Promise<string> {
    // Берём последние N сообщений из истории (не считая текущего)
    // messageHistory хранится newest-first, поэтому срезаем с индекса 1
    const recentHistory = (ctx.session?.messageHistory ?? [])
        .slice(1, 1 + HISTORY_CONTEXT_MESSAGES)
        .reverse() // хронологический порядок для промпта
        .map((m) => ({ role: m.role, content: m.content }));

    const { answerQueries, contextQueries } = await generateMemoryQueries(userMessage, recentHistory.length > 0 ? recentHistory : undefined);

    const seen = new Map<string, SearchResultLike>();

    // Якорные факты — всегда в контексте
    const anchorResults = await getAnchorMemories(ctx, 5);
    for (const r of anchorResults) {
        if (!seen.has(r.id)) {
            seen.set(r.id, { ...r, importance: r.importance ?? 0.5, confidence: r.confidence ?? 0.6, domain: r.domain });
        }
    }

    // Answer-запросы: приоритетный поиск, полный score
    await Promise.all(
        answerQueries.map(async (query) => {
            const results = await searchAllDomainsMemories(ctx, query, ANSWER_RESULTS_PER_QUERY);
            for (const r of results) {
                if (seen.has(r.id)) {
                    const existing = seen.get(r.id)!;
                    if (r.score > existing.score) {
                        seen.set(r.id, { ...r, importance: r.importance ?? 0.5, confidence: r.confidence ?? 0.6, domain: r.domain });
                    }
                } else {
                    seen.set(r.id, { ...r, importance: r.importance ?? 0.5, confidence: r.confidence ?? 0.6, domain: r.domain });
                }
            }
        })
    );

    // Context-запросы: фоновый контекст, score дисконтируется
    await Promise.all(
        contextQueries.map(async (query) => {
            const results = await searchAllDomainsMemories(ctx, query, CONTEXT_RESULTS_PER_QUERY);
            for (const r of results) {
                if (seen.has(r.id)) {
                    // уже найден answer-запросом — не перезаписываем более высокий score
                } else {
                    seen.set(r.id, {
                        ...r,
                        score: r.score * CONTEXT_QUERY_SCORE_DISCOUNT,
                        importance: r.importance ?? 0.5,
                        confidence: r.confidence ?? 0.6,
                        domain: r.domain,
                    });
                }
            }
        })
    );

    // 1-hop graph expansion: для топовых результатов подгружаем связанные факты
    const svcForGraph = getVectorService();
    if (svcForGraph) {
        const primaryResults = Array.from(seen.values()).sort((a, b) => b.score - a.score).slice(0, 8);
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
                                seen.set(fetched.id ?? id, {
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
    }

    const sorted = Array.from(seen.values()).sort((a, b) => {
        const confA = a.confidence ?? 0.6;
        const confB = b.confidence ?? 0.6;
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
            if (fact.domain) {
                svc.updateMemoryAccess(fact.id, fact.domain).catch(() => {});
            }
        }
    }

    const factsBlock = top.join('\n');
    const preamble =
        'Ниже — факты из долговременной памяти о пользователе. Используй их при ответе. Если спрашивает конкретное (кто жена, как зовут, имя) — дай краткий прямой ответ из фактов. Если «что знаешь обо мне» — перечисли в формате «Вот что я знаю о тебе:». Если подходящих фактов нет — честно скажи, что в памяти этого нет.\n\nФакты из памяти:\n';
    const context = preamble + (factsBlock || '(пока нет сохранённых фактов)');
    devLog('Multi-query memory context:', {
        answerQueries: answerQueries.length,
        contextQueries: contextQueries.length,
        uniqueFacts: top.length,
    });
    return context;
}
