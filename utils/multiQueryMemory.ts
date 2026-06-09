import { BotContext, MemoryRelation, MemoryRelationType } from '../types';
import { searchAllDomainsMemories, getAnchorMemories, getRecentMemories } from './enhancedDomainMemory';
import { devLog } from '../utils';
import { createChatCompletionForTask } from '../ai/chatCompletion';
import { getVectorService } from '../services/VectorServiceFactory';
import { llmCache, LLM_CACHE_TTL } from './llmCache';
import { Contact } from '../stores/ContactsStore';
import { contactDisplayName, contactIdentityTags, normalizeContactLookupValue, resolveContactIdentity } from './contactMemory';

const ANSWER_RESULTS_PER_QUERY = 5;
const CONTEXT_RESULTS_PER_QUERY = 2;
const ASSOCIATIVE_RESULTS_PER_QUERY = 2;
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
/** Дисконт для ассоциативных запросов от рабочей памяти */
const ASSOCIATIVE_QUERY_SCORE_DISCOUNT = 0.7;
/** Контекстные местоимения сильнее зависят от текущей рабочей памяти */
const ASSOCIATIVE_CONTEXTUAL_SCORE_DISCOUNT = 0.82;
const MAX_ASSOCIATIVE_QUERIES = 6;
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
/** Устойчивые модели пользователя, синтезированные консолидацией памяти */
const MEMORY_SCHEMA_TAG = 'memory-schema';
const MAX_SCHEMA_MEMORIES = 6;
const SCHEMA_DIRECT_SCORE = 0.78;
/** Метапамять: где сведения слабые, мутные или могут устареть */
const MEMORY_UNCERTAINTY_TAG = 'sleep_uncertainty_index';
const UNCERTAINTY_DIRECT_SCORE = 0.70;
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
const TOKEN_STOPWORDS = new Set([
    'что', 'как', 'кто', 'где', 'куда', 'когда', 'почему', 'зачем',
    'это', 'этот', 'эта', 'эти', 'там', 'тут', 'уже', 'еще', 'ещё',
    'про', 'для', 'мне', 'тебе', 'его', 'ее', 'её', 'они', 'она', 'оно',
    'the', 'and', 'for', 'with', 'about',
]);

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
    if (hasContextDependentReference(lc)) return 'light';
    if (lc.length < 4) return 'none';

    const cacheKey = `mem_need:${lc.slice(0, 150)}`;
    const cached = llmCache.get<MemoryNeed>(cacheKey);
    if (cached) return cached;

    try {
        const resp = await createChatCompletionForTask('memoryExtraction', {
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
            max_completion_tokens: 5,
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

function isSchemaMemoryLike(memory: Pick<SearchResultLike, 'content' | 'tags'>): boolean {
    return (memory.tags ?? []).includes(MEMORY_SCHEMA_TAG) ||
        memory.content.startsWith('[МОДЕЛЬ ПАМЯТИ:');
}

function isUncertaintyIndexLike(memory: Pick<SearchResultLike, 'content' | 'tags'>): boolean {
    return (memory.tags ?? []).includes(MEMORY_UNCERTAINTY_TAG) ||
        memory.content.startsWith('[ИНДЕКС СОМНЕНИЙ ПАМЯТИ]');
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

function normalizeQuery(value: string): string {
    return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function tokenizeCue(value: string): Set<string> {
    const tokens = value
        .toLowerCase()
        .match(/[\p{L}\p{N}_-]{3,}/gu) ?? [];
    return new Set(tokens.filter(token => !TOKEN_STOPWORDS.has(token)));
}

function tokenOverlapRatio(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 || b.size === 0) return 0;
    let overlap = 0;
    for (const token of a) {
        if (b.has(token)) overlap++;
    }
    return overlap / Math.min(a.size, b.size);
}

function compactCue(value: string, limit = 90): string {
    return value
        .replace(/[«»"]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, limit);
}

function isWeakAssociativeCue(value: string): boolean {
    const normalized = normalizeQuery(value);
    return normalized.length < 2 ||
        ['general', 'personal', 'общий', 'общая', 'личное', 'разговор', 'чат', 'сообщение'].includes(normalized);
}

function hasContextDependentReference(message: string): boolean {
    return /(?:^|[^\p{L}\p{N}_])(?:он|она|оно|они|его|е[её]|ему|ей|ним|ней|ними|там|туда|оттуда|это|этот|эта|эти|такой|такая|такое|тогда|раньше|потом|снова|опять)(?=$|[^\p{L}\p{N}_])|(?:^|[^\p{L}\p{N}_])про\s+(?:это|него|не[её]|них)(?=$|[^\p{L}\p{N}_])|(?:^|[^\p{L}\p{N}_])как\s+(?:там|тогда)(?=$|[^\p{L}\p{N}_])|(?:^|[^\p{L}\p{N}_])что\s+с\s+(?:этим|ним|ней|ними)(?=$|[^\p{L}\p{N}_])/iu
        .test(message);
}

/**
 * Ассоциативный прайминг: человеческая память всплывает не только по словам
 * вопроса, но и по текущему "рабочему столу" разговора.
 */
function buildAssociativePrimingQueries(ctx: BotContext, userMessage: string): string[] {
    const wm = ctx.session?.workingMemory;
    if (!wm) return [];

    const contextDependent = hasContextDependentReference(userMessage);
    const messageCue = compactCue(userMessage, 80);
    const queries: string[] = [];
    const seen = new Set<string>();
    const push = (query: string) => {
        const cue = compactCue(query);
        const key = normalizeQuery(cue);
        if (!cue || seen.has(key) || isWeakAssociativeCue(cue)) return;
        seen.add(key);
        queries.push(cue);
    };

    for (const entity of wm.activeEntities?.slice(0, 4) ?? []) {
        const cue = compactCue(entity, 60);
        if (isWeakAssociativeCue(cue)) continue;
        if (contextDependent) push(`${cue} ${messageCue}`);
        push(cue);
    }

    for (const topic of wm.activeTopics?.slice(0, 3) ?? []) {
        const cue = compactCue(topic, 60);
        if (isWeakAssociativeCue(cue)) continue;
        if (contextDependent) push(`${cue} ${messageCue}`);
        push(cue);
    }

    for (const loop of wm.openLoops?.slice(0, 3) ?? []) {
        const cue = compactCue(loop, 90);
        if (isWeakAssociativeCue(cue)) continue;
        push(cue);
        if (contextDependent) push(`${cue} ${messageCue}`);
    }

    if (contextDependent && wm.lastUserIntent) {
        push(`${compactCue(wm.lastUserIntent, 80)} ${messageCue}`);
    }

    return queries.slice(0, MAX_ASSOCIATIVE_QUERIES);
}

function clamp01(value: number): number {
    return Math.min(1, Math.max(0, value));
}

function boundedMetric(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value)
        ? clamp01(value)
        : undefined;
}

function ageDays(date: Date | undefined): number | undefined {
    if (!date) return undefined;
    const ts = date instanceof Date ? date.getTime() : new Date(date).getTime();
    if (!Number.isFinite(ts)) return undefined;
    return Math.max(0, (Date.now() - ts) / 86_400_000);
}

function isHistoricalRecallRequest(message: string): boolean {
    return /раньше|истори|как\s+было|до\s+этого|прошл|поменял|измени/i.test(message);
}

function isProspectiveRecallRequest(message: string): boolean {
    return /план|надо|нужно|долж|срок|дедлайн|напомни|обещал|договорил|ожида|предстоит|что\s+дальше/i.test(message);
}

function cueResonanceScore(memory: SearchResultLike, activeCues: string[]): number {
    const historicalCues = [
        ...(memory.retrievalCues ?? []),
        memory.sourceContext ?? '',
    ].filter(Boolean);
    if (historicalCues.length === 0 || activeCues.length === 0) return 0;

    const activeTokens = tokenizeCue(activeCues.join(' '));
    if (activeTokens.size === 0) return 0;

    let best = 0;
    for (const cue of historicalCues.slice(0, 8)) {
        best = Math.max(best, tokenOverlapRatio(activeTokens, tokenizeCue(cue)));
    }
    return Math.min(1, best);
}

function relationActivationMultiplier(type: MemoryRelationType | undefined, userMessage: string): number {
    switch (type) {
        case 'same_episode':
            return 1.18;
        case 'person_link':
        case 'same_entity':
            return 1.12;
        case 'goal_step':
            return isProspectiveRecallRequest(userMessage) ? 1.18 : 1.02;
        case 'temporal':
            return isHistoricalRecallRequest(userMessage) ? 1.08 : 0.94;
        case 'updates':
            return 0.96;
        case 'supports':
            return 1.02;
        case 'contextual':
            return 1.00;
        case 'contradicts':
            return isHistoricalRecallRequest(userMessage) ? 0.70 : 0.42;
        case 'semantic':
        default:
            return 0.92;
    }
}

function spreadingActivationScore(seedScore: number, relation: MemoryRelation, userMessage: string, depth: 1 | 2): number {
    const relationWeight = clamp01(relation.weight ?? 0.62);
    const typeMultiplier = relationActivationMultiplier(relation.type, userMessage);
    const depthMultiplier = depth === 1 ? 1 : 0.72;
    const weightedDiscount = GRAPH_EXPANSION_DISCOUNT * (0.72 + relationWeight * 0.48);
    return seedScore * weightedDiscount * typeMultiplier * depthMultiplier;
}

function relationPathLabel(relation: MemoryRelation, depth: 1 | 2): string {
    const type = relation.type ?? 'semantic';
    const weight = (relation.weight ?? 0.62).toFixed(2);
    const cue = relation.cue ? `; cue=${relation.cue}` : '';
    return `${depth}-hop ${type}; weight=${weight}${cue}`;
}

function observedAgeDays(memory: SearchResultLike): number | undefined {
    return ageDays(memory.validTo ?? memory.validFrom ?? memory.timestamp);
}

function isPossiblyStaleCurrentState(memory: SearchResultLike): boolean {
    const tags = memory.tags ?? [];
    if (tags.includes('possibly-stale')) return true;
    if (!tags.includes('temporal_scope:current_state')) return false;
    const observedAge = observedAgeDays(memory);
    return observedAge !== undefined && observedAge > 120 && memory.status !== 'done';
}

function inferenceLevelFromTags(memory: SearchResultLike): 'direct' | 'reported' | 'inferred' | 'ambiguous' | undefined {
    const tag = (memory.tags ?? []).find((value) => String(value).startsWith('inference:'));
    const level = String(tag ?? '').replace('inference:', '');
    return ['direct', 'reported', 'inferred', 'ambiguous'].includes(level)
        ? level as 'direct' | 'reported' | 'inferred' | 'ambiguous'
        : undefined;
}

function hasEvidenceRisk(memory: Pick<SearchResultLike, 'tags'>): boolean {
    return (memory.tags ?? []).some((tag) =>
        String(tag) === 'weak-evidence' ||
        String(tag) === 'needs-caution' ||
        String(tag) === 'importance-capped' ||
        String(tag) === 'anchor-capped' ||
        String(tag).startsWith('quality:')
    );
}

function evidenceRiskMultiplier(memory: Pick<SearchResultLike, 'tags'>): number {
    const tags = memory.tags ?? [];
    let multiplier = 1;
    if (tags.includes('weak-evidence') || tags.some(tag => String(tag).startsWith('quality:'))) multiplier *= 0.88;
    if (tags.includes('needs-caution')) multiplier *= 0.90;
    if (tags.includes('importance-capped') || tags.includes('anchor-capped')) multiplier *= 0.82;
    return multiplier;
}

function humanRecallMultiplier(memory: SearchResultLike, userMessage: string, activeCues: string[] = []): number {
    let multiplier = 1;
    const strength = boundedMetric(memory.strength);
    const vividness = boundedMetric(memory.vividness);
    const specificity = boundedMetric(memory.specificity);

    if (strength !== undefined) multiplier *= 1 + strength * 0.08;
    if (vividness !== undefined) multiplier *= 1 + vividness * 0.06;
    if (specificity !== undefined) multiplier *= 1 + specificity * 0.05;

    const kind = memory.memoryKind ?? '';
    if (kind === 'relationship' || kind === 'preference' || kind === 'boundary') {
        multiplier *= 1.04;
    }
    if (kind === 'open_loop' || kind === 'goal' || kind === 'prospective' || kind === 'promise') {
        multiplier *= isProspectiveRecallRequest(userMessage) ? 1.10 : 1.04;
    }

    const status = memory.status ?? '';
    if ((status === 'superseded' || status === 'expired') && !isHistoricalRecallRequest(userMessage)) {
        multiplier *= 0.55;
    } else if (status === 'done' && isProspectiveRecallRequest(userMessage)) {
        multiplier *= 0.82;
    } else if (status === 'planned' && isProspectiveRecallRequest(userMessage)) {
        multiplier *= 1.08;
    }

    if (isPossiblyStaleCurrentState(memory) && !isHistoricalRecallRequest(userMessage)) {
        multiplier *= /актуальн|сейчас|теперь|ещ[её]|до сих пор/i.test(userMessage) ? 0.72 : 0.86;
    }
    if (memory.validTo && new Date(memory.validTo).getTime() < Date.now() && !isHistoricalRecallRequest(userMessage)) {
        multiplier *= 0.70;
    }

    const inferenceLevel = inferenceLevelFromTags(memory);
    if (inferenceLevel === 'reported') {
        multiplier *= 0.96;
    } else if (inferenceLevel === 'inferred') {
        multiplier *= 0.88;
    } else if (inferenceLevel === 'ambiguous') {
        multiplier *= 0.70;
    }

    multiplier *= evidenceRiskMultiplier(memory);

    const savedAge = ageDays(memory.timestamp);
    if (savedAge !== undefined) {
        if (savedAge <= 2) multiplier *= 1.05;
        else if (savedAge <= 14) multiplier *= 1.02;
        else if (savedAge > 180 && !memory.isAnchor) multiplier *= 0.94;
    }

    const retrievedAge = ageDays(memory.lastRetrievedAt);
    if (retrievedAge !== undefined && retrievedAge <= 3) {
        multiplier *= 1.03;
    }

    const resonance = cueResonanceScore(memory, activeCues);
    if (resonance > 0) {
        multiplier *= 1 + resonance * 0.12;
    }

    return multiplier;
}

function schemaRecallScore(memory: SearchResultLike, userMessage: string, activeCues: string[]): number {
    const activeTokens = tokenizeCue([userMessage, ...activeCues].join(' '));
    const schemaTokens = tokenizeCue([
        memory.content,
        ...(memory.tags ?? []).filter((tag) => String(tag).startsWith('schema_')),
        memory.sourceContext ?? '',
    ].join(' '));
    const overlap = tokenOverlapRatio(activeTokens, schemaTokens);
    const importance = memory.importance ?? 0.78;
    const confidence = memory.confidence ?? 0.72;
    const strength = boundedMetric(memory.strength) ?? 0.68;
    const inventoryBoost = isMemoryInventoryRequest(userMessage) ? 0.08 : 0;
    const boundaryBoost = memory.memoryKind === 'boundary' ? 0.06 : 0;
    return clamp01(
        SCHEMA_DIRECT_SCORE +
        overlap * 0.14 +
        (importance - 0.78) * 0.08 +
        (confidence - 0.72) * 0.08 +
        strength * 0.04 +
        inventoryBoost +
        boundaryBoost
    );
}

function uncertaintyRecallScore(memory: SearchResultLike, userMessage: string, activeCues: string[]): number {
    const activeTokens = tokenizeCue([userMessage, ...activeCues].join(' '));
    const uncertaintyTokens = tokenizeCue([
        memory.content,
        memory.sourceContext ?? '',
    ].join(' '));
    const overlap = tokenOverlapRatio(activeTokens, uncertaintyTokens);
    const uncertaintyIntentBoost = /актуальн|точно|помнишь|забыл|не уверен|уточн|что изменил|план|дедлайн|жд[уеё]/i.test(userMessage)
        ? 0.08
        : 0;
    return clamp01(UNCERTAINTY_DIRECT_SCORE + overlap * 0.16 + uncertaintyIntentBoost);
}

function recallManifestationMarker(r: SearchResultLike): string {
    const finalScore = (r as SearchResultLike & { _finalScore?: number })._finalScore ?? r.score;
    const conf = r.confidence ?? 0.6;
    const strength = boundedMetric(r.strength) ?? 0.45;
    const vividness = boundedMetric(r.vividness) ?? 0.35;
    const specificity = boundedMetric(r.specificity) ?? 0.4;
    const kind = r.memoryKind ?? 'fact';

    if (r.status === 'superseded' || r.status === 'expired') return '[историческое/устаревшее воспоминание] ';
    if (isEpisodeMemoryLike(r)) return '[яркий эпизод] ';
    if (isChapterMemoryLike(r)) return '[сводный автобиографический слой] ';
    if (isSchemaMemoryLike(r)) return '[устойчивая модель пользователя] ';
    if (isUncertaintyIndexLike(r)) return '[метапамять: стоит уточнить] ';
    if (isPossiblyStaleCurrentState(r)) return '[возможно устаревшее состояние] ';
    if (kind === 'open_loop' || kind === 'goal' || kind === 'prospective' || kind === 'promise') {
        return '[незакрытая линия памяти] ';
    }
    if (kind === 'routine') return '[фоновая привычка] ';
    if (kind === 'preference') return '[фоновое предпочтение] ';
    if (kind === 'boundary') return '[граница/важное правило] ';
    if (kind === 'relationship' || kind === 'portrait') return '[устойчивая модель человека] ';
    if (r.isAnchor || (conf >= 0.82 && strength >= 0.68)) return '[устойчивое воспоминание] ';
    if (vividness >= 0.72 || kind === 'event') return '[яркое воспоминание] ';
    if (finalScore < 0.5 || conf < 0.5 || (strength < 0.42 && specificity < 0.45)) return '[смутная ассоциация] ';
    return '[рабочее воспоминание] ';
}

function memoryLayerFor(r: SearchResultLike): MemoryLayer {
    const kind = r.memoryKind ?? 'fact';
    const strength = boundedMetric(r.strength) ?? 0.45;
    const specificity = boundedMetric(r.specificity) ?? 0.4;
    const finalScore = (r as SearchResultLike & { _finalScore?: number })._finalScore ?? r.score;

    if (r.status === 'superseded' || r.status === 'expired') return 'historical';
    if (isSchemaMemoryLike(r)) return 'background';
    if (isUncertaintyIndexLike(r)) return 'associative';
    if (kind === 'open_loop' || kind === 'goal' || kind === 'prospective' || kind === 'promise' || r.status === 'planned') {
        return 'openLoops';
    }
    if (hasEvidenceRisk(r) && finalScore < 0.66 && !r.isAnchor) return 'associative';
    if (kind === 'preference' || kind === 'routine' || kind === 'boundary' || kind === 'trait' || kind === 'relationship' || kind === 'portrait') {
        return 'background';
    }
    if (isEpisodeMemoryLike(r) || isChapterMemoryLike(r) || kind === 'event') return 'episodic';
    if ((r.recallSources ?? []).some(source => source === 'associative' || source === 'graph') || (r.cueResonance ?? 0) >= 0.3) {
        return finalScore >= 0.62 || strength >= 0.65 || specificity >= 0.65 ? 'core' : 'associative';
    }
    return finalScore < 0.5 ? 'associative' : 'core';
}

function memoryLayerTitle(layer: MemoryLayer): string {
    switch (layer) {
        case 'core':
            return 'Явная память / ядро ответа';
        case 'openLoops':
            return 'Незакрытые линии, планы и обещания';
        case 'background':
            return 'Фоновая память: предпочтения, привычки, границы, люди';
        case 'episodic':
            return 'Эпизодическая и автобиографическая память';
        case 'associative':
            return 'Смутные ассоциации и дальние связи';
        case 'historical':
            return 'Исторический слой и устаревшие версии';
    }
}

function isProtectedMemory(r: SearchResultLike): boolean {
    const kind = r.memoryKind ?? 'fact';
    if (hasEvidenceRisk(r)) return false;
    return Boolean(r.isAnchor) ||
        isSchemaMemoryLike(r) ||
        kind === 'boundary' ||
        kind === 'open_loop' ||
        kind === 'goal' ||
        kind === 'promise' ||
        kind === 'prospective' ||
        (r.confidence ?? 0.6) >= 0.85;
}

function selectLayeredMemories(candidates: RankedMemory[], maxReturn: number, inventoryRequest: boolean): RankedMemory[] {
    if (inventoryRequest || candidates.length <= maxReturn) return candidates.slice(0, maxReturn);

    const sorted = [...candidates].sort((a, b) => b._finalScore - a._finalScore);
    const layerCaps: Record<MemoryLayer, number> = {
        core: Math.max(4, Math.ceil(maxReturn * 0.42)),
        openLoops: Math.max(3, Math.ceil(maxReturn * 0.18)),
        background: Math.max(4, Math.ceil(maxReturn * 0.22)),
        episodic: Math.max(3, Math.ceil(maxReturn * 0.18)),
        associative: Math.max(2, Math.ceil(maxReturn * 0.14)),
        historical: Math.max(1, Math.ceil(maxReturn * 0.08)),
    };
    const layerOrder: MemoryLayer[] = ['core', 'openLoops', 'background', 'episodic', 'associative', 'historical'];
    const selected: RankedMemory[] = [];
    const selectedIds = new Set<string>();
    const layerCounts = new Map<MemoryLayer, number>();
    const kindCounts = new Map<string, number>();
    const episodeCounts = new Map<string, number>();

    const canSelect = (candidate: RankedMemory, strict: boolean): boolean => {
        if (selectedIds.has(candidate.id)) return false;
        if (!strict || isProtectedMemory(candidate)) return true;

        const layer = memoryLayerFor(candidate);
        if ((layerCounts.get(layer) ?? 0) >= layerCaps[layer]) return false;

        const kind = candidate.memoryKind ?? 'fact';
        if ((kindCounts.get(kind) ?? 0) >= Math.max(4, Math.ceil(maxReturn * 0.32))) return false;

        const episodeId = candidate.sourceEpisodeId;
        if (episodeId && (episodeCounts.get(episodeId) ?? 0) >= 3) return false;

        return true;
    };

    const add = (candidate: RankedMemory) => {
        selected.push(candidate);
        selectedIds.add(candidate.id);
        const layer = memoryLayerFor(candidate);
        layerCounts.set(layer, (layerCounts.get(layer) ?? 0) + 1);
        const kind = candidate.memoryKind ?? 'fact';
        kindCounts.set(kind, (kindCounts.get(kind) ?? 0) + 1);
        if (candidate.sourceEpisodeId) {
            episodeCounts.set(candidate.sourceEpisodeId, (episodeCounts.get(candidate.sourceEpisodeId) ?? 0) + 1);
        }
    };

    // One representative from each layer prevents a single memory type from crowding out the rest.
    for (const layer of layerOrder) {
        if (selected.length >= maxReturn) break;
        const candidate = sorted.find(memory => memoryLayerFor(memory) === layer && canSelect(memory, true));
        if (candidate) add(candidate);
    }

    for (const candidate of sorted) {
        if (selected.length >= maxReturn) break;
        if (canSelect(candidate, true)) add(candidate);
    }

    for (const candidate of sorted) {
        if (selected.length >= maxReturn) break;
        if (canSelect(candidate, false)) add(candidate);
    }

    return selected.sort((a, b) => b._finalScore - a._finalScore);
}

function retrievalImportanceBoost(memory: SearchResultLike & { _finalScore?: number }): number {
    if (memory.status === 'superseded' || memory.status === 'expired') return 0;
    const inferenceLevel = inferenceLevelFromTags(memory);
    if (hasEvidenceRisk(memory) || inferenceLevel === 'inferred' || inferenceLevel === 'ambiguous') return 0;

    const finalScore = memory._finalScore ?? memory.score;
    const confidence = memory.confidence ?? 0.6;
    const kind = memory.memoryKind ?? 'fact';

    let boost = 0.012;
    if (finalScore >= 0.72) boost += 0.008;
    if (confidence >= 0.78) boost += 0.006;
    if (memory.cueResonance && memory.cueResonance >= 0.35) boost += 0.004;
    if (kind === 'open_loop' || kind === 'goal' || kind === 'prospective' || kind === 'promise') boost += 0.006;
    if (kind === 'boundary' || kind === 'relationship') boost += 0.004;
    if (memory.isAnchor) boost *= 0.65;
    if (finalScore < 0.5 || confidence < 0.5) boost *= 0.35;

    return Math.min(0.035, Math.max(0.003, boost));
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
        const resp = await createChatCompletionForTask('memoryExtraction', {
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
    validFrom?: Date;
    validTo?: Date;
    confirmationCount?: number;
    retrievalCount?: number;
    lastRetrievedAt?: Date;
    retrievalCues?: string[];
    memoryKind?: string;
    strength?: number;
    vividness?: number;
    specificity?: number;
    recallSources?: RecallSource[];
    recallPath?: string;
    relationType?: MemoryRelationType;
    relationWeight?: number;
    cueResonance?: number;
}

type RecallSource =
    | 'direct'
    | 'context'
    | 'associative'
    | 'anchor'
    | 'schema'
    | 'metamemory'
    | 'inventory'
    | 'tag'
    | 'graph'
    | 'episode'
    | 'chapter';

type RankedMemory = SearchResultLike & { _finalScore: number };
type MemoryLayer = 'core' | 'openLoops' | 'background' | 'episodic' | 'associative' | 'historical';

export interface RecalledMemoryRef {
    id: string;
    domain: string;
    content: string;
    score: number;
    memoryKind?: string;
    confidence?: number;
    status?: string;
    sourceEpisodeId?: string;
    sourceMemoryIds?: string[];
}

export interface MultiQueryMemoryContextResult {
    context: string;
    recalledMemories: RecalledMemoryRef[];
}

function addCandidate(
    seen: Map<string, SearchResultLike>,
    candidate: SearchResultLike,
    scoreOverride?: number
): void {
    const recallSources: RecallSource[] = [...new Set<RecallSource>(candidate.recallSources ?? ['direct'])];
    const normalized: SearchResultLike = {
        ...candidate,
        score: scoreOverride ?? candidate.score,
        importance: candidate.importance ?? 0.5,
        confidence: candidate.confidence ?? 0.6,
        domain: candidate.domain,
        tags: candidate.tags,
        recallSources,
    };

    const existing = seen.get(candidate.id);
    if (!existing || normalized.score > existing.score) {
        seen.set(candidate.id, {
            ...normalized,
            recallSources: [...new Set<RecallSource>([...(existing?.recallSources ?? []), ...recallSources])],
            cueResonance: Math.max(existing?.cueResonance ?? 0, normalized.cueResonance ?? 0),
            recallPath: normalized.recallPath ?? existing?.recallPath,
            relationType: normalized.relationType ?? existing?.relationType,
            relationWeight: normalized.relationWeight ?? existing?.relationWeight,
        });
    } else {
        seen.set(candidate.id, {
            ...existing,
            recallSources: [...new Set<RecallSource>([...(existing.recallSources ?? []), ...recallSources])],
            cueResonance: Math.max(existing.cueResonance ?? 0, normalized.cueResonance ?? 0),
            recallPath: existing.recallPath ?? normalized.recallPath,
            relationType: existing.relationType ?? normalized.relationType,
            relationWeight: existing.relationWeight ?? normalized.relationWeight,
        });
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
                        recallSources: ['episode'],
                        recallPath: `sourceEpisodeId=${episodeId}`,
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

    const sourceBackedSeeds = seedCandidates
        .filter((candidate) =>
            (isChapterMemoryLike(candidate) || isSchemaMemoryLike(candidate) || isUncertaintyIndexLike(candidate)) &&
            (candidate.sourceMemoryIds?.length ?? 0) > 0
        )
        .sort((a, b) => b.score - a.score)
        .slice(0, CHAPTER_SOURCE_TOP_N);

    let added = 0;
    await Promise.all(
        sourceBackedSeeds.map(async (chapter) => {
            try {
                const ids = chapter.sourceMemoryIds ?? [];
                const sources = await svc.fetchMemoriesByIds(userId, ids, CHAPTER_SOURCE_MAX_PER_CHAPTER);
                const sourceDiscount = isUncertaintyIndexLike(chapter)
                    ? CHAPTER_SOURCE_DISCOUNT * 0.82
                    : isSchemaMemoryLike(chapter)
                        ? CHAPTER_SOURCE_DISCOUNT * 0.90
                        : CHAPTER_SOURCE_DISCOUNT;
                const sourceScore = Math.max(0.50, chapter.score * sourceDiscount);
                for (const source of sources) {
                    if (source.id === chapter.id || seen.has(source.id)) continue;
                    addScopedCandidate({
                        ...source,
                        recallSources: ['chapter'],
                        recallPath: `sourceMemory=${chapter.id}`,
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

    if (added > 0) devLog('Source-backed memory expansion added memories:', added);
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
    const validFrom = r.validFrom ? new Date(r.validFrom).toISOString().slice(0, 10) : '';
    const validTo = r.validTo ? new Date(r.validTo).toISOString().slice(0, 10) : '';
    const temporal = validFrom || validTo
        ? ` [временная привязка: ${validFrom || '?'}${validTo ? `—${validTo}` : ''}]`
        : '';
    const confirmations = (r.confirmationCount ?? 0) > 1 ? ` [подтверждений: ${r.confirmationCount}]` : '';
    const retrievals = (r.retrievalCount ?? 0) >= 3 ? ` [часто всплывает: ${r.retrievalCount}]` : '';
    const kind = r.memoryKind && r.memoryKind !== 'fact' ? ` [тип: ${r.memoryKind}]` : '';
    const strength = boundedMetric(r.strength);
    const vividness = boundedMetric(r.vividness);
    const specificity = boundedMetric(r.specificity);
    const metaSignal = strength !== undefined || vividness !== undefined || specificity !== undefined
        ? ` [мета: сила ${(strength ?? 0).toFixed(2)}, яркость ${(vividness ?? 0).toFixed(2)}, конкретность ${(specificity ?? 0).toFixed(2)}]`
        : '';
    const resonance = (r.cueResonance ?? 0) >= 0.28 ? ` [резонанс подсказки: ${r.cueResonance!.toFixed(2)}]` : '';
    const recallPath = r.recallPath ? ` [путь вспоминания: ${r.recallPath}]` : '';
    const sources = r.recallSources?.length ? ` [источник вспоминания: ${r.recallSources.join('+')}]` : '';
    const quality = hasEvidenceRisk(r)
        ? ' [качество: слабая опора]'
        : '';
    const inferenceLevel = inferenceLevelFromTags(r);
    const inference =
        inferenceLevel === 'reported' ? ' [происхождение: пересказ]' :
            inferenceLevel === 'inferred' ? ' [происхождение: вывод]' :
                inferenceLevel === 'ambiguous' ? ' [происхождение: неоднозначно]' :
                    '';
    const source = r.sourceContext && r.sourceContext.trim() && r.sourceContext.trim() !== r.content.trim()
        ? ` (источник: ${r.sourceContext.trim().slice(0, 140)})`
        : '';
    const manifestation = recallManifestationMarker(r);

    return `${confidenceMarker}${manifestation}${r.content}${kind}${status}${temporal}${confirmations}${retrievals}${quality}${inference}${metaSignal}${resonance}${recallPath}${sources}${history}${source}`;
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
        const resp = await createChatCompletionForTask('memoryExtraction', {
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
            max_completion_tokens: 100,
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

interface LayeredMemoryContext {
    context: string;
    includedMemories: RankedMemory[];
    layerCounts: Record<MemoryLayer, number>;
}

function formatLayeredMemoryContext(memories: RankedMemory[], budget: number): LayeredMemoryContext {
    const layerOrder: MemoryLayer[] = ['core', 'openLoops', 'background', 'episodic', 'associative', 'historical'];
    const items = memories.map(memory => ({
        memory,
        layer: memoryLayerFor(memory),
        text: formatFactWithHistory(memory),
    }));

    const included: typeof items = [];
    const includedIds = new Set<string>();
    let used = 0;

    const add = (item: typeof items[number]): boolean => {
        if (includedIds.has(item.memory.id)) return false;
        const tokens = estimateTokens(item.text);
        if (included.length > 0 && used + tokens > budget) return false;
        included.push(item);
        includedIds.add(item.memory.id);
        used += tokens;
        return true;
    };

    // Keep at least one affordable representative per layer before filling by rank.
    for (const layer of layerOrder) {
        const item = items.find(candidate => candidate.layer === layer && !includedIds.has(candidate.memory.id));
        if (item) add(item);
    }

    for (const item of items) {
        add(item);
    }

    const layerCounts = Object.fromEntries(layerOrder.map(layer => [layer, 0])) as Record<MemoryLayer, number>;
    for (const item of included) {
        layerCounts[item.layer] += 1;
    }

    const sections = layerOrder
        .map(layer => {
            const layerItems = included.filter(item => item.layer === layer);
            if (layerItems.length === 0) return '';
            return `\n${memoryLayerTitle(layer)}:\n` +
                layerItems.map((item, index) => `${index + 1}. ${item.text}`).join('\n');
        })
        .filter(Boolean);

    return {
        context: sections.join('\n'),
        includedMemories: included.map(item => item.memory),
        layerCounts,
    };
}

/**
 * Трёхуровневый поиск по долговременной памяти:
 * 1. Классификация потребности в памяти (none / light / full)
 * 2. Answer-запросы — ищут факты, прямо отвечающие на вопрос (больше результатов, выше вес)
 * 3. Context-запросы — ищут фоновый контекст (меньше результатов, score дисконтируется)
 * 4. Ассоциативный прайминг от рабочей памяти разговора
 * 5. 1-hop graph expansion для топовых результатов (только в full-режиме)
 * 6. LLM reranker — фильтрация нерелевантных фактов
 * 7. Token budget — обрезка до 1500 токенов
 */
/** Количество предыдущих сообщений для резолвинга местоимений */
const HISTORY_CONTEXT_MESSAGES = 3;

export async function getMultiQueryMemoryContextDetailed(ctx: BotContext, userMessage: string, memoryNeed?: MemoryNeed): Promise<MultiQueryMemoryContextResult> {
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
            return { context: '', recalledMemories: [] };
        }
        // Есть недавние факты — возвращаем только их, без vector search
        devLog('Memory need: none, but injecting recent facts:', recentSessionFacts.length);
        return { context: '[Только что запомнила]:\n' + recentSessionFacts.join('\n'), recalledMemories: [] };
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
    const contextDependent = hasContextDependentReference(userMessage);
    const associativeQueries = inventoryRequest || (need === 'light' && !contextDependent)
        ? []
        : buildAssociativePrimingQueries(ctx, userMessage);
    const contactScope = resolveContactRetrievalScope(userMessage);
    const activeRecallCues = [
        userMessage,
        ...answerQueries,
        ...contextQueries,
        ...associativeQueries,
    ].filter(Boolean);

    const seen = new Map<string, SearchResultLike>();
    const addScopedCandidate = (candidate: SearchResultLike, scoreOverride?: number) => {
        if (!isCandidateAllowedByContactScope(candidate, contactScope)) return;
        addCandidate(seen, {
            ...candidate,
            cueResonance: Math.max(candidate.cueResonance ?? 0, cueResonanceScore(candidate, activeRecallCues)),
        }, scoreOverride);
    };
    /** Set of anchor IDs for score boosting (instead of unconditional inclusion) */
    const anchorIds = new Set<string>();
    try {
        const anchorResults = await getAnchorMemories(ctx, 10);
        for (const r of anchorResults) {
            anchorIds.add(r.id);
            if (need === 'full' || inventoryRequest) {
                addScopedCandidate({ ...r, isAnchor: true, recallSources: ['anchor'] }, ANCHOR_DIRECT_SCORE);
            }
        }
    } catch { /* ignore */ }

    // Устойчивые модели пользователя: не отвечают на вопрос напрямую, но задают
    // человеческий фон — предпочтения, границы, стиль решений и повторяющиеся паттерны.
    if ((need === 'full' || inventoryRequest) && ctx.from?.id) {
        const svcForSchemas = getVectorService();
        if (svcForSchemas) {
            const schemaResults = await svcForSchemas.getMemoriesByTag(String(ctx.from.id), MEMORY_SCHEMA_TAG).catch(() => []);
            const rankedSchemas = schemaResults
                .filter((schema) => schema.status !== 'expired' && schema.status !== 'superseded')
                .map((schema) => ({
                    ...schema,
                    score: schemaRecallScore(schema, userMessage, activeRecallCues),
                }))
                .sort((a, b) => b.score - a.score)
                .slice(0, MAX_SCHEMA_MEMORIES);
            for (const schema of rankedSchemas) {
                addScopedCandidate({ ...schema, recallSources: ['schema'] }, schema.score);
            }
        }
    }

    // Метапамять о сомнительных/устаревающих сведениях: используется для хеджирования
    // и мягких уточнений, но не как самостоятельный факт о пользователе.
    if ((need === 'full' || inventoryRequest) && ctx.from?.id) {
        const svcForMeta = getVectorService();
        if (svcForMeta) {
            const uncertaintyResults = await svcForMeta.getMemoriesByTag(String(ctx.from.id), MEMORY_UNCERTAINTY_TAG).catch(() => []);
            const index = uncertaintyResults
                .filter((memory) => memory.status !== 'expired' && memory.status !== 'superseded')
                .map((memory) => ({
                    ...memory,
                    score: uncertaintyRecallScore(memory, userMessage, activeRecallCues),
                }))
                .sort((a, b) => b.score - a.score)[0];
            if (index) {
                addScopedCandidate({ ...index, recallSources: ['metamemory'] }, index.score);
            }
        }
    }

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
                    addScopedCandidate({ ...result, recallSources: ['tag'] }, Math.max(result.score ?? 0, ANCHOR_DIRECT_SCORE));
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
                    validFrom: memory.validFrom,
                    validTo: memory.validTo,
                    confirmationCount: memory.confirmationCount,
                    retrievalCount: memory.retrievalCount,
                    lastRetrievedAt: memory.lastRetrievedAt,
                    retrievalCues: memory.retrievalCues,
                    memoryKind: memory.memoryKind,
                    strength: memory.strength,
                    vividness: memory.vividness,
                    specificity: memory.specificity,
                    recallSources: ['inventory'],
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
                addScopedCandidate({ ...r, recallSources: ['direct'] });
            }
        })
    );

    // Context-запросы: фоновый контекст, score дисконтируется
    await Promise.all(
        contextQueries.map(async (query) => {
            const results = await searchAllDomainsMemories(ctx, query, CONTEXT_RESULTS_PER_QUERY);
            for (const r of results) {
                addScopedCandidate({ ...r, recallSources: ['context'] }, r.score * CONTEXT_QUERY_SCORE_DISCOUNT);
            }
        })
    );

    // Ассоциативные запросы: активные люди, темы и open loops из рабочей памяти.
    // Они слабее прямого запроса, но помогают с фразами вроде "а ей что подарить?".
    await Promise.all(
        associativeQueries.map(async (query) => {
            const results = await searchAllDomainsMemories(ctx, query, ASSOCIATIVE_RESULTS_PER_QUERY);
            const discount = contextDependent
                ? ASSOCIATIVE_CONTEXTUAL_SCORE_DISCOUNT
                : ASSOCIATIVE_QUERY_SCORE_DISCOUNT;
            for (const r of results) {
                addScopedCandidate({ ...r, recallSources: ['associative'] }, r.score * discount);
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
                            related.map(async (relation) => {
                                const { id, domain } = relation;
                                if (seen.has(id)) return;
                                const fetched = await svcForGraph.fetchMemoryById(id, domain);
                                if (fetched) {
                                    const activatedScore = spreadingActivationScore(fact.score, relation, userMessage, 1);
                                    addScopedCandidate({
                                        ...fetched,
                                        score: activatedScore,
                                        importance: fetched.importance ?? 0.5,
                                        confidence: fetched.confidence ?? 0.6,
                                        domain: fetched.domain,
                                        recallSources: ['graph'],
                                        relationType: relation.type,
                                        relationWeight: relation.weight,
                                        recallPath: relationPathLabel(relation, 1),
                                    }, activatedScore);
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
                    for (const relation of related) {
                        const { id, domain } = relation;
                        if (hopTwoCount >= GRAPH_EXPANSION_HOP2_MAX || seen.has(id)) continue;
                        const fetched = await svcForGraph.fetchMemoryById(id, domain);
                        if (fetched) {
                            const activatedScore = spreadingActivationScore(fact.score, relation, userMessage, 2);
                            addScopedCandidate({
                                ...fetched,
                                score: activatedScore,
                                importance: fetched.importance ?? 0.5,
                                confidence: fetched.confidence ?? 0.6,
                                domain: fetched.domain,
                                recallSources: ['graph'],
                                relationType: relation.type,
                                relationWeight: relation.weight,
                                recallPath: relationPathLabel(relation, 2),
                            }, activatedScore);
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

    // Schema-to-evidence expansion: если нашлась сводная глава, модель пользователя
    // или индекс метапамяти, подтягиваем несколько исходных воспоминаний,
    // чтобы ответ был конкретным и проверяемым.
    if (need === 'full' && ctx.from?.id) {
        const chapterSeeds = Array.from(seen.values())
            .filter((fact) =>
                (isChapterMemoryLike(fact) || isSchemaMemoryLike(fact) || isUncertaintyIndexLike(fact)) &&
                (fact.sourceMemoryIds?.length ?? 0) > 0
            )
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
            return { ...r, _finalScore: baseScore * anchorMul * familiarityMul * humanRecallMultiplier(r, userMessage, activeRecallCues) };
        })
        .filter((r) => r._finalScore >= MIN_FINAL_SCORE_THRESHOLD)
        .sort((a, b) => b._finalScore - a._finalScore);

    // LLM reranker: убирает нерелевантные факты, переупорядочивает по смыслу
    const preRerank = sorted.slice(0, maxFacts + 10); // даём reranker'у чуть больше кандидатов
    const rerankedRaw = need === 'full' && !inventoryRequest
        ? await rerankFacts(userMessage, preRerank, maxFacts)
        : preRerank.slice(0, maxFacts); // для light — не тратим LLM-вызов
    const reranked = selectLayeredMemories(rerankedRaw, maxFacts, inventoryRequest);

    // Token budget + layered presentation: память подаётся не плоским списком, а слоями.
    const layeredMemory = formatLayeredMemoryContext(reranked, tokenBudget);

    // Буст важности + сброс кривой забывания для фактов, которые оказались релевантны (fire & forget)
    const svc = getVectorService();
    if (svc) {
        for (const fact of layeredMemory.includedMemories) {
            const boosted = Math.min(1.0, (fact.importance ?? 0.5) + retrievalImportanceBoost(fact));
            if (boosted > (fact.importance ?? 0.5)) {
                svc.updateImportance(fact.id, boosted).catch(() => { });
            }
            if (fact.domain) {
                svc.updateMemoryAccess(fact.id, fact.domain, undefined, userMessage).catch(() => { });
            }
        }
    }

    const factsBlock = layeredMemory.context;

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
        return !layeredMemory.includedMemories.some(memory => {
            const contentLower = memory.content.toLowerCase();
            return contentLower.includes(rfLower) || rfLower.includes(contentLower);
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
        '  [качество: слабая опора] — факт прошёл фильтр, но опора в переписке слабая или важность была снижена; не делай из него сильных выводов\n' +
        '  [происхождение: пересказ] — факт сообщил не сам субъект; говори осторожнее\n' +
        '  [происхождение: вывод] — это аккуратный вывод, не прямое свидетельство; не представляй как точный факт\n' +
        '  [происхождение: неоднозначно] — атрибуция или смысл сомнительны; лучше уточнить, чем утверждать\n' +
        '  Без маркера — факт надёжен, говори уверенно\n' +
        'Маркеры проявления памяти:\n' +
        '  [устойчивое воспоминание] — можно опираться уверенно\n' +
        '  [рабочее воспоминание] — обычный релевантный факт\n' +
        '  [смутная ассоциация] — используй осторожно, как возможную связь\n' +
        '  [яркий эпизод] / [яркое воспоминание] — конкретная сцена или событие, не обобщай без основания\n' +
        '  [устойчивая модель пользователя] — повторяющийся паттерн, стиль, граница или предпочтение; учитывай как фон и не цитируй напрямую без необходимости\n' +
        '  [метапамять: стоит уточнить] — это не факт, а сигнал сомнения: говори осторожнее и уточняй актуальность только если это естественно в текущем ответе\n' +
        '  [возможно устаревшее состояние] — это было текущим состоянием в прошлом; не называй актуальным без проверки\n' +
        '  [незакрытая линия памяти] — цель, обещание, ожидание или план; проверь актуальность в ответе\n' +
        '  [фоновое предпочтение] / [фоновая привычка] / [граница/важное правило] — учитывай в тоне и предложениях, даже если не называешь явно\n' +
        '  [историческое/устаревшее воспоминание] — упоминай только если пользователь спрашивает историю или изменения\n' +
        '  [временная привязка] — когда факт был наблюдён или действовал; не выдавай старое текущее состояние за актуальное без оговорки\n' +
        'Служебные поля [мета], [резонанс подсказки], [путь вспоминания] и [источник вспоминания] показывают, почему факт всплыл. Не цитируй их пользователю; используй только для уверенности, глубины и тона ответа.\n' +
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
        associativeQueries: associativeQueries.length,
        contextDependent,
        candidateFacts: sorted.length,
        afterRerank: rerankedRaw.length,
        afterLayerCompetition: reranked.length,
        afterTokenBudget: layeredMemory.includedMemories.length,
        layers: layeredMemory.layerCounts,
        recentFactsInjected: newRecentFacts.length,
    });
    const recalledMemories = layeredMemory.includedMemories
        .map((fact) => ({
            id: fact.id,
            domain: fact.domain || 'general',
            content: fact.content,
            score: fact._finalScore ?? fact.score,
            memoryKind: fact.memoryKind,
            confidence: fact.confidence,
            status: fact.status,
            sourceEpisodeId: fact.sourceEpisodeId,
            sourceMemoryIds: fact.sourceMemoryIds,
        }));
    return { context, recalledMemories };
}

export async function getMultiQueryMemoryContext(ctx: BotContext, userMessage: string, memoryNeed?: MemoryNeed): Promise<string> {
    return (await getMultiQueryMemoryContextDetailed(ctx, userMessage, memoryNeed)).context;
}
