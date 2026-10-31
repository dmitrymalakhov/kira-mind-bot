import { AsyncLocalStorage } from 'node:async_hooks';
import type { MemoryReadCoverage, MemoryRecallSummary } from '../types/memoryRecallTypes';

interface Reads { succeeded: number; failed: number; errors: Set<unknown>; active: boolean }
const scope = new AsyncLocalStorage<Reads>();
const current = () => { const reads = scope.getStore(); return reads?.active ? reads : undefined; };

/** No error text, queries, owner IDs or memory payloads enter this diagnostic. */
export function recordMemoryReadFailure(error: unknown): void {
    const reads = current();
    if (reads && !reads.errors.has(error)) { reads.failed++; reads.errors.add(error); }
}

export function memoryReadIncomplete(): boolean { return Boolean(current()?.failed); }
export function isMemoryReadFailure(error: unknown): boolean { return Boolean(current()?.errors.has(error)); }

/** Observe the real source request before callers degrade to an empty array. */
export async function observeMemoryRead<T>(read: () => Promise<T>): Promise<T> {
    const reads = current();
    if (!reads) return read();
    try { const result = await read(); if (reads.active) reads.succeeded++; return result; }
    catch (error) { if (reads.active) { reads.failed++; reads.errors.add(error); } throw error; }
}

/** Preserve the existing caller's fallback and report failures from alternate backends too. */
export async function readMemoryOr<T>(read: () => Promise<T>, fallback: T): Promise<T> {
    try { return await read(); }
    catch (error) { recordMemoryReadFailure(error); return fallback; }
}

/** Nested lookups have local coverage and merge into the enclosing owner/channel turn. */
export async function collectMemoryReads<T>(read: () => Promise<T>): Promise<{ value: T; coverage?: MemoryReadCoverage }> {
    const parent = current();
    const reads: Reads = { succeeded: 0, failed: 0, errors: new Set(), active: true };
    try {
        const value = await scope.run(reads, read);
        const coverage = reads.succeeded || reads.failed ? {
            status: reads.failed ? reads.succeeded ? 'partial' as const : 'unavailable' as const : 'available' as const,
            succeeded: reads.succeeded, failed: reads.failed,
        } : undefined;
        return { value, coverage };
    } finally {
        reads.active = false;
        if (parent?.active) {
            parent.succeeded += reads.succeeded;
            parent.failed += reads.failed;
            for (const error of reads.errors) parent.errors.add(error);
        }
        reads.errors.clear();
    }
}

const UNAVAILABLE = 'Сейчас не удалось прочитать память. Это сбой поиска, а не отсутствие сохранённых сведений. Не проси повторно сообщить факты и не утверждай, что пользователь их не рассказывал.';
const PARTIAL = 'Поиск выполнен частично: часть источников памяти не удалось прочитать. Используй найденные свидетельства, но не утверждай полноту списка или отсутствие других сведений. Недоступный источник не означает, что факт не сохранён.';

export function applyMemoryReadCoverage<T extends { context: string; recall?: MemoryRecallSummary }>(result: T, coverage?: MemoryReadCoverage): T {
    if (!coverage || !result.recall) return result;
    const recall = { ...result.recall, readCoverage: coverage };
    if (!coverage.failed) return { ...result, recall };
    const hasEvidence = recall.evidenceCount > 0;
    if (recall.state !== 'ambiguous') recall.state = hasEvidence || coverage.status === 'partial' ? 'partial' : 'unavailable';
    recall.identityVerified = false;
    delete recall.noNewEvidenceInPool;
    return { ...result, recall, context: hasEvidence || recall.state === 'ambiguous'
        ? `${result.context.includes(PARTIAL) ? '' : PARTIAL + '\n\n'}${result.context}` : coverage.status === 'unavailable' ? UNAVAILABLE : PARTIAL };
}
