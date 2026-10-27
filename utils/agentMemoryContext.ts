import { BotContext } from '../types';
import { classifyMemoryNeed, getMultiQueryMemoryContextDetailed, RecalledMemoryRef, MultiQueryMemoryContextResult } from './multiQueryMemory';
import type { MemoryRecallSummary } from '../types/memoryRecallTypes';
import { devLog } from '../utils';
import { buildTodayImportanceContext } from './todayImportance';
import { getVectorService } from '../services/VectorServiceFactory';
import { recallOwnerRelationship } from './personalRelationshipRecall';
import { isFocusedPersonalRecall, ownerRelationshipIntent } from './personalRecallIntent';
import { readPersonIdentities } from '../services/PersonIdentityService';
import { validMemoryFocus, isMemoryContinuation, saveMemoryFocus } from './memoryQueryPlan';

export interface AgentMemoryContext {
    /** The new kernel handles mutations through tools, so synthesis is read-only. */
    allowSideEffects?: boolean;
    allowSelfEvolution?: boolean;
    domain: string;
    context: string;
    recalledMemories?: RecalledMemoryRef[];
    recall?: MemoryRecallSummary;
}

export interface AgentMemoryContextOptions {
    memoryNeed?: 'none' | 'light' | 'full';
    /** Детерминированная дневная сводка строит snapshot отдельно и не должна читать его дважды. */
    includeTodayImportance?: boolean;
    trackAccess?: boolean;
    replyPerson?: import('../types/memoryRecallTypes').MemoryReplyPerson;
}

/**
 * На все запросы пользователя подтягиваем контекст из долговременной памяти:
 * запрос разбирается на интенты в getMultiQueryMemoryContext, по каждому подтягиваются факты.
 *
 * Сначала классифицирует потребность в памяти (none / light / full),
 * чтобы не тратить ресурсы на приветствия и реакции.
 */
export async function fetchAgentMemoryContext(
    ctx: BotContext,
    message: string,
    options: AgentMemoryContextOptions = {},
): Promise<AgentMemoryContext> {
    // Personal memory is only available in private chat to prevent leaking private info in group chats
    if (ctx.chat?.type !== 'private') {
        return { domain: 'personal', context: '' };
    }
    const trimmed = message.trim();
    if (trimmed.length < 1) {
        return { domain: 'personal', context: '' };
    }

    // Классифицируем потребность в памяти до запуска тяжёлого retrieval
    const focused = isFocusedPersonalRecall(trimmed);
    const service = ownerRelationshipIntent(trimmed) ? getVectorService() : null;
    const relationship = service && ctx.from?.id
        ? await recallOwnerRelationship(service, String(ctx.from.id), trimmed, Date.now(), { identities: readPersonIdentities }).catch(() => undefined) : undefined;
    if (relationship?.complete && relationship.person) saveMemoryFocus(ctx, [relationship.person], trimmed, relationship.memories.map(memory => memory.id));
    const memoryNeed = focused || relationship?.context || (validMemoryFocus(ctx) || options.replyPerson?.personId || options.replyPerson?.contactId) && isMemoryContinuation(trimmed) ? 'full' : options.memoryNeed && ['none', 'light', 'full'].includes(options.memoryNeed)
        ? options.memoryNeed : await classifyMemoryNeed(trimmed);
    if (memoryNeed === 'none') {
        devLog('Memory need: none — skipping retrieval for this message');
        return { domain: 'personal', context: '' };
    }

    const [memory, todayImportanceContext] = await Promise.all([
        focused && relationship?.complete
            ? Promise.resolve<MultiQueryMemoryContextResult>({ context: '', recalledMemories: [] })
            : getMultiQueryMemoryContextDetailed(ctx, trimmed, memoryNeed, { trackAccess: options.trackAccess, replyPerson: options.replyPerson }),
        options.includeTodayImportance === false
            ? Promise.resolve('')
            : buildTodayImportanceContext(ctx, trimmed),
    ]);
    const context = memory.context;
    const working = formatWorkingMemory(ctx);
    const enrichedContext = [working, todayImportanceContext, context, relationship?.context,
        'Если поиск не нашёл нужный факт, это не означает, что пользователь его никогда не сообщал. Не утверждай «ты не называл»; обозначь ограничение текущего поиска.',
    ].filter(Boolean).join('\n\n');
    const recalled = new Map(memory.recalledMemories.map(item => [item.id, item]));
    for (const item of relationship?.memories ?? []) recalled.set(item.id, { id: item.id, domain: item.domain, content: item.content, score: 1, confidence: item.confidence, status: item.status, sourceMemoryIds: item.sourceMemoryIds, sourceEpisodeId: item.sourceEpisodeId });
    devLog('Fetched memory context (enrichment)', {
        memoryNeed,
        hasTodayImportanceContext: Boolean(todayImportanceContext),
        hasContext: Boolean(enrichedContext),
        contextLength: enrichedContext.length,
        recalledMemories: recalled.size,
        structuredRelationship: Boolean(relationship?.context),
    });
    const recall = focused && relationship?.complete && relationship.person
        ? { state: 'found' as const, requestKind: 'identity' as const, identityVerified: true,
            subjects: [{ name: relationship.person.displayName, owner: Boolean(relationship.person.owner) }], domains: [], evidenceCount: recalled.size }
        : memory.recall;
    return { domain: 'personal', context: enrichedContext, recalledMemories: [...recalled.values()], recall };
}

function formatWorkingMemory(ctx: BotContext): string {
    const wm = ctx.session?.workingMemory;
    if (!wm?.summary?.trim()) return '';
    const lines = [
        'Рабочая сводка разговора (поисковый контекст; не доказательства фактов, первичные записи ниже имеют приоритет):',
        `- Ситуация: ${wm.summary}`,
        wm.activeTopics?.length ? `- Активные темы: ${wm.activeTopics.join(', ')}` : '',
        wm.activeEntities?.length ? `- Активные люди/объекты: ${wm.activeEntities.join(', ')}` : '',
        wm.openLoops?.length ? `- Открытые вопросы/ожидания: ${wm.openLoops.join('; ')}` : '',
        wm.userMood ? `- Настроение пользователя: ${wm.userMood}` : '',
        wm.lastUserIntent ? `- Последнее намерение: ${wm.lastUserIntent}` : '',
    ].filter(Boolean);
    return lines.join('\n');
}

export function buildMemoryContextBlock(memoryContext: AgentMemoryContext): string {
    if (!memoryContext.context.trim()) {
        return "";
    }

    return `\nРелевантный контекст из долговременной памяти (домен: ${memoryContext.domain}):\n${memoryContext.context}`;
}
