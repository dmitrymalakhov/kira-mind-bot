import { createHash } from 'node:crypto';
import { tokenizeMemoryRetrievalText } from './memoryRetrieval';

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
    return 'rerank_v2:' + createHash('sha256').update(JSON.stringify({ scope, query, candidates, maxReturn })).digest('hex');
}
