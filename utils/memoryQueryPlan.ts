import { createHash } from 'node:crypto';
import type { BotContext } from '../types';
import type { MemoryQueryPlan, MemoryQueryReference, MemoryRecallFocus } from '../types/memoryRecallTypes';
import { PERSON_RELATION_TYPES, SYMMETRIC_PERSON_RELATION_TYPES } from './personRelation';

export const MEMORY_FOCUS_TTL_MS = 30 * 60_000;
const normalize = (text: string) => text.normalize('NFKC').toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();

export function memoryQueryHistory(ctx: BotContext, message: string): Array<{ role: string; content: string }> {
    const history = ctx.session.messageHistory ?? [];
    // Foreground includes the new user message, a deferred snapshot does not.
    const skip = history[0]?.role === 'user' && normalize(history[0].content) === normalize(message) ? 1 : 0;
    return history.slice(skip, skip + 3).reverse().map(({ role, content }) => ({ role, content }));
}

export function memoryQueryCacheKey(message: string, history: Array<{ role: string; content: string }>): string {
    return 'queries_v3:' + createHash('sha256').update(JSON.stringify({ message, history })).digest('hex');
}

export function parseMemoryQueryPlan(text: string, question: string, history: Array<{ role: string; content: string }> = []): MemoryQueryPlan | undefined {
    let value: any;
    try { value = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { return undefined; }
    if (!value || typeof value !== 'object') return undefined;
    const queries = (items: unknown): string[] => Array.isArray(items)
        ? [...new Set(items.filter((q): q is string => typeof q === 'string' && q.trim().length > 1 && q.length <= 160).map(q => q.trim()))].slice(0, 4) : [];
    const answerQueries = queries(value.answerQueries);
    if (!answerQueries.length) return undefined;
    const source = normalize([question, ...history.map(item => item.content.slice(0, 120))].join('\n'));
    const references: MemoryQueryReference[] = [];
    for (const ref of (Array.isArray(value.references) ? value.references.slice(0, 4) : [])) {
        if (!ref || !['person', 'topic'].includes(ref.kind) || !['named', 'owner', 'focus'].includes(ref.from) || typeof ref.mention !== 'string' || ref.mention.length > 120) continue;
        if (!ref.mention.trim() || !source.includes(normalize(ref.mention))) continue;
        // Owner relation requests must originate in user words, not a bot's claimed relationship.
        if (ref.from === 'owner' && !normalize(question).includes(normalize(ref.mention))) continue;
        const steps = Array.isArray(ref.relationPath) ? ref.relationPath : [];
        if (steps.length > 3 || steps.some((step: any) => !step || !PERSON_RELATION_TYPES.includes(step.type) ||
            !['out', 'in', 'either'].includes(step.direction) || step.direction === 'either' && !SYMMETRIC_PERSON_RELATION_TYPES.has(step.type))) continue;
        if (ref.kind === 'person' && ref.from === 'owner' && !steps.length) continue;
        const path = steps.map((step: any) => ({ type: step.type, direction: step.direction,
            alternatives: step.direction === 'either' && Array.isArray(step.alternatives)
                ? [...new Set(step.alternatives.filter((type: any) => PERSON_RELATION_TYPES.includes(type) && SYMMETRIC_PERSON_RELATION_TYPES.has(type)))].slice(0, 3) as any : undefined }));
        references.push({ kind: ref.kind, mention: ref.mention.trim(), from: ref.from, relationPath: path });
    }
    return { answerQueries, contextQueries: queries(value.contextQueries), references,
        standaloneQuery: typeof value.standaloneQuery === 'string' && value.standaloneQuery.length <= 600 ? value.standaloneQuery.trim() : undefined,
        requestKind: ['identity', 'overview', 'specific'].includes(value.requestKind) ? value.requestKind : 'specific' };
}

export function validMemoryFocus(ctx: BotContext, now = Date.now()): MemoryRecallFocus | undefined {
    const focus = ctx.session.memoryRecallFocus;
    if (!focus || focus.expiresAt <= now || focus.ownerId !== String(ctx.from?.id) ||
        focus.channel !== (ctx.sessionStorageKey ?? String(ctx.chat?.id)) || !focus.evidenceIds?.length) return undefined;
    return focus;
}

/** Admission/fallback cue only; actual identity is read from grounded focus, never from this regex. */
export function isMemoryContinuation(message: string): boolean {
    return /(?<![\p{L}])(?:он|она|они|него|нее|неё|нему|ней|ним|них|ему|её|его|их|это|этого|этом|этой|там)(?![\p{L}])|(?:подробнее|что\s+ещ[её]|расскажи\s+ещ[её]|продолжи)/iu.test(message);
}

export function saveMemoryFocus(ctx: BotContext, people: MemoryRecallFocus['people'], query: string, evidenceIds: string[], now = Date.now()): void {
    if (!evidenceIds.length || ctx.chat?.type !== 'private') return;
    const previous = validMemoryFocus(ctx, now);
    const keys = (items: MemoryRecallFocus['people']) => items.map(person => person.contactId ?? [...person.personIds].sort().join(',')).sort().join(';');
    const seen = people.length && previous && keys(previous.people) === keys(people) ? previous.evidenceIds : [];
    ctx.session.memoryRecallFocus = { ownerId: String(ctx.from?.id), channel: ctx.sessionStorageKey ?? String(ctx.chat?.id),
        people: people.slice(0, 4), query: query.slice(0, 600), evidenceIds: [...new Set([...evidenceIds, ...seen])].slice(0, 200), expiresAt: now + MEMORY_FOCUS_TTL_MS };
}
