import { createHash } from 'crypto';
import type { BotContext } from '../../types';

/** Server-derived identity of the operation confirmed by the existing channel callback. */
export function memoryConfirmationKey(id: string, domain: string): string {
    return `mem:${createHash('sha256').update(JSON.stringify([domain, id])).digest('hex').slice(0, 24)}`;
}

export function contactMemoryConfirmationKey(ctx: BotContext): string | undefined {
    const pending = ctx.session.pendingContactMemory;
    return pending ? `cmem:${pending.createdAt}` : undefined;
}
