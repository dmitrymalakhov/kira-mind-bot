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
    requestKind?: 'identity' | 'overview' | 'relationship' | 'specific';
    references?: MemoryQueryReference[];
}
