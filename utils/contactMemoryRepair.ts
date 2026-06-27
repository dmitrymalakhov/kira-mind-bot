import { BotContext, MemoryEntry } from '../types';
import { getVectorService } from '../services/VectorServiceFactory';
import {
    contactIdentityTags,
    resolveContactIdentity,
} from './contactMemory';
import { devLog } from '../utils';

export interface ContactIdentityRepairResult {
    scanned: number;
    repaired: number;
    ambiguous: number;
    skipped: number;
}

function hasStableContactIdentity(tags: string[] | undefined): boolean {
    return (tags ?? []).some((tag) =>
        String(tag).startsWith('contact_id:') ||
        String(tag).startsWith('contact_username:') ||
        String(tag).startsWith('contact_key:')
    );
}

function hasContactId(tags: string[] | undefined): boolean {
    return (tags ?? []).some((tag) => String(tag).startsWith('contact_id:'));
}

function legacyContactName(memory: Pick<MemoryEntry, 'content' | 'tags'>): string | null {
    for (const tag of memory.tags ?? []) {
        const value = String(tag);
        if (value.startsWith('contact_name:')) return value.replace('contact_name:', '').trim();
        if (value.startsWith('contact:')) return value.replace('contact:', '').trim();
        if (value.startsWith('contact_alias:')) return value.replace('contact_alias:', '').trim();
        if (value.startsWith('contact_username:')) return value.replace('contact_username:', '').trim();
    }

    const prefix = memory.content.match(/^\[([^\]]+)\]\s+/);
    return prefix?.[1]?.trim() || null;
}

function isContactLike(memory: Pick<MemoryEntry, 'content' | 'tags'>): boolean {
    return Boolean(legacyContactName(memory)) ||
        (memory.tags ?? []).some((tag) => String(tag).startsWith('contact'));
}

export function countLegacyContactIdentities(memories: Array<Pick<MemoryEntry, 'content' | 'tags'>>): number {
    return memories.filter(memory =>
        isContactLike(memory) && !hasStableContactIdentity(memory.tags)
    ).length;
}

export async function repairLegacyContactIdentities(
    ctx: BotContext,
    limit = 1000
): Promise<ContactIdentityRepairResult> {
    const svc = getVectorService();
    if (!svc) {
        return { scanned: 0, repaired: 0, ambiguous: 0, skipped: 0 };
    }

    const userId = String(ctx.from?.id);
    const memories = await svc.getRecentMemories(userId, limit);
    const result: ContactIdentityRepairResult = {
        scanned: memories.length,
        repaired: 0,
        ambiguous: 0,
        skipped: 0,
    };

    for (const memory of memories) {
        if (!isContactLike(memory) || hasContactId(memory.tags)) {
            result.skipped++;
            continue;
        }

        const name = legacyContactName(memory);
        if (!name) {
            result.skipped++;
            continue;
        }

        const resolution = resolveContactIdentity(name);
        if (resolution.status === 'ambiguous' || resolution.status === 'needs_name') {
            result.ambiguous++;
            continue;
        }
        if (hasStableContactIdentity(memory.tags) && !resolution.contact) {
            result.skipped++;
            continue;
        }

        const tags = [
            ...(memory.tags ?? []),
            ...contactIdentityTags(name, resolution.contact),
        ];
        const { id, ...entry } = memory;
        await svc.updateMemory(id, memory.domain, {
            ...entry,
            tags: [...new Set(tags)],
            userId,
        });
        result.repaired++;
    }

    devLog('Contact identity repair result:', result);
    return result;
}
