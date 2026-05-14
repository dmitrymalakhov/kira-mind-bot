export interface EmotionalTag {
    valence: number;
    arousal: number;
    isFlashbulb: boolean;
}

export type MemorySubject = 'user' | 'contact' | 'bot' | 'system';
export type MemoryStatus = 'active' | 'planned' | 'done' | 'superseded' | 'expired' | 'unknown';
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
    relatedIds?: Array<{ id: string; domain: string }>;
    emotionalTag?: EmotionalTag;
    sourceEpisodeId?: string;
    sourceContext?: string;
    sourceMessageIds?: string[];
    sourceMemoryIds?: string[];
    extractionMethod?: MemoryExtractionMethod;
    subject?: MemorySubject;
    predicate?: string;
    object?: string;
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
    expiresAt?: Date;
    relatedIds?: Array<{ id: string; domain: string }>;
    emotionalTag?: EmotionalTag;
    sourceEpisodeId?: string;
    sourceContext?: string;
    sourceMessageIds?: string[];
    sourceMemoryIds?: string[];
    extractionMethod?: MemoryExtractionMethod;
    subject?: MemorySubject;
    predicate?: string;
    object?: string;
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
    abstract updateImportance(memoryId: string, importance: number): Promise<void>;
    /** Обновляет lastAccessedAt, retrieval-счётчик и опционально confidence/cue */
    abstract updateMemoryAccess(memoryId: string, domain: string, confidence?: number, retrievalCue?: string): Promise<void>;
    abstract deleteMemory(memoryId: string, domain: string): Promise<void>;
    abstract cleanupOldMemories(userId: string, daysToKeep?: number): Promise<number>;
    abstract getMemoryStats(userId: string): Promise<MemoryStats>;
    abstract getRecentMemories(userId: string, limit?: number): Promise<MemoryEntry[]>;
    /**
     * Возвращает факты в конкретном домене старше olderThanDays.
     * Используется для эпизодической компрессии.
     */
    abstract getMemoriesForCompression(userId: string, domain: string, olderThanDays: number): Promise<MemoryEntry[]>;
    /** Добавляет двунаправленную связь между двумя фактами */
    abstract addRelationship(idA: string, domainA: string, idB: string, domainB: string): Promise<void>;
    /** Возвращает список связанных фактов для 1-hop graph expansion */
    abstract getRelatedFacts(memoryId: string, domain: string): Promise<Array<{ id: string; domain: string }>>;
    /** Загружает факт по ID и домену (для graph expansion при retrieval) */
    abstract fetchMemoryById(memoryId: string, domain: string): Promise<SearchResult | null>;
    /** Загружает несколько воспоминаний по ID, когда домены неизвестны. */
    abstract fetchMemoriesByIds(userId: string, memoryIds: string[], limit?: number): Promise<SearchResult[]>;
    /** Возвращает эпизод и факты, извлечённые из одного исходного эпизода разговора. */
    abstract getMemoriesBySourceEpisodeId(userId: string, sourceEpisodeId: string, limit?: number): Promise<SearchResult[]>;
}
