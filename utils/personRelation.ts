export const PERSON_RELATION_TYPES = [
    'spouse_of',
    'partner_of',
    'ex_partner_of',
    'parent_of',
    'child_of',
    'sibling_of',
    'relative_of',
    'friend_of',
    'coworker_of',
    'works_with',
    'manager_of',
    'reports_to',
    'client_of',
    'studies_with',
    'lives_with',
    'neighbor_of',
    'knows',
    'introduced_by',
] as const;

export type PersonRelationType = typeof PERSON_RELATION_TYPES[number];
export type PersonRelationTargetRole = 'user' | 'contact' | 'third_party';

export interface PersonRelationDescriptor {
    type: PersonRelationType;
    targetRole: PersonRelationTargetRole;
    /** Exact name copied from evidence. Required only for a named third party. */
    targetName?: string;
}

export interface PersonRelationCandidateContext {
    subject: 'user' | 'contact';
    evidence?: string;
    ownerName?: string;
    contactName?: string;
}

export interface PersonRelationTagContext {
    subject: 'user' | 'contact';
    subjectPersonId?: string;
    targetPersonId?: string;
    targetName?: string;
}

const VALID_RELATION_TYPES = new Set<string>(PERSON_RELATION_TYPES);

const RELATION_EVIDENCE_PATTERNS: Record<PersonRelationType, RegExp> = {
    spouse_of: /супруг|муж|жен[аы]|женат|замуж|в\s+браке|spouse|husband|wife/iu,
    partner_of: /партн[её]р|отношени|встреча(?:юсь|ется|ются)|partner|dating/iu,
    ex_partner_of: /бывш[\p{L}-]*\s+(?:муж|жен|партн[её]р)|экс[-\s]?партн[её]р|ex[-\s]?partner/iu,
    parent_of: /мам|мать|матер|пап|отец|родител|сын|доч|реб[её]нок|parent|mother|father|son|daughter/iu,
    child_of: /мам|мать|матер|пап|отец|родител|сын|доч|реб[её]нок|parent|mother|father|son|daughter/iu,
    sibling_of: /брат|сестр|siblings?|brother|sister/iu,
    relative_of: /родствен|родн(?:ой|ая|ые)|дяд|т[её]т|племян|кузен|кузин|relative|cousin/iu,
    friend_of: /(?<![а-яёa-z])(?:друг(?:а|у|ом|е|и)?|друз(?:ья|ей|ьям|ьями)|подруг[\p{L}-]*|друж[\p{L}-]*|friends?)(?![а-яёa-z])/iu,
    coworker_of: /коллег|coworker|colleague/iu,
    works_with: /вместе\s+работ|работа(?:ю|ет|ем|ют)\s+с|works?\s+with/iu,
    manager_of: /руководител|начальник|менеджер|manager|supervisor|boss/iu,
    reports_to: /подчин[её]н|отчитыва(?:юсь|ется)|reports?\s+to/iu,
    client_of: /клиент|заказчик|client|customer/iu,
    studies_with: /вместе\s+уч|уч(?:усь|ится|имся)\s+с|одногрупп|однокурс|classmate|studies?\s+with/iu,
    lives_with: /жив(?:у|ет|ём|ем|ут)\s+(?:вместе|с)|сожитель|lives?\s+with/iu,
    neighbor_of: /сосед|neighbor/iu,
    knows: /знаком|познаком|зна(?:ю|ет|ем|ют)\s+(?:его|е[её]|их|друг)|knows?|acquaint/iu,
    introduced_by: /познакомил|представил|св[её]л|через\s+.{0,60}\s+познаком|introduced|met\s+through/iu,
};

export const SYMMETRIC_PERSON_RELATION_TYPES = new Set<PersonRelationType>([
    'spouse_of',
    'partner_of',
    'ex_partner_of',
    'sibling_of',
    'relative_of',
    'friend_of',
    'coworker_of',
    'works_with',
    'studies_with',
    'lives_with',
    'neighbor_of',
    'knows',
]);

function normalizeName(value: unknown): string | undefined {
    const name = String(value ?? '').replace(/\s+/gu, ' ').trim();
    return name.length >= 2 && name.length <= 100 ? name : undefined;
}

function comparableText(value: string): string {
    return value
        .normalize('NFKC')
        .toLocaleLowerCase('ru-RU')
        .replace(/ё/gu, 'е')
        .replace(/[^\p{L}\p{N}@]+/gu, ' ')
        .replace(/\s+/gu, ' ')
        .trim();
}

function evidenceContainsExactName(evidence: string | undefined, name: string): boolean {
    const haystack = ` ${comparableText(evidence ?? '')} `;
    const needle = comparableText(name);
    return Boolean(needle) && haystack.includes(` ${needle} `);
}

/**
 * Keeps only binary person relations whose second endpoint can be proven and
 * resolved without guessing. A named third party must be copied verbatim from
 * evidence; owner/contact endpoints are supplied by the chat context.
 */
export function normalizePersonRelationDescriptor(
    value: unknown,
    context: PersonRelationCandidateContext,
): PersonRelationDescriptor | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const candidate = value as Record<string, unknown>;
    const type = String(candidate.type ?? '').trim().toLowerCase();
    if (!VALID_RELATION_TYPES.has(type)) return undefined;
    if (!RELATION_EVIDENCE_PATTERNS[type as PersonRelationType].test(context.evidence ?? '')) return undefined;

    const targetRole = String(candidate.targetRole ?? '').trim().toLowerCase();
    if (!['user', 'contact', 'third_party'].includes(targetRole)) return undefined;
    if (context.subject === 'user' && targetRole === 'user') return undefined;
    if (context.subject === 'contact' && targetRole === 'contact') return undefined;

    if (targetRole === 'third_party') {
        const targetName = normalizeName(candidate.targetName);
        if (!targetName || !evidenceContainsExactName(context.evidence, targetName)) return undefined;

        const subjectName = context.subject === 'user' ? context.ownerName : context.contactName;
        if (subjectName && comparableText(subjectName) === comparableText(targetName)) return undefined;
        return { type: type as PersonRelationType, targetRole, targetName };
    }

    return {
        type: type as PersonRelationType,
        targetRole: targetRole as PersonRelationTargetRole,
    };
}

/** Stable, tag-only representation consumed by Memory Atlas. */
export function buildPersonRelationTags(
    relation: PersonRelationDescriptor,
    context: PersonRelationTagContext,
): string[] {
    const subjectEndpoint = context.subject === 'user'
        ? 'relation_subject:user'
        : context.subjectPersonId
            ? `relation_subject_person_id:${context.subjectPersonId}`
            : undefined;
    const objectEndpoint = relation.targetRole === 'user'
        ? 'relation_object:user'
        : context.targetPersonId
            ? `relation_object_person_id:${context.targetPersonId}`
            : undefined;

    if (!subjectEndpoint || !objectEndpoint) return [];

    const targetName = normalizeName(context.targetName ?? relation.targetName);
    return [...new Set([
        'person_relation',
        `relation_type:${relation.type}`,
        subjectEndpoint,
        objectEndpoint,
        targetName ? `relation_object_name:${targetName}` : '',
        `relation_direction:${SYMMETRIC_PERSON_RELATION_TYPES.has(relation.type) ? 'symmetric' : 'directed'}`,
    ].filter(Boolean))];
}

function relationIdentityTags(tags: string[] | undefined): string[] {
    return (tags ?? [])
        .map(String)
        .filter(tag => tag === 'person_relation' ||
            tag.startsWith('relation_type:') ||
            tag.startsWith('relation_subject:') ||
            tag.startsWith('relation_subject_person_id:') ||
            tag.startsWith('relation_object:') ||
            tag.startsWith('relation_object_person_id:'))
        .sort();
}

/** Prevents vector deduplication from merging facts about different pairs. */
export function arePersonRelationTagScopesCompatible(
    incomingTags: string[],
    existingTags: string[] | undefined,
): boolean {
    const incoming = relationIdentityTags(incomingTags);
    const existing = relationIdentityTags(existingTags);
    if (incoming.length === 0 && existing.length === 0) return true;
    if (incoming.length === 0 || existing.length === 0) return false;
    return incoming.length === existing.length && incoming.every((tag, index) => tag === existing[index]);
}
