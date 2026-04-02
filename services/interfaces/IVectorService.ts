export interface EmotionalTag {
    valence: number;
    arousal: number;
    isFlashbulb: boolean;
}

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
    previousVersions?: Array<{
        content: string;
        timestamp: Date;
        confidence: number;
    }>;
    relatedIds?: Array<{ id: string; domain: string }>;
    emotionalTag?: EmotionalTag;
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
    previousVersions?: Array<{
        content: string;
        timestamp: Date;
        confidence: number;
    }>;
    relatedIds?: Array<{ id: string; domain: string }>;
    emotionalTag?: EmotionalTag;
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
    /** Обновляет lastAccessedAt (сброс кривой забывания) и опционально confidence */
    abstract updateMemoryAccess(memoryId: string, domain: string, confidence?: number): Promise<void>;
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
}
