import { IVectorService, MemoryEntry, SearchOptions, SearchResult, MemoryStats } from './IVectorService';
import { DomainConfig, SearchStrategy, DomainStats, DomainTrend } from '../../types';

export abstract class IDomainVectorService extends IVectorService {
    abstract createDomain(config: DomainConfig): Promise<void>;
    abstract getDomainConfig(domain: string): Promise<DomainConfig | null>;
    abstract updateDomainConfig(domain: string, updates: Partial<DomainConfig>): Promise<void>;
    abstract listDomains(userId: string): Promise<DomainConfig[]>;
    abstract archiveDomain(domain: string): Promise<void>;
    abstract mergeDomains(source: string[], target: string): Promise<number>;

    abstract searchInDomain(query: string, domain: string, userId: string, options?: SearchOptions): Promise<SearchResult[]>;
    abstract searchCrossDomain(query: string, userId: string, strategy: SearchStrategy): Promise<SearchResult[]>;
    abstract searchAllDomains(query: string, userId: string, limit?: number): Promise<SearchResult[]>;
    /** Якорные факты (явные «Запомни») для подмешивания в контекст */
    abstract getAnchorMemories(userId: string, limit?: number): Promise<SearchResult[]>;
    /** Обновить существующую точку (при дедупликации) */
    abstract updateMemory(memoryId: string, domain: string, memory: Omit<MemoryEntry, 'id'>): Promise<void>;
    abstract suggestDomains(query: string, userId: string): Promise<string[]>;

    abstract getDomainStats(userId: string): Promise<DomainStats[]>;
    abstract getDomainTrends(userId: string, days: number): Promise<DomainTrend[]>;
    abstract cleanupInactiveDomains(userId: string): Promise<string[]>;

    /**
     * Возвращает все записи пользователя с указанным тегом (во всех доменах).
     * Используется для получения психологических портретов по тегу `portrait:<Name>`.
     */
    abstract getMemoriesByTag(userId: string, tag: string): Promise<SearchResult[]>;
}
