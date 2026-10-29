import { createHash } from 'node:crypto';
import type { BotContext, MessageHistory } from '../types';
import type { MemoryEntry } from '../services/interfaces/IVectorService';

export type MemoryEvidence = Pick<MemoryEntry, 'sourceEpisodeId' | 'sourceMessageIds' | 'sourceMemoryIds'>;

/** The position in a sliding history window is not the identity of a message. */
export function memoryMessageSourceId(message: MessageHistory): string {
    if (message.sourceMessageId) return message.sourceMessageId;
    const timestamp = new Date(message.timestamp).getTime();
    const digest = createHash('sha256').update(message.content).digest('hex').slice(0, 24);
    return `history:${message.role}:${Number.isFinite(timestamp) ? timestamp : 'unknown'}:${digest}`;
}

export function currentUserMemorySourceId(ctx: BotContext, text: string, currentMessage?: MessageHistory): string {
    const id = ctx.message?.message_id;
    if (typeof id === 'number' && Number.isSafeInteger(id) && id > 0) {
        return String(ctx.sessionStorageKey || '').startsWith('api:')
            ? `api:${ctx.from?.id}:${id}` : `tg:${ctx.chat?.id}:${id}`;
    }
    const message = currentMessage ?? ctx.session?.messageHistory?.find(item => item.role === 'user' && item.content === text);
    return memoryMessageSourceId(message ?? { role: 'user', content: text, timestamp: new Date((ctx.message?.date ?? 0) * 1000) });
}

function sourceKey(id: string): string {
    const legacy = /^(user|bot):(\d+):\d+$/u.exec(id);
    if (legacy) return `history-event:${legacy[1]}:${legacy[2]}`;
    const history = /^history:(user|bot):(\d+):/u.exec(id);
    if (history) return `history-event:${history[1]}:${history[2]}`;
    return id.replace(/^telegram:/u, 'tg:');
}

export function isIndependentMemoryEvidence(existing: MemoryEvidence, incoming: MemoryEvidence): boolean {
    if (existing.sourceEpisodeId && existing.sourceEpisodeId === incoming.sourceEpisodeId) return false;
    for (const key of ['sourceMessageIds', 'sourceMemoryIds'] as const) {
        const known = new Set((existing[key] ?? []).map(value => key === 'sourceMessageIds' ? sourceKey(String(value)) : String(value)));
        if ((incoming[key] ?? []).some(value => known.has(key === 'sourceMessageIds' ? sourceKey(String(value)) : String(value)))) return false;
    }
    return Boolean(incoming.sourceEpisodeId || incoming.sourceMessageIds?.length || incoming.sourceMemoryIds?.length);
}

/** Optimistic precondition for delayed writes; access counters are deliberately excluded. */
export function memoryAssertionVersion(memory: Partial<MemoryEntry>): string {
    const fields = ['content', 'subject', 'predicate', 'object', 'negated', 'status', 'validFrom', 'validTo', 'expiresAt'] as const;
    return createHash('sha256').update(JSON.stringify([
        fields.map(key => {
            if (key === 'negated') return Boolean(memory[key]);
            if (key === 'status') return memory.status ?? 'active';
            if (['validFrom', 'validTo', 'expiresAt'].includes(key) && memory[key]) return new Date(memory[key] as any).toISOString();
            return memory[key] ?? null;
        }),
        (memory.tags ?? []).filter(tag => /^(subject:|person_id:|contact_id:|contact_username:|relation_|person_relation$)/u.test(tag)).sort(),
    ])).digest('hex');
}
