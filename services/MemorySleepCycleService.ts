import { config } from '../config';
import { PREDEFINED_DOMAINS } from '../constants/domains';
import { MemoryEntry } from '../types';
import { getVectorService } from './VectorServiceFactory';
import openai, { openAiModels } from '../openai';
import { devLog, parseLLMJson } from '../utils';

const OPEN_LOOP_INDEX_TAG = 'sleep_open_loop_index';
const UNCERTAINTY_INDEX_TAG = 'sleep_uncertainty_index';
const MAX_OPEN_LOOP_SOURCES = 40;
const MAX_UNCERTAINTY_SOURCES = 35;

interface SleepCycleResult {
    openLoopIndexCreated: boolean;
    uncertaintyIndexCreated: boolean;
    staleFactsSoftened: number;
    sourceCount: number;
    uncertaintySourceCount: number;
    skipped: string[];
}

interface OpenLoopIndexResponse {
    summary?: string;
    priorities?: string[];
    staleOrUnclear?: string[];
}

interface UncertaintyIndexResponse {
    summary?: string;
    clarificationCues?: string[];
    likelyStale?: string[];
    conflictingOrWeak?: string[];
}

function isOpenLoopCandidate(memory: MemoryEntry): boolean {
    if (memory.status === 'done' || memory.status === 'expired' || memory.status === 'superseded') return false;
    if (memory.tags?.includes(OPEN_LOOP_INDEX_TAG)) return false;
    if (memory.tags?.includes(UNCERTAINTY_INDEX_TAG)) return false;
    if (memory.tags?.includes('memory-episode') || memory.tags?.includes('memory-chapter')) return false;
    if (memory.tags?.includes('memory-schema')) return false;
    if (memory.memoryKind && ['goal', 'open_loop', 'prospective', 'promise'].includes(memory.memoryKind)) return true;
    if (memory.status === 'planned') return true;
    if ((memory.tags ?? []).includes('temporal_scope:future_plan')) return true;
    return /жду|ожидаю|надо|нужно|дедлайн|срок|планир|собира|хоч[уе]т|обещал|договорил[аи]сь|предстоит/i
        .test(memory.content);
}

function memoryAgeDays(memory: MemoryEntry): number {
    return Math.max(0, (Date.now() - memory.timestamp.getTime()) / 86_400_000);
}

function lastEvidenceAgeDays(memory: MemoryEntry): number {
    const date = memory.lastConfirmedAt ?? memory.lastRetrievedAt ?? memory.lastAccessedAt ?? memory.timestamp;
    return Math.max(0, (Date.now() - new Date(date).getTime()) / 86_400_000);
}

function isSyntheticOrIndex(memory: MemoryEntry): boolean {
    const tags = memory.tags ?? [];
    return tags.includes(OPEN_LOOP_INDEX_TAG) ||
        tags.includes(UNCERTAINTY_INDEX_TAG) ||
        tags.includes('memory-episode') ||
        tags.includes('memory-chapter') ||
        tags.includes('memory-schema') ||
        memory.content.startsWith('[ЭПИЗОД ПАМЯТИ:') ||
        memory.content.startsWith('[ГЛАВА ПАМЯТИ:') ||
        memory.content.startsWith('[МОДЕЛЬ ПАМЯТИ:');
}

function isUncertaintyCandidate(memory: MemoryEntry): boolean {
    if (isSyntheticOrIndex(memory)) return false;
    if (memory.status === 'expired' || memory.status === 'superseded' || memory.status === 'done') return false;

    const confidence = memory.confidence ?? 0.6;
    const age = memoryAgeDays(memory);
    const evidenceAge = lastEvidenceAgeDays(memory);
    const kind = memory.memoryKind ?? 'fact';
    const tags = memory.tags ?? [];

    if (confidence < 0.55) return true;
    if ((memory.previousVersions?.length ?? 0) > 0 && confidence < 0.78) return true;
    if (memory.status === 'unknown') return true;
    if (memory.status === 'planned' && age > 21) return true;
    if (tags.includes('temporal_scope:current_state') && age > 90 && evidenceAge > 21) return true;
    if (tags.includes('temporal_scope:future_plan') && age > 30) return true;
    if (tags.includes('possibly-stale')) return true;
    if (tags.includes('needs-caution') || tags.includes('inference:ambiguous')) return true;
    if (['goal', 'open_loop', 'prospective', 'promise'].includes(kind) && age > 30) return true;
    if (kind === 'state' && age > 120 && evidenceAge > 30) return true;
    if (kind === 'event' && age > 90 && confidence < 0.72) return true;
    if (tags.some((tag) => ['contradicts-merged', 'updated', 'planning-invalidated'].includes(String(tag))) && confidence < 0.82) {
        return true;
    }
    if (tags.some((tag) =>
        String(tag) === 'weak-evidence' ||
        String(tag) === 'importance-capped' ||
        String(tag) === 'anchor-capped' ||
        String(tag).startsWith('quality:') ||
        String(tag) === 'critic-rewritten' ||
        String(tag) === 'inference:inferred' ||
        String(tag) === 'inference:reported'
    )) {
        return true;
    }
    return /кажется|возможно|не уверен|не уверена|надо уточнить|стоит уточнить|непонятно|под вопросом/i.test(memory.content);
}

function shouldSoftenStaleTemporalMemory(memory: MemoryEntry): boolean {
    if (isSyntheticOrIndex(memory)) return false;
    if (memory.status === 'expired' || memory.status === 'superseded' || memory.status === 'done') return false;
    const tags = memory.tags ?? [];
    const age = memoryAgeDays(memory);
    const evidenceAge = lastEvidenceAgeDays(memory);
    if (tags.includes('possibly-stale') && (memory.confidence ?? 0.6) <= 0.58) return false;
    if (tags.includes('temporal_scope:current_state') && age > 120 && evidenceAge > 30) return true;
    if (tags.includes('temporal_scope:future_plan') && age > 75) return true;
    if (memory.status === 'planned' && age > 75) return true;
    return false;
}

function softenTemporalMemory(memory: MemoryEntry, userId: string): Omit<MemoryEntry, 'id'> {
    const now = new Date();
    const tags = [...new Set([...(memory.tags ?? []), 'possibly-stale', 'sleep-softened'])];
    const nextStatus = memory.status === 'planned' || tags.includes('temporal_scope:future_plan')
        ? 'unknown'
        : memory.status ?? 'unknown';
    return {
        content: memory.content,
        domain: memory.domain,
        botId: memory.botId || config.botUsername.toLowerCase(),
        timestamp: memory.timestamp,
        importance: memory.importance,
        tags,
        userId,
        isAnchor: memory.isAnchor || undefined,
        expiresAt: memory.expiresAt,
        confidence: Math.min(memory.confidence ?? 0.6, 0.56),
        lastAccessedAt: memory.lastAccessedAt,
        retrievalCount: memory.retrievalCount,
        lastRetrievedAt: memory.lastRetrievedAt,
        retrievalCues: memory.retrievalCues,
        previousVersions: memory.previousVersions,
        relatedIds: memory.relatedIds,
        memoryKind: memory.memoryKind,
        strength: Math.min(memory.strength ?? 0.5, 0.54),
        vividness: memory.vividness,
        specificity: memory.specificity,
        emotionalTag: memory.emotionalTag,
        sourceEpisodeId: memory.sourceEpisodeId,
        sourceContext: [
            memory.sourceContext,
            `Sleep-cycle ${now.toISOString()}: temporal fact softened because it may be stale.`,
        ].filter(Boolean).join('\n'),
        sourceMessageIds: memory.sourceMessageIds,
        sourceMemoryIds: memory.sourceMemoryIds,
        extractionMethod: memory.extractionMethod,
        subject: memory.subject,
        predicate: memory.predicate,
        object: memory.object,
        validFrom: memory.validFrom,
        validTo: memory.validTo,
        status: nextStatus,
        confirmationCount: memory.confirmationCount,
        lastConfirmedAt: memory.lastConfirmedAt,
    };
}

function rankOpenLoop(memory: MemoryEntry): number {
    const importance = memory.importance ?? 0.5;
    const strength = memory.strength ?? 0.45;
    const specificity = memory.specificity ?? 0.45;
    const ageDays = Math.max(0, (Date.now() - memory.timestamp.getTime()) / 86_400_000);
    const recency = ageDays < 7 ? 0.18 : ageDays < 30 ? 0.10 : ageDays < 90 ? 0.04 : 0;
    return importance * 0.45 + strength * 0.25 + specificity * 0.18 + recency;
}

function rankUncertainty(memory: MemoryEntry): number {
    const confidence = memory.confidence ?? 0.6;
    const importance = memory.importance ?? 0.5;
    const age = memoryAgeDays(memory);
    const evidenceAge = lastEvidenceAgeDays(memory);
    const lowConfidence = Math.max(0, 0.65 - confidence);
    const oldness = Math.min(0.22, Math.log1p(Math.max(age, evidenceAge)) * 0.045);
    const changed = (memory.previousVersions?.length ?? 0) > 0 ? 0.14 : 0;
    const planned = memory.status === 'planned' ? 0.12 : 0;
    const unknown = memory.status === 'unknown' ? 0.12 : 0;
    return importance * 0.34 + lowConfidence * 1.2 + oldness + changed + planned + unknown;
}

function formatOpenLoopSource(memory: MemoryEntry, index: number): string {
    return [
        `${index + 1}. id=${memory.id}`,
        `date=${memory.timestamp.toISOString().slice(0, 10)}`,
        `domain=${memory.domain}`,
        `kind=${memory.memoryKind ?? 'unknown'}`,
        `status=${memory.status ?? 'unknown'}`,
        `importance=${(memory.importance ?? 0.5).toFixed(2)}`,
        `content="${memory.content.slice(0, 420)}"`,
    ].join('; ');
}

function formatUncertaintySource(memory: MemoryEntry, index: number): string {
    return [
        `${index + 1}. id=${memory.id}`,
        `date=${memory.timestamp.toISOString().slice(0, 10)}`,
        `lastEvidenceDays=${lastEvidenceAgeDays(memory).toFixed(0)}`,
        `domain=${memory.domain}`,
        `kind=${memory.memoryKind ?? 'unknown'}`,
        `status=${memory.status ?? 'unknown'}`,
        `importance=${(memory.importance ?? 0.5).toFixed(2)}`,
        `confidence=${(memory.confidence ?? 0.6).toFixed(2)}`,
        `versions=${memory.previousVersions?.length ?? 0}`,
        `tags=${(memory.tags ?? []).slice(0, 8).join(',') || 'none'}`,
        `content="${memory.content.slice(0, 440)}"`,
    ].join('; ');
}

async function synthesizeOpenLoopIndex(sources: MemoryEntry[]): Promise<OpenLoopIndexResponse | null> {
    const sourceText = sources.map(formatOpenLoopSource).join('\n');
    const resp = await openai.chat.completions.create({
        model: openAiModels.memoryExtractionModel,
        messages: [
            { role: 'system', content: 'Ты собираешь индекс незакрытых линий долговременной памяти. Отвечай только JSON.' },
            {
                role: 'user',
                content: `Ниже воспоминания пользователя, похожие на цели, обещания, планы или незакрытые вопросы.

${sourceText}

Собери компактный индекс будущего внимания: что ассистенту стоит держать в голове и при каких темах это может всплывать.
Не выдумывай новых фактов. Если что-то выглядит устаревшим или мутным, вынеси в staleOrUnclear.

JSON:
{
  "summary": "3-6 предложений: текущие открытые линии пользователя",
  "priorities": ["короткие cues, когда это вспоминать"],
  "staleOrUnclear": ["что стоит уточнить при случае"]
}`,
            },
        ],
        temperature: 0.25,
        response_format: { type: 'json_object' },
    });

    return parseLLMJson<OpenLoopIndexResponse>(resp.choices[0]?.message?.content ?? '');
}

async function synthesizeUncertaintyIndex(sources: MemoryEntry[]): Promise<UncertaintyIndexResponse | null> {
    const sourceText = sources.map(formatUncertaintySource).join('\n');
    const resp = await openai.chat.completions.create({
        model: openAiModels.memoryExtractionModel,
        messages: [
            { role: 'system', content: 'Ты собираешь индекс метапамяти: что ассистент помнит неуверенно или что может устареть. Отвечай только JSON.' },
            {
                role: 'user',
                content: `Ниже воспоминания, которые выглядят слабыми, устаревающими, противоречиво обновлёнными или требующими проверки.

${sourceText}

Собери компактный индекс сомнений памяти. Это НЕ список фактов для ответа пользователю.
Задача — помочь ассистенту понимать, где надо говорить осторожно или при удобном случае уточнить актуальность.

Правила:
- Не выдумывай новые факты.
- Не проси уточнять всё подряд: выбирай только полезные и естественные поводы.
- Если факт просто старый, но устойчивый/биографический, не считай его проблемой.
- Формулируй cues так, чтобы ассистент понял, в какой теме стоит уточнить.

JSON:
{
  "summary": "2-5 предложений: где память сейчас наиболее мутная или устаревающая",
  "clarificationCues": ["когда уместно мягко уточнить"],
  "likelyStale": ["что может быть устаревшим"],
  "conflictingOrWeak": ["что слабое/противоречивое"]
}`,
            },
        ],
        temperature: 0.2,
        response_format: { type: 'json_object' },
    });

    return parseLLMJson<UncertaintyIndexResponse>(resp.choices[0]?.message?.content ?? '');
}

async function replaceExistingIndex(userId: string): Promise<void> {
    const svc = getVectorService();
    if (!svc) return;
    const existing = await svc.getMemoriesByTag(userId, OPEN_LOOP_INDEX_TAG).catch(() => []);
    await Promise.allSettled(existing.map(memory => svc.deleteMemory(memory.id, memory.domain)));
}

async function replaceExistingUncertaintyIndex(userId: string): Promise<void> {
    const svc = getVectorService();
    if (!svc) return;
    const existing = await svc.getMemoriesByTag(userId, UNCERTAINTY_INDEX_TAG).catch(() => []);
    await Promise.allSettled(existing.map(memory => svc.deleteMemory(memory.id, memory.domain)));
}

export async function runMemorySleepCycleForUser(userId: string): Promise<SleepCycleResult> {
    const svc = getVectorService();
    if (!svc) {
        return {
            openLoopIndexCreated: false,
            uncertaintyIndexCreated: false,
            staleFactsSoftened: 0,
            sourceCount: 0,
            uncertaintySourceCount: 0,
            skipped: ['vector-service-unavailable'],
        };
    }

    const skipped: string[] = [];
    const recent = await svc.getRecentMemories(userId, 700);
    const openLoops = recent
        .filter(isOpenLoopCandidate)
        .sort((a, b) => rankOpenLoop(b) - rankOpenLoop(a))
        .slice(0, MAX_OPEN_LOOP_SOURCES);
    const uncertaintyCandidates = recent
        .filter(isUncertaintyCandidate)
        .sort((a, b) => rankUncertainty(b) - rankUncertainty(a))
        .slice(0, MAX_UNCERTAINTY_SOURCES);

    if (openLoops.length < 3) {
        skipped.push(`open-loops: only ${openLoops.length}/3`);
    }

    let openLoopIndexCreated = false;
    let uncertaintyIndexCreated = false;
    let staleFactsSoftened = 0;

    try {
        const staleTemporal = recent
            .filter(shouldSoftenStaleTemporalMemory)
            .sort((a, b) => rankUncertainty(b) - rankUncertainty(a))
            .slice(0, 25);
        const results = await Promise.allSettled(
            staleTemporal.map((memory) => svc.updateMemory(memory.id, memory.domain, softenTemporalMemory(memory, userId)))
        );
        staleFactsSoftened = results.filter((result) => result.status === 'fulfilled').length;
        if (staleFactsSoftened > 0) {
            devLog('[memory-sleep-cycle] stale temporal facts softened', { count: staleFactsSoftened });
        }
    } catch (e) {
        devLog('[memory-sleep-cycle] stale temporal softening failed:', e);
        skipped.push('stale-temporal-softening-failed');
    }

    try {
        if (openLoops.length >= 3) {
            const index = await synthesizeOpenLoopIndex(openLoops);
            const summary = index?.summary?.trim();
            if (!summary) {
                skipped.push('empty-open-loop-index');
            } else {
                await replaceExistingIndex(userId);
                const now = new Date();
                const priorities = Array.isArray(index?.priorities) ? index!.priorities.filter(Boolean).slice(0, 12) : [];
                const stale = Array.isArray(index?.staleOrUnclear) ? index!.staleOrUnclear.filter(Boolean).slice(0, 8) : [];
                const content = [
                    '[ИНДЕКС ОТКРЫТЫХ ЛИНИЙ ПАМЯТИ]',
                    `Кратко: ${summary}`,
                    priorities.length ? `Когда вспоминать: ${priorities.join('; ')}` : '',
                    stale.length ? `Стоит уточнить: ${stale.join('; ')}` : '',
                ].filter(Boolean).join('\n');

                await svc.saveMemory({
                    content,
                    domain: PREDEFINED_DOMAINS.GENERAL,
                    timestamp: now,
                    importance: 0.86,
                    tags: [OPEN_LOOP_INDEX_TAG, 'autobiographical', 'prospective', 'subject:user'],
                    userId,
                    botId: config.botUsername.toLowerCase(),
                    isAnchor: true,
                    confidence: 0.78,
                    lastAccessedAt: now,
                    sourceContext: `Индекс собран sleep-cycle по ${openLoops.length} активным целям/планам/обещаниям.`,
                    sourceMemoryIds: openLoops.map(memory => memory.id),
                    extractionMethod: 'consolidation',
                    subject: 'user',
                    predicate: 'open_loop_index',
                    object: 'active_future_attention',
                    status: 'active',
                    memoryKind: 'open_loop',
                    strength: 0.88,
                    vividness: 0.55,
                    specificity: 0.70,
                    confirmationCount: openLoops.length,
                    lastConfirmedAt: now,
                });

                openLoopIndexCreated = true;
                devLog('[memory-sleep-cycle] open loop index saved', { sourceCount: openLoops.length });
            }
        }
    } catch (e) {
        devLog('[memory-sleep-cycle] open loop index failed:', e);
        skipped.push('open-loop-index-failed');
    }

    if (uncertaintyCandidates.length < 3) {
        skipped.push(`uncertainty: only ${uncertaintyCandidates.length}/3`);
    } else {
        try {
            const index = await synthesizeUncertaintyIndex(uncertaintyCandidates);
            const summary = index?.summary?.trim();
            if (!summary) {
                skipped.push('empty-uncertainty-index');
            } else {
                await replaceExistingUncertaintyIndex(userId);
                const now = new Date();
                const cues = Array.isArray(index?.clarificationCues) ? index!.clarificationCues.filter(Boolean).slice(0, 12) : [];
                const stale = Array.isArray(index?.likelyStale) ? index!.likelyStale.filter(Boolean).slice(0, 8) : [];
                const weak = Array.isArray(index?.conflictingOrWeak) ? index!.conflictingOrWeak.filter(Boolean).slice(0, 8) : [];
                const content = [
                    '[ИНДЕКС СОМНЕНИЙ ПАМЯТИ]',
                    `Кратко: ${summary}`,
                    cues.length ? `Когда уточнять: ${cues.join('; ')}` : '',
                    stale.length ? `Возможно устарело: ${stale.join('; ')}` : '',
                    weak.length ? `Слабое/противоречивое: ${weak.join('; ')}` : '',
                ].filter(Boolean).join('\n');

                await svc.saveMemory({
                    content,
                    domain: PREDEFINED_DOMAINS.GENERAL,
                    timestamp: now,
                    importance: 0.74,
                    tags: [UNCERTAINTY_INDEX_TAG, 'metamemory', 'needs-clarification', 'subject:user'],
                    userId,
                    botId: config.botUsername.toLowerCase(),
                    confidence: 0.72,
                    lastAccessedAt: now,
                    sourceContext: `Индекс сомнений собран sleep-cycle по ${uncertaintyCandidates.length} слабым/устаревающим воспоминаниям.`,
                    sourceMemoryIds: uncertaintyCandidates.map(memory => memory.id),
                    extractionMethod: 'consolidation',
                    subject: 'user',
                    predicate: 'memory_uncertainty_index',
                    object: 'stale_or_uncertain_memory',
                    status: 'active',
                    memoryKind: 'state',
                    strength: 0.66,
                    vividness: 0.28,
                    specificity: 0.66,
                    confirmationCount: uncertaintyCandidates.length,
                    lastConfirmedAt: now,
                });

                uncertaintyIndexCreated = true;
                devLog('[memory-sleep-cycle] uncertainty index saved', { sourceCount: uncertaintyCandidates.length });
            }
        } catch (e) {
            devLog('[memory-sleep-cycle] uncertainty index failed:', e);
            skipped.push('uncertainty-index-failed');
        }
    }

    return {
        openLoopIndexCreated,
        uncertaintyIndexCreated,
        staleFactsSoftened,
        sourceCount: openLoops.length,
        uncertaintySourceCount: uncertaintyCandidates.length,
        skipped,
    };
}
