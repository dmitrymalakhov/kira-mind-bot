/**
 * Чистые функции гибридного memory retrieval.
 *
 * Важно: entity-сигнал используется только для ранжирования уже разрешённых
 * кандидатов. Он не заменяет contact scope и не может авторизовать смешение
 * воспоминаний о разных людях.
 */

const RETRIEVAL_STOPWORDS = new Set([
    'а', 'без', 'бы', 'был', 'была', 'были', 'быть', 'в', 'во', 'вот', 'вы',
    'где', 'да', 'для', 'до', 'его', 'ее', 'её', 'если', 'есть', 'ещё', 'же',
    'за', 'и', 'из', 'или', 'как', 'когда', 'кто', 'ли', 'мне', 'мой', 'моя',
    'мы', 'на', 'над', 'не', 'него', 'нее', 'неё', 'но', 'о', 'об', 'он', 'она',
    'они', 'от', 'по', 'под', 'про', 'с', 'со', 'так', 'там', 'тебе', 'ты', 'у',
    'что', 'это', 'этот', 'эта', 'эти', 'я',
    'a', 'about', 'and', 'are', 'for', 'from', 'how', 'in', 'is', 'of', 'on',
    'or', 'the', 'to', 'was', 'what', 'when', 'where', 'who', 'with',
]);

const ENTITY_TAG_PREFIXES = [
    'contact:',
    'contact_name:',
    'contact_alias:',
    'contact_username:',
    'contact_id:',
    'contact_key:',
    'person_id:',
    'entity:',
    'entity_name:',
    'relation_subject_name:',
    'relation_object_name:',
];

export interface MemoryRetrievalCandidate {
    id: string;
    content: string;
    score: number;
    tags?: string[];
}

export interface MemoryRetrievalScoreDetails {
    /** Запрос, для которого рассчитаны сигналы. */
    query: string;
    /** Исходный cosine dense-поиска; не смешивается с dedup threshold. */
    semanticScore: number;
    /** Нормализованное точное лексическое совпадение [0..1]. */
    lexicalScore: number;
    /** Нормализованное совпадение сущностей [0..1]. */
    entityScore: number;
    /** Результат fusion до importance/confidence/recall-множителей. */
    hybridScore: number;
    matchedTokens: string[];
    matchedEntities: string[];
    candidateSources: Array<'semantic' | 'lexical'>;
    /** Вес ветки multi-query: direct=1, context/associative меньше 1. */
    queryWeight?: number;
    /** Score после веса ветки, но до финальных memory-множителей. */
    weightedRetrievalScore?: number;
    finalScore?: number;
    rankingFactors?: {
        importanceConfidence: number;
        anchor: number;
        familiarity: number;
        humanRecall: number;
    };
}

export type HybridMemoryRetrievalResult<T extends MemoryRetrievalCandidate> = T & {
    score: number;
    scoreDetails: MemoryRetrievalScoreDetails;
};

export function normalizeMemoryRetrievalText(value: string): string {
    return value
        .normalize('NFKC')
        .toLocaleLowerCase('ru-RU')
        .replace(/ё/g, 'е')
        .replace(/[«»“”„"'`]/g, ' ')
        .replace(/[^a-zа-я0-9@._:+/-]+/giu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

export function tokenizeMemoryRetrievalText(value: string): string[] {
    const normalized = normalizeMemoryRetrievalText(value);
    if (!normalized) return [];
    return [...new Set(
        normalized
            .split(' ')
            .map(token => token.replace(/^[._:+/-]+|[._:+/-]+$/g, ''))
            .filter(token => token.length >= 2 && !RETRIEVAL_STOPWORDS.has(token))
    )];
}

function normalizeEntity(value: string): string {
    return normalizeMemoryRetrievalText(value)
        .replace(/^@/, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function entityStem(value: string): string {
    const normalized = normalizeEntity(value);
    if (!/^[а-я]{5,}$/u.test(normalized)) return normalized;
    return normalized.replace(/(иями|ями|ами|ого|ему|ому|ыми|ими|ой|ей|ою|ею|ом|ем|ам|ям|ах|ях|ов|ев|а|я|у|ю|ы|и|е)$/u, '');
}

function isIdentifierToken(token: string): boolean {
    return (/\d/u.test(token) && /[a-zа-я]/u.test(token)) || /[@._:+/-]/u.test(token);
}

function extractCapitalizedEntities(value: string): string[] {
    const matches = value.match(/(?:^|[\s([{"'«])([A-ZА-ЯЁ][a-zа-яё]{2,}(?:\s+[A-ZА-ЯЁ][a-zа-яё]{2,}){0,2})/gu) ?? [];
    return matches
        .map(match => match.replace(/^[\s([{"'«]+/u, '').trim())
        .filter(Boolean);
}

export function extractMemoryEntities(value: string, tags: string[] = []): string[] {
    const entities = new Set<string>();
    const bracketSubject = value.match(/^\s*\[([^\]]{2,80})\]/u)?.[1];
    if (bracketSubject) entities.add(normalizeEntity(bracketSubject));

    for (const match of value.matchAll(/@([a-z0-9_][a-z0-9_.-]{1,63})/giu)) {
        entities.add(normalizeEntity(match[1]));
    }
    for (const token of tokenizeMemoryRetrievalText(value)) {
        if (isIdentifierToken(token)) entities.add(normalizeEntity(token));
    }
    for (const entity of extractCapitalizedEntities(value)) {
        entities.add(normalizeEntity(entity));
    }

    for (const rawTag of tags) {
        const tag = normalizeMemoryRetrievalText(String(rawTag));
        const prefix = ENTITY_TAG_PREFIXES.find(candidate => tag.startsWith(candidate));
        if (!prefix) continue;
        const valueFromTag = normalizeEntity(tag.slice(prefix.length));
        if (valueFromTag) entities.add(valueFromTag);
    }

    return [...entities]
        .filter(entity => entity.length >= 2 && !RETRIEVAL_STOPWORDS.has(entity))
        .slice(0, 24);
}

export interface MemoryLexicalMatch {
    score: number;
    matchedTokens: string[];
}

export function scoreMemoryLexicalMatch(content: string, query: string): MemoryLexicalMatch {
    const queryTokens = tokenizeMemoryRetrievalText(query);
    if (queryTokens.length === 0) return { score: 0, matchedTokens: [] };

    const contentTokens = new Set(tokenizeMemoryRetrievalText(content));
    const matchedTokens = queryTokens.filter(token => contentTokens.has(token));
    const coverage = matchedTokens.length / queryTokens.length;
    const normalizedContent = normalizeMemoryRetrievalText(content);
    const normalizedQuery = normalizeMemoryRetrievalText(query);
    const exactPhrase = normalizedQuery.length >= 4 && normalizedContent.includes(normalizedQuery) ? 1 : 0;
    const identifierTokens = queryTokens.filter(isIdentifierToken);
    const identifierCoverage = identifierTokens.length > 0
        ? identifierTokens.filter(token => contentTokens.has(token)).length / identifierTokens.length
        : 0;

    const score = Math.min(1, coverage * 0.86 + exactPhrase * 0.08 + identifierCoverage * 0.06);
    return { score, matchedTokens };
}

export interface MemoryEntityMatch {
    score: number;
    matchedEntities: string[];
}

export function scoreMemoryEntityMatch(content: string, tags: string[] | undefined, query: string): MemoryEntityMatch {
    const queryEntities = extractMemoryEntities(query);
    if (queryEntities.length === 0) return { score: 0, matchedEntities: [] };

    const candidateEntities = extractMemoryEntities(content, tags);
    const exact = queryEntities.filter(entity => candidateEntities.includes(entity));
    const exactSet = new Set(exact);
    const stemmed = queryEntities.filter(queryEntity => {
        if (exactSet.has(queryEntity)) return false;
        const queryStem = entityStem(queryEntity);
        return queryStem.length >= 4 && candidateEntities.some(entity => entityStem(entity) === queryStem);
    });
    const weightedMatches = exact.length + stemmed.length * 0.82;
    const matchedEntities = [...exact, ...stemmed];
    return {
        score: Math.min(1, weightedMatches / queryEntities.length),
        matchedEntities,
    };
}

function clamp01(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.min(1, Math.max(0, value));
}

/**
 * Объединяет dense и Qdrant full-text candidate sets.
 *
 * Dense score сохраняет свою исходную шкалу. Нормализованные lexical/entity
 * сигналы могут поднять точное имя/ID, а согласие нескольких сигналов даёт
 * небольшой бонус. Это не смешение cosine с ненормализованным BM25.
 */
export function fuseMemoryRetrievalCandidates<T extends MemoryRetrievalCandidate>(
    query: string,
    semanticCandidates: T[],
    lexicalCandidates: T[],
    limit: number
): Array<HybridMemoryRetrievalResult<T>> {
    const merged = new Map<string, { candidate: T; semanticScore: number; sources: Set<'semantic' | 'lexical'> }>();

    for (const candidate of semanticCandidates) {
        merged.set(candidate.id, {
            candidate,
            semanticScore: clamp01(candidate.score),
            sources: new Set(['semantic']),
        });
    }
    for (const candidate of lexicalCandidates) {
        const existing = merged.get(candidate.id);
        if (existing) {
            existing.sources.add('lexical');
        } else {
            merged.set(candidate.id, {
                candidate,
                semanticScore: 0,
                sources: new Set(['lexical']),
            });
        }
    }

    return [...merged.values()]
        .map(({ candidate, semanticScore, sources }) => {
            const lexical = scoreMemoryLexicalMatch(candidate.content, query);
            const entity = scoreMemoryEntityMatch(candidate.content, candidate.tags, query);
            const positiveSignals = [semanticScore >= 0.35, lexical.score >= 0.35, entity.score >= 0.35]
                .filter(Boolean).length;
            const agreementBonus = positiveSignals >= 3 ? 0.07 : positiveSignals === 2 ? 0.035 : 0;
            const blended = semanticScore * 0.62 + lexical.score * 0.25 + entity.score * 0.13 + agreementBonus;
            const lexicalRescue = lexical.score >= 0.82 && lexical.matchedTokens.length >= 2
                ? lexical.score * 0.92
                : 0;
            const entityRescue = entity.score >= 0.80 ? entity.score * 0.86 : 0;
            const hybridScore = clamp01(Math.max(semanticScore, blended, lexicalRescue, entityRescue));
            const scoreDetails: MemoryRetrievalScoreDetails = {
                query,
                semanticScore,
                lexicalScore: lexical.score,
                entityScore: entity.score,
                hybridScore,
                matchedTokens: lexical.matchedTokens,
                matchedEntities: entity.matchedEntities,
                candidateSources: [...sources],
            };
            return { ...candidate, score: hybridScore, scoreDetails };
        })
        .sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            if (b.scoreDetails.semanticScore !== a.scoreDetails.semanticScore) {
                return b.scoreDetails.semanticScore - a.scoreDetails.semanticScore;
            }
            return a.id.localeCompare(b.id);
        })
        .slice(0, Math.max(0, limit));
}
