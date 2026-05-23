import { config } from '../config';
import { PREDEFINED_DOMAINS } from '../constants/domains';
import { MemoryEntry } from '../types';
import { getVectorService } from './VectorServiceFactory';
import openai from '../openai';
import { devLog, parseLLMJson } from '../utils';

const OPEN_LOOP_INDEX_TAG = 'sleep_open_loop_index';
const MAX_OPEN_LOOP_SOURCES = 40;

interface SleepCycleResult {
    openLoopIndexCreated: boolean;
    sourceCount: number;
    skipped: string[];
}

interface OpenLoopIndexResponse {
    summary?: string;
    priorities?: string[];
    staleOrUnclear?: string[];
}

function isOpenLoopCandidate(memory: MemoryEntry): boolean {
    if (memory.status === 'done' || memory.status === 'expired' || memory.status === 'superseded') return false;
    if (memory.tags?.includes(OPEN_LOOP_INDEX_TAG)) return false;
    if (memory.tags?.includes('memory-episode') || memory.tags?.includes('memory-chapter')) return false;
    if (memory.memoryKind && ['goal', 'open_loop', 'prospective', 'promise'].includes(memory.memoryKind)) return true;
    if (memory.status === 'planned') return true;
    return /жду|ожидаю|надо|нужно|дедлайн|срок|планир|собира|хоч[уе]т|обещал|договорил[аи]сь|предстоит/i
        .test(memory.content);
}

function rankOpenLoop(memory: MemoryEntry): number {
    const importance = memory.importance ?? 0.5;
    const strength = memory.strength ?? 0.45;
    const specificity = memory.specificity ?? 0.45;
    const ageDays = Math.max(0, (Date.now() - memory.timestamp.getTime()) / 86_400_000);
    const recency = ageDays < 7 ? 0.18 : ageDays < 30 ? 0.10 : ageDays < 90 ? 0.04 : 0;
    return importance * 0.45 + strength * 0.25 + specificity * 0.18 + recency;
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

async function synthesizeOpenLoopIndex(sources: MemoryEntry[]): Promise<OpenLoopIndexResponse | null> {
    const sourceText = sources.map(formatOpenLoopSource).join('\n');
    const resp = await openai.chat.completions.create({
        model: 'gpt-5.4-nano',
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

async function replaceExistingIndex(userId: string): Promise<void> {
    const svc = getVectorService();
    if (!svc) return;
    const existing = await svc.getMemoriesByTag(userId, OPEN_LOOP_INDEX_TAG).catch(() => []);
    await Promise.allSettled(existing.map(memory => svc.deleteMemory(memory.id, memory.domain)));
}

export async function runMemorySleepCycleForUser(userId: string): Promise<SleepCycleResult> {
    const svc = getVectorService();
    if (!svc) {
        return { openLoopIndexCreated: false, sourceCount: 0, skipped: ['vector-service-unavailable'] };
    }

    const skipped: string[] = [];
    const recent = await svc.getRecentMemories(userId, 700);
    const openLoops = recent
        .filter(isOpenLoopCandidate)
        .sort((a, b) => rankOpenLoop(b) - rankOpenLoop(a))
        .slice(0, MAX_OPEN_LOOP_SOURCES);

    if (openLoops.length < 3) {
        return {
            openLoopIndexCreated: false,
            sourceCount: openLoops.length,
            skipped: [`open-loops: only ${openLoops.length}/3`],
        };
    }

    try {
        const index = await synthesizeOpenLoopIndex(openLoops);
        const summary = index?.summary?.trim();
        if (!summary) {
            return { openLoopIndexCreated: false, sourceCount: openLoops.length, skipped: ['empty-open-loop-index'] };
        }

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

        devLog('[memory-sleep-cycle] open loop index saved', { sourceCount: openLoops.length });
        return { openLoopIndexCreated: true, sourceCount: openLoops.length, skipped };
    } catch (e) {
        devLog('[memory-sleep-cycle] failed:', e);
        return { openLoopIndexCreated: false, sourceCount: openLoops.length, skipped: ['sleep-cycle-failed'] };
    }
}
