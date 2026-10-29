import type { MemoryEntry } from '../services/interfaces/IVectorService';
import { containsMultipleAssertions } from './atomicAssertion';

export const MEMORY_TEMPORAL_SCOPES = ['stable', 'preference', 'routine', 'relationship', 'current_state', 'future_plan', 'past_event', 'unknown'] as const;
export type MemoryTemporalScope = typeof MEMORY_TEMPORAL_SCOPES[number];
type RetainedMemory = Partial<MemoryEntry>;
const lastingScopes = new Set<MemoryTemporalScope>(['stable', 'preference', 'routine', 'relationship', 'past_event']);
const derivedKinds = new Set(['episode', 'chapter', 'portrait']);
const derivedMethods = new Set(['episode', 'consolidation', 'compression', 'portrait']);

export function normalizeMemoryTemporalScope(value: unknown): MemoryTemporalScope {
    return MEMORY_TEMPORAL_SCOPES.includes(value as MemoryTemporalScope) ? value as MemoryTemporalScope : 'unknown';
}

/** Reuse the extraction contract; salience, a name or a domain alone prove no permanence. */
export function inferMemoryRetention(memory: RetainedMemory): 'durable' | 'standard' {
    if (!memory.content || containsMultipleAssertions(memory.content)) return 'standard';
    if (!['user', 'contact'].includes(memory.subject || '')) return 'standard';
    const tags = memory.tags ?? [];
    if (tags.some(tag => ['weak-evidence', 'needs-caution', 'inference:inferred', 'inference:ambiguous'].includes(tag))) return 'standard';
    if (derivedKinds.has(memory.memoryKind || '') || derivedMethods.has(memory.extractionMethod || '') ||
        tags.some(tag => /^(memory-(?:episode|chapter|schema)|user-schema|schema_key:|chapter_key:)/u.test(tag))) return 'standard';
    if (memory.subject === 'contact' && !tags.some(tag => /^(person_id:|contact_id:)/u.test(tag))) return 'standard';
    if (tags.some(tag => tag.startsWith('subject:') && tag !== `subject:${memory.subject}`)) return 'standard';
    const scopes = [...new Set(tags.filter(tag => tag.startsWith('temporal_scope:')).map(tag => normalizeMemoryTemporalScope(tag.slice('temporal_scope:'.length))))];
    if (scopes.some(scope => !lastingScopes.has(scope)) || memory.status === 'planned' || memory.status === 'unknown') return 'standard';
    const explicit = ['explicit', 'manual'].includes(memory.extractionMethod || '');
    const direct = explicit || ['quick', 'delayed'].includes(memory.extractionMethod || '') || tags.includes('inference:direct');
    const source = Boolean(memory.sourceContext?.trim()) && (explicit || Boolean(memory.sourceMessageIds?.length || memory.sourceMemoryIds?.length));
    if (!direct || !source || (memory.confidence ?? .6) < .6) return 'standard';
    return (scopes.length === 1 || (explicit && memory.isAnchor) || memory.retentionPolicy === 'durable') ? 'durable' : 'standard';
}

/** Stored protection survives paraphrase, confirmation and low access frequency. */
export function isDurableMemory(memory: RetainedMemory): boolean {
    return memory.retentionPolicy === 'durable' || inferMemoryRetention(memory) === 'durable';
}

/** Unclassified or open-ended primary knowledge is not disposable just because it is old. */
export function canAutomaticallyDeleteMemory(memory: RetainedMemory, now = Date.now()): boolean {
    if (isDurableMemory(memory)) return false;
    if (derivedKinds.has(memory.memoryKind || '') || derivedMethods.has(memory.extractionMethod || '')) return true;
    if (containsMultipleAssertions(memory.content || '')) return false;
    if (memory.status === 'superseded' || !memory.expiresAt) return false;
    const expiry = new Date(memory.expiresAt).getTime();
    const scopes = [...new Set((memory.tags ?? []).filter(tag => tag.startsWith('temporal_scope:')).map(tag => tag.slice('temporal_scope:'.length)))];
    return Number.isFinite(expiry) && expiry < now && scopes.length === 1 && ['future_plan', 'current_state'].includes(scopes[0]);
}

export function changesDurableAssertion(existing: RetainedMemory, incoming: RetainedMemory): boolean {
    if (incoming.confidence !== undefined && incoming.confidence < (existing.confidence ?? .6)) return true;
    for (const key of ['content', 'subject', 'predicate', 'object', 'negated', 'status'] as const) {
        if (key === 'negated' && Boolean(incoming.negated) === Boolean(existing.negated)) continue;
        if (key === 'status' && incoming.status === 'active' && existing.status === undefined) continue;
        if (incoming[key] !== undefined && incoming[key] !== existing[key]) return true;
    }
    for (const key of ['validFrom', 'validTo', 'expiresAt'] as const) {
        if (incoming[key] !== undefined && new Date(incoming[key]!).getTime() !== new Date(existing[key] || 0).getTime()) return true;
    }
    const identityTags = (tags: string[] = []) => tags.filter(tag => /^(subject:|person_id:|contact_id:|person_relation:)/u.test(tag)).sort().join('\n');
    return incoming.retentionPolicy === 'standard' || (incoming.tags !== undefined && identityTags(existing.tags) !== identityTags(incoming.tags));
}
