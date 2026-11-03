import { ApiError } from '../../api/contracts';
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function invalid(): never { throw new ApiError(400, 'invalid_body', 'Некорректный запрос.'); }
export function object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
    return value as Record<string, unknown>;
}
export function fields(body: Record<string, unknown>, allowed: string[], required: string[] = []): void {
    if (Object.keys(body).some(k => !allowed.includes(k)) || required.some(k => !(k in body))) invalid();
}
export function version(body: Record<string, unknown>): void { if (body.version !== 1) invalid(); }
export function text(value: unknown, min = 1, max = 4096): string {
    if (typeof value !== 'string' || value.length < min || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) return invalid();
    return value;
}
export function uuid(value: unknown): string { const s = text(value, 36, 36); if (!UUID.test(s)) invalid(); return s.toLowerCase(); }
export function idempotency(value: unknown): string {
    const s = text(value, 8, 128); if (!/^[A-Za-z0-9_-]+$/.test(s)) invalid(); return s;
}
/** JSON object order is not semantic; Swift/HTTP retries may encode keys in another order. */
export function canonicalJson(value: unknown): string {
    const canonical = (item: unknown): unknown => Array.isArray(item) ? item.map(canonical)
        : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([k, val]) => [k, canonical(val)])) : item;
    return JSON.stringify(canonical(value));
}
