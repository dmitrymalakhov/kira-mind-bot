import { BotContext } from '../types';
import { classifyMemoryNeed, getMultiQueryMemoryContextDetailed, RecalledMemoryRef } from './multiQueryMemory';
import { devLog } from '../utils';
import { buildTodayImportanceContext } from './todayImportance';

export interface AgentMemoryContext {
    domain: string;
    context: string;
    recalledMemories?: RecalledMemoryRef[];
}

export interface AgentMemoryContextOptions {
    /** Детерминированная дневная сводка строит snapshot отдельно и не должна читать его дважды. */
    includeTodayImportance?: boolean;
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
    const memoryNeed = await classifyMemoryNeed(trimmed);
    if (memoryNeed === 'none') {
        devLog('Memory need: none — skipping retrieval for this message');
        return { domain: 'personal', context: '' };
    }

    const [memory, todayImportanceContext] = await Promise.all([
        getMultiQueryMemoryContextDetailed(ctx, trimmed, memoryNeed),
        options.includeTodayImportance === false
            ? Promise.resolve('')
            : buildTodayImportanceContext(ctx, trimmed),
    ]);
    const context = memory.context;
    const working = formatWorkingMemory(ctx);
    const enrichedContext = [working, todayImportanceContext, context].filter(Boolean).join('\n\n');
    devLog('Fetched memory context (enrichment)', {
        memoryNeed,
        hasTodayImportanceContext: Boolean(todayImportanceContext),
        hasContext: Boolean(enrichedContext),
        contextLength: enrichedContext.length,
        recalledMemories: memory.recalledMemories.length,
    });
    return { domain: 'personal', context: enrichedContext, recalledMemories: memory.recalledMemories };
}

function formatWorkingMemory(ctx: BotContext): string {
    const wm = ctx.session?.workingMemory;
    if (!wm?.summary?.trim()) return '';
    const lines = [
        'Текущая рабочая память разговора:',
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
