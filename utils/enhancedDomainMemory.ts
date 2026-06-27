import { getVectorService } from '../services/VectorServiceFactory';
import { EmotionalTag, MemoryEntry, MemoryExtractionMethod, MemoryKind, MemoryRelationType, MemoryStatus, MemorySubject, SearchOptions, SearchResult } from '../types';
import { BotContext } from '../types';
import { devLog, parseLLMJson } from '../utils';
import { createChatCompletionForTask } from '../ai/chatCompletion';
import { llmCache, LLM_CACHE_TTL } from './llmCache';
import { detectEmotionalTag } from './emotionalTagger';
import { PREDEFINED_DOMAINS } from '../constants/domains';
import { getActiveMemoryBotId } from './botIdentity';

function vectorService() {
    return getVectorService();
}

const botId = getActiveMemoryBotId();

let lastSaveError: string | null = null;

export function getLastSaveError(): string | null {
    return lastSaveError;
}

export interface MemorySaveMetadata {
    sourceEpisodeId?: string;
    sourceContext?: string;
    sourceMessageIds?: string[];
    sourceMemoryIds?: string[];
    reminderId?: string;
    extractionMethod?: MemoryExtractionMethod;
    confidence?: number;
    subject?: MemorySubject;
    predicate?: string;
    object?: string;
    validFrom?: Date;
    validTo?: Date;
    status?: MemoryStatus;
    memoryKind?: MemoryKind;
    strength?: number;
    vividness?: number;
    specificity?: number;
}

export const REMINDER_SOURCE_TAG_PREFIX = 'source_reminder:';

export function buildReminderSourceTag(reminderId: string): string {
    return `${REMINDER_SOURCE_TAG_PREFIX}${reminderId}`;
}

// Нижний порог для поиска устаревших планировочных фактов при смене состояния
const PLANNING_SWEEP_THRESHOLD = 0.55;
const DEDUP_CROSS_DOMAIN_LIMIT = 20;
const CONTRADICTION_CROSS_DOMAIN_LIMIT = 20;
// Дефолтный порог противоречий (используется в invalidatePlanningFacts при кросс-доменном поиске)
const DEFAULT_CONTRADICTION_THRESHOLD = 0.72;

// Домено-специфичные пороги сходства.
// contacts/health/travel — осторожнее, мелкие детали важны ("живёт в Москве" vs "живёт в Питере")
// hobbies/entertainment — много похожих вариантов нормально сосуществуют
const DOMAIN_SIMILARITY_CONFIG: Record<string, { dedup: number; contradiction: number }> = {
    contacts:      { dedup: 0.88, contradiction: 0.68 },
    health:        { dedup: 0.90, contradiction: 0.70 },
    finance:       { dedup: 0.90, contradiction: 0.70 },
    work:          { dedup: 0.91, contradiction: 0.71 },
    travel:        { dedup: 0.90, contradiction: 0.70 },
    family:        { dedup: 0.91, contradiction: 0.71 },
    personal:      { dedup: 0.91, contradiction: 0.71 },
    home:          { dedup: 0.91, contradiction: 0.71 },
    education:     { dedup: 0.92, contradiction: 0.72 },
    social:        { dedup: 0.92, contradiction: 0.72 },
    hobbies:       { dedup: 0.93, contradiction: 0.74 },
    entertainment: { dedup: 0.93, contradiction: 0.74 },
    general:       { dedup: 0.91, contradiction: 0.71 },
};

function getDedupThreshold(domain: string): number {
    return DOMAIN_SIMILARITY_CONFIG[domain]?.dedup ?? 0.92;
}

function getContradictionThreshold(domain: string): number {
    return DOMAIN_SIMILARITY_CONFIG[domain]?.contradiction ?? DEFAULT_CONTRADICTION_THRESHOLD;
}

function normalizeMemoryDomain(domain: string | undefined): string {
    const normalized = String(domain || '').trim().toLowerCase();
    return Object.values(PREDEFINED_DOMAINS).includes(normalized as any)
        ? normalized
        : PREDEFINED_DOMAINS.GENERAL;
}

function inferMemoryStatus(content: string, expiresAt?: Date): MemoryStatus {
    const lc = content.toLowerCase();
    if (expiresAt && expiresAt.getTime() < Date.now()) return 'expired';
    if (/планир|собира[ею]тся|хоч[уе]т|намерен|предстоит|будет|должен|нужно\s+будет|запланирован/.test(lc)) {
        return 'planned';
    }
    if (/уже\s+(сделал|сделала|сделано|купил|купила|забронировал|забронировала|оплатил|оплатила|вернул[ас]ь|прилетел|прилетела)|готово|завершил|завершила/.test(lc)) {
        return 'done';
    }
    return 'active';
}

export function inferMemoryKind(content: string, tags: string[] = [], metadata: Partial<MemorySaveMetadata> = {}): MemoryKind {
    if (metadata.memoryKind) return metadata.memoryKind;
    if (tags.includes('memory-episode') || content.startsWith('[ЭПИЗОД ПАМЯТИ:')) return 'episode';
    if (tags.includes('memory-chapter') || content.startsWith('[ГЛАВА ПАМЯТИ:')) return 'chapter';
    if (tags.some(tag => String(tag).startsWith('portrait:')) || content.startsWith('[ПСИХОЛОГИЧЕСКИЙ ПОРТРЕТ:')) return 'portrait';

    const lc = content.toLowerCase();
    if (/обещал|обещала|пообещал|пообещала|договорил[аи]сь|договоренность|договорённость/.test(lc)) return 'promise';
    if (/не хочу чтобы|не надо|не нужно|не люблю когда|границ|нельзя|не спрашивай|не предлагай/.test(lc)) return 'boundary';
    if (/кажд(ый|ое|ую)|обычно|регулярно|по утрам|по вечерам|привычк|рутин/.test(lc)) return 'routine';
    if (/люблю|нравится|предпочита|не люблю|терпеть не могу|обожаю|ненавижу|мой любим/.test(lc)) return 'preference';
    if (/жена|муж|мама|папа|сын|дочь|брат|сестра|коллега|друг|подруга|партн[её]р|отношени/.test(lc)) return 'relationship';
    if (/жду|ожидаю|надо|нужно|осталось|дедлайн|срок|не забыть|предстоит|открыт(ый|ая|ое) вопрос/.test(lc)) return 'open_loop';
    if (/планир|собира[ею]тся|хоч[уе]т|цель|мечта|намерен|намерена|будет/.test(lc)) return 'goal';
    if (/сейчас|теперь|уже|переехал|переехала|работает|жив[её]т|болеет|принимает|находится/.test(lc)) return 'state';
    if (/\b\d{1,2}[./-]\d{1,2}|\b20\d{2}\b|сегодня|вчера|позавчера|вернулся|вернулась|сходил|сходила|купил|купила|получил|получила/.test(lc)) return 'event';
    if (/характер|ценит|важно|склонен|склонна|обычно реагирует|стиль общения/.test(lc)) return 'trait';
    return 'fact';
}

function clamp01(value: number): number {
    return Math.min(1, Math.max(0, value));
}

function estimateSpecificity(content: string, tags: string[] = []): number {
    let score = 0.25;
    if (/[А-ЯЁA-Z][А-ЯЁA-Zа-яёa-z-]+(?:\s+[А-ЯЁA-Z][А-ЯЁA-Zа-яёa-z-]+)?/.test(content)) score += 0.16;
    if (/\b\d{1,2}[./-]\d{1,2}(?:[./-]\d{2,4})?\b|\b20\d{2}\b|сегодня|вчера|завтра|понедельник|вторник|среду|четверг|пятниц|суббот|воскресен/i.test(content)) score += 0.18;
    if (/\b\d+\b|@\w+/.test(content)) score += 0.10;
    if (/(?:в|из|на|у)\s+[А-ЯЁA-Z][А-ЯЁA-Zа-яёa-z-]+/.test(content)) score += 0.10;
    if (content.length >= 70) score += 0.10;
    if (tags.length >= 2) score += 0.06;
    return clamp01(score);
}

export function estimateHumanMemoryMetrics(input: {
    content: string;
    importance: number;
    confidence?: number;
    tags?: string[];
    isAnchor?: boolean;
    emotionalTag?: EmotionalTag;
    memoryKind?: MemoryKind;
    status?: MemoryStatus;
    retrievalCount?: number;
}): { strength: number; vividness: number; specificity: number } {
    const tags = input.tags ?? [];
    const specificity = estimateSpecificity(input.content, tags);
    const emotionalArousal = input.emotionalTag?.arousal ?? 0;
    const flashbulbBoost = input.emotionalTag?.isFlashbulb ? 0.22 : 0;
    const kindBoost =
        input.memoryKind === 'episode' || input.memoryKind === 'event' ? 0.10 :
        input.memoryKind === 'portrait' || input.memoryKind === 'relationship' ? 0.08 :
        input.memoryKind === 'goal' || input.memoryKind === 'open_loop' || input.memoryKind === 'prospective' ? 0.06 :
        0;
    const retrievalBoost = Math.min(0.10, Math.log1p(Math.max(0, input.retrievalCount ?? 0)) * 0.025);
    const anchorBoost = input.isAnchor ? 0.12 : 0;
    const statusPenalty = input.status === 'expired' || input.status === 'superseded' ? 0.18 : 0;

    return {
        strength: clamp01((input.importance * 0.42) + ((input.confidence ?? 0.6) * 0.30) + specificity * 0.14 + anchorBoost + retrievalBoost - statusPenalty),
        vividness: clamp01(0.18 + emotionalArousal * 0.48 + specificity * 0.18 + flashbulbBoost + kindBoost),
        specificity,
    };
}

function mergeSourceMessageIds(existing: string[] | undefined, incoming: string[] | undefined): string[] | undefined {
    const merged = [...(existing ?? []), ...(incoming ?? [])]
        .map(String)
        .filter(Boolean);
    return merged.length > 0 ? [...new Set(merged)].slice(-20) : undefined;
}

function mergeSourceMemoryIds(existing: string[] | undefined, incoming: string[] | undefined): string[] | undefined {
    const merged = [...(existing ?? []), ...(incoming ?? [])]
        .map(String)
        .filter(Boolean);
    return merged.length > 0 ? [...new Set(merged)].slice(-80) : undefined;
}

function overlapCount(a: string[] | undefined, b: string[] | undefined): number {
    const left = new Set((a ?? []).map(String).filter(Boolean));
    if (left.size === 0) return 0;
    let count = 0;
    for (const value of b ?? []) {
        if (left.has(String(value))) count++;
    }
    return count;
}

function isIndependentConfirmation(existing: Pick<MemoryEntry, 'sourceEpisodeId' | 'sourceMessageIds' | 'sourceMemoryIds'>, incoming: Partial<MemorySaveMetadata>): boolean {
    if (existing.sourceEpisodeId && incoming.sourceEpisodeId && existing.sourceEpisodeId === incoming.sourceEpisodeId) {
        return false;
    }
    if (overlapCount(existing.sourceMessageIds, incoming.sourceMessageIds) > 0) return false;
    if (overlapCount(existing.sourceMemoryIds, incoming.sourceMemoryIds) > 0) return false;
    return Boolean(
        incoming.sourceEpisodeId ||
        (incoming.sourceMessageIds?.length ?? 0) > 0 ||
        (incoming.sourceMemoryIds?.length ?? 0) > 0
    );
}

function hasWeakEvidenceShape(tags: string[]): boolean {
    return tags.includes('weak-evidence') ||
        tags.includes('needs-caution') ||
        tags.includes('inference:ambiguous') ||
        tags.includes('inference:inferred') ||
        tags.some(tag => String(tag).startsWith('quality:'));
}

function calibratedImportanceForEvidence(importance: number, tags: string[], confidence: number): number {
    const bounded = clamp01(Number.isFinite(importance) ? importance : 0.5);
    let cap = 1;
    if (tags.includes('inference:ambiguous')) cap = Math.min(cap, 0.45);
    if (tags.includes('weak-evidence') || tags.some(tag => String(tag).startsWith('quality:'))) cap = Math.min(cap, 0.58);
    if (tags.includes('inference:inferred')) cap = Math.min(cap, 0.66);
    if (tags.includes('needs-caution')) cap = Math.min(cap, 0.68);
    if (tags.includes('inference:reported')) cap = Math.min(cap, 0.74);
    if (confidence < 0.45) cap = Math.min(cap, 0.50);
    if (confidence < 0.55) cap = Math.min(cap, 0.62);
    return Math.min(bounded, cap);
}

function canAutoPromoteToAnchor(tags: string[], confidence: number): boolean {
    return confidence >= 0.78 &&
        !hasWeakEvidenceShape(tags) &&
        !tags.includes('importance-capped');
}

function canKeepRequestedAnchor(tags: string[], confidence: number): boolean {
    return confidence >= 0.58 &&
        !hasWeakEvidenceShape(tags) &&
        !tags.includes('importance-capped');
}

function contactIdFromTags(tags: string[] | undefined): string | null {
    const tag = (tags ?? []).find(t => String(t).startsWith('contact_id:'));
    return tag ? String(tag).replace('contact_id:', '').trim() : null;
}

function contactNamesFromTags(tags: string[] | undefined): Set<string> {
    const names = new Set<string>();
    for (const tag of tags ?? []) {
        const value = String(tag);
        if (value.startsWith('contact:') || value.startsWith('contact_name:') || value.startsWith('contact_alias:') || value.startsWith('contact_username:')) {
            names.add(
                value
                    .replace(/^contact(_name|_alias)?:/, '')
                    .replace(/^contact_username:/, '')
                    .trim()
                    .toLowerCase()
            );
        }
    }
    return names;
}

function hasStableContactIdentity(tags: string[] | undefined): boolean {
    return (tags ?? []).some(t =>
        String(t).startsWith('contact_id:') ||
        String(t).startsWith('contact_username:') ||
        String(t).startsWith('contact_key:')
    );
}

function hasContactId(tags: string[] | undefined): boolean {
    return (tags ?? []).some(t => String(t).startsWith('contact_id:'));
}

function isContactLikeMemory(memory: Pick<MemoryEntry, 'content' | 'tags'>): boolean {
    const tags = memory.tags ?? [];
    return /^\[[^\]]+\]\s+/.test(memory.content) ||
        tags.includes('subject:contact') ||
        tags.some(t =>
            String(t).startsWith('contact:') ||
            String(t).startsWith('contact_name:') ||
            String(t).startsWith('contact_alias:') ||
            String(t).startsWith('contact_id:') ||
            String(t).startsWith('contact_username:') ||
            String(t).startsWith('contact_key:')
        );
}

function isEpisodeMemory(memory: Pick<MemoryEntry, 'content' | 'tags'>): boolean {
    return (memory.tags ?? []).includes('memory-episode') ||
        memory.content.startsWith('[ЭПИЗОД ПАМЯТИ:');
}

function isChapterMemory(memory: Pick<MemoryEntry, 'content' | 'tags'>): boolean {
    return (memory.tags ?? []).includes('memory-chapter') ||
        memory.content.startsWith('[ГЛАВА ПАМЯТИ:');
}

function isSchemaMemory(memory: Pick<MemoryEntry, 'content' | 'tags'>): boolean {
    return (memory.tags ?? []).includes('memory-schema') ||
        memory.content.startsWith('[МОДЕЛЬ ПАМЯТИ:');
}

function isSleepIndexMemory(memory: Pick<MemoryEntry, 'content' | 'tags'>): boolean {
    const tags = memory.tags ?? [];
    return tags.includes('sleep_open_loop_index') ||
        tags.includes('sleep_uncertainty_index') ||
        memory.content.startsWith('[ИНДЕКС ОТКРЫТЫХ ЛИНИЙ ПАМЯТИ]') ||
        memory.content.startsWith('[ИНДЕКС СОМНЕНИЙ ПАМЯТИ]');
}

function isSyntheticMemory(memory: Pick<MemoryEntry, 'content' | 'tags'>): boolean {
    return isEpisodeMemory(memory) || isChapterMemory(memory) || isSchemaMemory(memory) || isSleepIndexMemory(memory);
}

function normalizeMemoryTags(tags: string[]): string[] {
    const normalized = tags
        .map(tag => String(tag).trim())
        .filter(Boolean);
    const isContact = normalized.some(tag =>
        tag.startsWith('contact:') ||
        tag.startsWith('contact_name:') ||
        tag.startsWith('contact_alias:') ||
        tag.startsWith('contact_id:') ||
        tag.startsWith('contact_username:') ||
        tag.startsWith('contact_key:')
    );
    if (isContact) {
        return [...new Set([
            ...normalized.filter(tag => !tag.startsWith('subject:')),
            'subject:contact',
        ])];
    }

    const hasSubjectTag = normalized.some(tag => tag.startsWith('subject:'));
    if (!hasSubjectTag) {
        normalized.push('subject:user');
    }
    return [...new Set(normalized)];
}

function canonicalFactText(content: string): string {
    return content
        .toLowerCase()
        .replace(/^\[[^\]]+\]\s+/, '')
        .replace(/[«»"']/g, '')
        .replace(/[^\p{L}\p{N}@]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function hasSpecificTemporalOrSourceDetail(content: string): boolean {
    return /(?:\b\d{1,2}[./-]\d{1,2}(?:[./-]\d{2,4})?\b|\b20\d{2}\b|\([^)]{3,80}\)|\bс\s+\d{1,2}\s+[а-яё]+\b|\bс\s+20\d{2}\b|сегодня|вчера|позавчера)/i
        .test(content);
}

function chooseDedupContent(existingContent: string, newContent: string): string {
    const existing = existingContent.trim();
    const incoming = newContent.trim();
    if (!existing) return incoming;
    if (!incoming) return existing;
    if (canonicalFactText(existing) === canonicalFactText(incoming)) return existing;

    const existingHasDetail = hasSpecificTemporalOrSourceDetail(existing);
    const incomingHasDetail = hasSpecificTemporalOrSourceDetail(incoming);
    if (existingHasDetail && !incomingHasDetail) return existing;
    if (incomingHasDetail && !existingHasDetail) return incoming;

    // Near-duplicate confirmations are often shorter paraphrases. Keep the richer
    // canonical wording and only boost confidence/tags.
    if (existing.length >= incoming.length * 1.25 && incoming.length < 160) {
        return existing;
    }
    return incoming;
}

function isSameContactScope(newTags: string[], existingTags: string[] | undefined): boolean {
    const newContactId = contactIdFromTags(newTags);
    const existingContactId = contactIdFromTags(existingTags);
    if (newContactId && existingContactId) return newContactId === existingContactId;

    const newNames = contactNamesFromTags(newTags);
    const existingNames = contactNamesFromTags(existingTags);
    const newHasContactScope = Boolean(newContactId) || newNames.size > 0;
    const existingHasContactScope = Boolean(existingContactId) || existingNames.size > 0;
    if (newHasContactScope !== existingHasContactScope) return false;
    if (!newHasContactScope && !existingHasContactScope) return true;

    const newHasStableIdentity = hasStableContactIdentity(newTags);
    const existingHasStableIdentity = hasStableContactIdentity(existingTags);
    if (newHasStableIdentity !== existingHasStableIdentity) return false;
    if ((newContactId || existingContactId) && newContactId !== existingContactId) return false;

    if (newNames.size > 0 && existingNames.size > 0) {
        for (const name of newNames) {
            if (existingNames.has(name)) return true;
        }
        return false;
    }

    return true;
}

// Категории состояний для расширенного поиска противоречий.
// Ловит логические противоречия с низким векторным сходством:
// "живёт в Москве" vs "переехал в Питер" — разные векторы, но одна категория.
const STATE_CATEGORY_QUERIES: Record<string, string[]> = {
    location:      ['место жительства', 'живёт переехал город', 'адрес проживания'],
    job:           ['место работы должность', 'компания работодатель', 'уволился устроился'],
    relationship:  ['семейное положение партнёр', 'женат замужем отношения', 'расстались разведён'],
    study:         ['учится университет школа', 'студент учебное заведение'],
    health_status: ['диагноз болезнь хроническое', 'состояние здоровья лечение'],
};

function detectStateCategory(content: string): string | null {
    const lc = content.toLowerCase();
    if (/живёт|переехал|адрес|прописан|жить в|город где/.test(lc)) return 'location';
    if (/работает|должность|компания|уволился|нанялся|устроился|работодатель/.test(lc)) return 'job';
    if (/женат|замужем|партнёр|встречается|разведён|расстались|вместе с/.test(lc)) return 'relationship';
    if (/учится|студент|университет|школа|поступил|учёба в/.test(lc)) return 'study';
    if (/диагноз|хронический|принимает лекарств|принимает таблетк|принимает препарат/.test(lc)) return 'health_status';
    return null;
}

// Счётчик ошибок в fire-and-forget задачах
const _asyncTaskErrors: Record<string, number> = {};

function fireAndForget(taskName: string, fn: () => Promise<void>): void {
    fn().catch((e) => {
        _asyncTaskErrors[taskName] = (_asyncTaskErrors[taskName] ?? 0) + 1;
        console.error(`❌ [async] ${taskName}:`, e instanceof Error ? e.message : String(e));
    });
}

export function getAsyncTaskErrors(): Readonly<Record<string, number>> {
    return { ..._asyncTaskErrors };
}

async function linkSourceMemories(
    memoryId: string,
    domain: string,
    userId: string,
    metadata: Partial<MemorySaveMetadata>,
    svc: ReturnType<typeof vectorService>
): Promise<void> {
    if (!svc || !memoryId || !metadata.sourceMemoryIds?.length) return;

    const sourceIds = [...new Set(metadata.sourceMemoryIds.map(String).filter(Boolean))].slice(0, 8);
    for (const sourceId of sourceIds) {
        const source = await svc.fetchMemoriesByIds(userId, [sourceId], 1).catch(() => []);
        const sourceMemory = source[0];
        if (!sourceMemory || sourceMemory.id === memoryId) continue;
        const relationType: MemoryRelationType = sourceMemory.memoryKind === 'episode' || sourceMemory.tags?.includes('memory-episode')
            ? 'same_episode'
            : 'contextual';
        await svc.addRelationship(
            memoryId,
            domain,
            sourceMemory.id,
            sourceMemory.domain,
            relationType,
            relationType === 'same_episode' ? 0.90 : 0.74,
            metadata.sourceEpisodeId ? `source episode ${metadata.sourceEpisodeId}` : 'source memory'
        );
    }
}

/**
 * Определяет через LLM, является ли факт сменой состояния.
 * Примеры: "приехал", "переехал", "уволился", "купил квартиру".
 * Результат кешируется — повторные вызовы бесплатны.
 */
async function isStateChangeFact(content: string): Promise<boolean> {
    const cacheKey = `state_change:${content.slice(0, 120)}`;
    const cached = llmCache.get<boolean>(cacheKey);
    if (cached !== undefined) return cached;

    const prompt = `Факт: "${content}"\nЭто факт смены состояния? (человек что-то сделал/изменил: приехал, переехал, уволился, купил, вернулся, начал/закончил работу, получил диагноз и т.п.)\nJSON: {"state_change": true/false}`;
    try {
        const resp = await createChatCompletionForTask('memoryExtraction', {
            messages: [
                { role: 'system', content: 'Отвечай только валидным JSON.' },
                { role: 'user', content: prompt },
            ],
            temperature: 0,
            max_completion_tokens: 15,
        });
        const data = parseLLMJson<{ state_change?: boolean }>(resp.choices[0]?.message?.content?.trim() || '');
        const result = data?.state_change === true;
        llmCache.set(cacheKey, result, LLM_CACHE_TTL.CLASSIFY);
        return result;
    } catch {
        return false;
    }
}

/**
 * Определяет через LLM, является ли факт планировочным/будущим.
 * Примеры: "планирует поехать", "собирается уволиться", "хочет купить квартиру".
 * Результат кешируется — повторные вызовы бесплатны.
 */
async function isPlanningFact(content: string): Promise<boolean> {
    const cacheKey = `planning_fact:${content.slice(0, 120)}`;
    const cached = llmCache.get<boolean>(cacheKey);
    if (cached !== undefined) return cached;

    const prompt = `Факт: "${content}"\nЭто планировочный/будущий факт? (человек планирует, собирается, хочет, намерен что-то сделать — но ещё не сделал)\nJSON: {"planning": true/false}`;
    try {
        const resp = await createChatCompletionForTask('memoryExtraction', {
            messages: [
                { role: 'system', content: 'Отвечай только валидным JSON.' },
                { role: 'user', content: prompt },
            ],
            temperature: 0,
            max_completion_tokens: 15,
        });
        const data = parseLLMJson<{ planning?: boolean }>(resp.choices[0]?.message?.content?.trim() || '');
        const result = data?.planning === true;
        llmCache.set(cacheKey, result, LLM_CACHE_TTL.CLASSIFY);
        return result;
    } catch {
        return false;
    }
}

type ContradictionVerdict = 'contradicts' | 'updates' | 'complements';

interface ContradictionResult {
    verdict: ContradictionVerdict;
    /**
     * Объединённая формулировка для хранения в памяти.
     * Обязательна для 'contradicts' и 'updates', отсутствует для 'complements'.
     *
     * contradicts: сохраняет историю ("работал в Сбере, затем уволился")
     * updates:     отражает актуальное состояние ("переехал из Москвы в Питер")
     */
    mergedContent?: string;
}

/**
 * Спрашивает LLM, как два похожих факта соотносятся друг с другом.
 *
 * contradicts — факты прямо противоречат; mergedContent сохраняет историю ("работал в X, уволился")
 * updates     — новый факт обновляет старый; mergedContent отражает актуальное состояние
 * complements — факты не пересекаются, сохраняем оба
 */
async function checkContradiction(
    existingContent: string,
    newContent: string
): Promise<ContradictionResult> {
    const cacheKey = `contradiction:${existingContent.slice(0, 100)}|||${newContent.slice(0, 100)}`;
    const cached = llmCache.get<ContradictionResult>(cacheKey);
    if (cached) return cached;

    const today = new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
    const prompt = `Два факта об одном человеке:

Сегодняшняя дата: ${today}

Факт А (старый): "${existingContent}"
Факт Б (новый): "${newContent}"

Определи отношение:
- "contradicts" — прямо противоречат: А и Б не могут быть одновременно актуальны (пример: "работает в Сбере" vs "уволился из Сбере")
- "updates" — Б обновляет или уточняет А: А устарел, Б — актуальная версия (пример: "живёт в Москве" vs "переехал в Питер")
- "complements" — не противоречат, добавляют разную информацию

ВАЖНО: Обрати особое внимание на переходы состояний события (запланировано → в процессе → завершено).
Это всегда "updates", и mergedContent должен отражать ТЕКУЩЕЕ состояние с датами.

Для временных событий (поездки, путешествия, встречи, конференции и т.д.):
  - А="планирует поехать во Вьетнам", Б="уже во Вьетнаме" → "Сейчас во Вьетнаме (с ${today})" [verdict: updates]
  - А="летит во Вьетнам сегодня", Б="уже во Вьетнаме" → "Сейчас во Вьетнаме (с ${today})" [verdict: updates]
  - А="сейчас во Вьетнаме (с 1 апреля)", Б="вернулся из Вьетнама" → "Был во Вьетнаме с 1 апреля по ${today}" [verdict: updates]
  - А="летит на конференцию", Б="уже на конференции" → "Сейчас на конференции (с ${today})" [verdict: updates]
  - А="сейчас на конференции", Б="вернулся с конференции" → "Был на конференции, вернулся ${today}" [verdict: updates]

Для "contradicts" — напиши mergedContent, сохраняющий историю: что было раньше и что изменилось.
  Пример: А="работает в Сбере", Б="уволился из Сбере" → "Работал в Сбере, затем уволился"
  Пример: А="не пьёт алкоголь", Б="выпил вчера пива" → "В целом не пьёт алкоголь, но иногда делает исключения"

Для "updates" — напиши mergedContent, отражающий актуальное состояние с датами если они известны.
  Пример: А="живёт в Москве", Б="переехал в Питер" → "Переехал из Москвы в Санкт-Петербург"

Ответ только JSON:
{"verdict": "contradicts|updates|complements", "mergedContent": "обязательно для contradicts и updates"}`;

    try {
        const resp = await createChatCompletionForTask('memoryExtraction', {
            messages: [
                { role: 'system', content: 'Отвечай только валидным JSON.' },
                { role: 'user', content: prompt },
            ],
            temperature: 0,
        });
        const text = resp.choices[0]?.message?.content?.trim() || '';
        const data = parseLLMJson<{ verdict?: string; mergedContent?: string }>(text);
        if (!data) return { verdict: 'complements' };
        const verdict: ContradictionVerdict =
            data.verdict === 'contradicts' ? 'contradicts' :
                data.verdict === 'updates' ? 'updates' : 'complements';
        const result: ContradictionResult = {
            verdict,
            mergedContent: verdict !== 'complements' && data.mergedContent
                ? String(data.mergedContent).trim()
                : undefined,
        };
        llmCache.set(cacheKey, result, LLM_CACHE_TTL.CONTRADICTION);
        return result;
    } catch {
        return { verdict: 'complements' };
    }
}

// Temporal keywords that suggest a fact has limited lifespan
const TEMPORAL_HINT_RE = new RegExp(
    [
        // Явные ожидания
        'жду', 'ожидаю', 'жду ответа', 'жду результатов', 'жду звонка', 'жду письма',
        // События и встречи
        'встреча', 'звонок', 'собрание', 'мероприятие', 'событие', 'вечеринка', 'концерт', 'конференция',
        // Поездки
        'отпуск', 'поездка', 'командировка', 'рейс', 'вылет', 'перелёт',
        // Ближайшие дни
        'сегодня', 'завтра', 'послезавтра',
        // Дни недели
        'в понедельник', 'в вторник', 'в среду', 'в четверг', 'в пятницу', 'в субботу', 'в воскресенье',
        'на понедельник', 'на вторник', 'на среду', 'на четверг', 'на пятницу', 'на субботу', 'на воскресенье',
        // Недели
        'на этой неделе', 'на следующей неделе', 'на прошлой неделе', 'в выходные', 'на выходных',
        // «Через N» — число или слово
        'через \\d+',
        'через несколько', 'через пару', 'через пол', 'через полгода', 'через квартал',
        'через неделю', 'через месяц', 'через год', 'через два', 'через три', 'через четыре', 'через пять',
        // Месяцы
        'в январе', 'в феврале', 'в марте', 'в апреле', 'в мае', 'в июне',
        'в июле', 'в августе', 'в сентябре', 'в октябре', 'в ноябре', 'в декабре',
        // «К + точка во времени»
        'к лету', 'к зиме', 'к весне', 'к осени',
        'к новому году', 'к праздникам', 'к выходным',
        'к концу недели', 'к концу месяца', 'к концу года',
        'к пятнице', 'к понедельнику', 'к вторнику', 'к среде', 'к четвергу', 'к субботе', 'к воскресенью',
        // Начало/конец периода
        'в начале', 'в конце', 'в середине',
        'в следующем месяце', 'в этом месяце', 'в следующем году',
        // Скорое наступление
        'скоро', 'вот-вот', 'со дня на день', 'с минуты на минуту',
        // Сроки и дедлайны
        'дедлайн', 'крайний срок', 'срок сдачи', 'до конца', 'до дедлайна',
        'истекает', 'заканчивается', 'скоро истекает',
        // Учёба и экзамены
        'экзамен', 'зачёт', 'защита', 'сдаю', 'сессия', 'контрольная',
        // Медицина
        'запись к', 'приём у врача', 'операция', 'обследование', 'анализы',
        // Намерения с временным горизонтом
        'планирую (поехать|съездить|пойти|сходить|полететь|сделать|записаться)',
        'собираюсь (поехать|съездить|пойти|сходить|полететь|сделать|записаться)',
        'хочу (поехать|съездить|пойти|сходить|полететь) (сегодня|завтра|на этой|на следующей|в эти|в выходные)',
    ].join('|'),
    'i'
);

/**
 * Определяет, является ли факт временным, и возвращает дату истечения актуальности.
 * Использует быструю эвристику, а для неоднозначных случаев — LLM.
 */
async function detectTemporalExpiry(content: string): Promise<Date | undefined> {
    if (!TEMPORAL_HINT_RE.test(content)) return undefined;

    try {
        const resp = await createChatCompletionForTask('memoryExtraction', {
            messages: [
                { role: 'system', content: 'Отвечай только валидным JSON.' },
                {
                    role: 'user',
                    content: `Факт: "${content}"
Является ли этот факт временным (актуален ограниченное время)?
Если да — через сколько дней от сегодня он потеряет актуальность?

Примеры:
- "жду посылку" → {"temporal": true, "days": 14}
- "встреча в пятницу" → {"temporal": true, "days": 7}
- "отпуск в июле" → {"temporal": true, "days": 60}
- "через месяц переезжаю" → {"temporal": true, "days": 30}
- "через полгода защита диплома" → {"temporal": true, "days": 180}
- "экзамен на следующей неделе" → {"temporal": true, "days": 7}
- "запись к врачу в среду" → {"temporal": true, "days": 5}
- "к концу года хочу похудеть" → {"temporal": true, "days": 180}
- "дедлайн через три дня" → {"temporal": true, "days": 3}
- "собираюсь съездить в Питер на выходных" → {"temporal": true, "days": 7}
- "к лету планирую купить машину" → {"temporal": true, "days": 90}
- "вот-вот получу оффер" → {"temporal": true, "days": 14}
- "со дня на день придут результаты анализов" → {"temporal": true, "days": 7}
- "люблю горы" → {"temporal": false}
- "работаю программистом" → {"temporal": false}
- "у меня есть кот" → {"temporal": false}

JSON: {"temporal": true/false, "days": число_или_null}`,
                },
            ],
            temperature: 0,
        });
        const text = resp.choices[0]?.message?.content?.trim() || '';
        const data = parseLLMJson<{ temporal?: boolean; days?: number }>(text);
        if (!data?.temporal || !data.days) return undefined;
        const expiry = new Date();
        expiry.setDate(expiry.getDate() + Number(data.days));
        return expiry;
    } catch {
        return undefined;
    }
}

/**
 * Fire-and-forget: ищет устаревшие планировочные факты при смене состояния.
 * Обрабатывает случаи, когда similarity ниже порога contradiction-check (0.55–0.72),
 * но факт явно содержит планировочные паттерны ("планирую поехать", "собираюсь в...").
 * Запускается только если новый факт содержит признаки смены состояния.
 */
async function invalidatePlanningFacts(
    newContent: string,
    userId: string,
    newFactId: string,
    newTags: string[],
    svc: ReturnType<typeof vectorService>
): Promise<void> {
    if (!svc) return;
    if (!await isStateChangeFact(newContent)) return;

    try {
        const candidates = await svc.searchAllDomains(newContent, userId, 12);
        for (const candidate of candidates) {
            if (candidate.id === newFactId) continue;
            if (isSyntheticMemory(candidate)) continue;
            if (!isSameContactScope(newTags, candidate.tags)) continue;
            // Обрабатываем только зону ниже обычного contradiction-check
            if (candidate.score >= DEFAULT_CONTRADICTION_THRESHOLD) continue;
            if (candidate.score < PLANNING_SWEEP_THRESHOLD) continue;
            if (!await isPlanningFact(candidate.content)) continue;

            const check = await checkContradiction(candidate.content, newContent);
            devLog(`🔍 [sweep] Проверка устаревшего плана [${check.verdict}]:`, {
                old: candidate.content.slice(0, 60),
                new: newContent.slice(0, 60),
            });

            if ((check.verdict === 'updates' || check.verdict === 'contradicts') && check.mergedContent) {
                const existingConfidence = candidate.confidence ?? 0.6;
                const newVersion = {
                    content: candidate.content,
                    timestamp: candidate.timestamp,
                    confidence: existingConfidence,
                };
                await svc.updateMemory(candidate.id, candidate.domain, {
                    content: check.mergedContent,
                    domain: candidate.domain,
                    timestamp: new Date(),
                    importance: candidate.importance,
                    tags: [...new Set([...(candidate.tags || []), 'planning-invalidated'])],
                    userId,
                    botId,
                    confidence: Math.max(0.3, existingConfidence - 0.1),
                    memoryKind: candidate.memoryKind ?? inferMemoryKind(check.mergedContent, candidate.tags ?? []),
                    strength: candidate.strength,
                    vividness: candidate.vividness,
                    specificity: candidate.specificity,
                    previousVersions: [newVersion, ...((candidate as any).previousVersions ?? [])].slice(0, 10),
                    status: check.verdict === 'updates' ? inferMemoryStatus(check.mergedContent) : candidate.status,
                });
                devLog(`🔄 [sweep] Устаревший план обновлён:`, check.mergedContent.slice(0, 60));
            }
        }
    } catch (e) {
        devLog('invalidatePlanningFacts error (ignored):', e);
    }
}

/** Сохраняет факт в векторную БД (Qdrant) с обнаружением противоречий и дедупликацией. */
export async function saveMemory(
    ctx: BotContext,
    domain: string,
    content: string,
    importance: number,
    tags: string[] = [],
    isAnchor = false,
    metadata: MemorySaveMetadata = {}
): Promise<boolean> {
    const userId = ctx.from?.id;
    const normalizedDomain = normalizeMemoryDomain(domain);
    const normalizedContent = content.trim();
    devLog('💾 Сохранение в векторную БД (долговременная память):', {
        userId,
        domain: normalizedDomain,
        content: normalizedContent.slice(0, 100) + '...',
        importance,
        isAnchor,
        vectorServiceAvailable: !!vectorService()
    });

    if (!userId) {
        const msg = 'Не удалось определить пользователя. Факт не сохранён в долговременную память.';
        console.error('❌', msg);
        lastSaveError = msg;
        if (ctx.session) ctx.session.lastFactSaveError = msg;
        return false;
    }

    if (!normalizedContent) return false;

    const svc = vectorService();
    if (!svc) {
        const msg = 'Векторный сервис недоступен. Факт не сохранён в долговременную память.';
        console.error('❌', msg);
        lastSaveError = msg;
        if (ctx.session) ctx.session.lastFactSaveError = msg;
        return false;
    }

    try {
        domain = normalizedDomain;
        content = normalizedContent;
        tags = normalizeMemoryTags(tags);
        if (metadata.reminderId?.trim()) {
            tags = normalizeMemoryTags([...tags, buildReminderSourceTag(metadata.reminderId.trim())]);
        }

        const incomingConfidence = clamp01(
            typeof metadata.confidence === 'number' && Number.isFinite(metadata.confidence)
                ? metadata.confidence
                : 0.6
        );
        const originalImportance = clamp01(Number.isFinite(importance) ? importance : 0.5);
        const calibratedImportance = calibratedImportanceForEvidence(originalImportance, tags, incomingConfidence);
        if (calibratedImportance < originalImportance) {
            tags = [...new Set([...tags, 'importance-capped'])];
        }
        importance = calibratedImportance;
        if (isAnchor && !canKeepRequestedAnchor(tags, incomingConfidence)) {
            tags = [...new Set([...tags, 'anchor-capped'])];
            isAnchor = false;
        }
        const dedupThreshold = getDedupThreshold(domain);
        const contradictionThreshold = getContradictionThreshold(domain);

        // ── Шаг 1: Дедупликация (почти идентичные факты) ─────────────────────
        // Ищем кросс-доменно: факт мог быть сохранён с другим доменом ранее
        const nearIdenticalInDomain = await svc.searchMemories(content, String(userId), {
            domain,
            limit: 5,
            minScore: dedupThreshold,
        });
        let dedupCandidate = nearIdenticalInDomain.find(existing =>
            !isSyntheticMemory(existing) && isSameContactScope(tags, existing.tags)
        );
        if (!dedupCandidate) {
            dedupCandidate = (await svc.searchAllDomains(content, String(userId), DEDUP_CROSS_DOMAIN_LIMIT))
                .filter(r => r.score >= dedupThreshold && !isSyntheticMemory(r))
                .find(existing => isSameContactScope(tags, existing.tags));
        }

        if (dedupCandidate) {
            const existing = dedupCandidate;
            const canonicalContent = chooseDedupContent(existing.content, content);
            const independentConfirmation = isIndependentConfirmation(existing, metadata);
            // Каждое подтверждение повышает достоверность, но слабые фоновые
            // извлечения не должны резко укреплять сомнительный факт.
            const baseConfirmationBoost = incomingConfidence >= 0.78 ? 0.10 : incomingConfidence >= 0.60 ? 0.07 : 0.03;
            const confirmationBoost = independentConfirmation
                ? baseConfirmationBoost
                : Math.min(0.015, baseConfirmationBoost * 0.2);
            const boostedConfidence = clamp01(Math.max(existing.confidence ?? 0.6, incomingConfidence) + confirmationBoost);
            const confirmationCount = independentConfirmation
                ? (existing.confirmationCount ?? 1) + 1
                : (existing.confirmationCount ?? 1);
            const existingImportance = calibratedImportanceForEvidence(
                existing.importance ?? 0.5,
                existing.tags ?? [],
                existing.confidence ?? 0.6
            );
            const mergedImportance = Math.max(importance, existingImportance);
            let mergedTags = [...new Set([
                ...(tags || []),
                ...(existing.tags || []),
                independentConfirmation ? 'independent-confirmation' : 'same-source-confirmation',
            ])];
            if (existingImportance < (existing.importance ?? 0.5)) {
                mergedTags = [...new Set([...mergedTags, 'importance-capped'])];
            }
            const keepExistingAnchor = Boolean(existing.isAnchor) && canKeepRequestedAnchor(mergedTags, boostedConfidence);
            // Авто-продвижение в anchors требует независимого подтверждения и чистой доказательной формы.
            const shouldAutoAnchor = independentConfirmation &&
                boostedConfidence >= 0.9 &&
                mergedImportance >= 0.8 &&
                canAutoPromoteToAnchor(mergedTags, boostedConfidence);
            const memoryKind = inferMemoryKind(canonicalContent, mergedTags, metadata);
            const metrics = estimateHumanMemoryMetrics({
                content: canonicalContent,
                importance: mergedImportance,
                confidence: boostedConfidence,
                tags: mergedTags,
                isAnchor: isAnchor || shouldAutoAnchor || keepExistingAnchor,
                emotionalTag: existing.emotionalTag,
                memoryKind,
                status: metadata.status ?? existing.status ?? inferMemoryStatus(canonicalContent),
                retrievalCount: existing.retrievalCount,
            });
            if (shouldAutoAnchor) devLog('⚓ Авто-продвижение в anchor:', content.slice(0, 60));
            await svc.updateMemory(existing.id, existing.domain, {
                content: canonicalContent,
                domain: existing.domain,
                timestamp: new Date(),
                importance: mergedImportance,
                tags: mergedTags,
                userId: String(userId),
                botId,
                isAnchor: isAnchor || shouldAutoAnchor || keepExistingAnchor || undefined,
                confidence: boostedConfidence,
                memoryKind,
                strength: metadata.strength ?? metrics.strength,
                vividness: metadata.vividness ?? metrics.vividness,
                specificity: metadata.specificity ?? metrics.specificity,
                sourceEpisodeId: metadata.sourceEpisodeId ?? existing.sourceEpisodeId,
                sourceContext: metadata.sourceContext ?? existing.sourceContext,
                sourceMessageIds: mergeSourceMessageIds(existing.sourceMessageIds, metadata.sourceMessageIds),
                sourceMemoryIds: mergeSourceMemoryIds(existing.sourceMemoryIds, metadata.sourceMemoryIds),
                extractionMethod: metadata.extractionMethod ?? existing.extractionMethod,
                subject: metadata.subject ?? existing.subject,
                predicate: metadata.predicate ?? existing.predicate,
                object: metadata.object ?? existing.object,
                validFrom: metadata.validFrom ?? existing.validFrom,
                validTo: metadata.validTo ?? existing.validTo,
                status: metadata.status ?? existing.status ?? inferMemoryStatus(canonicalContent),
                confirmationCount,
                lastConfirmedAt: new Date(),
            });
            fireAndForget('linkSourceMemories', () => linkSourceMemories(existing.id, existing.domain, String(userId), metadata, svc));
            devLog('✅ Факт обновлён (дедупликация) ID:', existing.id, '| confidence:', boostedConfidence, '| independent:', independentConfirmation);
            lastSaveError = null;
            if (ctx.session) delete ctx.session.lastFactSaveError;
            return true;
        }

        // ── Шаг 2: Поиск похожих фактов для проверки противоречий ────────────
        // Ищем в том же домене + кросс-доменно: домен старого факта может не совпадать с новым
        // (например, "планирую поездку" в general, а "прилетел" — в travel).
        const relatedInDomain = await svc.searchMemories(content, String(userId), {
            domain,
            limit: 7,
            minScore: contradictionThreshold,
        });
        const relatedAllDomains = await svc.searchAllDomains(content, String(userId), CONTRADICTION_CROSS_DOMAIN_LIMIT);

        // Объединяем результаты, дедуплицируем по id, фильтруем по порогу
        const related = relatedInDomain.filter(r => !isSyntheticMemory(r) && isSameContactScope(tags, r.tags));
        const seenIds = new Set(related.map(r => r.id));
        for (const r of relatedAllDomains) {
            if (isSyntheticMemory(r)) continue;
            if (!seenIds.has(r.id) && r.score >= contradictionThreshold && r.score < dedupThreshold) {
                if (!isSameContactScope(tags, r.tags)) continue;
                seenIds.add(r.id);
                related.push(r);
            }
        }

        // Расширенный поиск по семантической категории состояния:
        // ловит противоречия с низким векторным сходством ("живёт в Москве" vs "переехал в Питер")
        const stateCategory = detectStateCategory(content);
        if (stateCategory) {
            for (const catQuery of STATE_CATEGORY_QUERIES[stateCategory]) {
                const catResults = await svc.searchAllDomains(catQuery, String(userId), 3);
                for (const r of catResults) {
                    if (isSyntheticMemory(r)) continue;
                    if (seenIds.has(r.id)) continue;
                    if (!isSameContactScope(tags, r.tags)) continue;
                    if (r.score < 0.55 || r.score >= dedupThreshold) continue;
                    seenIds.add(r.id);
                    related.push(r);
                }
            }
        }

        let mergedCount = 0;
        for (const candidate of related) {
            // Пропускаем то, что уже обработано порогом дедупликации
            if (candidate.score >= dedupThreshold) continue;
            if (!isSameContactScope(tags, candidate.tags)) continue;

            const check = await checkContradiction(candidate.content, content);
            devLog(`🔍 Проверка противоречия [${check.verdict}]:`, {
                old: candidate.content.slice(0, 60),
                new: content.slice(0, 60),
            });

            if ((check.verdict === 'contradicts' || check.verdict === 'updates') && check.mergedContent) {
                const existingConfidence = candidate.confidence ?? 0.6;
                const newVersion = {
                    content: candidate.content,
                    timestamp: candidate.timestamp,
                    confidence: existingConfidence,
                };
                const previousVersions = [
                    newVersion,
                    ...((candidate as any).previousVersions ?? []),
                ].slice(0, 10);

                if (mergedCount === 0) {
                    // Первый конфликт: полное слияние — становится каноническим текущим состоянием
                    // - contradicts: "работал в Сбере, затем уволился" (история сохранена)
                    // - updates:     "переехал из Москвы в Питер" (актуальное состояние)
                    const mergeTag = check.verdict === 'contradicts' ? 'contradicts-merged' : 'updated';
                    const mergedConfidence = check.verdict === 'contradicts'
                        ? Math.max(0.3, Math.min(existingConfidence, incomingConfidence) - 0.15)
                        : Math.max(existingConfidence, incomingConfidence * 0.9);
                    const candidateImportance = calibratedImportanceForEvidence(
                        candidate.importance ?? 0.5,
                        candidate.tags ?? [],
                        candidate.confidence ?? 0.6
                    );
                    const mergedImportance = Math.max(importance, candidateImportance);
                    let mergedTags = [...new Set([...(tags || []), ...(candidate.tags || []), mergeTag])];
                    if (candidateImportance < (candidate.importance ?? 0.5)) {
                        mergedTags = [...new Set([...mergedTags, 'importance-capped'])];
                    }
                    const keepCandidateAnchor = Boolean(candidate.isAnchor || candidate.tags?.includes('anchor')) &&
                        canKeepRequestedAnchor(mergedTags, mergedConfidence);
                    const memoryKind = inferMemoryKind(check.mergedContent, mergedTags, metadata);
                    const status = metadata.status ?? inferMemoryStatus(check.mergedContent);
                    const metrics = estimateHumanMemoryMetrics({
                        content: check.mergedContent,
                        importance: mergedImportance,
                        confidence: mergedConfidence,
                        tags: mergedTags,
                        isAnchor: isAnchor || keepCandidateAnchor,
                        emotionalTag: candidate.emotionalTag,
                        memoryKind,
                        status,
                        retrievalCount: candidate.retrievalCount,
                    });

                    await svc.updateMemory(candidate.id, candidate.domain, {
                        content: check.mergedContent,
                        domain: candidate.domain,
                        timestamp: new Date(),
                        importance: mergedImportance,
                        tags: mergedTags,
                        userId: String(userId),
                        botId,
                        isAnchor: isAnchor || keepCandidateAnchor || undefined,
                        confidence: mergedConfidence,
                        memoryKind,
                        strength: metadata.strength ?? metrics.strength,
                        vividness: metadata.vividness ?? metrics.vividness,
                        specificity: metadata.specificity ?? metrics.specificity,
                        previousVersions,
                        status,
                    });
                    devLog(`🔄 Факт объединён [${check.verdict}]:`, check.mergedContent.slice(0, 60));
                } else {
                    // Последующие конфликты: устаревший планировочный факт — истекает немедленно,
                    // чтобы не дублировать merged-контент в нескольких записях.
                    await svc.updateMemory(candidate.id, candidate.domain, {
                        content: candidate.content,
                        domain: candidate.domain,
                        timestamp: candidate.timestamp,
                        importance: candidate.importance,
                        tags: [...new Set([...(candidate.tags || []), 'planning-superseded'])],
                        userId: String(userId),
                        botId,
                        expiresAt: new Date(),
                        confidence: Math.max(0.3, existingConfidence - 0.1),
                        memoryKind: candidate.memoryKind ?? inferMemoryKind(candidate.content, candidate.tags ?? []),
                        strength: candidate.strength,
                        vividness: candidate.vividness,
                        specificity: candidate.specificity,
                        previousVersions,
                        status: 'superseded',
                    });
                    devLog(`⏰ Дополнительный планировочный факт истёк:`, candidate.content.slice(0, 60));
                }
                mergedCount++;
            }
            // 'complements' — продолжаем, сохраним оба
        }

        if (mergedCount > 0) {
            lastSaveError = null;
            if (ctx.session) delete ctx.session.lastFactSaveError;
            return true; // Новый факт поглощён существующими записями
        }

        // ── Шаг 3: Эмоциональная маркировка (только для значимых фактов) ────
        // Flashbulb-факты (смерть, свадьба, рождение, расставание, кризис) —
        // автоматически становятся anchor и получают буст importance.
        // Аналогично человеческой памяти: эмоционально заряженные события запоминаются навсегда.
        let finalImportance = importance;
        let finalIsAnchor = isAnchor;
        let emotionalTag = undefined;
        if (importance >= 0.5) {
            const tag = await detectEmotionalTag(content).catch(() => null);
            if (tag) {
                emotionalTag = tag;
                if (tag.isFlashbulb && canKeepRequestedAnchor(tags, incomingConfidence)) {
                    finalIsAnchor = true;
                    // Буст к важности, но не более 1.0
                    finalImportance = Math.min(1.0, importance + 0.15);
                    devLog('🔥 Flashbulb-факт (эмоциональная память):', content.slice(0, 60), `arousal=${tag.arousal.toFixed(2)}`);
                } else if (tag.isFlashbulb) {
                    devLog('🔥 Flashbulb-кандидат не повышен до anchor из-за слабой опоры:', content.slice(0, 60));
                }
            }
        }

        // ── Шаг 4: Сохраняем как новый факт ──────────────────────────────────
        const expiresAt = await detectTemporalExpiry(content);
        const now = new Date();
        const status = metadata.status ?? inferMemoryStatus(content, expiresAt);
        const memoryKind = inferMemoryKind(content, tags, metadata);
        const metrics = estimateHumanMemoryMetrics({
            content,
            importance: finalImportance,
            confidence: incomingConfidence,
            tags,
            isAnchor: finalIsAnchor,
            emotionalTag,
            memoryKind,
            status,
        });
        const result = await svc.saveMemory({
            content,
            domain,
            timestamp: now,
            importance: finalImportance,
            tags,
            userId: String(userId),
            botId,
            isAnchor: finalIsAnchor || undefined,
            expiresAt,
            confidence: incomingConfidence,
            lastAccessedAt: now,
            emotionalTag,
            memoryKind,
            strength: metadata.strength ?? metrics.strength,
            vividness: metadata.vividness ?? metrics.vividness,
            specificity: metadata.specificity ?? metrics.specificity,
            sourceEpisodeId: metadata.sourceEpisodeId,
            sourceContext: metadata.sourceContext,
            sourceMessageIds: metadata.sourceMessageIds,
            sourceMemoryIds: metadata.sourceMemoryIds,
            extractionMethod: metadata.extractionMethod ?? 'unknown',
            subject: metadata.subject ?? (tags.includes('subject:contact') ? 'contact' : 'user'),
            predicate: metadata.predicate,
            object: metadata.object,
            validFrom: metadata.validFrom,
            validTo: metadata.validTo,
            status,
            confirmationCount: 1,
            lastConfirmedAt: now,
        });
        devLog('✅ Факт успешно сохранён с ID:', result);

        // ── Шаг 5: Строим граф связей (fire & forget) ────────────────────────
        fireAndForget('buildMemoryRelationships', () => buildMemoryRelationships(result, content, String(userId), domain, tags, svc));
        fireAndForget('linkSourceMemories', () => linkSourceMemories(result, domain, String(userId), metadata, svc));

        // ── Шаг 5.5: Аннулируем устаревшие планировочные факты (fire & forget) ─
        // Обрабатывает зону similarity 0.55–0.72 — ниже порога contradiction-check,
        // но достаточно близко чтобы "планирую поездку" нашлось по "прилетел".
        fireAndForget('invalidatePlanningFacts', () => invalidatePlanningFacts(content, String(userId), result, tags, svc));

        lastSaveError = null;
        if (ctx.session) delete ctx.session.lastFactSaveError;
        return true;
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        lastSaveError = msg;
        console.error('❌ Ошибка сохранения факта в векторную БД:', e instanceof Error ? e.stack : e);
        const userMsg =
            msg && /internal server error|500|ECONNREFUSED|ETIMEDOUT|unavailable/i.test(msg)
                ? 'Не удалось сохранить в долговременную память (ошибка сервиса или сети). Попробуй позже.'
                : msg;
        if (ctx.session) ctx.session.lastFactSaveError = userMsg;
        return false;
    }
}

/**
 * Строит двунаправленные связи между новым фактом и семантически близкими фактами из памяти.
 * Связывает факты с cosine similarity 0.60–0.80 (ниже порога дедупликации, но выше случайного).
 * Вызывается fire-and-forget после сохранения нового факта.
 */
async function buildMemoryRelationships(
    newId: string,
    content: string,
    userId: string,
    domain: string,
    tags: string[],
    svc: ReturnType<typeof vectorService>
): Promise<void> {
    if (!svc || !newId) return;
    try {
        // Ищем связанные факты в диапазоне [0.60, dedup) — не дубликаты, но семантически близкие
        const candidates = await svc.searchAllDomains(content, userId, 8);
        for (const candidate of candidates) {
            if (candidate.id === newId) continue;
            if (!isSameContactScope(tags, candidate.tags)) continue;
            const candidateDomain = normalizeMemoryDomain(candidate.domain || domain);
            const domainDedupThreshold = getDedupThreshold(candidateDomain);
            if (candidate.score >= domainDedupThreshold) continue; // пропускаем дубликаты
            const relation = inferRelation(content, candidate.content, tags, candidate.tags ?? [], candidate.score);
            await svc.addRelationship(newId, domain, candidate.id, candidate.domain, relation.type, relation.weight, relation.cue);
        }
    } catch (e) {
        devLog('buildMemoryRelationships error (ignored):', e);
    }
}

function inferRelation(
    newContent: string,
    existingContent: string,
    newTags: string[],
    existingTags: string[],
    score: number
): { type: MemoryRelationType; weight: number; cue: string } {
    const allTags = new Set([...newTags, ...existingTags]);
    const lc = `${newContent}\n${existingContent}`.toLowerCase();
    if (allTags.has('memory-episode') || /эпизод памяти/.test(lc)) {
        return { type: 'same_episode', weight: Math.max(0.65, score), cue: 'same episode/context' };
    }
    if ([...allTags].some(tag =>
        String(tag).startsWith('contact:') ||
        String(tag).startsWith('contact_id:') ||
        String(tag).startsWith('contact_username:')
    )) {
        return { type: 'person_link', weight: Math.max(0.64, score), cue: 'same contact/entity' };
    }
    if (/планир|собира|хоч|цель|нужно|надо|шаг|сделать|дедлайн/.test(lc)) {
        return { type: 'goal_step', weight: Math.max(0.60, score), cue: 'goal/open loop association' };
    }
    if (/сегодня|вчера|завтра|\b20\d{2}\b|\d{1,2}[./-]\d{1,2}|после|до |потом|раньше|теперь/.test(lc)) {
        return { type: 'temporal', weight: Math.max(0.58, score), cue: 'temporal association' };
    }
    if (/переехал|уволил|теперь|уже|вернул|стал|стала|изменил/.test(lc)) {
        return { type: 'updates', weight: Math.max(0.58, score), cue: 'state transition association' };
    }
    return { type: 'semantic', weight: Math.max(0.55, score), cue: 'semantic association' };
}

export async function searchMemories(ctx: BotContext, query: string, options?: SearchOptions, userIdOverride?: string) {
    const svc = vectorService();
    if (!svc) return [];
    try {
        devLog('Searching memories:', query, options);
        const userId = userIdOverride ?? String(ctx.from?.id);
        const res = await svc.searchMemories(query, userId, options);
        devLog('Search result count:', res.length);
        if (res.length === 0) {
            console.warn(`⚠️ Память не найдена по запросу: "${query.slice(0, 120)}"`);
        }
        return res;
    } catch (e) {
        console.error('Vector search error', e);
        return [];
    }
}

export async function searchAllDomainsMemories(ctx: BotContext, query: string, limit = 5) {
    const svc = vectorService();
    if (!svc) return [];
    try {
        devLog('Searching all domains:', { query: query.slice(0, 100), limit });
        const res = await svc.searchAllDomains(query, String(ctx.from?.id), limit);
        devLog('Cross-domain result count:', res.length);
        if (res.length === 0) {
            console.warn(`⚠️ Кросс-доменный поиск не нашел фактов: "${query.slice(0, 120)}"`);
        }
        return res;
    } catch (e) {
        console.error('Cross-domain vector search error', e);
        return [];
    }
}

type MemorySearchResultLike = SearchResult;

function tokenizeMemoryQuery(query: string): string[] {
    const normalized = query
        .toLowerCase()
        .replace(/[«»"'`]/g, ' ')
        .replace(/[^a-zа-яё0-9:.@_-]+/giu, ' ');

    return Array.from(new Set(
        normalized
            .split(/\s+/)
            .map((token) => token.trim())
            .filter((token) => token.length >= 2)
    ));
}

function lexicalMemoryScore(content: string, query: string): number {
    const loweredContent = content.toLowerCase();
    const loweredQuery = query.toLowerCase().trim();
    if (!loweredQuery) return 0;

    const tokens = tokenizeMemoryQuery(loweredQuery);
    if (tokens.length === 0) return 0;

    let score = 0;
    if (loweredContent.includes(loweredQuery)) score += 1;

    const matched = tokens.filter((token) => loweredContent.includes(token));
    score += matched.length / tokens.length;

    // Временные маркеры вроде 9:01 очень важны для одноразовых планов из reflection-эпизодов.
    if (/\d{1,2}[:.]\d{2}/u.test(query) && matched.some((token) => /\d{1,2}[:.]\d{2}/u.test(token))) {
        score += 0.35;
    }

    if (/source:reflection|reflection|рефлекс/iu.test(loweredQuery) && /source:reflection|фоновая рефлексия|reflection/iu.test(loweredContent)) {
        score += 0.35;
    }

    return score;
}

function memoryEntryToSearchResult(memory: MemoryEntry, score: number): MemorySearchResultLike {
    return {
        id: memory.id,
        content: memory.content,
        score,
        timestamp: memory.timestamp,
        importance: memory.importance,
        tags: memory.tags,
        domain: memory.domain,
        confidence: memory.confidence,
        lastAccessedAt: memory.lastAccessedAt,
        retrievalCount: memory.retrievalCount,
        lastRetrievedAt: memory.lastRetrievedAt,
        retrievalCues: memory.retrievalCues,
        previousVersions: memory.previousVersions,
    };
}

export async function searchAllDomainsMemoriesWithFallback(ctx: BotContext, query: string, limit = 5): Promise<MemorySearchResultLike[]> {
    const semantic = await searchAllDomainsMemories(ctx, query, limit);
    const recent = await getRecentMemories(ctx, 1000);
    const byId = new Map<string, MemorySearchResultLike>();

    for (const item of semantic) {
        byId.set(item.id, item);
    }

    for (const memory of recent) {
        const lexicalScore = lexicalMemoryScore(memory.content, query);
        if (lexicalScore < 0.45) continue;

        const normalizedScore = Math.min(0.99, lexicalScore);
        const existing = byId.get(memory.id);
        if (!existing || normalizedScore > existing.score) {
            byId.set(memory.id, memoryEntryToSearchResult(memory, normalizedScore));
        }
    }

    return Array.from(byId.values())
        .sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
        })
        .slice(0, limit);
}

export async function getDomainContextVector(ctx: BotContext, domain: string, query: string, limit = 5): Promise<string> {
    const svc = vectorService();
    if (!svc) return '';
    try {
        devLog('Fetching domain context vector:', { domain, query: query.slice(0, 100), limit });

        const primaryResults = await svc.searchMemories(query, String(ctx.from?.id), { domain, limit });
        let finalResults = primaryResults;

        if (primaryResults.length < 2) {
            devLog('Primary domain has too few results, using cross-domain fallback:', {
                domain,
                primaryCount: primaryResults.length,
            });

            const crossDomain = await svc.searchAllDomains(query, String(ctx.from?.id), limit);
            const seen = new Set(primaryResults.map(result => result.id));
            finalResults = [...primaryResults];

            for (const result of crossDomain) {
                if (seen.has(result.id)) continue;
                finalResults.push(result);
                seen.add(result.id);
                if (finalResults.length >= limit) break;
            }
        }

        const context = finalResults.map(result => result.content).join('\n');
        devLog('Domain context vector length:', context.length);
        return context;
    } catch (e) {
        console.error('Vector domain context error', e);
        return '';
    }
}

export async function cleanupOldMemories(ctx: BotContext, days?: number) {
    const svc = vectorService();
    if (!svc) return 0;
    try {
        devLog('Cleaning up old memories older than days:', days);
        const res = await svc.cleanupOldMemories(String(ctx.from?.id), days);
        devLog('Cleanup removed count:', res);
        return res;
    } catch (e) {
        console.error('Vector cleanup error', e);
        return 0;
    }
}

export async function getMemoryStats(ctx: BotContext) {
    const svc = vectorService();
    if (!svc) return { total: 0, domains: {} };
    try {
        devLog('Fetching memory stats');
        const res = await svc.getMemoryStats(String(ctx.from?.id));
        devLog('Memory stats:', res);
        return res;
    } catch (e) {
        console.error('Vector stats error', e);
        return { total: 0, domains: {} };
    }
}

export function calcImportance(role: string, content: string): number {
    let base = role === 'user' ? 0.7 : 0.5;
    if (/напоминание|событие/i.test(content)) base = 0.8;
    if (/[!\?]/.test(content)) base += 0.2;
    return Math.min(1, base);
}

export function extractTags(content: string): string[] {
    const tags: string[] = [];
    if (/тревог|паник|страх/i.test(content)) tags.push('тревога');
    if (/радост/i.test(content)) tags.push('радость');
    if (/грусть|печаль/i.test(content)) tags.push('грусть');
    if (/работ|офис/i.test(content)) tags.push('работа');
    if (/семь|родител/i.test(content)) tags.push('семья');
    if (/срочн|завтра/i.test(content)) tags.push('срочно');
    return Array.from(new Set(tags));
}


export async function getRecentMemories(ctx: BotContext, limit = 5): Promise<MemoryEntry[]> {
    const svc = vectorService();
    if (!svc) return [];
    try {
        devLog('Fetching recent memories:', { limit });
        const res = await svc.getRecentMemories(String(ctx.from?.id), limit);
        devLog('Recent memories fetched:', res.length);
        return res;
    } catch (e) {
        console.error('Recent memories fetch error', e);
        return [];
    }
}

export async function getAnchorMemories(ctx: BotContext, limit = 3) {
    const svc = vectorService();
    if (!svc) return [];
    try {
        const res = await svc.getAnchorMemories(String(ctx.from?.id), limit);
        devLog('Anchor memories fetched:', res.length);
        return res;
    } catch (e) {
        console.error('Anchor memories fetch error', e);
        return [];
    }
}

const DOMAIN_LABELS: Record<string, string> = {
    work: '💼 Работа',
    health: '🏥 Здоровье',
    family: '👨‍👩‍👧 Семья',
    finance: '💰 Финансы',
    education: '📚 Образование',
    hobbies: '🎨 Хобби',
    travel: '✈️ Путешествия',
    social: '👥 Общение',
    home: '🏠 Дом',
    personal: '🙋 Личное',
    entertainment: '🎬 Развлечения',
    general: '📝 Общее',
    contacts: '🧠 Психологические портреты',
};

/**
 * Генерирует читаемое резюме всего, что бот знает о пользователе.
 * Разбивает по доменам, факты о контактах выносит отдельно.
 */
export async function generateMemoryBiography(ctx: BotContext): Promise<string> {
    const all = await getRecentMemories(ctx, 500);
    if (all.length === 0) return 'В памяти пока нет сохранённых фактов о тебе.';

    // Психологические портреты хранятся в домене 'contacts' с тегом portrait:*
    const portraitFacts = all.filter(f =>
        f.domain === 'contacts' && f.tags?.some(t => String(t).startsWith('portrait:'))
    );
    const schemaFacts = all.filter(isSchemaMemory);
    const chapterFacts = all.filter(isChapterMemory);
    const userFacts = all.filter(f =>
        !isContactLikeMemory(f) && !isSyntheticMemory(f) && f.domain !== 'contacts'
    );
    const contactFacts = all.filter(f =>
        f.domain !== 'contacts' && isContactLikeMemory(f)
    );

    const byDomain: Record<string, MemoryEntry[]> = {};
    for (const fact of userFacts) {
        const d = fact.domain || 'general';
        if (!byDomain[d]) byDomain[d] = [];
        byDomain[d].push(fact);
    }

    const lines: string[] = ['Вот что я о тебе знаю:\n'];

    if (chapterFacts.length > 0) {
        lines.push('🧭 Сводные главы памяти');
        for (const chapter of chapterFacts.slice(0, 6)) {
            const summary = chapter.content
                .replace(/^\[ГЛАВА ПАМЯТИ:[^\]]+\]\s*/u, '')
                .split('\n')
                .filter(line => /^(Кратко|Текущее состояние|Открытые линии):/i.test(line))
                .slice(0, 3)
                .join(' ');
            lines.push(`• ${summary || chapter.content.slice(0, 240)}`);
        }
        lines.push('');
    }

    if (schemaFacts.length > 0) {
        lines.push('🧩 Устойчивые модели пользователя');
        for (const schema of schemaFacts.slice(0, 8)) {
            const summary = schema.content
                .replace(/^\[МОДЕЛЬ ПАМЯТИ:[^\]]+\]\s*/u, '')
                .split('\n')
                .filter(line => /^(Кратко|Как учитывать|Ограничения)/i.test(line))
                .slice(0, 3)
                .join(' ');
            lines.push(`• ${summary || schema.content.slice(0, 240)}`);
        }
        lines.push('');
    }

    for (const [domain, facts] of Object.entries(byDomain)) {
        if (facts.length === 0) continue;
        lines.push(DOMAIN_LABELS[domain] || domain);
        for (const f of facts.slice(0, 10)) {
            lines.push(`• ${f.content}`);
        }
        lines.push('');
    }

    if (contactFacts.length > 0) {
        lines.push('👥 О твоих контактах');
        for (const f of contactFacts.slice(0, 20)) {
            lines.push(`• ${f.content}`);
        }
        lines.push('');
    }

    if (portraitFacts.length > 0) {
        lines.push('🧠 Психологические портреты');
        for (const f of portraitFacts) {
            const nameTag = f.tags?.find(t => String(t).startsWith('portrait:'));
            const name = nameTag ? String(nameTag).replace('portrait:', '') : 'Контакт';
            // Показываем только краткое резюме, не весь портрет
            const summaryMatch = f.content.match(/Краткое резюме: (.+)/);
            const summary = summaryMatch ? summaryMatch[1] : f.content.slice(0, 120);
            lines.push(`• ${name}: ${summary}`);
        }
        lines.push('');
    }

    lines.push(`📊 Всего фактов в памяти: ${all.length}`);
    return lines.join('\n');
}

/**
 * Ищет факт по запросу и удаляет лучшее совпадение (если score >= 0.65).
 * Возвращает удалённый контент или undefined если ничего не найдено.
 */
export async function deleteMemoryByContent(
    ctx: BotContext,
    query: string
): Promise<string | undefined> {
    const svc = vectorService();
    if (!svc) return undefined;
    const userId = String(ctx.from?.id);

    const results = await svc.searchAllDomains(query, userId, 1);
    if (results.length === 0 || results[0].score < 0.65) return undefined;

    const best = results[0];
    await svc.deleteMemory(best.id, best.domain);
    devLog('🗑️ Факт удалён по запросу пользователя:', best.content.slice(0, 80));
    return best.content;
}

/**
 * Анализирует накопленные факты и возвращает 3-5 инсайтов о паттернах и трендах.
 * Полезно для самоотражения: "ты часто упоминаешь стресс", "много фактов о путешествиях".
 */
export async function generateMemoryInsights(ctx: BotContext): Promise<string> {
    const memories = await getRecentMemories(ctx, 200);
    if (memories.length < 5) {
        return 'Накопи больше воспоминаний — мне нужно хотя бы 5 фактов для анализа паттернов.';
    }

    const sample = memories
        .slice(0, 120)
        .map(m => `[${m.domain}] ${m.content}`)
        .join('\n');

    try {
        const resp = await createChatCompletionForTask('memoryExtraction', {
            messages: [
                {
                    role: 'system',
                    content: 'Ты анализируешь факты о человеке и находишь паттерны, тренды и интересные наблюдения. Отвечай по-русски, кратко и конкретно.',
                },
                {
                    role: 'user',
                    content: `Вот факты о человеке из его долговременной памяти (${memories.length} всего, показаны ${Math.min(120, memories.length)}):

${sample}

Найди 3-5 интересных паттерна, тренда или наблюдения. Примеры того, что стоит искать:
- Повторяющиеся темы или эмоции
- Противоречия или изменения во времени
- Области где накопилось много фактов
- Необычные или примечательные детали
- Возможные связи между разными сферами жизни

Каждое наблюдение — 1-2 предложения. Будь конкретным, используй данные из фактов.`,
                },
            ],
            temperature: 1,
        });

        const text = resp.choices[0]?.message?.content?.trim();
        if (!text) return 'Не удалось сгенерировать инсайты. Попробуй позже.';

        return `🔍 Инсайты из твоей памяти (${memories.length} фактов):\n\n${text}`;
    } catch (e) {
        console.error('generateMemoryInsights error:', e);
        return 'Не удалось проанализировать память. Попробуй позже.';
    }
}

/**
 * Ищет факт по запросу без удаления.
 * Возвращает лучшее совпадение или undefined.
 */
export async function findMemoryByContent(
    ctx: BotContext,
    query: string
): Promise<{ id: string; content: string; domain: string; score: number; previousVersions?: MemoryEntry['previousVersions'] } | undefined> {
    const svc = vectorService();
    if (!svc) return undefined;
    const userId = String(ctx.from?.id);

    let results = await svc.searchAllDomains(query, userId, 1);
    if (results.length === 0 || results[0].score < 0.55) {
        const recent = await getRecentMemories(ctx, 1000);
        const lexical = recent
            .map((memory) => ({ memory, score: lexicalMemoryScore(memory.content, query) }))
            .filter((item) => item.score >= 0.45)
            .sort((a, b) => {
                if (b.score !== a.score) return b.score - a.score;
                return b.memory.timestamp.getTime() - a.memory.timestamp.getTime();
            });

        if (lexical.length === 0) return undefined;
        results = [memoryEntryToSearchResult(lexical[0].memory, Math.min(0.99, lexical[0].score))];
    }

    const best = results[0];
    return {
        id: best.id,
        content: best.content,
        domain: best.domain,
        score: best.score,
        previousVersions: (best as any).previousVersions,
    };
}

/**
 * Удаляет факт по ID и домену.
 */
export async function deleteMemoryById(
    ctx: BotContext,
    memoryId: string,
    domain: string
): Promise<void> {
    const svc = vectorService();
    if (!svc) return;
    await svc.deleteMemory(memoryId, domain);
    devLog('🗑️ Факт удалён по ID:', memoryId);
}

/**
 * Эпизодическая компрессия: сжимает старые факты домена в 3-5 «эпизодных» воспоминаний.
 *
 * Алгоритм:
 * 1. Загружает факты старше olderThanDays (якоря пропускаются — они уже эпизодные)
 * 2. Если < 5 фактов — нечего сжимать
 * 3. LLM синтезирует 3-5 обобщённых утверждений с высокой важностью
 * 4. Сохраняет синтез как anchor-факты с тегом episodic-compression
 * 5. Удаляет исходные факты
 *
 * Возвращает { compressed, deleted }
 */
export async function compressOldMemories(
    ctx: BotContext,
    domain: string,
    olderThanDays = 60
): Promise<{ compressed: number; deleted: number }> {
    const svc = vectorService();
    if (!svc) return { compressed: 0, deleted: 0 };

    const userId = String(ctx.from?.id);
    const old = (await svc.getMemoriesForCompression(userId, domain, olderThanDays))
        .filter(memory => !isContactLikeMemory(memory) && !isSyntheticMemory(memory));

    if (old.length < 5) {
        devLog(`compressOldMemories [${domain}]: only ${old.length} facts, skipping`);
        return { compressed: 0, deleted: 0 };
    }

    const factsText = old.map((m, i) =>
        `${i + 1}. [importance=${m.importance.toFixed(2)}, conf=${(m.confidence ?? 0.6).toFixed(2)}] ${m.content}`
    ).join('\n');

    let summaries: string[] = [];
    try {
        const resp = await createChatCompletionForTask('memoryExtraction', {
            messages: [
                {
                    role: 'system',
                    content: 'Ты синтезируешь группу фактов о человеке в компактные обобщения. Отвечай только валидным JSON.',
                },
                {
                    role: 'user',
                    content: `Домен: ${domain}
Факты (${old.length} штук, старше ${olderThanDays} дней):

${factsText}

Сожми в 3-5 обобщённых утверждений. Каждое должно:
- Охватывать несколько исходных фактов
- Быть конкретным (не "интересуется работой", а "работает в IT, предпочитает бэкенд")
- Сохранять наиболее значимую информацию

JSON: {"summaries": ["утверждение 1", "утверждение 2", ...]}`,
                },
            ],
            temperature: 1,
        });

        const data = parseLLMJson<{ summaries?: string[] }>(
            resp.choices[0]?.message?.content?.trim() || ''
        );
        if (data?.summaries && Array.isArray(data.summaries)) {
            summaries = data.summaries.filter(s => typeof s === 'string' && s.trim()).slice(0, 5);
        }
    } catch (e) {
        console.error('compressOldMemories LLM error:', e);
        return { compressed: 0, deleted: 0 };
    }

    if (summaries.length === 0) return { compressed: 0, deleted: 0 };

    // Сохраняем синтез как anchor-факты
    const now = new Date();
    for (const summary of summaries) {
        await svc.saveMemory({
            content: summary,
            domain,
            timestamp: now,
            importance: 0.85,
            tags: ['episodic-compression'],
            userId,
            botId,
            isAnchor: true,
            confidence: 0.8,
            lastAccessedAt: now,
        });
    }

    // Удаляем исходные факты
    await Promise.allSettled(old.map(m => svc.deleteMemory(m.id, domain)));

    devLog(`compressOldMemories [${domain}]: ${old.length} facts → ${summaries.length} episodes`);
    return { compressed: summaries.length, deleted: old.length };
}

/**
 * Отчёт о здоровье памяти: низкая достоверность, давний доступ, распределение по доменам.
 */
export async function getMemoryHealthReport(ctx: BotContext): Promise<string> {
    const svc = vectorService();
    if (!svc) return '❌ Векторный сервис недоступен.';

    const all = await getRecentMemories(ctx, 1000);
    if (all.length === 0) return 'Память пуста.';

    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;

    let lowConfidence = 0;
    let stale = 0;             // не вспоминался > 60 дней
    let expiringSoon = 0;      // expiresAt в ближайшие 7 дней
    let contactFactsWithoutTelegramId = 0;
    let contactFactsWithoutStableIdentity = 0;
    let contactFactsWithoutSubjectTag = 0;
    let factsWithHistory = 0;
    let neverRetrieved = 0;
    let frequentlyRetrieved = 0;
    let totalRetrievals = 0;
    let atomicFacts = 0;
    let confidenceSum = 0;
    let factsWithSourceContext = 0;
    let factsWithEpisodeLink = 0;
    let factsWithSourceMemoryLink = 0;
    let weakEvidenceFacts = 0;
    let importanceCappedFacts = 0;
    let anchorCappedFacts = 0;
    let criticReviewedFacts = 0;
    let qualityTaggedFacts = 0;
    let currentStateFacts = 0;
    let futurePlanFacts = 0;
    let pastEventFacts = 0;
    let possiblyStaleFacts = 0;
    let directFacts = 0;
    let reportedFacts = 0;
    let inferredFacts = 0;
    let ambiguousInferenceFacts = 0;
    let independentConfirmations = 0;
    let sameSourceConfirmations = 0;
    const domainCounts: Record<string, number> = {};
    const duplicateGroups = new Map<string, MemoryEntry[]>();

    for (const m of all) {
        const conf = m.confidence ?? 0.6;
        const synthetic = isSyntheticMemory(m) || m.memoryKind === 'portrait';
        if (!synthetic) {
            atomicFacts++;
            confidenceSum += conf;
            if (m.sourceContext?.trim()) factsWithSourceContext++;
            if (m.sourceEpisodeId?.trim()) factsWithEpisodeLink++;
            if ((m.sourceMemoryIds?.length ?? 0) > 0) factsWithSourceMemoryLink++;
            if (m.tags?.includes('weak-evidence')) weakEvidenceFacts++;
            if (m.tags?.includes('importance-capped')) importanceCappedFacts++;
            if (m.tags?.includes('anchor-capped')) anchorCappedFacts++;
            if (m.tags?.some(tag => ['critic-reviewed', 'critic-rewritten'].includes(String(tag)))) criticReviewedFacts++;
            if (m.tags?.some(tag => String(tag).startsWith('quality:'))) qualityTaggedFacts++;
            if (m.tags?.includes('temporal_scope:current_state')) currentStateFacts++;
            if (m.tags?.includes('temporal_scope:future_plan')) futurePlanFacts++;
            if (m.tags?.includes('temporal_scope:past_event')) pastEventFacts++;
            if (m.tags?.includes('possibly-stale')) possiblyStaleFacts++;
            if (m.tags?.includes('inference:direct')) directFacts++;
            if (m.tags?.includes('inference:reported')) reportedFacts++;
            if (m.tags?.includes('inference:inferred')) inferredFacts++;
            if (m.tags?.includes('inference:ambiguous')) ambiguousInferenceFacts++;
            if (m.tags?.includes('independent-confirmation')) independentConfirmations++;
            if (m.tags?.includes('same-source-confirmation')) sameSourceConfirmations++;
        }
        if (conf < 0.4) lowConfidence++;
        if ((m.previousVersions?.length ?? 0) > 0) factsWithHistory++;
        const retrievalCount = m.retrievalCount ?? 0;
        totalRetrievals += retrievalCount;
        if (retrievalCount === 0) neverRetrieved++;
        if (retrievalCount >= 5) frequentlyRetrieved++;

        const accessed = m.lastAccessedAt ?? m.timestamp;
        const daysSinceAccess = (now - new Date(accessed).getTime()) / day;
        if (daysSinceAccess > 60) stale++;

        if (m.expiresAt) {
            const msToExpire = new Date(m.expiresAt).getTime() - now;
            if (msToExpire > 0 && msToExpire < 7 * day) expiringSoon++;
        }

        if (isContactLikeMemory(m) && !hasContactId(m.tags)) {
            contactFactsWithoutTelegramId++;
        }
        if (isContactLikeMemory(m)) {
            if (!hasStableContactIdentity(m.tags)) contactFactsWithoutStableIdentity++;
            if (!m.tags?.includes('subject:contact')) contactFactsWithoutSubjectTag++;
        }

        domainCounts[m.domain] = (domainCounts[m.domain] ?? 0) + 1;

        const canonical = canonicalFactText(m.content);
        if (canonical.length >= 20) {
            const group = duplicateGroups.get(canonical) ?? [];
            group.push(m);
            duplicateGroups.set(canonical, group);
        }
    }

    const likelyDuplicateGroups = [...duplicateGroups.values()]
        .filter(group => group.length > 1)
        .sort((a, b) => b.length - a.length);
    const asyncErrors = getAsyncTaskErrors();

    const lines: string[] = [
        `🏥 Состояние долговременной памяти\n`,
        `📊 Всего фактов: ${all.length}`,
        `⚠️  Низкая достоверность (< 0.4): ${lowConfidence}`,
        `🕸️  Давно не всплывали (> 60 дней): ${stale}`,
        `⏳ Скоро истекут (< 7 дней): ${expiringSoon}`,
        `🧬 Факты с историей изменений: ${factsWithHistory}`,
        `🧠 Никогда не всплывали в ответах: ${neverRetrieved}`,
        `💪 Часто вспоминались (>=5): ${frequentlyRetrieved}`,
        `🔁 Всего retrieval-укреплений: ${totalRetrievals}`,
        `🎯 Средняя уверенность атомарных фактов: ${atomicFacts ? (confidenceSum / atomicFacts).toFixed(2) : 'n/a'}`,
        `🧾 Факты с sourceContext: ${factsWithSourceContext}/${atomicFacts}`,
        `🎞️  Факты с sourceEpisodeId: ${factsWithEpisodeLink}/${atomicFacts}`,
        `🔗 Факты со ссылкой на sourceMemoryIds: ${factsWithSourceMemoryLink}/${atomicFacts}`,
        `🧐 Проверено critic-gate: ${criticReviewedFacts}/${atomicFacts}`,
        `⚙️  Quality-tagged факты: ${qualityTaggedFacts}/${atomicFacts}`,
        `🟡 Weak-evidence факты: ${weakEvidenceFacts}/${atomicFacts}`,
        `🧯 Importance-capped факты: ${importanceCappedFacts}/${atomicFacts}`,
        `⚓ Anchor-capped факты: ${anchorCappedFacts}/${atomicFacts}`,
        `🕰️  Current-state факты: ${currentStateFacts}/${atomicFacts}`,
        `📌 Future-plan факты: ${futurePlanFacts}/${atomicFacts}`,
        `✅ Past-event факты: ${pastEventFacts}/${atomicFacts}`,
        `🧊 Possibly-stale факты: ${possiblyStaleFacts}/${atomicFacts}`,
        `👁️  Direct факты: ${directFacts}/${atomicFacts}`,
        `🗣️  Reported факты: ${reportedFacts}/${atomicFacts}`,
        `🧩 Inferred факты: ${inferredFacts}/${atomicFacts}`,
        `❔ Ambiguous inference факты: ${ambiguousInferenceFacts}/${atomicFacts}`,
        `✅ Независимые подтверждения: ${independentConfirmations}/${atomicFacts}`,
        `🔂 Повторы из того же источника: ${sameSourceConfirmations}/${atomicFacts}`,
        `♻️  Вероятные точные дубли: ${likelyDuplicateGroups.length} групп`,
        `👥 Контактные факты без Telegram contact_id: ${contactFactsWithoutTelegramId}`,
        `👥 Контактные факты без stable identity: ${contactFactsWithoutStableIdentity}`,
        `👥 Контактные факты без subject:contact: ${contactFactsWithoutSubjectTag}`,
        ``,
        `📂 По доменам:`,
    ];

    const sorted = Object.entries(domainCounts).sort((a, b) => b[1] - a[1]);
    for (const [domain, count] of sorted) {
        lines.push(`  ${domain}: ${count}`);
    }

    if (lowConfidence > 0) {
        lines.push(`\n💡 Совет: запусти /memory_cleanup чтобы очистить устаревшие факты,`);
        lines.push(`  или /memory_compress <домен> чтобы сжать старые воспоминания.`);
    }
    if (atomicFacts > 0 && factsWithSourceContext / atomicFacts < 0.5) {
        lines.push(`\n💡 У многих старых фактов нет sourceContext. Новые фоновые факты уже сохраняются с опорой;`);
        lines.push(`  для старой памяти лучше постепенно использовать /memory_consolidate.`);
    }
    if (weakEvidenceFacts > 0) {
        lines.push(`\n💡 Weak-evidence факты попадут в индекс сомнений после /memory_consolidate.`);
    }
    if (contactFactsWithoutTelegramId > 0) {
        lines.push(`\n💡 Для старых контактных фактов запусти /memory_repair_contacts.`);
    }
    if (contactFactsWithoutSubjectTag > 0) {
        lines.push(`\n💡 Старые контактные факты без subject:contact будут читаться fallback-поиском,`);
        lines.push(`  но лучше постепенно мигрировать их через /memory_repair_contacts.`);
    }
    if (likelyDuplicateGroups.length > 0) {
        lines.push(`\n🔎 Примеры вероятных дублей:`);
        for (const group of likelyDuplicateGroups.slice(0, 3)) {
            const sample = group[0].content.slice(0, 100);
            lines.push(`  ×${group.length}: ${sample}`);
        }
    }
    if (Object.keys(asyncErrors).length > 0) {
        lines.push(`\n⚠️ Ошибки фоновых задач памяти:`);
        for (const [task, count] of Object.entries(asyncErrors)) {
            lines.push(`  ${task}: ${count}`);
        }
    }

    return lines.join('\n');
}
