import { BotContext } from '../types';
import { searchAllDomainsMemories, getAnchorMemories, getRecentMemories } from './enhancedDomainMemory';
import { devLog } from '../utils';
import openai from '../openai';
import { getVectorService } from '../services/VectorServiceFactory';
import { llmCache, LLM_CACHE_TTL } from './llmCache';
import { Contact } from '../stores/ContactsStore';
import { contactDisplayName, contactIdentityTags, normalizeContactLookupValue, resolveContactIdentity } from './contactMemory';

const ANSWER_RESULTS_PER_QUERY = 5;
const CONTEXT_RESULTS_PER_QUERY = 2;
const MAX_TOTAL_FACTS = 25;
/**
 * Факты с итоговым score ниже этого порога отсекаются.
 * Qdrant возвращает наружу чистый cosine score, а итоговый score дополнительно
 * умножается на importance/confidence, поэтому валидные результаты 0.55-0.60
 * оказываются около 0.40-0.45.
 */
const MIN_FINAL_SCORE_THRESHOLD = 0.4;
/** Дисконт для контекстных запросов при ранжировании */
const CONTEXT_QUERY_SCORE_DISCOUNT = 0.8;
/** Количество топовых результатов для graph expansion (было 8 — слишком много шума) */
const GRAPH_EXPANSION_TOP_N = 3;
/** Дисконт для фактов из graph expansion (было 0.8 — слишком щедро) */
const GRAPH_EXPANSION_DISCOUNT = 0.6;
/** Максимум новых фактов из 2-hop expansion */
const GRAPH_EXPANSION_HOP2_MAX = 5;
/** Contextual reinstatement: сколько исходных эпизодов восстанавливать по найденным фактам */
const EPISODE_CONTEXT_TOP_N = 5;
/** Сколько соседних воспоминаний из одного эпизода добавлять */
const EPISODE_CONTEXT_MAX_PER_EPISODE = 6;
/** Дисконт для соседних фактов из того же эпизода */
const EPISODE_CONTEXT_DISCOUNT = 0.72;
/** Сколько сводных глав раскрывать до исходных фактов */
const CHAPTER_SOURCE_TOP_N = 4;
/** Сколько исходных воспоминаний брать из одной сводной главы */
const CHAPTER_SOURCE_MAX_PER_CHAPTER = 8;
/** Дисконт для исходников, подтянутых из сводной главы */
const CHAPTER_SOURCE_DISCOUNT = 0.68;
/** Бонус для anchor-фактов при ранжировании (вместо отдельной загрузки) */
const ANCHOR_SCORE_BOOST = 1.15;
/** Базовый score для явно закреплённых фактов, когда они не нашлись embedding-поиском */
const ANCHOR_DIRECT_SCORE = 0.95;
/** Базовый score для broad inventory режима ("что ты обо мне знаешь") */
const MEMORY_INVENTORY_SCORE = 0.82;
const MEMORY_INVENTORY_LIMIT = 80;
/** Максимальный бюджет токенов для блока памяти (~4 символа = 1 токен для русского) */
const MAX_MEMORY_TOKENS = 1500;
const APPROX_CHARS_PER_TOKEN = 3.5;

/** Уровень потребности в памяти для запроса */
export type MemoryNeed = 'none' | 'light' | 'full';

/**
 * Быстрая классификация: нужна ли память для ответа на запрос.
 * none  — приветствие, благодарность, эмоция. Не грузим память вообще.
 * light — простой вопрос/ответ, достаточно 5 фактов.
 * full  — сложный/личный вопрос, нужна полная загрузка.
 */
export async function classifyMemoryNeed(message: string): Promise<MemoryNeed> {
    const lc = message.toLowerCase().trim();
    // Быстрая эвристика для очевидных случаев
    if (/^(привет|здравствуй|хай|хей|добр(ое|ый|ая)|hi|hello|hey|yo)\b/i.test(lc)) return 'none';
    if (/^(спасибо|благодарю|ок|ok|ладно|понял|хорошо|ясно|круто|класс|👍|👌|🙏|да|нет|ага|угу)$/i.test(lc)) return 'none';
    if (lc.length < 4) return 'none';

    const cacheKey = `mem_need:${lc.slice(0, 150)}`;
    const cached = llmCache.get<MemoryNeed>(cacheKey);
    if (cached) return cached;

    try {
        const resp = await openai.chat.completions.create({
            model: 'gpt-5.4-nano',
            messages: [
                { role: 'system', content: 'Отвечай только одним словом: none, light или full.' },
                {
                    role: 'user',
                    content: `Нужны ли факты из долговременной памяти чтобы ответить на это сообщение?

"${lc.slice(0, 200)}"

none — приветствие, благодарность, реакция, стикер, эмоция. Память не нужна.
light — простой разговор, вопрос не о пользователе. Может пригодиться немного контекста.
full — вопрос о пользователе, его жизни, планах, людях. Или "что ты обо мне знаешь". Нужна полная память.

Ответ (одно слово):`,
                },
            ],
            temperature: 0,
            max_tokens: 5,
        });
        const raw = resp.choices[0]?.message?.content?.trim().toLowerCase() || '';
        const result: MemoryNeed = raw === 'none' ? 'none' : raw === 'light' ? 'light' : 'full';
        llmCache.set(cacheKey, result, LLM_CACHE_TTL.CLASSIFY);
        return result;
    } catch {
        return 'full'; // при ошибке загружаем всё
    }
}

interface GeneratedQueries {
    /** Запросы для поиска фактов, НАПРЯМУЮ отвечающих на вопрос */
    answerQueries: string[];
    /** Запросы для фонового контекста (люди, места, отношения) */
    contextQueries: string[];
}

function isEpisodeMemoryLike(memory: Pick<SearchResultLike, 'content' | 'tags'>): boolean {
    return (memory.tags ?? []).includes('memory-episode') ||
        memory.content.startsWith('[ЭПИЗОД ПАМЯТИ:');
}

function isChapterMemoryLike(memory: Pick<SearchResultLike, 'content' | 'tags'>): boolean {
    return (memory.tags ?? []).includes('memory-chapter') ||
        memory.content.startsWith('[ГЛАВА ПАМЯТИ:');
}

interface RecentMessage {
    role: string;
    content: string;
}

interface ContactRetrievalScope {
    status: 'resolved' | 'ambiguous';
    queryName: string;
    displayName?: string;
    contact?: Contact;
    candidateNames?: string[];
}

function isMemoryInventoryRequest(message: string): boolean {
    return /^(?:что\s+(?:ты\s+)?(?:знаешь|помнишь|помнила)\s+обо?\s+мне|расскажи\s+что\s+(?:ты\s+)?(?:знаешь|помнишь)(?:\s+обо?\s+мне)?|покажи\s+(?:мою\s+)?память|что\s+ты\s+обо\s+мне(?:\s+знаешь)?|что\s+помнишь\s+обо?\s+мне)\??$/i
        .test(message);
}

function extractDeterministicQueries(message: string): string[] {
    const queries = [message.slice(0, 120)];
    const stopWords = new Set([
        'Что', 'Кто', 'Как', 'Когда', 'Где', 'Куда', 'Почему', 'Зачем',
        'Расскажи', 'Покажи', 'Напомни', 'Помнишь', 'Помнишь ли',
    ]);
    const names = message.match(/[А-ЯЁA-Z][А-ЯЁA-Zа-яёa-z-]+(?:\s+[А-ЯЁA-Z][А-ЯЁA-Zа-яёa-z-]+){0,2}/g) ?? [];
    queries.push(...names.filter(name => !stopWords.has(name.trim())));

    const relationshipWords = message.match(/\b(жена|муж|мама|папа|сын|дочь|брат|сестра|коллега|друг|подруга|партн[её]р)\b/gi) ?? [];
    for (const rel of relationshipWords) {
        queries.push(`${rel} имя`, `${rel} кто это`, `${rel} отношения`);
    }

    return queries
        .map(q => q.trim())
        .filter(q => q.length > 1);
}

function extractContactReferenceForRetrieval(message: string): string | null {
    const username = message.match(/@[a-zA-Z0-9_]{3,32}/)?.[0];
    if (username) return username;

    const patterns = [
        /(?:о|об|про|для|к|ко|с|со|у|от|по)\s+([А-ЯЁA-Z][А-ЯЁA-Zа-яёa-z-]+(?:\s+[А-ЯЁA-Z][А-ЯЁA-Zа-яёa-z-]+){0,2})/u,
        /(?:написать|позвонить|подарить|купить|встретиться)\s+([А-ЯЁA-Z][А-ЯЁA-Zа-яёa-z-]+)/u,
    ];

    for (const pattern of patterns) {
        const match = message.match(pattern);
        if (match?.[1]) return match[1].trim();
    }

    return null;
}

function resolveContactRetrievalScope(message: string): ContactRetrievalScope | null {
    const contactName = extractContactReferenceForRetrieval(message);
    if (!contactName) return null;

    const resolution = resolveContactIdentity(contactName);
    if (resolution.status === 'resolved') {
        return {
            status: 'resolved',
            queryName: contactName,
            displayName: resolution.displayName,
            contact: resolution.contact,
        };
    }

    if (resolution.status === 'ambiguous') {
        return {
            status: 'ambiguous',
            queryName: contactName,
            candidateNames: resolution.candidates.map(contactDisplayName),
        };
    }

    return null;
}

function contactIdFromTags(tags: string[] | undefined): string | null {
    const tag = (tags ?? []).find(t => String(t).startsWith('contact_id:'));
    return tag ? String(tag).replace('contact_id:', '').trim() : null;
}

function contactNamesFromTags(tags: string[] | undefined): Set<string> {
    const names = new Set<string>();
    for (const tag of tags ?? []) {
        const value = String(tag);
        if (value.startsWith('contact:') || value.startsWith('contact_name:') || value.startsWith('contact_alias:')) {
            names.add(normalizeContactLookupValue(value.replace(/^contact(_name|_alias)?:/, '')));
        }
    }
    return names;
}

function hasContactTags(tags: string[] | undefined): boolean {
    return (tags ?? []).some(tag => String(tag).startsWith('contact'));
}

function isCandidateAllowedByContactScope(candidate: SearchResultLike, scope: ContactRetrievalScope | null): boolean {
    if (!scope || !hasContactTags(candidate.tags)) return true;

    const names = contactNamesFromTags(candidate.tags);

    if (scope.status === 'ambiguous') {
        return false;
    }

    const candidateContactId = contactIdFromTags(candidate.tags);
    if (candidateContactId) {
        return scope.contact ? candidateContactId === String(scope.contact.id) : false;
    }

    const allowedNames = new Set(
        contactIdentityTags(scope.queryName, scope.contact)
            .filter(tag => tag.startsWith('contact:') || tag.startsWith('contact_name:') || tag.startsWith('contact_alias:'))
            .map(tag => normalizeContactLookupValue(tag.replace(/^contact(_name|_alias)?:/, '')))
    );
    if (scope.displayName) allowedNames.add(normalizeContactLookupValue(scope.displayName));

    for (const name of names) {
        if (allowedNames.has(name)) return true;
    }

    return false;
}

function mergeQueries(primary: string[], generated: string[], limit: number): string[] {
    const seen = new Set<string>();
    const merged: string[] = [];
    for (const query of [...primary, ...generated]) {
        const normalized = query.toLowerCase().replace(/\s+/g, ' ').trim();
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        merged.push(query.trim());
        if (merged.length >= limit) break;
    }
    return merged;
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
            model: 'gpt-5.4-nano',
            messages: [
                {
                    role: 'system',
                    content: 'Ты генерируешь поисковые фразы для RAG-поиска по долговременной памяти. Только фразы, без пояснений.',
                },
                { role: 'user', content: prompt },
            ],
            temperature: 0.3, // стабильные запросы важнее разнообразия
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
    tags?: string[];
    previousVersions?: Array<{ content: string; timestamp: Date; confidence: number }>;
    isAnchor?: boolean;
    sourceEpisodeId?: string;
    sourceContext?: string;
    sourceMemoryIds?: string[];
    status?: string;
    confirmationCount?: number;
    retrievalCount?: number;
    lastRetrievedAt?: Date;
    retrievalCues?: string[];
}

function addCandidate(
    seen: Map<string, SearchResultLike>,
    candidate: SearchResultLike,
    scoreOverride?: number
): void {
    const normalized: SearchResultLike = {
        ...candidate,
        score: scoreOverride ?? candidate.score,
        importance: candidate.importance ?? 0.5,
        confidence: candidate.confidence ?? 0.6,
        domain: candidate.domain,
        tags: candidate.tags,
    };

    const existing = seen.get(candidate.id);
    if (!existing || normalized.score > existing.score) {
        seen.set(candidate.id, normalized);
    }
}

async function addEpisodeContextCandidates(
    userId: string,
    seedCandidates: SearchResultLike[],
    seen: Map<string, SearchResultLike>,
    addScopedCandidate: (candidate: SearchResultLike, scoreOverride?: number) => void
): Promise<number> {
    const svc = getVectorService();
    if (!svc) return 0;

    const episodeSeeds = new Map<string, SearchResultLike>();
    for (const candidate of seedCandidates) {
        const sourceEpisodeId = candidate.sourceEpisodeId?.trim();
        if (!sourceEpisodeId) continue;
        if (!episodeSeeds.has(sourceEpisodeId)) {
            episodeSeeds.set(sourceEpisodeId, candidate);
        }
        if (episodeSeeds.size >= EPISODE_CONTEXT_TOP_N) break;
    }

    let added = 0;
    await Promise.all(
        [...episodeSeeds.entries()].map(async ([episodeId, seed]) => {
            try {
                const related = await svc.getMemoriesBySourceEpisodeId(userId, episodeId, EPISODE_CONTEXT_MAX_PER_EPISODE);
                const contextualScore = Math.max(0.55, seed.score * EPISODE_CONTEXT_DISCOUNT);
                for (const memory of related) {
                    if (memory.id === seed.id || seen.has(memory.id)) continue;
                    addScopedCandidate({
                        ...memory,
                        score: isEpisodeMemoryLike(memory)
                            ? Math.max(0.58, contextualScore)
                            : contextualScore,
                        importance: memory.importance ?? 0.5,
                        confidence: memory.confidence ?? 0.6,
                        domain: memory.domain,
                    });
                    added++;
                }
            } catch {
                // contextual reinstatement is best-effort
            }
        })
    );

    if (added > 0) devLog('Episode context expansion added memories:', added);
    return added;
}

async function addChapterSourceCandidates(
    userId: string,
    seedCandidates: SearchResultLike[],
    seen: Map<string, SearchResultLike>,
    addScopedCandidate: (candidate: SearchResultLike, scoreOverride?: number) => void
): Promise<number> {
    const svc = getVectorService();
    if (!svc) return 0;

    const chapterSeeds = seedCandidates
        .filter((candidate) => isChapterMemoryLike(candidate) && (candidate.sourceMemoryIds?.length ?? 0) > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, CHAPTER_SOURCE_TOP_N);

    let added = 0;
    await Promise.all(
        chapterSeeds.map(async (chapter) => {
            try {
                const ids = chapter.sourceMemoryIds ?? [];
                const sources = await svc.fetchMemoriesByIds(userId, ids, CHAPTER_SOURCE_MAX_PER_CHAPTER);
                const sourceScore = Math.max(0.52, chapter.score * CHAPTER_SOURCE_DISCOUNT);
                for (const source of sources) {
                    if (source.id === chapter.id || seen.has(source.id)) continue;
                    addScopedCandidate({
                        ...source,
                        score: isEpisodeMemoryLike(source)
                            ? sourceScore * 0.9
                            : sourceScore,
                        importance: source.importance ?? 0.5,
                        confidence: source.confidence ?? 0.6,
                        domain: source.domain,
                    });
                    added++;
                }
            } catch {
                // source expansion is best-effort
            }
        })
    );

    if (added > 0) devLog('Chapter source expansion added memories:', added);
    return added;
}

/**
 * Форматирует факт для вставки в LLM-контекст.
 *
 * Добавляет два типа аннотаций:
 * 1. История изменений: "(ранее: ...)" — даёт модели понимание эволюции
 * 2. Confidence-маркер — сигнализирует модели насколько уверенно говорить об этом факте:
 *    - [возможно] для confidence 0.35–0.64: модель должна мягко хеджировать ("кажется", "если не ошибаюсь")
 *    - [не уверена] для confidence < 0.35: модель должна явно обозначить неопределённость
 *    - нет маркера для confidence >= 0.65: факт достаточно надёжен, говорим уверенно
 *
 * Это имитирует мета-память человека: мы знаем, что мы помним хорошо, а что смутно.
 */
function formatFactWithHistory(r: SearchResultLike): string {
    const conf = r.confidence ?? 0.6;
    let confidenceMarker = '';
    if (conf < 0.35) {
        confidenceMarker = '[не уверена] ';
    } else if (conf < 0.65) {
        confidenceMarker = '[возможно] ';
    }

    const previous = (r.previousVersions ?? [])
        .slice(0, 2)
        .map(v => v.content.trim())
        .filter(Boolean);
    const history = previous.length > 0
        ? ` (история изменений, не текущее состояние: ${previous.join(' -> ')})`
        : '';
    const status = r.status && r.status !== 'active' ? ` [статус: ${r.status}]` : '';
    const confirmations = (r.confirmationCount ?? 0) > 1 ? ` [подтверждений: ${r.confirmationCount}]` : '';
    const retrievals = (r.retrievalCount ?? 0) >= 3 ? ` [часто всплывает: ${r.retrievalCount}]` : '';
    const source = r.sourceContext && r.sourceContext.trim() && r.sourceContext.trim() !== r.content.trim()
        ? ` (источник: ${r.sourceContext.trim().slice(0, 140)})`
        : '';
    const kindMarker = isEpisodeMemoryLike(r)
        ? '[эпизодический контекст] '
        : isChapterMemoryLike(r)
            ? '[сводная глава] '
            : '';

    return `${confidenceMarker}${kindMarker}${r.content}${status}${confirmations}${retrievals}${history}${source}`;
}

/**
 * LLM-based reranker: фильтрует и переранжирует факты по релевантности к запросу.
 * Аналог cross-encoder reranker — работает медленнее embedding-поиска,
 * но значительно точнее для финального отбора.
 *
 * Принимает top-N кандидатов из vector search, возвращает только реально релевантные
 * с обновлённым порядком.
 */
async function rerankFacts(
    userMessage: string,
    candidates: Array<SearchResultLike & { _finalScore: number }>,
    maxReturn: number
): Promise<Array<SearchResultLike & { _finalScore: number }>> {
    if (candidates.length <= 3) return candidates; // слишком мало — не тратим LLM-вызов

    const cacheKey = `rerank:${userMessage.slice(0, 150)}|${candidates.map(c => c.id).join(',')}`;
    const cached = llmCache.get<string[]>(cacheKey);
    if (cached) {
        const idOrder = cached;
        const idMap = new Map(candidates.map(c => [c.id, c]));
        return idOrder.map(id => idMap.get(id)).filter(Boolean) as typeof candidates;
    }

    // Нумеруем факты для LLM
    const factsBlock = candidates
        .slice(0, 30) // не больше 30 кандидатов в промпт
        .map((c, i) => `${i + 1}. ${c.content}`)
        .join('\n');

    try {
        const resp = await openai.chat.completions.create({
            model: 'gpt-5.4-nano',
            messages: [
                {
                    role: 'system',
                    content: 'Ты ранжируешь факты из памяти по релевантности к запросу. Отвечай только числами через запятую.',
                },
                {
                    role: 'user',
                    content: `Запрос пользователя: "${userMessage.slice(0, 200)}"

Факты-кандидаты:
${factsBlock}

Выбери ТОЛЬКО релевантные факты (которые помогут ответить на запрос или дают важный контекст о пользователе).
Верни их номера через запятую в порядке убывания релевантности. Нерелевантные факты НЕ включай.

Номера:`,
                },
            ],
            temperature: 0,
            max_tokens: 100,
        });

        const text = resp.choices[0]?.message?.content?.trim() || '';
        const indices = text
            .split(/[,\s]+/)
            .map(s => parseInt(s.trim(), 10) - 1)
            .filter(i => !isNaN(i) && i >= 0 && i < candidates.length);

        if (indices.length === 0) {
            devLog('Reranker returned empty, using original order');
            return candidates.slice(0, maxReturn);
        }

        // Собираем отфильтрованные факты в порядке LLM
        const reranked = indices
            .filter((v, i, a) => a.indexOf(v) === i) // deduplicate
            .slice(0, maxReturn)
            .map(i => candidates[i]);

        const idOrder = reranked.map(c => c.id);
        llmCache.set(cacheKey, idOrder, LLM_CACHE_TTL.CLASSIFY);

        devLog(`Reranker: ${candidates.length} → ${reranked.length} facts`);
        return reranked;
    } catch (e) {
        devLog('Reranker error, using original order:', e);
        return candidates.slice(0, maxReturn);
    }
}

/** Считает приблизительное количество токенов в тексте (для русского ~3.5 символа на токен) */
function estimateTokens(text: string): number {
    return Math.ceil(text.length / APPROX_CHARS_PER_TOKEN);
}

/** Обрезает массив фактов чтобы суммарно не превышать бюджет токенов */
function trimToTokenBudget(facts: string[], budget: number): string[] {
    const result: string[] = [];
    let used = 0;
    for (const fact of facts) {
        const tokens = estimateTokens(fact);
        if (used + tokens > budget) break;
        result.push(fact);
        used += tokens;
    }
    return result;
}

/**
 * Трёхуровневый поиск по долговременной памяти:
 * 1. Классификация потребности в памяти (none / light / full)
 * 2. Answer-запросы — ищут факты, прямо отвечающие на вопрос (больше результатов, выше вес)
 * 3. Context-запросы — ищут фоновый контекст (меньше результатов, score дисконтируется)
 * 4. 1-hop graph expansion для топовых результатов (только в full-режиме)
 * 5. LLM reranker — фильтрация нерелевантных фактов
 * 6. Token budget — обрезка до 1500 токенов
 */
/** Количество предыдущих сообщений для резолвинга местоимений */
const HISTORY_CONTEXT_MESSAGES = 3;

export async function getMultiQueryMemoryContext(ctx: BotContext, userMessage: string, memoryNeed?: MemoryNeed): Promise<string> {
    // Если memoryNeed не передан — классифицируем
    const need = memoryNeed ?? await classifyMemoryNeed(userMessage);

    // Даже если memory need = none, проверяем short-term буфер:
    // пользователь мог только что сказать «запомни X» и сразу спросить про X
    const nowTs = Date.now();
    const recentSessionFacts = (ctx.session?.recentlySavedFacts ?? [])
        .filter(f => nowTs - f.savedAt < 10 * 60 * 1000)
        .map(f => f.content);

    if (need === 'none') {
        if (recentSessionFacts.length === 0) {
            devLog('Memory need: none — skipping memory retrieval');
            return '';
        }
        // Есть недавние факты — возвращаем только их, без vector search
        devLog('Memory need: none, but injecting recent facts:', recentSessionFacts.length);
        return '[Только что запомнила]:\n' + recentSessionFacts.join('\n');
    }

    const inventoryRequest = isMemoryInventoryRequest(userMessage);
    const maxFacts = need === 'light' ? 5 : inventoryRequest ? 40 : MAX_TOTAL_FACTS;
    const tokenBudget = need === 'light' ? 500 : inventoryRequest ? 2200 : MAX_MEMORY_TOKENS;

    // Берём последние N сообщений из истории (не считая текущего)
    // messageHistory хранится newest-first, поэтому срезаем с индекса 1
    const recentHistory = (ctx.session?.messageHistory ?? [])
        .slice(1, 1 + HISTORY_CONTEXT_MESSAGES)
        .reverse() // хронологический порядок для промпта
        .map((m) => ({ role: m.role, content: m.content }));

    const generatedQueries = await generateMemoryQueries(userMessage, recentHistory.length > 0 ? recentHistory : undefined);
    const deterministicQueries = extractDeterministicQueries(userMessage);
    const answerQueries = mergeQueries(deterministicQueries, generatedQueries.answerQueries, 6);
    const contextQueries = mergeQueries([], generatedQueries.contextQueries, 3);
    const contactScope = resolveContactRetrievalScope(userMessage);

    const seen = new Map<string, SearchResultLike>();
    const addScopedCandidate = (candidate: SearchResultLike, scoreOverride?: number) => {
        if (!isCandidateAllowedByContactScope(candidate, contactScope)) return;
        addCandidate(seen, candidate, scoreOverride);
    };
    /** Set of anchor IDs for score boosting (instead of unconditional inclusion) */
    const anchorIds = new Set<string>();
    try {
        const anchorResults = await getAnchorMemories(ctx, 10);
        for (const r of anchorResults) {
            anchorIds.add(r.id);
            if (need === 'full' || inventoryRequest) {
                addScopedCandidate({ ...r, isAnchor: true }, ANCHOR_DIRECT_SCORE);
            }
        }
    } catch { /* ignore */ }

    if (contactScope?.status === 'resolved') {
        const svcForTags = getVectorService();
        if (svcForTags) {
            const tags = contactIdentityTags(contactScope.queryName, contactScope.contact);
            const tagResults = await Promise.all(
                [...new Set(tags)].map(tag =>
                    svcForTags.getMemoriesByTag(String(ctx.from?.id), tag).catch(() => [])
                )
            );
            for (const results of tagResults) {
                for (const result of results) {
                    addScopedCandidate(result, Math.max(result.score ?? 0, ANCHOR_DIRECT_SCORE));
                }
            }
        }
    }

    if (inventoryRequest) {
        try {
            const recentMemories = await getRecentMemories(ctx, MEMORY_INVENTORY_LIMIT);
            for (const memory of recentMemories) {
                if (memory.tags?.includes('memory-episode') || memory.content.startsWith('[ЭПИЗОД ПАМЯТИ:')) {
                    continue;
                }
                addScopedCandidate({
                    id: memory.id,
                    content: memory.content,
                    score: MEMORY_INVENTORY_SCORE,
                    importance: memory.importance,
                    timestamp: memory.timestamp,
                    confidence: memory.confidence,
                    domain: memory.domain,
                    tags: memory.tags,
                    previousVersions: memory.previousVersions,
                    isAnchor: memory.isAnchor,
                    sourceEpisodeId: memory.sourceEpisodeId,
                    sourceContext: memory.sourceContext,
                    sourceMemoryIds: memory.sourceMemoryIds,
                    status: memory.status,
                    confirmationCount: memory.confirmationCount,
                    retrievalCount: memory.retrievalCount,
                    lastRetrievedAt: memory.lastRetrievedAt,
                    retrievalCues: memory.retrievalCues,
                }, memory.isAnchor ? ANCHOR_DIRECT_SCORE : MEMORY_INVENTORY_SCORE);
            }
        } catch {
            // broad inventory fallback is best-effort
        }
    }

    // Answer-запросы: приоритетный поиск, полный score
    await Promise.all(
        answerQueries.map(async (query) => {
            const results = await searchAllDomainsMemories(ctx, query, ANSWER_RESULTS_PER_QUERY);
            for (const r of results) {
                addScopedCandidate(r);
            }
        })
    );

    // Context-запросы: фоновый контекст, score дисконтируется
    await Promise.all(
        contextQueries.map(async (query) => {
            const results = await searchAllDomainsMemories(ctx, query, CONTEXT_RESULTS_PER_QUERY);
            for (const r of results) {
                addScopedCandidate(r, r.score * CONTEXT_QUERY_SCORE_DISCOUNT);
            }
        })
    );

    // 1-hop graph expansion: только в full-режиме
    if (need === 'full') {
        const svcForGraph = getVectorService();
        if (svcForGraph) {
            const beforeHopOne = new Set(seen.keys());
            const primaryResults = Array.from(seen.values()).sort((a, b) => b.score - a.score).slice(0, GRAPH_EXPANSION_TOP_N);
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
                                    addScopedCandidate({
                                        ...fetched,
                                        score: fact.score * GRAPH_EXPANSION_DISCOUNT,
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

            // 2-hop expansion: берём топ-2 из результатов 1-hop и расширяем дальше
            const hopOneAdded = Array.from(seen.entries())
                .filter(([id]) => !beforeHopOne.has(id))
                .map(([, v]) => v)
                .sort((a, b) => b.score - a.score)
                .slice(0, 2);

            let hopTwoCount = 0;
            for (const fact of hopOneAdded) {
                if (!fact.domain) continue;
                try {
                    const related = await svcForGraph.getRelatedFacts(fact.id, fact.domain);
                    for (const { id, domain } of related) {
                        if (hopTwoCount >= GRAPH_EXPANSION_HOP2_MAX || seen.has(id)) continue;
                        const fetched = await svcForGraph.fetchMemoryById(id, domain);
                        if (fetched) {
                            addScopedCandidate({
                                ...fetched,
                                score: fact.score * GRAPH_EXPANSION_DISCOUNT,
                                importance: fetched.importance ?? 0.5,
                                confidence: fetched.confidence ?? 0.6,
                                domain: fetched.domain,
                            });
                            hopTwoCount++;
                        }
                    }
                } catch {
                    // игнорируем ошибки 2-hop expansion
                }
            }
        }
    }

    // Contextual reinstatement: если факт пришёл из конкретного эпизода,
    // восстанавливаем сцену и несколько соседних фактов из того же разговора.
    if (need === 'full' && ctx.from?.id) {
        const episodeSeeds = Array.from(seen.values())
            .filter((fact) => Boolean(fact.sourceEpisodeId))
            .sort((a, b) => b.score - a.score)
            .slice(0, EPISODE_CONTEXT_TOP_N);
        if (episodeSeeds.length > 0) {
            await addEpisodeContextCandidates(String(ctx.from.id), episodeSeeds, seen, addScopedCandidate);
        }
    }

    // Schema-to-evidence expansion: если нашлась сводная глава памяти,
    // подтягиваем несколько исходных воспоминаний, чтобы ответ был конкретным и проверяемым.
    if (need === 'full' && ctx.from?.id) {
        const chapterSeeds = Array.from(seen.values())
            .filter((fact) => isChapterMemoryLike(fact) && (fact.sourceMemoryIds?.length ?? 0) > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, CHAPTER_SOURCE_TOP_N);
        if (chapterSeeds.length > 0) {
            await addChapterSourceCandidates(String(ctx.from.id), chapterSeeds, seen, addScopedCandidate);
        }
    }

    // Первичное ранжирование (vector score + importance + confidence + anchor boost)
    const sorted = Array.from(seen.values())
        .map((r) => {
            const conf = r.confidence ?? 0.6;
            const baseScore = r.score * (0.6 + 0.2 * (r.importance ?? 0.5) + 0.1 * conf);
            // Anchor-факты получают буст при ранжировании (но не включаются безусловно)
            const anchorMul = anchorIds.has(r.id) ? ANCHOR_SCORE_BOOST : 1.0;
            const familiarityMul = 1 + Math.min(0.10, Math.log1p(Math.max(0, r.retrievalCount ?? 0)) * 0.02);
            return { ...r, _finalScore: baseScore * anchorMul * familiarityMul };
        })
        .filter((r) => r._finalScore >= MIN_FINAL_SCORE_THRESHOLD)
        .sort((a, b) => b._finalScore - a._finalScore);

    // LLM reranker: убирает нерелевантные факты, переупорядочивает по смыслу
    const preRerank = sorted.slice(0, maxFacts + 10); // даём reranker'у чуть больше кандидатов
    const reranked = need === 'full' && !inventoryRequest
        ? await rerankFacts(userMessage, preRerank, maxFacts)
        : preRerank.slice(0, maxFacts); // для light — не тратим LLM-вызов

    const topFormatted = reranked.map((r) => formatFactWithHistory(r));

    // Token budget: обрезаем факты если суммарно превышают бюджет
    const trimmed = trimToTokenBudget(topFormatted, tokenBudget);

    // Буст важности + сброс кривой забывания для фактов, которые оказались релевантны (fire & forget)
    const svc = getVectorService();
    if (svc) {
        for (const fact of reranked) {
            const boosted = Math.min(1.0, (fact.importance ?? 0.5) + 0.03);
            if (boosted > (fact.importance ?? 0.5)) {
                svc.updateImportance(fact.id, boosted).catch(() => { });
            }
            if (fact.domain) {
                svc.updateMemoryAccess(fact.id, fact.domain, undefined, userMessage).catch(() => { });
            }
        }
    }

    const factsBlock = trimmed.join('\n');

    // Short-term memory buffer: факты, сохранённые в текущей сессии (< 10 мин),
    // инжектируем напрямую — гарантия что только что запомненное не потеряется
    // из-за latency vector search или различия embeddings (порядок слов в имени и т.п.)
    const now = Date.now();
    const recentFacts = (ctx.session?.recentlySavedFacts ?? [])
        .filter(f => now - f.savedAt < 10 * 60 * 1000)
        .map(f => f.content);
    // Дедуплицируем с фактами из vector search
    const newRecentFacts = recentFacts.filter(rf => {
        const rfLower = rf.toLowerCase();
        return !trimmed.some(t => {
            const tLower = t.toLowerCase();
            return tLower.includes(rfLower) || rfLower.includes(tLower);
        });
    });
    const recentBlock = newRecentFacts.length > 0
        ? '\n\n[Только что запомнила]:\n' + newRecentFacts.join('\n')
        : '';
    const contactScopeNote = contactScope?.status === 'ambiguous'
        ? `\nВнимание: имя «${contactScope.queryName}» неоднозначно (${contactScope.candidateNames?.join(', ')}). Контактные факты по этому имени не подмешаны; попроси пользователя уточнить конкретного человека.\n`
        : contactScope?.status === 'resolved' && contactScope.displayName
            ? `\nКонтактный scope запроса: ${contactScope.displayName}. Не используй факты о других контактах с похожим именем.\n`
            : '';

    const preamble =
        'Ниже — факты из долговременной памяти о пользователе. Используй их при ответе.\n' +
        'Маркеры достоверности:\n' +
        '  [возможно] — помню, но не на 100%; используй мягкие обороты: "кажется", "если не ошибаюсь"\n' +
        '  [не уверена] — слабое воспоминание; скажи что помнишь смутно и предложи уточнить\n' +
        '  Без маркера — факт надёжен, говори уверенно\n' +
        'Если спрашивает конкретное (кто жена, как зовут) — дай прямой ответ из фактов. ' +
        'Если «что знаешь обо мне» — перечисли. Если фактов нет — честно скажи.\n' +
        contactScopeNote +
        '\nФакты из памяти:\n';
    const context = preamble + (factsBlock || '(пока нет сохранённых фактов)') + recentBlock;
    devLog('Multi-query memory context:', {
        memoryNeed: need,
        contactScope: contactScope?.status,
        answerQueries: answerQueries.length,
        contextQueries: contextQueries.length,
        candidateFacts: sorted.length,
        afterRerank: reranked.length,
        afterTokenBudget: trimmed.length,
        recentFactsInjected: newRecentFacts.length,
    });
    return context;
}
