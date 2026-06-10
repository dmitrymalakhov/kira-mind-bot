import { BotContext, MemoryEntry } from '../types';
import { PREDEFINED_DOMAINS } from '../constants/domains';
import { config } from '../config';
import { createChatCompletionForTask } from '../ai/chatCompletion';
import { devLog, parseLLMJson } from '../utils';
import { getVectorService } from './VectorServiceFactory';

const CHAPTER_TAG = 'memory-chapter';
const DEFAULT_LIMIT = 600;
const DEFAULT_MIN_FACTS = 8;
const DEFAULT_PERIOD_DAYS = 180;
const DEFAULT_MAX_DOMAINS = 6;
const MAX_SOURCES_PER_PROMPT = 80;
const MAX_SOURCE_IDS_PER_CHAPTER = 80;

export interface MemoryConsolidationOptions {
    domain?: string;
    limit?: number;
    minFacts?: number;
    periodDays?: number;
    maxDomains?: number;
}

export interface MemoryConsolidationResult {
    created: number;
    replaced: number;
    sourceCount: number;
    domains: string[];
    skipped: string[];
}

interface ChapterLLMResult {
    title?: string;
    summary?: string;
    domains?: string[];
    entities?: string[];
    timeRangeLabel?: string;
    currentState?: string;
    openLoops?: string[];
    sourceIds?: string[];
    salience?: number;
}

interface ChaptersLLMResponse {
    chapters?: ChapterLLMResult[];
}

function normalizeDomain(domain: string | undefined): string {
    const normalized = String(domain || '').trim().toLowerCase();
    return Object.values(PREDEFINED_DOMAINS).includes(normalized as any)
        ? normalized
        : PREDEFINED_DOMAINS.GENERAL;
}

function isEpisode(memory: Pick<MemoryEntry, 'content' | 'tags'>): boolean {
    return (memory.tags ?? []).includes('memory-episode') ||
        memory.content.startsWith('[ЭПИЗОД ПАМЯТИ:');
}

function isChapter(memory: Pick<MemoryEntry, 'content' | 'tags'>): boolean {
    return (memory.tags ?? []).includes(CHAPTER_TAG) ||
        memory.content.startsWith('[ГЛАВА ПАМЯТИ:');
}

function isPortrait(memory: Pick<MemoryEntry, 'domain' | 'tags'>): boolean {
    return memory.domain === PREDEFINED_DOMAINS.CONTACTS &&
        (memory.tags ?? []).some((tag) => String(tag).startsWith('portrait:'));
}

function sourceDomains(memory: MemoryEntry): string[] {
    if (!isEpisode(memory)) return [normalizeDomain(memory.domain)];

    const fromTags = (memory.tags ?? [])
        .filter((tag) => String(tag).startsWith('episode_domain:'))
        .map((tag) => normalizeDomain(String(tag).replace('episode_domain:', '')));

    return fromTags.length > 0 ? [...new Set(fromTags)] : [PREDEFINED_DOMAINS.GENERAL];
}

function clamp01(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.min(1, Math.max(0, value))
        : fallback;
}

function normalizeStringList(values: unknown, limit: number): string[] {
    if (!Array.isArray(values)) return [];
    return [...new Set(
        values
            .map((value) => String(value).trim())
            .filter((value) => value.length > 0 && value.length <= 120)
    )].slice(0, limit);
}

function safeTagValue(value: string): string {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9_.:-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80) || 'general';
}

function truncate(value: string, max: number): string {
    const normalized = value.replace(/\s+/g, ' ').trim();
    return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

function sourceRank(memory: MemoryEntry): number {
    const importance = memory.importance ?? 0.5;
    const confidence = memory.confidence ?? 0.6;
    const ageDays = Math.max(0, (Date.now() - new Date(memory.timestamp).getTime()) / 86_400_000);
    const recency = ageDays < 7 ? 0.18 : ageDays < 30 ? 0.12 : ageDays < 90 ? 0.06 : 0;
    const confirmations = Math.min(0.12, ((memory.confirmationCount ?? 1) - 1) * 0.03);
    const familiarity = Math.min(0.10, Math.log1p(Math.max(0, memory.retrievalCount ?? 0)) * 0.02);
    return importance * 0.55 + confidence * 0.25 + recency + confirmations + familiarity;
}

function formatSource(memory: MemoryEntry, index: number): string {
    const kind = isEpisode(memory) ? 'эпизод' : 'факт';
    const status = memory.status ? `; status=${memory.status}` : '';
    const tags = memory.tags?.length ? `; tags=${memory.tags.slice(0, 6).join(',')}` : '';
    return [
        `${index + 1}. id=${memory.id}`,
        `kind=${kind}`,
        `date=${new Date(memory.timestamp).toISOString().slice(0, 10)}`,
        `domain=${memory.domain}`,
        `importance=${(memory.importance ?? 0.5).toFixed(2)}`,
        `confidence=${(memory.confidence ?? 0.6).toFixed(2)}${status}${tags}`,
        `content="${truncate(memory.content, 520)}"`,
    ].join('; ');
}

function normalizeChapter(chapter: ChapterLLMResult, domain: string, fallbackSources: MemoryEntry[]): ChapterLLMResult | null {
    const title = String(chapter.title || '').trim().slice(0, 90);
    const summary = String(chapter.summary || '').trim().slice(0, 1200);
    if (!title || !summary) return null;

    const sourceIdSet = new Set(fallbackSources.map((m) => m.id));
    const sourceIds = normalizeStringList(chapter.sourceIds, MAX_SOURCE_IDS_PER_CHAPTER)
        .filter((id) => sourceIdSet.has(id));

    return {
        title,
        summary,
        domains: normalizeStringList(chapter.domains, 5).map(normalizeDomain),
        entities: normalizeStringList(chapter.entities, 16),
        timeRangeLabel: String(chapter.timeRangeLabel || '').trim().slice(0, 120),
        currentState: String(chapter.currentState || '').trim().slice(0, 700),
        openLoops: normalizeStringList(chapter.openLoops, 10),
        sourceIds: sourceIds.length > 0
            ? sourceIds
            : fallbackSources.slice(0, 20).map((m) => m.id),
        salience: clamp01(chapter.salience, domain === PREDEFINED_DOMAINS.GENERAL ? 0.72 : 0.78),
    };
}

function formatChapterContent(chapter: ChapterLLMResult): string {
    return [
        `[ГЛАВА ПАМЯТИ: ${chapter.title}]`,
        chapter.timeRangeLabel ? `Период: ${chapter.timeRangeLabel}` : '',
        `Кратко: ${chapter.summary}`,
        chapter.currentState ? `Текущее состояние: ${chapter.currentState}` : '',
        chapter.openLoops?.length ? `Открытые линии: ${chapter.openLoops.join('; ')}` : '',
        chapter.entities?.length ? `Ключевые сущности: ${chapter.entities.join(', ')}` : '',
    ].filter(Boolean).join('\n');
}

async function synthesizeChapters(domain: string, sources: MemoryEntry[], periodDays: number): Promise<ChapterLLMResult[]> {
    const selected = sources
        .slice()
        .sort((a, b) => sourceRank(b) - sourceRank(a))
        .slice(0, MAX_SOURCES_PER_PROMPT);
    const sourceText = selected.map(formatSource).join('\n');

    try {
        const resp = await createChatCompletionForTask('memoryConsolidation', {
            messages: [
                {
                    role: 'system',
                    content: 'Ты выполняешь консолидацию долговременной памяти ассистента. Отвечай только валидным JSON.',
                },
                {
                    role: 'user',
                    content: `Домен памяти: ${domain}
Окно консолидации: последние ${periodDays} дней.
Исходные воспоминания (${selected.length} из ${sources.length}):

${sourceText}

Собери 1-3 автобиографические главы памяти. Это НЕ список фактов.
Нужно восстановить человеческую смысловую структуру:
- устойчивые паттерны и повторяющиеся темы;
- текущие состояния, которые важны для будущих ответов;
- изменения во времени и незавершенные линии;
- ключевых людей, проекты, места и события;
- где возможно, отделяй актуальное от устаревшего.

Правила:
- Не выдумывай новые факты.
- Не теряй важные конкретные имена/проекты/места.
- sourceIds должны содержать только id из списка выше, на которых основана глава.
- Если исходники противоречат друг другу, отрази это как изменение/неопределенность.

JSON:
{
  "chapters": [
    {
      "title": "короткое название главы",
      "summary": "2-5 предложений: смысловая глава, не механический список",
      "domains": ["${domain}"],
      "entities": ["люди/проекты/места"],
      "timeRangeLabel": "например: последние 6 месяцев",
      "currentState": "что сейчас важно помнить",
      "openLoops": ["незавершенные дела/вопросы"],
      "sourceIds": ["id1", "id2"],
      "salience": 0.0-1.0
    }
  ]
}`,
                },
            ],
            temperature: 0.35,
            response_format: { type: 'json_object' },
        });

        const parsed = parseLLMJson<ChaptersLLMResponse>(resp.choices[0]?.message?.content || '');
        const rawChapters = Array.isArray(parsed?.chapters) ? parsed.chapters : [];
        return rawChapters
            .map((chapter) => normalizeChapter(chapter, domain, selected))
            .filter((chapter): chapter is ChapterLLMResult => chapter !== null)
            .slice(0, 3);
    } catch (e) {
        devLog('MemoryConsolidationService: LLM failed', e);
        return [];
    }
}

async function replaceExistingChapters(userId: string, chapterKey: string, domain: string): Promise<number> {
    const svc = getVectorService();
    if (!svc) return 0;

    const tag = `chapter_key:${chapterKey}`;
    const existing = await svc.getMemoriesByTag(userId, CHAPTER_TAG).catch(() => []);
    const toDelete = existing.filter((memory) =>
        memory.domain === domain &&
        (memory.tags ?? []).includes(tag)
    );

    await Promise.allSettled(toDelete.map((memory) => svc.deleteMemory(memory.id, memory.domain)));
    return toDelete.length;
}

export async function runMemoryConsolidationForUser(
    userId: string,
    options: MemoryConsolidationOptions = {}
): Promise<MemoryConsolidationResult> {
    const svc = getVectorService();
    if (!svc) {
        return { created: 0, replaced: 0, sourceCount: 0, domains: [], skipped: ['vector-service-unavailable'] };
    }

    const limit = options.limit ?? DEFAULT_LIMIT;
    const minFacts = options.minFacts ?? DEFAULT_MIN_FACTS;
    const periodDays = options.periodDays ?? DEFAULT_PERIOD_DAYS;
    const maxDomains = options.domain ? 1 : (options.maxDomains ?? DEFAULT_MAX_DOMAINS);
    const requestedDomain = options.domain ? normalizeDomain(options.domain) : undefined;
    const cutoff = Date.now() - periodDays * 86_400_000;

    const all = await svc.getRecentMemories(userId, limit);
    const eligible = all.filter((memory) => {
        if (isChapter(memory)) return false;
        if (isPortrait(memory)) return false;
        if (memory.status === 'expired') return false;
        if (new Date(memory.timestamp).getTime() < cutoff) return false;
        return true;
    });

    const grouped = new Map<string, MemoryEntry[]>();
    for (const memory of eligible) {
        for (const domain of sourceDomains(memory)) {
            if (requestedDomain && domain !== requestedDomain) continue;
            const list = grouped.get(domain) ?? [];
            if (!list.some((item) => item.id === memory.id)) list.push(memory);
            grouped.set(domain, list);
        }
    }

    const groups = [...grouped.entries()]
        .sort((a, b) => b[1].length - a[1].length)
        .slice(0, maxDomains);

    let created = 0;
    let replaced = 0;
    let sourceCount = 0;
    const domains: string[] = [];
    const skipped: string[] = [];
    const now = new Date();

    for (const [domain, memories] of groups) {
        const sources = memories
            .slice()
            .sort((a, b) => sourceRank(b) - sourceRank(a));

        if (sources.length < minFacts) {
            skipped.push(`${domain}: only ${sources.length}/${minFacts}`);
            continue;
        }

        const chapters = await synthesizeChapters(domain, sources, periodDays);
        if (chapters.length === 0) {
            skipped.push(`${domain}: no chapters generated`);
            continue;
        }

        const chapterKey = `${safeTagValue(domain)}:rolling-${periodDays}d`;
        replaced += await replaceExistingChapters(userId, chapterKey, domain);

        for (const chapter of chapters) {
            const sourceIds = chapter.sourceIds?.slice(0, MAX_SOURCE_IDS_PER_CHAPTER) ?? [];
            const salience = clamp01(chapter.salience, 0.78);
            const sourceDates = sources
                .filter((source) => sourceIds.includes(source.id))
                .map((source) => new Date(source.timestamp).getTime())
                .filter(Number.isFinite);
            const validFrom = sourceDates.length > 0
                ? new Date(Math.min(...sourceDates))
                : new Date(cutoff);

            await svc.saveMemory({
                content: formatChapterContent(chapter),
                domain,
                timestamp: now,
                importance: Math.max(0.76, salience),
                tags: [
                    CHAPTER_TAG,
                    'autobiographical',
                    'subject:user',
                    `chapter_domain:${domain}`,
                    `chapter_key:${chapterKey}`,
                    `chapter_period:${periodDays}d`,
                ],
                userId,
                botId: config.botUsername.toLowerCase(),
                isAnchor: salience >= 0.9 || undefined,
                confidence: 0.82,
                lastAccessedAt: now,
                memoryKind: 'chapter',
                strength: Math.min(1, 0.70 + salience * 0.22),
                vividness: Math.min(1, 0.40 + salience * 0.20),
                specificity: Math.min(1, 0.45 + (chapter.entities?.length ?? 0) * 0.025 + sourceIds.length * 0.004),
                sourceContext: `Сводная глава по ${sources.length} воспоминаниям домена ${domain} за ${periodDays} дней.`,
                sourceMemoryIds: sourceIds,
                extractionMethod: 'consolidation',
                subject: 'user',
                predicate: `memory_chapter:${domain}`,
                object: chapter.title,
                validFrom,
                status: 'active',
                confirmationCount: sourceIds.length || sources.length,
                lastConfirmedAt: now,
            });
            created++;
            sourceCount += sourceIds.length || sources.length;
        }

        domains.push(domain);
    }

    if (groups.length === 0) {
        skipped.push(requestedDomain ? `${requestedDomain}: no eligible memories` : 'no eligible memories');
    }

    return {
        created,
        replaced,
        sourceCount,
        domains,
        skipped,
    };
}

export async function runMemoryConsolidationForContext(
    ctx: BotContext,
    options: MemoryConsolidationOptions = {}
): Promise<MemoryConsolidationResult> {
    const userId = ctx.from?.id;
    if (!userId) {
        return { created: 0, replaced: 0, sourceCount: 0, domains: [], skipped: ['missing-user-id'] };
    }
    return runMemoryConsolidationForUser(String(userId), options);
}
