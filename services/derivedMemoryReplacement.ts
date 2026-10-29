import type { IDomainVectorService } from './interfaces/IDomainVectorService';
import type { MemoryEntry } from './interfaces/IVectorService';

/** Keep the previous generation until every replacement has been acknowledged. */
export async function replaceDerivedMemories(
    service: Pick<IDomainVectorService, 'saveMemory' | 'deleteMemory'>,
    previous: Array<Pick<MemoryEntry, 'id' | 'domain'>>,
    replacements: Array<Omit<MemoryEntry, 'id'>>,
): Promise<{ created: number; replaced: number }> {
    if (!replacements.length) return { created: 0, replaced: 0 };
    for (const memory of replacements) {
        const id = await service.saveMemory(memory);
        if (!id) throw new Error('Derived memory save was not acknowledged');
    }
    // Delete only the snapshot read before saving, never a newly saved generation.
    const unique = [...new Map(previous.map(memory => [`${memory.domain}:${memory.id}`, memory])).values()];
    const deletions = await Promise.allSettled(unique.map(memory => service.deleteMemory(memory.id, memory.domain)));
    return { created: replacements.length, replaced: deletions.filter(result => result.status === 'fulfilled').length };
}
