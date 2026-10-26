import type { BotContext, SearchResult } from '../types';
import type { MemoryPerson, MemoryQueryPlan, MemoryRelationStep, MemoryReplyPerson } from '../types/memoryRecallTypes';
import type { IDomainVectorService } from '../services/interfaces/IDomainVectorService';
import { findPersonIdentitiesForRecall, findMentionedPeopleForRecall, readPersonIdentities } from '../services/PersonIdentityService';
import { contactNamesLikelyMatch, normalizeContactLookupValue, resolveContactIdentity, isMemoryEntryAllowedForContactScope, type ContactIdentityScope } from './contactMemory';
import { recallOwnerRelationship } from './personalRelationshipRecall';
import { validMemoryFocus, isMemoryContinuation, saveMemoryFocus, memoryQueryHistory } from './memoryQueryPlan';
import { memoryContentExcerpt } from './memoryRanking';
import { tokenizeMemoryRetrievalText, scoreMemoryLexicalMatch } from './memoryRetrieval';
import { isPersonRoleLabel, PERSON_RELATION_QUERY_SUBTYPES } from './personRelation';

export function personRecallScope(person: MemoryPerson): ContactIdentityScope {
    return { status: 'resolved', queryName: person.displayName, displayName: person.displayName,
        personIds: person.personIds, contactId: person.contactId, username: person.username, requireEntityMatch: true };
}

function personKey(person: MemoryPerson): string { return person.owner ? 'owner' : person.contactId ? `contact:${person.contactId}` : `person:${person.personIds.join(',')}`; }

export async function resolveNamedMemoryPerson(owner: string, mention: string): Promise<{ person?: MemoryPerson; ambiguous: boolean }> {
    if (isPersonRoleLabel(mention)) return { ambiguous: false };
    const contact = resolveContactIdentity(mention);
    if (contact.status === 'ambiguous') return { ambiguous: true };
    const contactId = contact.status === 'resolved' && contact.contact ? String(contact.contact.id) : undefined;
    const candidates = (await findPersonIdentitiesForRecall(owner, mention, contactId)).filter(candidate => contactId ||
        [candidate.displayName, ...(candidate.aliases ?? [])].some(alias => contactNamesLikelyMatch(alias, mention)));
    const groups = new Map<string, typeof candidates>();
    for (const candidate of candidates) {
        const key = candidate.telegramContactId ? `contact:${candidate.telegramContactId}` : `person:${candidate.id}`;
        groups.set(key, [...(groups.get(key) ?? []), candidate]);
    }
    if (groups.size > 1 || candidates.length >= 12) return { ambiguous: true };
    const identities = [...groups.values()][0] ?? [];
    if (!identities.length && !contactId) return { ambiguous: false };
    const identity = identities[0];
    return { ambiguous: false, person: { personIds: identities.map(item => item.id),
        displayName: identity?.displayName || (contact.status === 'resolved' ? contact.displayName : mention),
        contactId: identity?.telegramContactId || contactId, username: identity?.telegramUsername || (contact.status === 'resolved' ? contact.contact?.username : undefined),
        aliases: [...new Set(identities.flatMap(item => item.aliases ?? []))], evidenceIds: [] } };
}

const INVERSE_TYPES = { parent_of: 'child_of', child_of: 'parent_of', manager_of: 'reports_to', reports_to: 'manager_of' } as const;

export async function followMemoryRelations(service: IDomainVectorService, owner: string, root: MemoryPerson | undefined, path: MemoryRelationStep[]): Promise<{ person?: MemoryPerson; memories: SearchResult[]; ambiguous: boolean }> {
    let person = root;
    const memories = new Map<string, SearchResult>();
    for (const step of path) {
        const types = [...new Set([step.type, ...(step.alternatives ?? []), ...(PERSON_RELATION_QUERY_SUBTYPES[step.type] ?? [])])];
        const variants = types.map(type => ({ type, direction: step.direction }));
        const inverse = INVERSE_TYPES[step.type as keyof typeof INVERSE_TYPES];
        if (inverse) variants.push({ type: inverse, direction: step.direction === 'in' ? 'out' : 'in' });
        const matches = await Promise.all(variants.map(variant => recallOwnerRelationship(service, owner, '', Date.now(), { step: variant, anchor: person, identities: readPersonIdentities })));
        const resolved = matches.filter(match => match.complete && match.person);
        if (matches.some(match => match.context && !match.complete)) return { memories: [...memories.values()], ambiguous: true };
        const keys = new Set(resolved.map(match => personKey(match.person!)));
        if (keys.size > 1) return { memories: [...memories.values()], ambiguous: true };
        if (!resolved.length) return { memories: [...memories.values()], ambiguous: false };
        person = resolved[0].person;
        for (const match of resolved) for (const memory of match.memories) memories.set(memory.id, memory);
    }
    return { person, memories: [...memories.values()], ambiguous: false };
}

export interface MemoryEntityResolution {
    people: MemoryPerson[];
    memories: SearchResult[];
    ambiguous: boolean;
    requestedPerson: boolean;
    unresolved: boolean;
    query: string;
}

export async function resolveMemoryQueryEntities(ctx: BotContext, question: string, plan: MemoryQueryPlan, service: IDomainVectorService, replyPerson?: MemoryReplyPerson): Promise<MemoryEntityResolution> {
    const focus = validMemoryFocus(ctx);
    let fallbackPeople: MemoryPerson[] | undefined;
    const previousPeople = async () => {
        if (fallbackPeople) return fallbackPeople;
        if (replyPerson?.personId || replyPerson?.contactId) {
            const registered = replyPerson.personId ? await readPersonIdentities(String(ctx.from?.id), [replyPerson.personId]) :
                await findPersonIdentitiesForRecall(String(ctx.from?.id), replyPerson.contactName ?? '', String(replyPerson.contactId));
            const found = registered[0];
            if (registered.length > 1) return registered.map(item => ({ personIds: [item.id], displayName: item.displayName, contactId: item.telegramContactId, evidenceIds: [] }));
            fallbackPeople = found || replyPerson.contactId ? [{ personIds: found ? [found.id] : [], displayName: found?.displayName || replyPerson.contactName || 'контакт из reply',
                contactId: found?.telegramContactId || (replyPerson.contactId ? String(replyPerson.contactId) : undefined), evidenceIds: [] }] : [];
            return fallbackPeople;
        }
        if (focus) return focus.people;
        const active = ctx.session.activePersonContext;
        const candidates = active && active.expiresAt > Date.now() && active.personId
            ? await readPersonIdentities(String(ctx.from?.id), [active.personId])
            : await findMentionedPeopleForRecall(String(ctx.from?.id), memoryQueryHistory(ctx, question).map(item => item.content.slice(0, 120)).join('\n'));
        const groups = new Map<string, MemoryPerson>();
        for (const candidate of candidates) {
            const person: MemoryPerson = { personIds: [candidate.id], displayName: candidate.displayName, contactId: candidate.telegramContactId,
                username: candidate.telegramUsername ?? undefined, aliases: candidate.aliases, evidenceIds: [] };
            const key = personKey(person), existing = groups.get(key);
            if (existing) existing.personIds.push(candidate.id); else groups.set(key, person);
        }
        fallbackPeople = [...groups.values()]; return fallbackPeople;
    };
    const refs = plan.references ?? [];
    const resolved: MemoryPerson[] = [];
    const memories = new Map<string, SearchResult>();
    let ambiguous = false;
    let unresolved = false;
    const explicitTopic = refs.some(ref => ref.kind === 'topic' && ref.from !== 'focus');
    let requestedPerson = refs.some(ref => ref.kind === 'person');
    for (const ref of refs.filter(ref => ref.kind === 'person' || ref.from === 'owner')) {
        let root: MemoryPerson | undefined;
        if (ref.from === 'named') {
            const named = await resolveNamedMemoryPerson(String(ctx.from?.id), ref.mention);
            ambiguous ||= named.ambiguous; root = named.person;
            if (!root) { unresolved = true; continue; }
        } else if (ref.from === 'focus') {
            const previous = await previousPeople();
            if (!previous.length && focus && !focus.people.length) { if (refs.filter(item => item.kind === 'person').every(item => item.from === 'focus')) requestedPerson = false; continue; }
            if (previous.length !== 1) { ambiguous ||= previous.length > 1; unresolved ||= !previous.length; continue; }
            root = previous[0];
        }
        if (ref.relationPath.length) {
            const relation = await followMemoryRelations(service, String(ctx.from?.id), root, ref.relationPath);
            ambiguous ||= relation.ambiguous; root = relation.person;
            for (const memory of relation.memories) memories.set(memory.id, memory);
        }
        if (ref.from === 'owner' && !ref.relationPath.length) root = {
            personIds: ['user'], displayName: 'текущий пользователь (владелец диалога)', owner: true, evidenceIds: [],
        };
        if (root) resolved.push(root); else unresolved = true;
    }
    // Model failure or old text-format models retain grounded focus for genuine
    // continuations, never for an explicitly different person/topic.
    if (!refs.length && !explicitTopic && isMemoryContinuation(question)) {
        const previous = await previousPeople();
        requestedPerson = previous.length > 0;
        if (previous.length > 1 && !/(?<![\p{L}])(?:они|их|них|ними)(?![\p{L}])/iu.test(question)) ambiguous = true;
        else resolved.push(...previous);
    }
    const people = [...new Map(resolved.map(person => [personKey(person), person])).values()];
    const topicContinuation = focus && !explicitTopic && (refs.some(ref => ref.from === 'focus') || !refs.length && isMemoryContinuation(question));
    // The model may propose a search phrase, but only grounded names identify people.
    const query = people.length ? `${people.map(person => person.displayName).join('; ')}. ${question}` :
        topicContinuation ? `${focus.query}. ${question}` : plan.standaloneQuery || question;
    return { people: ambiguous ? [] : people, memories: [...memories.values()], ambiguous, unresolved, requestedPerson, query };
}

export function isUsablePersonEvidence(memory: SearchResult, person: MemoryPerson, now = Date.now()): boolean {
    return isMemoryEntryAllowedForContactScope(memory, personRecallScope(person)) &&
        !['bot', 'system', 'unknown'].includes(memory.subject ?? '') &&
        !memory.tags.some(tag => /^(?:subject|evidence_subject):(?:bot|system|unknown)$/.test(tag)) &&
        !['expired', 'superseded'].includes(memory.status ?? '') && (memory.confidence ?? .6) >= .5 &&
        (!memory.expiresAt || new Date(memory.expiresAt).getTime() > now);
}

export async function readPersonEvidence(service: IDomainVectorService, owner: string, person: MemoryPerson, domains: string[] = []): Promise<SearchResult[]> {
    if (person.owner) {
        const records = service.getOwnerMemories ? await service.getOwnerMemories(owner, domains, 300) :
            service.getMemoriesByTags ? await service.getMemoriesByTags(owner, ['subject:user', 'person_id:user'], 300) :
                await service.getMemoriesByTag(owner, 'subject:user');
        return [...new Map(records.filter(record => isUsablePersonEvidence(record, person) && (!domains.length || domains.includes(record.domain)))
            .map(record => [record.id, record])).values()];
    }
    const tags = [...person.personIds.filter(id => id !== 'user').map(id => `person_id:${id}`),
        ...(person.contactId ? [`contact_id:${person.contactId}`] : []),
        `contact_name:${person.displayName}`, `contact:${person.displayName}`,
        ...(person.username ? [`contact_username:@${person.username.replace(/^@/, '')}`, `contact_username:${person.username.replace(/^@/, '')}`] : []),
    ];
    const records = service.getMemoriesByTags ? await service.getMemoriesByTags(owner, tags, 300) :
        (await Promise.all(tags.map(tag => service.getMemoriesByTag(owner, tag)))).flat();
    // An edge may be stored on its other endpoint and have no person_id/contact_id
    // tag for this person. Read endpoint tags explicitly instead of scanning all edges.
    const endpointTags = person.personIds.filter(id => id !== 'user').slice(0, 12)
        .flatMap(id => [`relation_subject_person_id:${id}`, `relation_object_person_id:${id}`]);
    const relations: SearchResult[] = [];
    for (let start = 0; start < endpointTags.length; start += 16) {
        const batch = endpointTags.slice(start, start + 16);
        relations.push(...(service.getMemoriesByTags ? await service.getMemoriesByTags(owner, batch, 100).catch(() => []) :
            (await Promise.all(batch.map(tag => service.getMemoriesByTag(owner, tag).catch(() => [])))).flat())
            .filter(record => record.tags.includes('person_relation')));
    }
    return [...new Map([...relations, ...records].filter(record => isUsablePersonEvidence(record, person)).map(record => [record.id, record])).values()].slice(0, 400);
}

/** A direct owner↔person edge is different from a person's relationship with someone else. */
export function isOwnerPersonRelation(memory: SearchResult, person: MemoryPerson): boolean {
    const tags = memory.tags;
    return tags.includes('person_relation') && person.personIds.some(id =>
        tags.includes(`relation_subject_person_id:${id}`) && tags.includes('relation_object:user') ||
        tags.includes(`relation_object_person_id:${id}`) && tags.includes('relation_subject:user'));
}

function isQueriedPairRelation(memory: SearchResult, person: MemoryPerson, peers: MemoryPerson[]): boolean {
    if (!peers.length) return isOwnerPersonRelation(memory, person);
    return memory.tags.includes('person_relation') && person.personIds.some(id => peers.some(peer => peer.personIds.some(other =>
        memory.tags.includes(`relation_subject_person_id:${id}`) && memory.tags.includes(`relation_object_person_id:${other}`) ||
        memory.tags.includes(`relation_object_person_id:${id}`) && memory.tags.includes(`relation_subject_person_id:${other}`))));
}

/** Rank interaction evidence without declaring every fact about the person a joint fact. */
export function selectRelationshipEvidence(records: SearchResult[], person: MemoryPerson, queries: string, limit = 24, seen: ReadonlySet<string> = new Set(), peers: MemoryPerson[] = []): SearchResult[] {
    const names = tokenizeMemoryRetrievalText([person.displayName, ...(person.aliases ?? [])].join(' '));
    const topic = tokenizeMemoryRetrievalText(queries).filter(token => !names.some(name => contactNamesLikelyMatch(token, name))).join(' ');
    const score = (record: SearchResult) => Number(isQueriedPairRelation(record, person, peers)) * 10 +
        scoreMemoryLexicalMatch(record.content, topic).score * 4 + Number(record.memoryKind === 'relationship') +
        Number(!record.status || record.status === 'active') * .3 + (record.confidence ?? .6) * .2 -
        Number(seen.has(record.id)) * .75 -
        Number(record.tags.some(tag => tag === 'weak-evidence' || tag === 'needs-caution' || tag.startsWith('quality:') || tag === 'inference:ambiguous')) * .5;
    const sorted = records.filter(record => isUsablePersonEvidence(record, person))
        .sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id));
    const selected: SearchResult[] = [], buckets = new Map<string, number>();
    for (const record of sorted) {
        const bucket = isQueriedPairRelation(record, person, peers) ? 'pair' : `${record.memoryKind ?? 'fact'}:${record.domain}`;
        if ((buckets.get(bucket) ?? 0) >= (bucket === 'pair' ? 6 : 4)) continue;
        selected.push(record); buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
        if (selected.length >= limit) return selected;
    }
    for (const record of sorted) { if (selected.length >= limit) break; if (!selected.includes(record)) selected.push(record); }
    return selected;
}

/** Choose breadth for a profile, relevance for a specific question; names alone add no relevance. */
export function selectPersonEvidence(records: SearchResult[], person: MemoryPerson, question: string, overview: boolean, limit = 24, seen: ReadonlySet<string> = new Set(), preferTopic = false): SearchResult[] {
    const nameTokens = new Set(tokenizeMemoryRetrievalText([person.displayName, ...(person.aliases ?? [])].join(' ')));
    const topic = tokenizeMemoryRetrievalText(question).filter(token => !nameTokens.has(token)).join(' ');
    const score = (record: SearchResult) => {
        const kind = record.memoryKind ?? 'fact';
        const current = !record.status || record.status === 'active';
        const stable = ['fact', 'preference', 'boundary', 'relationship', 'trait', 'portrait'].includes(kind);
        return (overview ? Number(current) * .5 + Number(stable) * .3 : 0) +
            (!overview || preferTopic ? scoreMemoryLexicalMatch(record.content, topic).score * 2 : 0) +
            (record.confidence ?? .6) * .15 + (record.importance ?? .5) * .05 -
            (overview && seen.has(record.id) ? .75 : 0) -
            (record.tags.some(tag => tag === 'weak-evidence' || tag === 'needs-caution' || tag.startsWith('quality:') || tag === 'inference:ambiguous') ? .5 : 0);
    };
    const sorted = [...records].sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id));
    if (!overview) return sorted.slice(0, limit);
    const selected: SearchResult[] = [];
    const counts = new Map<string, number>();
    for (const record of sorted) {
        const bucket = `${record.memoryKind ?? 'fact'}:${record.domain}`;
        if ((counts.get(bucket) ?? 0) >= 3) continue;
        selected.push(record); counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
        if (selected.length >= limit) break;
    }
    for (const record of sorted) { if (selected.length >= limit) break; if (!selected.includes(record)) selected.push(record); }
    return selected;
}

export function formatPersonOverview(people: Array<{ person: MemoryPerson; records: SearchResult[] }>, budget = 6500, relationship = false): { context: string; included: SearchResult[] } {
    const lines = ['Подтверждённый предмет поиска — конкретные люди ниже. Их факты не относятся к владельцу автоматически. План/завершённое событие не является текущим состоянием. Это ограниченная выборка, не весь профиль. reported/inferred/ambiguous и quality требуют оговорки, не выдавай пересказ или вывод за прямые слова человека. Отсутствие записи не доказывает отсутствие сведений в архиве. Не выводи новые факты из фрагментов.'];
    if (people.some(item => item.person.owner)) lines[0] = 'Субъект «текущий пользователь (владелец диалога)» — автор текущего запроса, а не ассистент. Его «я/мои/обо мне» относятся к нему; в ответе обращайся «ты/твои/о тебе». Остальные люди — отдельные субъекты. Ниже только ограниченная выборка сохранённых сведений; планы, прошлые события, отрицания и временные границы не означают текущее состояние. Не выдумывай факты и не делай вывод об отсутствии сведений во всём архиве.';
    if (relationship) lines[0] += ' Вопрос о взаимодействии людей: ищи явно описанные совместные дела, разговоры и отношения в дословных фрагментах. pair=queried обозначает сохранённое ребро между запрошенными людьми (для одного человека — с владельцем); pair=context — только сведения о человеке, они сами по себе не доказывают общую работу или близость. Источник переписки и общие интересы не доказывают отношения. Отсутствие структурированного ребра не отменяет явно описанного в тексте взаимодействия. Отделяй подтверждённое от предположений.';
    const included: SearchResult[] = [];
    let remaining = budget - lines[0].length;
    // Interleave people so a comparison cannot silently omit the second person.
    for (let index = 0; index < 24; index++) for (const item of people) {
        const record = item.records[index]; if (!record || included.some(previous => previous.id === record.id)) continue;
        const peers = people.filter(other => other !== item).map(other => other.person);
        const provenance = record.tags.filter(tag => tag.startsWith('inference:') || tag.startsWith('quality:') || tag === 'weak-evidence' || tag === 'needs-caution').join(',');
        const text = `${item.person.displayName} [${record.domain}/${record.id}; subject=${record.subject ?? 'legacy'}; status=${record.status ?? 'active'}; confidence=${record.confidence ?? .6}; negated=${Boolean(record.negated)}${relationship ? `; pair=${isQueriedPairRelation(record, item.person, peers) ? 'queried' : 'context'}` : ''}${provenance ? `; ${provenance}` : ''}${record.validFrom ? `; from=${new Date(record.validFrom).toISOString()}` : ''}${record.validTo ? `; to=${new Date(record.validTo).toISOString()}` : ''}]: ${memoryContentExcerpt(record.content, '', 450)}`;
        if (text.length + 1 > remaining) continue;
        lines.push(text); remaining -= text.length + 1; included.push(record);
    }
    return { context: lines.join('\n'), included };
}

export function rememberResolvedSearch(ctx: BotContext, entities: MemoryEntityResolution, records: Array<{ id: string }>): void {
    saveMemoryFocus(ctx, entities.people, entities.query, [...entities.memories.map(record => record.id), ...records.map(record => record.id)]);
}
