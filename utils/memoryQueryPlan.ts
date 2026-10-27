import { createHash } from 'node:crypto';
import type { BotContext } from '../types';
import type { MemoryQueryPlan, MemoryQueryReference, MemoryRecallFocus } from '../types/memoryRecallTypes';
import { PERSON_RELATION_TYPES, SYMMETRIC_PERSON_RELATION_TYPES } from './personRelation';
import { PREDEFINED_DOMAINS } from '../constants/domains';
import { hasOwnerSelfReference } from './personalRecallIntent';

export const MEMORY_FOCUS_TTL_MS = 30 * 60_000;
const normalize = (text: string) => text.normalize('NFKC').toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();

export function memoryQueryHistory(ctx: BotContext, message: string): Array<{ role: string; content: string }> {
    const history = ctx.session.messageHistory ?? [];
    // Foreground includes the new user message, a deferred snapshot does not.
    const skip = history[0]?.role === 'user' && normalize(history[0].content) === normalize(message) ? 1 : 0;
    return history.slice(skip, skip + 3).reverse().map(({ role, content }) => ({ role, content }));
}

export function memoryQueryCacheKey(message: string, history: Array<{ role: string; content: string }>): string {
    return 'queries_v9:' + createHash('sha256').update(JSON.stringify({ message, history })).digest('hex');
}

/** A demonstrative reference cannot become a literal name even if the planner labels it named. */
export function normalizeMemoryReference(ref: MemoryQueryReference): MemoryQueryReference {
    if (ref.from !== 'named') return ref;
    const mention = normalize(ref.mention);
    const pronoun = /^(?:он|она|они|его|ее|ему|ей|него|нее|нему|ней|ним|них|ими|их|это|этого|этом|этой|там)$/u.test(mention);
    const demonstrative = /^(?:этот|эта|это|эти|этого|этому|этой|этом|этим|этих|эту)\s+(?:человек(?:а|у|ом|е)?|люд(?:и|ей|ям|ьми|ях)|собеседник(?:а|у|ом|е)?|контакт(?:а|у|ом|е)?|проект(?:а|у|ом|е)?|тем(?:а|ы|е|у|ой))$/u.test(mention);
    return pronoun || demonstrative ? { ...ref, from: 'focus' } : ref;
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
        if (ref.from === 'owner' && !steps.length && !hasOwnerSelfReference(ref.mention)) continue;
        const path = steps.map((step: any) => ({ type: step.type, direction: step.direction,
            alternatives: step.direction === 'either' && Array.isArray(step.alternatives)
                ? [...new Set(step.alternatives.filter((type: any) => PERSON_RELATION_TYPES.includes(type) && SYMMETRIC_PERSON_RELATION_TYPES.has(type)))].slice(0, 3) as any : undefined }));
        references.push({ kind: ref.kind, mention: ref.mention.trim(), from: ref.from, relationPath: path });
    }
    return { answerQueries, contextQueries: queries(value.contextQueries), references: references.map(normalizeMemoryReference), includeConversations: value.includeConversations === true,
        domains: Array.isArray(value.domains) ? [...new Set(value.domains.filter((domain: unknown) =>
            typeof domain === 'string' && Object.values(PREDEFINED_DOMAINS).includes(domain as any)))].slice(0, 3) as string[] : [],
        standaloneQuery: typeof value.standaloneQuery === 'string' && value.standaloneQuery.length <= 600 ? value.standaloneQuery.trim() : undefined,
        peopleQuery: value.requestKind === 'people_list' && value.peopleQuery && ['relationships', 'communication', 'both'].includes(value.peopleQuery.basis)
            ? { basis: value.peopleQuery.basis, relations: Array.isArray(value.peopleQuery.relations)
                ? value.peopleQuery.relations.filter((step: any) => step && PERSON_RELATION_TYPES.includes(step.type) &&
                    ['out', 'in', 'either'].includes(step.direction) && (step.direction !== 'either' || SYMMETRIC_PERSON_RELATION_TYPES.has(step.type)))
                    .slice(0, 6).map((step: any) => ({ type: step.type, direction: step.direction })) : [] } : undefined,
        requestKind: ['identity', 'overview', 'relationship', 'highlight', 'people_list', 'specific'].includes(value.requestKind) ? value.requestKind : 'specific' };
}

export function validMemoryFocus(ctx: BotContext, now = Date.now()): MemoryRecallFocus | undefined {
    const focus = ctx.session.memoryRecallFocus;
    if (!focus || focus.expiresAt <= now || focus.ownerId !== String(ctx.from?.id) ||
        focus.channel !== (ctx.sessionStorageKey ?? String(ctx.chat?.id)) || !focus.evidenceIds?.length) return undefined;
    return focus;
}

/** Admission/fallback cue only; actual identity is read from grounded focus, never from this regex. */
export function isMemoryContinuation(message: string): boolean {
    return /(?<![\p{L}])(?:он|она|они|него|нее|неё|нему|ней|ним|них|ему|её|его|их|это|этого|этом|этой|там)(?![\p{L}])|(?:подробнее|(?:что|кто)\s+ещ[её]|расскажи\s+ещ[её]|продолжи)/iu.test(message);
}

/** Keep an explicitly established topic on continuations, without carrying it to a new question. */
export function continueMemoryQueryPlan(plan: MemoryQueryPlan, question: string, focus?: MemoryRecallFocus): MemoryQueryPlan {
    plan = { ...plan, references: plan.references?.map(normalizeMemoryReference) };
    if (!focus || !isMemoryContinuation(question) || plan.references?.some(ref => ref.from !== 'focus')) return plan;
    return { ...plan, domains: plan.domains?.length ? plan.domains : focus.domains,
        includeConversations: plan.domains?.length ? plan.includeConversations : plan.includeConversations || focus.includeConversations,
        ...(focus.requestKind === 'people_list' && !focus.people.length && !plan.peopleQuery &&
            /^(?:а\s+)?(?:что\s+ещ[её]|кто\s+ещ[её]|расскажи\s+ещ[её]|продолжи|подробнее)[\s?!.,]*$/iu.test(question.trim())
            ? { requestKind: 'people_list', peopleQuery: focus.peopleQuery,
                references: [{ kind: 'person', mention: 'я', from: 'owner', relationPath: [] }] } : {}),
    };
}

export function saveMemoryFocus(ctx: BotContext, people: MemoryRecallFocus['people'], query: string, evidenceIds: string[], now = Date.now(), plan?: MemoryQueryPlan): void {
    if (!evidenceIds.length || ctx.chat?.type !== 'private') return;
    const previous = validMemoryFocus(ctx, now);
    const sameScope = previous && memoryFocusMatches(previous, people, plan);
    const seen = sameScope ? previous.evidenceIds : [];
    ctx.session.memoryRecallFocus = { ownerId: String(ctx.from?.id), channel: ctx.sessionStorageKey ?? String(ctx.chat?.id),
        people: people.slice(0, 4), query: query.slice(0, 600), evidenceIds: [...new Set([...evidenceIds, ...seen])].slice(0, 200), expiresAt: now + MEMORY_FOCUS_TTL_MS,
        domains: plan?.domains, requestKind: plan?.requestKind, peopleQuery: plan?.peopleQuery, includeConversations: plan?.includeConversations };
}

export function memoryFocusMatches(focus: MemoryRecallFocus, people: MemoryRecallFocus['people'], plan?: MemoryQueryPlan): boolean {
    const keys = (items: MemoryRecallFocus['people']) => items.map(person => person.contactId ?? [...person.personIds].sort().join(',')).sort().join(';');
    return keys(focus.people) === keys(people) && JSON.stringify([...(focus.domains ?? [])].sort()) === JSON.stringify([...(plan?.domains ?? [])].sort()) &&
        focus.requestKind === plan?.requestKind;
}
