import { BotContext, MemoryEntry, MemoryKind } from '../types';
import { PREDEFINED_DOMAINS } from '../constants/domains';
import { config } from '../config';
import openai from '../openai';
import { devLog, parseLLMJson } from '../utils';
import { getVectorService } from './VectorServiceFactory';

const SCHEMA_TAG = 'memory-schema';
const SCHEMA_SET_TAG = 'schema_set:user-model-v1';
const DEFAULT_LIMIT = 800;
const DEFAULT_MIN_SOURCES = 14;
const DEFAULT_PERIOD_DAYS = 240;
const MAX_SOURCES_PER_PROMPT = 120;
const MAX_SOURCE_IDS_PER_SCHEMA = 80;
const MAX_SCHEMAS = 8;

type SchemaDimension =
    | 'identity'
    | 'preference'
    | 'routine'
    | 'boundary'
    | 'relationship'
    | 'goal_pattern'
    | 'decision_style'
    | 'stressor'
    | 'communication_style'
    | 'support_style'
    | 'work_style'
    | 'health_pattern'
    | 'unknown';

export interface MemorySchemaConsolidationOptions {
    domain?: string;
    limit?: number;
    minSources?: number;
    periodDays?: number;
}

export interface MemorySchemaConsolidationResult {
    created: number;
    replaced: number;
    sourceCount: number;
    schemaTitles: string[];
    skipped: string[];
}

interface UserSchemaLLMResult {
    title?: string;
    dimension?: string;
    summary?: string;
    guidance?: string;
    cues?: string[];
    domains?: string[];
    entities?: string[];
    caution?: string;
    sourceIds?: string[];
    confidence?: number;
    salience?: number;
}

interface UserSchemaLLMResponse {
    schemas?: UserSchemaLLMResult[];
}

function normalizeDomain(domain: string | undefined): string {
    const normalized = String(domain || '').trim().toLowerCase();
    return Object.values(PREDEFINED_DOMAINS).includes(normalized as any)
        ? normalized
        : PREDEFINED_DOMAINS.PERSONAL;
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
            .filter((value) => value.length > 0 && value.length <= 160)
    )].slice(0, limit);
}

function safeTagValue(value: string): string {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9_.:-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80) || 'unknown';
}

function truncate(value: string, max: number): string {
    const normalized = value.replace(/\s+/g, ' ').trim();
    return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

function isEpisode(memory: Pick<MemoryEntry, 'content' | 'tags'>): boolean {
    return (memory.tags ?? []).includes('memory-episode') ||
        memory.content.startsWith('[ЭПИЗОД ПАМЯТИ:');
}

function isChapter(memory: Pick<MemoryEntry, 'content' | 'tags'>): boolean {
    return (memory.tags ?? []).includes('memory-chapter') ||
        memory.content.startsWith('[ГЛАВА ПАМЯТИ:');
}

function isSchema(memory: Pick<MemoryEntry, 'content' | 'tags'>): boolean {
    return (memory.tags ?? []).includes(SCHEMA_TAG) ||
        memory.content.startsWith('[МОДЕЛЬ ПАМЯТИ:');
}

function isPortrait(memory: Pick<MemoryEntry, 'domain' | 'tags'>): boolean {
    return memory.domain === PREDEFINED_DOMAINS.CONTACTS &&
        (memory.tags ?? []).some((tag) => String(tag).startsWith('portrait:'));
}

function sourceMatchesDomain(memory: MemoryEntry, domain: string | undefined): boolean {
    if (!domain) return true;
    const normalized = normalizeDomain(domain);
    if (normalizeDomain(memory.domain) === normalized) return true;
    return (memory.tags ?? []).some((tag) =>
        tag === `episode_domain:${normalized}` ||
        tag === `chapter_domain:${normalized}`
    );
}

function normalizeDimension(value: unknown): SchemaDimension {
    const normalized = String(value || '').trim().toLowerCase();
    switch (normalized) {
        case 'identity':
        case 'preference':
        case 'routine':
        case 'boundary':
        case 'relationship':
        case 'goal_pattern':
        case 'decision_style':
        case 'stressor':
        case 'communication_style':
        case 'support_style':
        case 'work_style':
        case 'health_pattern':
            return normalized;
        default:
            return 'unknown';
    }
}

function schemaMemoryKind(dimension: SchemaDimension): MemoryKind {
    switch (dimension) {
        case 'preference':
            return 'preference';
        case 'routine':
            return 'routine';
        case 'boundary':
            return 'boundary';
        case 'relationship':
            return 'relationship';
        case 'goal_pattern':
            return 'open_loop';
        case 'identity':
        case 'decision_style':
        case 'stressor':
        case 'communication_style':
        case 'support_style':
        case 'work_style':
        case 'health_pattern':
        case 'unknown':
        default:
            return 'trait';
    }
}

function sourceRank(memory: MemoryEntry): number {
    const importance = memory.importance ?? 0.5;
    const confidence = memory.confidence ?? 0.6;
    const strength = memory.strength ?? 0.45;
    const specificity = memory.specificity ?? 0.45;
    const ageDays = Math.max(0, (Date.now() - new Date(memory.timestamp).getTime()) / 86_400_000);
    const recency = ageDays < 14 ? 0.16 : ageDays < 60 ? 0.10 : ageDays < 180 ? 0.04 : 0;
    const confirmations = Math.min(0.10, ((memory.confirmationCount ?? 1) - 1) * 0.025);
    const tags = memory.tags ?? [];
    const kindBoost =
        isChapter(memory) ? 0.12 :
        isEpisode(memory) ? 0.08 :
        ['preference', 'routine', 'boundary', 'relationship', 'trait', 'open_loop', 'goal'].includes(memory.memoryKind ?? '') ? 0.08 :
        0;
    const weakPenalty = tags.includes('weak-evidence') || tags.some(tag => String(tag).startsWith('quality:')) ? 0.14 : 0;
    const stalePenalty = tags.includes('possibly-stale') || memory.status === 'unknown' ? 0.10 : 0;
    const inferencePenalty =
        tags.includes('inference:ambiguous') ? 0.16 :
            tags.includes('inference:inferred') ? 0.10 :
                tags.includes('inference:reported') ? 0.05 :
                    0;
    const temporalPenalty =
        tags.includes('temporal_scope:current_state') && ageDays > 90 ? 0.08 :
            tags.includes('temporal_scope:future_plan') && ageDays > 30 ? 0.05 :
                0;
    return importance * 0.36 + confidence * 0.22 + strength * 0.16 + specificity * 0.12 + recency + confirmations + kindBoost - weakPenalty - stalePenalty - inferencePenalty - temporalPenalty;
}

function formatSource(memory: MemoryEntry, index: number): string {
    const kind = isChapter(memory)
        ? 'chapter'
        : isEpisode(memory)
            ? 'episode'
            : memory.memoryKind ?? 'fact';
    const tags = memory.tags?.length ? `; tags=${memory.tags.slice(0, 7).join(',')}` : '';
    const status = memory.status ? `; status=${memory.status}` : '';
    const valid = memory.validFrom || memory.validTo
        ? `; valid=${memory.validFrom ? new Date(memory.validFrom).toISOString().slice(0, 10) : '?'}${memory.validTo ? `..${new Date(memory.validTo).toISOString().slice(0, 10)}` : ''}`
        : '';
    return [
        `${index + 1}. id=${memory.id}`,
        `kind=${kind}`,
        `date=${new Date(memory.timestamp).toISOString().slice(0, 10)}`,
        `domain=${memory.domain}`,
        `importance=${(memory.importance ?? 0.5).toFixed(2)}`,
        `confidence=${(memory.confidence ?? 0.6).toFixed(2)}${status}${valid}${tags}`,
        `content="${truncate(memory.content, 560)}"`,
    ].join('; ');
}

function formatSchemaContent(schema: NormalizedUserSchema): string {
    return [
        `[МОДЕЛЬ ПАМЯТИ: ${schema.title}]`,
        `Измерение: ${schema.dimension}`,
        `Кратко: ${schema.summary}`,
        schema.guidance ? `Как учитывать: ${schema.guidance}` : '',
        schema.cues.length ? `Когда вспоминать: ${schema.cues.join('; ')}` : '',
        schema.caution ? `Ограничения/неуверенность: ${schema.caution}` : '',
        schema.entities.length ? `Ключевые сущности: ${schema.entities.join(', ')}` : '',
    ].filter(Boolean).join('\n');
}

interface NormalizedUserSchema {
    title: string;
    dimension: SchemaDimension;
    summary: string;
    guidance: string;
    cues: string[];
    domains: string[];
    entities: string[];
    caution?: string;
    sourceIds: string[];
    confidence: number;
    salience: number;
}

function normalizeSchema(schema: UserSchemaLLMResult, fallbackSources: MemoryEntry[]): NormalizedUserSchema | null {
    const title = String(schema.title || '').trim().slice(0, 90);
    const summary = String(schema.summary || '').trim().slice(0, 900);
    const guidance = String(schema.guidance || '').trim().slice(0, 700);
    if (!title || !summary || !guidance) return null;

    const sourceIdSet = new Set(fallbackSources.map((memory) => memory.id));
    const sourceIds = normalizeStringList(schema.sourceIds, MAX_SOURCE_IDS_PER_SCHEMA)
        .filter((id) => sourceIdSet.has(id));
    const dimension = normalizeDimension(schema.dimension);
    const domains = normalizeStringList(schema.domains, 5)
        .map(normalizeDomain);

    return {
        title,
        dimension,
        summary,
        guidance,
        cues: normalizeStringList(schema.cues, 10),
        domains: domains.length > 0 ? [...new Set(domains)] : [PREDEFINED_DOMAINS.PERSONAL],
        entities: normalizeStringList(schema.entities, 14),
        caution: String(schema.caution || '').trim().slice(0, 500) || undefined,
        sourceIds: sourceIds.length > 0
            ? sourceIds
            : fallbackSources.slice(0, 24).map((memory) => memory.id),
        confidence: clamp01(schema.confidence, 0.72),
        salience: clamp01(schema.salience, 0.78),
    };
}

async function synthesizeUserSchemas(sources: MemoryEntry[], periodDays: number): Promise<NormalizedUserSchema[]> {
    const selected = sources
        .slice()
        .sort((a, b) => sourceRank(b) - sourceRank(a))
        .slice(0, MAX_SOURCES_PER_PROMPT);
    const sourceText = selected.map(formatSource).join('\n');

    try {
        const resp = await openai.chat.completions.create({
            model: 'gpt-5.4',
            messages: [
                {
                    role: 'system',
                    content: 'Ты синтезируешь человекоподобную долговременную память ассистента. Отвечай только валидным JSON.',
                },
                {
                    role: 'user',
                    content: `Ниже воспоминания о пользователе за последние ${periodDays} дней.
Это смесь фактов, эпизодов, глав и незакрытых линий.

${sourceText}

Собери 3-8 устойчивых МОДЕЛЕЙ пользователя, как это делает человеческая память.
Это не список фактов и не биография. Модель = повторяющийся паттерн, предпочтение, граница, стиль решений, рабочий/здоровьевой паттерн, способ поддержки, отношение к людям или текущая линия жизни.

Правила:
- Не выдумывай. Каждая модель должна опираться на sourceIds из списка.
- Отделяй устойчивое от временного: если данных мало, пиши caution и снижай confidence.
- Не превращай один разовый факт в черту характера.
- Не превращай temporal_scope:current_state, temporal_scope:future_plan или status:planned в устойчивую черту без нескольких подтверждений.
- weak-evidence, quality:* и possibly-stale источники можно использовать только как слабый сигнал; если они важны, обязательно добавь caution.
- inference:inferred/reported/ambiguous источники не должны становиться устойчивой моделью без независимых direct-подтверждений.
- guidance — как ассистенту учитывать модель в ответах. Часто это нужно учитывать молча, не цитируя пользователю.
- cues — при каких темах/словах/ситуациях эта модель должна всплывать.
- Если есть противоречия, отрази их как неуверенность, а не выбирай произвольно.

Допустимые dimension:
identity, preference, routine, boundary, relationship, goal_pattern, decision_style, stressor, communication_style, support_style, work_style, health_pattern, unknown

JSON:
{
  "schemas": [
    {
      "title": "короткое название модели",
      "dimension": "preference",
      "summary": "2-4 предложения: устойчивый паттерн/модель",
      "guidance": "как учитывать в будущих ответах; что делать и чего избегать",
      "cues": ["когда вспоминать"],
      "domains": ["personal"],
      "entities": ["люди/проекты/места"],
      "caution": "если модель слабая или устаревает",
      "sourceIds": ["id1", "id2"],
      "confidence": 0.0-1.0,
      "salience": 0.0-1.0
    }
  ]
}`,
                },
            ],
            temperature: 0.25,
            response_format: { type: 'json_object' },
        });

        const parsed = parseLLMJson<UserSchemaLLMResponse>(resp.choices[0]?.message?.content || '');
        const rawSchemas = Array.isArray(parsed?.schemas) ? parsed.schemas : [];
        return rawSchemas
            .map((schema) => normalizeSchema(schema, selected))
            .filter((schema): schema is NormalizedUserSchema => schema !== null)
            .slice(0, MAX_SCHEMAS);
    } catch (e) {
        devLog('MemorySchemaConsolidationService: LLM failed', e);
        return [];
    }
}

async function replaceExistingSchemas(userId: string, domain?: string): Promise<number> {
    const svc = getVectorService();
    if (!svc) return 0;
    const normalizedDomain = domain ? normalizeDomain(domain) : undefined;
    const existing = await svc.getMemoriesByTag(userId, SCHEMA_SET_TAG).catch(() => []);
    const toDelete = normalizedDomain
        ? existing.filter((memory) =>
            normalizeDomain(memory.domain) === normalizedDomain ||
            (memory.tags ?? []).includes(`schema_domain:${safeTagValue(normalizedDomain)}`)
        )
        : existing;
    await Promise.allSettled(toDelete.map((memory) => svc.deleteMemory(memory.id, memory.domain)));
    return toDelete.length;
}

export async function runMemorySchemaConsolidationForUser(
    userId: string,
    options: MemorySchemaConsolidationOptions = {}
): Promise<MemorySchemaConsolidationResult> {
    const svc = getVectorService();
    if (!svc) {
        return { created: 0, replaced: 0, sourceCount: 0, schemaTitles: [], skipped: ['vector-service-unavailable'] };
    }

    const limit = options.limit ?? DEFAULT_LIMIT;
    const minSources = options.minSources ?? DEFAULT_MIN_SOURCES;
    const periodDays = options.periodDays ?? DEFAULT_PERIOD_DAYS;
    const requestedDomain = options.domain ? normalizeDomain(options.domain) : undefined;
    const cutoff = Date.now() - periodDays * 86_400_000;

    const all = await svc.getRecentMemories(userId, limit);
    const sources = all
        .filter((memory) => {
            if (isSchema(memory)) return false;
            if (isPortrait(memory)) return false;
            if (memory.status === 'expired' || memory.status === 'superseded') return false;
            if (memory.subject === 'bot' || memory.subject === 'system') return false;
            if (new Date(memory.timestamp).getTime() < cutoff) return false;
            if (!sourceMatchesDomain(memory, requestedDomain)) return false;
            return memory.content.trim().length >= 20;
        })
        .sort((a, b) => sourceRank(b) - sourceRank(a))
        .slice(0, MAX_SOURCES_PER_PROMPT);

    if (sources.length < minSources) {
        return {
            created: 0,
            replaced: 0,
            sourceCount: sources.length,
            schemaTitles: [],
            skipped: [`schemas: only ${sources.length}/${minSources} sources`],
        };
    }

    const schemas = await synthesizeUserSchemas(sources, periodDays);
    if (schemas.length === 0) {
        return {
            created: 0,
            replaced: 0,
            sourceCount: sources.length,
            schemaTitles: [],
            skipped: ['schemas: no models generated'],
        };
    }

    const replaced = await replaceExistingSchemas(userId, requestedDomain);
    const now = new Date();
    const schemaTitles: string[] = [];
    let created = 0;

    for (const schema of schemas) {
        const sourceIds = schema.sourceIds.slice(0, MAX_SOURCE_IDS_PER_SCHEMA);
        const primaryDomain = requestedDomain ?? schema.domains[0] ?? PREDEFINED_DOMAINS.PERSONAL;
        const memoryKind = schemaMemoryKind(schema.dimension);
        const salience = clamp01(schema.salience, 0.78);
        const confidence = clamp01(schema.confidence, 0.72);

        await svc.saveMemory({
            content: formatSchemaContent(schema),
            domain: primaryDomain,
            timestamp: now,
            importance: Math.max(0.78, salience),
            tags: [
                SCHEMA_TAG,
                SCHEMA_SET_TAG,
                'autobiographical',
                'implicit-context',
                'subject:user',
                `schema_dimension:${safeTagValue(schema.dimension)}`,
                ...schema.domains.map((domain) => `schema_domain:${safeTagValue(domain)}`),
            ],
            userId,
            botId: config.botUsername.toLowerCase(),
            isAnchor: memoryKind === 'boundary' || (salience >= 0.92 && confidence >= 0.82) || undefined,
            confidence,
            lastAccessedAt: now,
            memoryKind,
            strength: Math.min(1, 0.70 + salience * 0.20 + confidence * 0.06),
            vividness: Math.min(1, 0.34 + salience * 0.18),
            specificity: Math.min(1, 0.46 + schema.entities.length * 0.025 + sourceIds.length * 0.004),
            sourceContext: `Синтезированная модель пользователя по ${sources.length} воспоминаниям за ${periodDays} дней.`,
            sourceMemoryIds: sourceIds,
            extractionMethod: 'consolidation',
            subject: 'user',
            predicate: `user_schema:${schema.dimension}`,
            object: schema.title,
            validFrom: new Date(cutoff),
            status: 'active',
            confirmationCount: sourceIds.length || sources.length,
            lastConfirmedAt: now,
        });
        schemaTitles.push(schema.title);
        created++;
    }

    return {
        created,
        replaced,
        sourceCount: sources.length,
        schemaTitles,
        skipped: [],
    };
}

export async function runMemorySchemaConsolidationForContext(
    ctx: BotContext,
    options: MemorySchemaConsolidationOptions = {}
): Promise<MemorySchemaConsolidationResult> {
    const userId = ctx.from?.id;
    if (!userId) {
        return { created: 0, replaced: 0, sourceCount: 0, schemaTitles: [], skipped: ['missing-user-id'] };
    }
    return runMemorySchemaConsolidationForUser(String(userId), options);
}
