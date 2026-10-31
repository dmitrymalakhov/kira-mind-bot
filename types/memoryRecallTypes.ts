import type { PersonRelationType } from '../utils/personRelation';

export interface MemoryPerson {
    personIds: string[];
    displayName: string;
    contactId?: string;
    username?: string;
    aliases?: string[];
    evidenceIds: string[];
    owner?: boolean;
}

export interface MemoryReplyPerson { personId?: string; contactId?: number; contactName?: string }

/** Search context only. Never authorizes sending, saving facts or merging identities. */
export interface MemoryRecallFocus {
    ownerId: string;
    channel: string;
    people: MemoryPerson[];
    query: string;
    evidenceIds: string[];
    expiresAt: number;
    /** Grounded search facets survive short follow-ups; never grants action scope. */
    domains?: string[];
    requestKind?: MemoryQueryPlan['requestKind'];
    peopleQuery?: MemoryQueryPlan['peopleQuery'];
    includeConversations?: boolean;
}

/** Retrieval outcome, separate from conversational summaries or assistant claims. */
export interface MemoryRecallSummary {
    state: 'found' | 'empty' | 'partial' | 'ambiguous' | 'unresolved' | 'unavailable';
    /** Availability of attempted reads, never completeness of the whole archive. */
    readCoverage?: MemoryReadCoverage;
    requestKind?: MemoryQueryPlan['requestKind'];
    subjects: Array<{ name: string; owner: boolean }>;
    domains: string[];
    evidenceCount: number;
    freshEvidenceCount?: number;
    /** Only the bounded current pool is exhausted, never a claim about the whole archive. */
    noNewEvidenceInPool?: boolean;
    /** Only a successful scoped typed-relation resolver may set this flag. */
    identityVerified?: boolean;
}

export interface MemoryReadCoverage {
    status: 'available' | 'partial' | 'unavailable';
    succeeded: number;
    failed: number;
}

export interface MemoryRelationStep {
    type: PersonRelationType;
    direction: 'out' | 'in' | 'either';
    alternatives?: PersonRelationType[];
}

export interface MemoryQueryReference {
    kind: 'person' | 'topic';
    /** Verbatim span from current question or the supplied history. */
    mention: string;
    from: 'named' | 'owner' | 'focus';
    relationPath: MemoryRelationStep[];
}

export interface MemoryQueryPlan {
    answerQueries: string[];
    contextQueries: string[];
    standaloneQuery?: string;
    requestKind?: 'identity' | 'overview' | 'relationship' | 'highlight' | 'people_list' | 'specific';
    /** A collection, or related people supplementing an owner's topic overview. */
    peopleQuery?: { basis: 'relationships' | 'communication' | 'both'; relations: MemoryRelationStep[] };
    /** Validated memory domains for the explicitly requested topic, never identities. */
    domains?: string[];
    /** Contextual topics of direct saved conversations, never promoted to owner facts. */
    includeConversations?: boolean;
    references?: MemoryQueryReference[];
}
