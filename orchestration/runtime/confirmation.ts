import { createHash } from 'crypto';
import type { BotContext } from '../../types';

/** Server-derived identity of the operation confirmed by the existing channel callback. */
export function memoryConfirmationKey(id: string, domain: string): string {
    return `mem:${createHash('sha256').update(JSON.stringify([domain, id])).digest('hex').slice(0, 24)}`;
}

export function contactMemoryConfirmationKey(ctx: BotContext): string | undefined {
    const pending = ctx.session.pendingContactMemory;
    return pending ? `cmem:${pending.confirmationId ?? pending.createdAt}` : undefined;
}

export function telegramPeriodConfirmationKey(kind: 'chat-analysis' | 'study-chat', requestId: string): string {
    return `${kind}:${requestId}`;
}

export function browserConfirmationKey(sessionId: string): string { return `browser:${sessionId}`; }

export const CONTACT_MEMORY_PARENT_TOOLS = ['memory.rememberContact', 'telegram.readMessages', 'agents.start'];

export function hasPendingRuntimeConfirmation(ctx: BotContext, key: string): boolean {
    return Boolean(findPendingRuntimeConfirmation(ctx, key));
}

export function findPendingRuntimeConfirmation(ctx: BotContext, key: string) {
    return [ctx.session.agentRuntime, ...(ctx.session.agentRuntimePending ?? [])].find(run => run?.status === 'waiting' && run.observations?.some(item => item.status === 'needs_input' && item.confirmationKey === key));
}
