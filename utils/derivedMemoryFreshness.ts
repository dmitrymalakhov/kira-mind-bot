import type { MemoryEntry, MemorySourceSnapshot } from '../services/interfaces/IVectorService';
import { memoryAssertionVersion } from './memoryProvenance';

type Source = Partial<MemoryEntry> & { id: string; domain: string };
type SourceRef = Pick<MemorySourceSnapshot, 'id' | 'domain'>;
const key = (source: SourceRef) => JSON.stringify([source.domain, source.id]);
const MAX_SOURCES = 512;
const MAX_DEPTH = 4;

function isDerived(memory: Source): boolean {
    return memory.sourceMemorySnapshots !== undefined || ['chapter', 'episode', 'portrait'].includes(memory.memoryKind ?? '') ||
        ['consolidation', 'compression', 'episode', 'portrait'].includes(memory.extractionMethod ?? '') ||
        (memory.tags ?? []).some(tag => ['memory-chapter', 'memory-schema', 'memory-episode', 'sleep_open_loop_index', 'sleep_uncertainty_index'].includes(tag)) ||
        /^(?:memory_chapter:|user_schema:|open_loop_index$|memory_uncertainty_index$)/u.test(memory.predicate ?? '') ||
        /^\[(?:ГЛАВА ПАМЯТИ:|МОДЕЛЬ ПАМЯТИ:|ЭПИЗОД ПАМЯТИ:|ИНДЕКС )/u.test(memory.content ?? '');
}

function readable(memory: Source, now: number): boolean {
    return memory.status !== 'superseded' && memory.status !== 'expired' &&
        (!memory.expiresAt || !(new Date(memory.expiresAt).getTime() <= now));
}

function linkedSnapshots(memory: Source): MemorySourceSnapshot[] | undefined {
    const snapshots = parseMemorySourceSnapshots(memory.sourceMemorySnapshots);
    if (snapshots === undefined) return undefined;
    const ids = new Set(memory.sourceMemoryIds ?? []);
    return snapshots.length && snapshots.length === ids.size && new Set(snapshots.map(ref => ref.id)).size === snapshots.length &&
        snapshots.every(ref => ids.has(ref.id)) ? snapshots : [];
}

/** Capture the supplied source pool, never a later read or an ID invented by a model. */
export function snapshotMemorySources(sources: Source[], sourceIds = sources.map(source => source.id)): MemorySourceSnapshot[] {
    const ids = new Set(sourceIds);
    return [...new Map(sources.filter(source => ids.has(source.id)).map(source => [key(source), {
        id: source.id, domain: source.domain, assertionVersion: memoryAssertionVersion(source),
    }])).values()];
}

/** Keep absence distinct from an invalid snapshot: invalid versioned data fails closed. */
export function parseMemorySourceSnapshots(value: unknown): MemorySourceSnapshot[] | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || !value.length || value.length > MAX_SOURCES) return [];
    if (!value.every(source => source && typeof source.id === 'string' && source.id.length > 0 && source.id.length <= 120 &&
        typeof source.domain === 'string' && source.domain.length > 0 && source.domain.length <= 80 &&
        typeof source.assertionVersion === 'string' && /^[a-f0-9]{64}$/u.test(source.assertionVersion))) return [];
    return value.map(source => ({ id: source.id, domain: source.domain, assertionVersion: source.assertionVersion }));
}

/**
 * Read-only, bounded dependency validation. No cross-request cache: a correction or
 * deletion must be visible on the next recall. Legacy summaries without snapshots
 * remain readable; their historical source versions cannot be reconstructed.
 */
export async function filterCurrentDerivedMemories<T extends Source>(
    memories: T[],
    readSources: (refs: SourceRef[]) => Promise<Source[]>,
    now = Date.now(),
    onStaleSources?: (memory: T, sources: Source[]) => void,
): Promise<T[]> {
    const loaded = new Map<string, Source | null>();
    let frontier: Source[] = memories;
    for (let depth = 0; depth < MAX_DEPTH && frontier.length; depth++) {
        const pending = new Map<string, SourceRef>();
        for (const memory of frontier) for (const ref of linkedSnapshots(memory) ?? []) {
            if (!loaded.has(key(ref)) && loaded.size + pending.size < MAX_SOURCES) pending.set(key(ref), ref);
        }
        const refs = [...pending.values()];
        if (!refs.length) break;
        for (const ref of refs) loaded.set(key(ref), null);
        let sources: Source[];
        try { sources = await readSources(refs); } catch { sources = []; }
        frontier = [];
        for (const source of sources) if (pending.has(key(source))) {
            loaded.set(key(source), source);
            frontier.push(source);
        }
    }

    const checked = new Map<string, boolean>();
    const valid = (memory: Source, path: Set<string>): boolean => {
        if (!readable(memory, now)) return false;
        const snapshots = linkedSnapshots(memory);
        if (snapshots === undefined) return true;
        if (!snapshots.length || path.has(key(memory)) || path.size >= MAX_DEPTH) return false;
        const checkKey = JSON.stringify([key(memory), path.size]);
        if (checked.has(checkKey)) return checked.get(checkKey)!;
        const nextPath = new Set(path).add(key(memory));
        const current = snapshots.every(ref => {
            const source = loaded.get(key(ref));
            if (!source) return false;
            try { if (memoryAssertionVersion(source) !== ref.assertionVersion) return false; } catch { return false; }
            return valid(source, nextPath);
        });
        checked.set(checkKey, current);
        return current;
    };
    const primarySources = (memory: Source): Source[] => {
        const sources: Source[] = [];
        const queue = [{ memory, depth: 0 }];
        const visited = new Set([key(memory)]);
        for (let index = 0; index < queue.length; index++) {
            const node = queue[index];
            if (node.depth >= MAX_DEPTH) continue;
            for (const ref of linkedSnapshots(node.memory) ?? []) {
                if (visited.has(key(ref)) || visited.size >= MAX_SOURCES) continue;
                visited.add(key(ref));
                const source = loaded.get(key(ref));
                if (!source || !readable(source, now)) continue;
                if (isDerived(source)) queue.push({ memory: source, depth: node.depth + 1 });
                else sources.push(source);
            }
        }
        return sources;
    };
    return memories.filter(memory => {
        if (valid(memory, new Set())) return true;
        // Only a search hint. The caller must still apply person/topic scope and ranking.
        // Reuse already read current sources; never expose the stale summary as evidence.
        if (onStaleSources && readable(memory, now) && isDerived(memory)) {
            const sources = primarySources(memory);
            if (sources.length) onStaleSources(memory, sources);
        }
        return false;
    });
}
