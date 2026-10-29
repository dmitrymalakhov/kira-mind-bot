import { createHash } from 'node:crypto';
import { tokenizeMemoryRetrievalText } from './memoryRetrieval';
import type { SearchResult } from '../services/interfaces/IVectorService';

/** Meaning-bearing metadata must survive the bounded reranker representation. */
export function formatMemoryRerankCandidate(memory: Partial<Pick<SearchResult, 'tags' | 'negated' | 'validFrom' | 'validTo' | 'predicate'>> & {
    content: string; subject?: string; memoryKind?: string; status?: string;
}, index: number, query: string): string {
    const date = (value: Date | undefined) => {
        const time = value ? new Date(value).getTime() : NaN;
        return Number.isFinite(time) ? new Date(time).toISOString().slice(0, 10) : undefined;
    };
    const meta = JSON.stringify({
        subject: String(memory.subject ?? memory.tags?.find(tag => tag.startsWith('subject:'))?.slice(8) ?? 'unknown').slice(0, 20),
        identity: memory.tags?.filter(tag => /^(?:person_id|contact_id|contact_name):/.test(tag)).slice(0, 2).map(tag => tag.slice(0, 70)),
        kind: memory.memoryKind,
        status: memory.status,
        negated: memory.negated === true,
        validFrom: date(memory.validFrom), validTo: date(memory.validTo),
        predicate: memory.predicate?.slice(0, 70),
    });
    const prefix = `${index + 1}. ${meta}\n`;
    return prefix + memoryContentExcerpt(memory.content, query, Math.max(100, 900 - prefix.length));
}

/** Pure, bounded verbatim excerpt. Omitted parts are explicitly marked. */
export function memoryContentExcerpt(content: string, query: string, maxChars: number): string {
    if (content.length <= maxChars) return content;
    const marker = '[фрагмент] ';
    const size = Math.max(0, maxChars - marker.length - 2);
    const text = content.toLowerCase().replace(/ё/g, 'е');
    const tokens = tokenizeMemoryRetrievalText(query);
    const positions = tokens.flatMap(token => {
        const position = text.indexOf(token);
        return position < 0 ? [] : [position];
    });
    const starts = [0, ...positions.map(position => Math.max(0, position - Math.floor(size / 3)))];
    const best = starts.map(start => {
        const snippet = text.slice(start, start + size);
        return { start, matches: tokens.filter(token => snippet.includes(token)).length };
    }).sort((a, b) => b.matches - a.matches || a.start - b.start)[0];
    return marker + (best.start > 0 ? '…' : '') + content.slice(best.start, best.start + size) + '…';
}

/** Prose, partial integers and numbers outside the presented pool are invalid. */
export function parseMemoryRerankOrder(text: string, count: number): number[] | null {
    if (/^NONE$/i.test(text.trim())) return [];
    if (!/^\s*\d+(?:\s*,\s*\d+)*\s*$/u.test(text)) return null;
    const numbers = text.split(',').map(value => Number(value.trim()));
    if (numbers.some(value => !Number.isSafeInteger(value) || value < 1 || value > count)) return null;
    return [...new Set(numbers)].map(value => value - 1);
}

/** Content changes, long-query suffixes and owner scope must invalidate cached order. */
export function memoryRerankCacheKey(scope: string, query: string, candidates: Array<{ id: string; content: string }>, maxReturn: number): string {
    return 'rerank_v3:' + createHash('sha256').update(JSON.stringify({ scope, query, candidates, maxReturn })).digest('hex');
}
