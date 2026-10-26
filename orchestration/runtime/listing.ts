import { objectSchema, textSchema } from './registry';

export const listSchema = objectSchema({ query: textSchema('Фильтр по тексту объекта', 300), offset: { type: 'integer', minimum: 0, maximum: 100_000 }, limit: { type: 'integer', minimum: 1, maximum: 20 } }, []);

/** Bound a page rather than discarding an oversized list and losing its object IDs. */
export function listPage<T extends object>(records: T[], args: Record<string, unknown>) {
    const query = String(args.query ?? '').toLocaleLowerCase();
    const matching = query ? records.filter(record => JSON.stringify(record).toLocaleLowerCase().includes(query)) : records;
    const offset = Number(args.offset ?? 0); const limit = Number(args.limit ?? 10);
    const items: Array<T | { id?: unknown; detailsTruncated: true; preview: string }> = [];
    let chars = 0;
    for (const record of matching.slice(offset, offset + limit)) {
        const json = JSON.stringify(record);
        const item = json.length > 7000 ? { id: (record as { id?: unknown }).id, detailsTruncated: true as const, preview: json.slice(0, 1200) } : record;
        const size = JSON.stringify(item).length;
        if (items.length && chars + size > 8000) break;
        items.push(item); chars += size;
    }
    const next = offset + items.length;
    return { items, total: matching.length, offset, ...(next < matching.length ? { nextOffset: next } : {}) };
}
