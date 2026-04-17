import { BotContext } from '../types';
import { getMultiQueryMemoryContext, classifyMemoryNeed } from './multiQueryMemory';
import { devLog } from '../utils';

export interface AgentMemoryContext {
    domain: string;
    context: string;
}

/**
 * На все запросы пользователя подтягиваем контекст из долговременной памяти:
 * запрос разбирается на интенты в getMultiQueryMemoryContext, по каждому подтягиваются факты.
 *
 * Сначала классифицирует потребность в памяти (none / light / full),
 * чтобы не тратить ресурсы на приветствия и реакции.
 */
export async function fetchAgentMemoryContext(ctx: BotContext, message: string): Promise<AgentMemoryContext> {
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

    const context = await getMultiQueryMemoryContext(ctx, trimmed, memoryNeed);
    devLog('Fetched memory context (enrichment)', {
        memoryNeed,
        hasContext: Boolean(context),
        contextLength: context.length,
    });
    return { domain: 'personal', context };
}

export function buildMemoryContextBlock(memoryContext: AgentMemoryContext): string {
    if (!memoryContext.context.trim()) {
        return "";
    }

    return `\nРелевантный контекст из долговременной памяти (домен: ${memoryContext.domain}):\n${memoryContext.context}`;
}
