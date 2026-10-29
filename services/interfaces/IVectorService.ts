export interface EmotionalTag {
    valence: number;
    arousal: number;
    isFlashbulb: boolean;
}

export type MemorySubject = 'user' | 'contact' | 'third_party' | 'unknown' | 'bot' | 'system';
export type MemoryStatus = 'active' | 'planned' | 'done' | 'superseded' | 'expired' | 'unknown';
export interface MemoryMutationOptions {
    expectedAssertion?: string;
    isActive?: () => boolean;
    confirmation?: { confidence: number; sourceEpisodeId?: string; sourceMessageIds?: string[]; sourceMemoryIds?: string[] };
    automaticDeletion?: { userId: string; olderThan: Date };
    /** Only an authenticated owner turn may supply this evidence, never an extraction model. */
    userCorrection?: { userId: string; sourceText: string; sourceMessageIds: string[] };
    /** Explicit owner deletion remains available for protected facts. */
    userDeletion?: { userId: string };
}
export type MemoryKind =
    | 'fact'
    | 'episode'
    | 'chapter'
    | 'trait'
    | 'preference'
    | 'goal'
    | 'open_loop'
    | 'relationship'
    | 'routine'
    | 'boundary'
    | 'promise'
    | 'prospective'
    | 'portrait'
    | 'event'
    | 'state'
    | 'unknown';
export type MemoryRelationType =
    | 'semantic'
    | 'same_episode'
    | 'same_entity'
    | 'temporal'
    | 'updates'
    | 'supports'
    | 'contradicts'
    | 'goal_step'
    | 'person_link'
    | 'contextual';
export interface MemoryRelation {
    id: string;
    domain: string;
    type?: MemoryRelationType;
    weight?: number;
    createdAt?: Date;
    cue?: string;
}
export type MemoryExtractionMethod =
    | 'explicit'
    | 'quick'
    | 'delayed'
    | 'study_chat'
    | 'reflection'
    | 'portrait'
    | 'episode'
    | 'consolidation'
    | 'compression'
    | 'manual'
    | 'unknown';

export interface MemoryEntry {
    id: string;
    content: string;
    domain: string;
    botId: string;
    timestamp: Date;
    importance: number;
    tags: string[];
    userId: string;
    isAnchor?: boolean;
    retentionPolicy?: 'durable' | 'standard';
    expiresAt?: Date;
    confidence?: number;
    lastAccessedAt?: Date;
    retrievalCount?: number;
    lastRetrievedAt?: Date;
    retrievalCues?: string[];
    previousVersions?: Array<{
        content: string;
        timestamp: Date;
        confidence: number;
    }>;
    relatedIds?: MemoryRelation[];
    memoryKind?: MemoryKind;
    strength?: number;
    vividness?: number;
    specificity?: number;
    emotionalTag?: EmotionalTag;
    sourceEpisodeId?: string;
    sourceContext?: string;
    sourceMessageIds?: string[];
    sourceMemoryIds?: string[];
    extractionMethod?: MemoryExtractionMethod;
    subject?: MemorySubject;
    predicate?: string;
    object?: string;
    negated?: boolean;
    validFrom?: Date;
    validTo?: Date;
    status?: MemoryStatus;
    confirmationCount?: number;
    lastConfirmedAt?: Date;
}

export interface SearchOptions {
    domain?: string;
    limit?: number;
    minScore?: number;
    tags?: string[];
}

export interface SearchResult {
    id: string;
    content: string;
    score: number;
    timestamp: Date;
    importance: number;
    tags: string[];
    domain: string;
    confidence?: number;
    lastAccessedAt?: Date;
    retrievalCount?: number;
    lastRetrievedAt?: Date;
    retrievalCues?: string[];
    previousVersions?: Array<{
        content: string;
        timestamp: Date;
        confidence: number;
    }>;
    isAnchor?: boolean;
    retentionPolicy?: 'durable' | 'standard';
    expiresAt?: Date;
    relatedIds?: MemoryRelation[];
    memoryKind?: MemoryKind;
    strength?: number;
    vividness?: number;
    specificity?: number;
    emotionalTag?: EmotionalTag;
    sourceEpisodeId?: string;
    sourceContext?: string;
    sourceMessageIds?: string[];
    sourceMemoryIds?: string[];
    extractionMethod?: MemoryExtractionMethod;
    subject?: MemorySubject;
    predicate?: string;
    object?: string;
    negated?: boolean;
    validFrom?: Date;
    validTo?: Date;
    status?: MemoryStatus;
    confirmationCount?: number;
    lastConfirmedAt?: Date;
}

export interface MemoryStats {
    total: number;
    domains: Record<string, number>;
}

export abstract class IVectorService {
    abstract initializeCollection(): Promise<void>;
    abstract saveMemory(memory: Omit<MemoryEntry, 'id'>): Promise<string>;
    abstract searchMemories(query: string, userId: string, options?: SearchOptions): Promise<SearchResult[]>;
    abstract getDomainContext(userId: string, domain: string, query: string, limit?: number): Promise<string>;
    abstract updateImportance(memoryId: string, importance: number, domain?: string): Promise<void>;
    /** Обновляет lastAccessedAt, retrieval-счётчик и опционально confidence/cue */
    abstract updateMemoryAccess(memoryId: string, domain: string, confidence?: number, retrievalCue?: string): Promise<void>;
    abstract deleteMemory(memoryId: string, domain: string, options?: MemoryMutationOptions): Promise<void>;
    abstract cleanupOldMemories(userId: string, daysToKeep?: number): Promise<number>;
    abstract getMemoryStats(userId: string): Promise<MemoryStats>;
    /** Active records ordered by timestamp before top-k; runtime pool is bounded to 1000. */
    abstract getRecentMemories(userId: string, limit?: number): Promise<MemoryEntry[]>;
    /** Полный read-only scan памяти пользователя; используется аудитами, а не runtime retrieval. */
    abstract getAllMemories(userId: string, options?: { includeArchived?: boolean }): Promise<MemoryEntry[]>;
    /**
     * Возвращает факты в конкретном домене старше olderThanDays.
     * Используется для эпизодической компрессии.
     */
    abstract getMemoriesForCompression(userId: string, domain: string, olderThanDays: number): Promise<MemoryEntry[]>;
    /** Добавляет двунаправленную связь между двумя фактами */
    abstract addRelationship(idA: string, domainA: string, idB: string, domainB: string, type?: MemoryRelationType, weight?: number, cue?: string): Promise<void>;
    /** Возвращает список связанных фактов для 1-hop graph expansion */
    abstract getRelatedFacts(memoryId: string, domain: string, userId?: string): Promise<MemoryRelation[]>;
    /** Загружает факт по ID и домену (для graph expansion при retrieval) */
    abstract fetchMemoryById(memoryId: string, domain: string, userId?: string): Promise<SearchResult | null>;
    /** Загружает несколько воспоминаний по ID, когда домены неизвестны. */
    abstract fetchMemoriesByIds(userId: string, memoryIds: string[], limit?: number): Promise<SearchResult[]>;
    /** Возвращает эпизод и факты, извлечённые из одного исходного эпизода разговора. */
    abstract getMemoriesBySourceEpisodeId(userId: string, sourceEpisodeId: string, limit?: number): Promise<SearchResult[]>;
}
