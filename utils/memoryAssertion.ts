import type { MemoryEntry } from '../services/interfaces/IVectorService';
import { containsMultipleAssertions } from './atomicAssertion';

type Assertion = Partial<Pick<MemoryEntry, 'content' | 'subject' | 'predicate' | 'object' | 'negated' | 'status' | 'validFrom' | 'validTo'>>;
const normalize = (value: string) => value.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();

/** Replacing a row is safe only for one assertion about the same subject/predicate. */
export function canSupersedeMemoryAssertions(incoming: Assertion, existing: Assertion): boolean {
    if ([incoming.content, existing.content].some(content => content && containsMultipleAssertions(content))) return false;
    if (incoming.subject && existing.subject && incoming.subject !== existing.subject) return false;
    if (incoming.predicate && existing.predicate && normalize(incoming.predicate) !== normalize(existing.predicate)) return false;
    return true;
}

/** High cosine similarity cannot turn a changed assertion into a confirmation. */
export function canDeduplicateMemoryAssertions(incoming: Assertion, existing: Assertion): boolean {
    if (!canSupersedeMemoryAssertions(incoming, existing)) return false;
    if (Boolean(incoming.negated) !== Boolean(existing.negated)) return false;
    for (const key of ['predicate', 'object'] as const) {
        if (incoming[key] && existing[key] && normalize(incoming[key]!) !== normalize(existing[key]!)) return false;
    }
    if (incoming.status && existing.status && incoming.status !== existing.status) return false;
    for (const key of ['validFrom', 'validTo'] as const) {
        if (incoming[key] && existing[key] && new Date(incoming[key]!).getTime() !== new Date(existing[key]!).getTime()) return false;
    }
    return true;
}
