import { QdrantClient } from '@qdrant/js-client-rest';
import { v4 as uuidv4 } from 'uuid';
import { IDomainVectorService } from './interfaces/IDomainVectorService';
import { MemoryEntry, SearchOptions, SearchResult, MemoryStats, DomainConfig, SearchStrategy, DomainStats, DomainTrend } from '../types';
import { PREDEFINED_DOMAINS, DOMAIN_SEARCH_THRESHOLDS } from '../constants/domains';
import { config } from '../config';
import openai from '../openai';
import { devLog } from '../utils';

export class QdrantVectorService implements IDomainVectorService {
    private client: QdrantClient;
    private botId: string;
    private memoryPrefix: string;
    private configCollection: string;
    private defaultSearchThreshold: number;

    private collectionFor(domain: string) {
        return `${this.memoryPrefix}${domain}`;
    }

    private mapSearchPoint(point: any, scoreOverride?: number): SearchResult {
        return {
            id: String(point.id),
            content: point.payload.content,
            score: scoreOverride ?? point.score,
            timestamp: new Date(point.payload.timestamp),
            importance: point.payload.importance ?? 0.5,
            tags: point.payload.tags ?? [],
            domain: point.payload.domain,
            confidence: point.payload.confidence ?? 0.6,
            lastAccessedAt: point.payload.lastAccessedAt
                ? new Date(point.payload.lastAccessedAt)
                : undefined,
            previousVersions: Array.isArray(point.payload.previousVersions)
                ? (point.payload.previousVersions as any[]).map((v: any) => ({
                    content: String(v.content ?? ''),
                    timestamp: new Date(v.timestamp),
                    confidence: typeof v.confidence === 'number' ? v.confidence : 0.6,
                }))
                : undefined,
        };
    }

    /**
     * Ранжирование с учётом важности, давности, достоверности и кривой забывания.
     *
     * Кривая забывания (Эббингауз): факты, к которым давно не обращались,
     * получают штраф к эффективной важности. Сброс происходит при каждом retrieval
     * через updateMemoryAccess (fire & forget).
     *
     * Формула: score * importanceBoost * recencyFactor
     *   importanceBoost = 0.6 + 0.2 * effectiveImportance + 0.1 * confidence
     *   effectiveImportance = importance * forgettingDecay  (floor 0.5)
     *   forgettingDecay = max(0.5, 0.99 ^ daysSinceAccess)
     */
    private applyImportanceRecencyRanking(results: SearchResult[]): SearchResult[] {
        const now = Date.now();
        const day = 24 * 60 * 60 * 1000;
        return results
            .map((r) => {
                // Recency: давность по timestamp (когда факт был сохранён/обновлён)
                const ageDays = (now - new Date(r.timestamp).getTime()) / day;
                const recencyFactor = ageDays < 7 ? 1 : ageDays < 30 ? 0.9 : ageDays < 90 ? 0.8 : 0.7;

                // Forgetting curve: штраф за давность последнего обращения
                const accessedAt = r.lastAccessedAt ?? r.timestamp;
                const daysSinceAccess = (now - new Date(accessedAt).getTime()) / day;
                const forgettingDecay = Math.max(0.5, Math.pow(0.99, daysSinceAccess));

                const importance = r.importance ?? 0.5;
                const confidence = r.confidence ?? 0.6;
                const effectiveImportance = importance * forgettingDecay;

                const importanceBoost = 0.6 + 0.2 * effectiveImportance + 0.1 * confidence;
                const combinedScore = r.score * importanceBoost * recencyFactor;
                return { ...r, score: combinedScore };
            })
            .sort((a, b) => b.score - a.score);
    }

    constructor() {
        console.log('🔧 Инициализация QdrantVectorService...');

        // Используем botUsername из конфигурации для уникальной идентификации
        this.botId = config.botUsername.toLowerCase(); // 'kiramindbot' или 'sergeybrainbot'
        this.memoryPrefix = `${this.botId}_memories_`;
        this.configCollection = `${this.botId}_domain_configs`;
        const envThreshold = Number(process.env.VECTOR_SEARCH_THRESHOLD);
        this.defaultSearchThreshold = Number.isFinite(envThreshold)
            ? Math.min(1, Math.max(0, envThreshold))
            : 0.58;

        console.log('📋 QdrantVectorService конфигурация:');
        console.log('- Bot ID:', this.botId);
        console.log('- Character Name:', config.characterName);
        console.log('- Memory Prefix:', this.memoryPrefix);
        console.log('- Config Collection:', this.configCollection);
        console.log('- Vector Search Threshold:', this.defaultSearchThreshold);

        this.client = new QdrantClient({
            url: process.env.QDRANT_URL || 'http://localhost:6333',
            apiKey: process.env.QDRANT_API_KEY || undefined,
        });

        console.log('✅ QdrantVectorService инициализирован для бота:', config.characterName);
    }

    private async checkCollectionExists(collectionName: string): Promise<boolean> {
        try {
            const res = await this.client.collectionExists(collectionName);
            return Boolean(res.exists);
        } catch (e) {
            console.error(`⚠️ Ошибка проверки коллекции ${collectionName}:`, e);
            return false;
        }
    }

    private async createCollectionSafely(collectionName: string, vectorSize = 1536): Promise<'created' | 'exists' | 'failed'> {
        if (await this.checkCollectionExists(collectionName)) {
            return 'exists';
        }
        try {
            await this.client.createCollection(collectionName, {
                vectors: { size: vectorSize, distance: 'Cosine' },
            });
            return 'created';
        } catch (e: any) {
            if (String(e.message || '').includes('already exists')) {
                return 'exists';
            }
            console.error(`❌ Ошибка создания коллекции ${collectionName}:`, e);
            return 'failed';
        }
    }

    private async createConfigCollection() {
        const status = await this.createCollectionSafely(this.configCollection);
        if (status === 'created') {
            console.log(`✅ Создана коллекция конфигураций: ${this.configCollection}`);
        } else if (status === 'exists') {
            console.log(`✅ Коллекция конфигураций уже существует: ${this.configCollection}`);
        }
    }

    async initializeCollection(): Promise<void> {
        console.log(`🏗️ Инициализация коллекций для бота ${config.characterName} (${this.botId})...`);
        await this.createConfigCollection();
        await this.initializeAllDomains();
        console.log(`✅ Все коллекции для бота ${config.characterName} инициализированы`);
    }

    async initializeAllDomains(): Promise<void> {
        console.log(`🏗️ Инициализация всех предопределенных доменов для ${config.characterName}...`);

        for (const domainKey of Object.values(PREDEFINED_DOMAINS)) {
            const collection = this.collectionFor(domainKey);
            const status = await this.createCollectionSafely(collection);
            if (status === 'created') {
                console.log(`✅ Создан домен для ${config.characterName}: ${domainKey} (${collection})`);
            } else if (status === 'exists') {
                console.log(`✅ Домен для ${config.characterName} уже существует: ${domainKey} (${collection})`);
            } else {
                console.log(`❌ Не удалось создать домен для ${config.characterName}: ${domainKey}`);
            }
        }
    }

    private async embed(text: string): Promise<number[]> {
        const resp = await openai.embeddings.create({
            model: 'text-embedding-ada-002',
            input: text,
        });
        return resp.data[0].embedding;
    }

    async saveMemory(memory: Omit<MemoryEntry, 'id'>): Promise<string> {
        const vector = await this.embed(memory.content);
        const id = uuidv4();
        const collection = this.collectionFor(memory.domain);
        const now = new Date();
        const payload = {
            ...memory,
            timestamp: memory.timestamp instanceof Date ? memory.timestamp.toISOString() : memory.timestamp,
            expiresAt: memory.expiresAt instanceof Date ? memory.expiresAt.toISOString() : undefined,
            confidence: memory.confidence ?? 0.6,
            lastAccessedAt: memory.lastAccessedAt instanceof Date
                ? memory.lastAccessedAt.toISOString()
                : now.toISOString(),
            id,
            botId: this.botId,
            characterName: config.characterName,
        };

        console.log(`💾 Сохранение памяти для ${config.characterName} в домен ${memory.domain}:`);
        console.log(`- Collection: ${collection}`);
        console.log(`- Content preview: ${memory.content.substring(0, 100)}...`);

        await this.client.upsert(collection, {
            wait: true,
            points: [{ id, vector, payload }],
        });

        console.log(`✅ Память сохранена для ${config.characterName} с ID: ${id}`);
        return id;
    }

    async updateMemory(memoryId: string, domain: string, memory: Omit<MemoryEntry, 'id'>): Promise<void> {
        const vector = await this.embed(memory.content);
        const collection = this.collectionFor(domain);
        const now = new Date();
        const payload = {
            ...memory,
            timestamp: memory.timestamp instanceof Date ? memory.timestamp.toISOString() : memory.timestamp,
            confidence: memory.confidence ?? 0.6,
            lastAccessedAt: now.toISOString(),
            id: memoryId,
            botId: this.botId,
            characterName: config.characterName,
        };
        await this.client.upsert(collection, {
            wait: true,
            points: [{ id: memoryId, vector, payload }],
        });
        devLog(`✅ Память обновлена (дедупликация) ID: ${memoryId}`);
    }

    /** Обновляет lastAccessedAt (сброс кривой забывания) и опционально confidence без перевложения */
    async updateMemoryAccess(memoryId: string, domain: string, confidence?: number): Promise<void> {
        const collection = this.collectionFor(domain);
        const patch: Record<string, unknown> = { lastAccessedAt: new Date().toISOString() };
        if (confidence !== undefined) patch.confidence = confidence;
        try {
            await this.client.setPayload(collection, {
                points: [memoryId],
                payload: patch,
            });
        } catch {
            // fire & forget — не критично
        }
    }

    async searchMemories(query: string, userId: string, options?: SearchOptions): Promise<SearchResult[]> {
        const vector = await this.embed(query);
        const domain = options?.domain || 'general';
        const collection = this.collectionFor(domain);

        console.log(`🔍 Поиск памяти для ${config.characterName}:`);
        console.log(`- Query: ${query.substring(0, 100)}...`);
        console.log(`- Domain: ${domain}`);
        console.log(`- Collection: ${collection}`);
        console.log(`- User ID: ${userId}`);

        const domainThreshold = DOMAIN_SEARCH_THRESHOLDS[domain] ?? this.defaultSearchThreshold;
        const search = await this.client.search(collection, {
            vector,
            limit: options?.limit ?? 5,
            score_threshold: options?.minScore ?? domainThreshold,
            filter: {
                must: [
                    { key: 'botId', match: { value: this.botId } },
                    { key: 'userId', match: { value: userId } },
                    options?.domain ? { key: 'domain', match: { value: options.domain } } : undefined,
                ].filter(Boolean) as any[],
                must_not: [
                    // Exclude facts where expiresAt is set and is in the past
                    { key: 'expiresAt', range: { lt: new Date().toISOString() } },
                ],
            },
        });

        console.log(`📋 Найдено ${search.length} результатов для ${config.characterName}`);

        const mapped = search.map((p: any) => this.mapSearchPoint(p));
        return this.applyImportanceRecencyRanking(mapped);
    }

    async getDomainContext(userId: string, domain: string, query: string, limit = 5): Promise<string> {
        const results = await this.searchMemories(query, userId, { domain, limit });
        if (results.length < 2) {
            const crossDomainResults = await this.searchAllDomains(query, userId, limit);
            const mergedResults = [...results];
            const seen = new Set(results.map(result => result.id));

            for (const result of crossDomainResults) {
                if (seen.has(result.id)) continue;
                mergedResults.push(result);
                seen.add(result.id);
                if (mergedResults.length >= limit) break;
            }

            return mergedResults.map(result => result.content).join('\n');
        }

        return results.map(r => r.content).join('\n');
    }

    async searchAllDomains(query: string, userId: string, limit = 5): Promise<SearchResult[]> {
        const vector = await this.embed(query);

        // Параллельный поиск по всем доменам — эмбеддинг уже готов
        const domainSearches = Object.values(PREDEFINED_DOMAINS).map(async (domain) => {
            const collection = this.collectionFor(domain);
            const domainThreshold = DOMAIN_SEARCH_THRESHOLDS[domain] ?? this.defaultSearchThreshold;
            const results = await this.client.search(collection, {
                vector,
                limit: 3,
                score_threshold: domainThreshold,
                filter: {
                    must: [
                        { key: 'botId', match: { value: this.botId } },
                        { key: 'userId', match: { value: userId } },
                    ],
                },
            });
            return results.map((point) => {
                const mapped = this.mapSearchPoint(point);
                return { ...mapped, domain: mapped.domain || domain };
            });
        });

        const settled = await Promise.allSettled(domainSearches);
        const allResults: SearchResult[] = [];
        for (const r of settled) {
            if (r.status === 'fulfilled') allResults.push(...r.value);
            else devLog('searchAllDomains domain error:', r.reason);
        }

        return this.applyImportanceRecencyRanking(allResults).slice(0, limit);
    }

    async getAnchorMemories(userId: string, limit = 3): Promise<SearchResult[]> {
        const anchors: SearchResult[] = [];
        for (const domainKey of Object.values(PREDEFINED_DOMAINS)) {
            const collection = this.collectionFor(domainKey);
            const scroll = await this.client.scroll(collection, {
                filter: {
                    must: [
                        { key: 'botId', match: { value: this.botId } },
                        { key: 'userId', match: { value: userId } },
                        { key: 'isAnchor', match: { value: true } },
                    ],
                },
                limit: 50,
                with_payload: true,
                with_vector: false,
            });
            for (const point of scroll.points || []) {
                const payload = point.payload as any;
                if (payload?.content && payload?.timestamp) {
                    anchors.push(this.mapSearchPoint(point, 1));
                }
            }
        }
        return anchors
            .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
            .slice(0, limit);
    }

    /** Добавляет двунаправленную связь между двумя фактами (макс 5 связей на факт) */
    async addRelationship(idA: string, domainA: string, idB: string, domainB: string): Promise<void> {
        await Promise.allSettled([
            this.appendRelation(idA, domainA, idB, domainB),
            this.appendRelation(idB, domainB, idA, domainA),
        ]);
    }

    private async appendRelation(memoryId: string, domain: string, relatedId: string, relatedDomain: string): Promise<void> {
        const collection = this.collectionFor(domain);
        try {
            const points = await this.client.retrieve(collection, {
                ids: [memoryId] as any[],
                with_payload: true,
                with_vector: false,
            });
            if (!points[0]) return;
            const existing: Array<{ id: string; domain: string }> =
                Array.isArray(points[0].payload?.relatedIds) ? (points[0].payload!.relatedIds as any) : [];
            if (existing.some(r => r.id === relatedId)) return; // уже связаны
            if (existing.length >= 5) return;                   // лимит связей
            await this.client.setPayload(collection, {
                points: [memoryId],
                payload: { relatedIds: [...existing, { id: relatedId, domain: relatedDomain }] },
            });
        } catch {
            // fire & forget — не критично
        }
    }

    /** Возвращает список relatedIds из payload без эмбеддинга */
    async getRelatedFacts(memoryId: string, domain: string): Promise<Array<{ id: string; domain: string }>> {
        const collection = this.collectionFor(domain);
        try {
            const points = await this.client.retrieve(collection, {
                ids: [memoryId] as any[],
                with_payload: true,
                with_vector: false,
            });
            if (!points[0]) return [];
            return Array.isArray(points[0].payload?.relatedIds)
                ? (points[0].payload!.relatedIds as Array<{ id: string; domain: string }>)
                : [];
        } catch {
            return [];
        }
    }

    /** Загружает факт по ID без векторного поиска (для graph expansion) */
    async fetchMemoryById(memoryId: string, domain: string): Promise<SearchResult | null> {
        const collection = this.collectionFor(domain);
        try {
            const points = await this.client.retrieve(collection, {
                ids: [memoryId] as any[],
                with_payload: true,
                with_vector: false,
            });
            if (!points[0]) return null;
            return this.mapSearchPoint({ ...points[0], score: 0 });
        } catch {
            return null;
        }
    }

    async getMemoriesForCompression(userId: string, domain: string, olderThanDays: number): Promise<MemoryEntry[]> {
        const threshold = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();
        const collection = this.collectionFor(domain);
        const scroll = await this.client.scroll(collection, {
            filter: {
                must: [
                    { key: 'botId', match: { value: this.botId } },
                    { key: 'userId', match: { value: userId } },
                    { key: 'timestamp', range: { lt: threshold } },
                ],
                must_not: [
                    { key: 'isAnchor', match: { value: true } },
                ],
            },
            limit: 500,
            with_payload: true,
            with_vector: false,
        });

        return (scroll.points ?? [])
            .map((point) => {
                const p = point.payload as Partial<MemoryEntry> & { lastAccessedAt?: string };
                if (!p?.content || !p?.timestamp) return null;
                return {
                    id: String(point.id),
                    content: String(p.content),
                    domain: String(p.domain || domain),
                    botId: String(p.botId || this.botId),
                    timestamp: new Date(p.timestamp as Date | string),
                    importance: typeof p.importance === 'number' ? p.importance : 0.5,
                    tags: Array.isArray(p.tags) ? p.tags.map(String) : [],
                    userId: String(p.userId || userId),
                    confidence: typeof p.confidence === 'number' ? p.confidence : 0.6,
                    isAnchor: Boolean(p.isAnchor),
                } as MemoryEntry;
            })
            .filter((m): m is MemoryEntry => m !== null);
    }

    async deleteMemory(memoryId: string, domain: string): Promise<void> {
        const collection = this.collectionFor(domain);
        await this.client.delete(collection, { points: [memoryId] });
        devLog(`🗑️ Факт удалён (противоречие) ID: ${memoryId}`);
    }

    async updateImportance(memoryId: string, importance: number): Promise<void> {
        for (const domainKey of Object.values(PREDEFINED_DOMAINS)) {
            const collection = this.collectionFor(domainKey);
            const points = await this.client.retrieve(collection, { ids: [memoryId] as any[] });
            if (points.length > 0) {
                await this.client.setPayload(collection, {
                    points: [memoryId],
                    payload: { importance },
                });
                return;
            }
        }
    }

    async cleanupOldMemories(userId: string, daysToKeep = 30): Promise<number> {
        const threshold = new Date(Date.now() - daysToKeep * 24 * 60 * 60 * 1000).toISOString();
        let removed = 0;

        for (const domainKey of Object.values(PREDEFINED_DOMAINS)) {
            const collection = this.collectionFor(domainKey);
            const noAnchorFilter = { must_not: [{ key: 'isAnchor', match: { value: true } }] };
            const toDelete = await this.client.scroll(collection, {
                filter: {
                    must: [
                        { key: 'botId', match: { value: this.botId } },
                        { key: 'userId', match: { value: userId } },
                        { key: 'timestamp', range: { lt: threshold } },
                    ],
                    ...noAnchorFilter,
                },
                limit: 10000,
                with_payload: false,
                with_vector: false,
            });
            removed += toDelete.points?.length || 0;

            await this.client.delete(collection, {
                filter: {
                    must: [
                        { key: 'botId', match: { value: this.botId } },
                        { key: 'userId', match: { value: userId } },
                        { key: 'timestamp', range: { lt: threshold } },
                    ],
                    ...noAnchorFilter,
                },
            });
        }

        return removed;
    }

    async getMemoryStats(userId: string): Promise<MemoryStats> {
        const domains: Record<string, number> = {};
        let total = 0;

        for (const domainKey of Object.values(PREDEFINED_DOMAINS)) {
            const collection = this.collectionFor(domainKey);
            const scroll = await this.client.scroll(collection, {
                filter: {
                    must: [
                        { key: 'botId', match: { value: this.botId } },
                        { key: 'userId', match: { value: userId } }
                    ]
                },
                limit: 10000,
                with_payload: false,
                with_vector: false,
            });

            const domainCount = scroll.points?.length || 0;
            if (domainCount > 0) {
                domains[domainKey] = domainCount;
            }
            total += domainCount;
        }

        return { total, domains };
    }

    async getRecentMemories(userId: string, limit = 5): Promise<MemoryEntry[]> {
        const memories: MemoryEntry[] = [];

        for (const domainKey of Object.values(PREDEFINED_DOMAINS)) {
            const collection = this.collectionFor(domainKey);
            const scroll = await this.client.scroll(collection, {
                filter: {
                    must: [
                        { key: 'botId', match: { value: this.botId } },
                        { key: 'userId', match: { value: userId } },
                    ],
                },
                limit: 1000,
                with_payload: true,
                with_vector: false,
            });

            for (const point of scroll.points || []) {
                const payload = point.payload as Partial<MemoryEntry> & { lastAccessedAt?: string } | undefined;
                if (!payload?.content || !payload?.timestamp) continue;

                memories.push({
                    id: String(point.id),
                    content: String(payload.content),
                    domain: String(payload.domain || domainKey),
                    botId: String(payload.botId || this.botId),
                    timestamp: new Date(payload.timestamp as Date | string),
                    importance: typeof payload.importance === 'number' ? payload.importance : 0.5,
                    tags: Array.isArray(payload.tags) ? payload.tags.map(tag => String(tag)) : [],
                    userId: String(payload.userId || userId),
                    confidence: typeof payload.confidence === 'number' ? payload.confidence : 0.6,
                    lastAccessedAt: payload.lastAccessedAt ? new Date(payload.lastAccessedAt) : undefined,
                    previousVersions: Array.isArray(payload.previousVersions)
                        ? (payload.previousVersions as any[]).map((v: any) => ({
                            content: String(v.content ?? ''),
                            timestamp: new Date(v.timestamp),
                            confidence: typeof v.confidence === 'number' ? v.confidence : 0.6,
                        }))
                        : undefined,
                });
            }
        }

        return memories
            .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
            .slice(0, limit);
    }



    async createDomain(config: DomainConfig): Promise<void> {
        console.log(`ℹ️ Домен ${config.name} является предопределенным для ${this.botId}. Создание не требуется.`);
    }
    async getDomainConfig(domain: string): Promise<DomainConfig | null> {
        const res = await this.client.scroll(this.configCollection, {
            filter: {
                must: [
                    { key: 'name', match: { value: domain } },
                    { key: 'botId', match: { value: this.botId } }
                ]
            },
            limit: 1,
        });
        return (res.points?.[0]?.payload as unknown as DomainConfig) || null;
    }
    async updateDomainConfig(domain: string, updates: Partial<DomainConfig>): Promise<void> {
        const config = await this.getDomainConfig(domain);
        if (!config) return;
        const updated = { ...config, ...updates };
        await this.client.upsert(this.configCollection, {
            wait: true,
            points: [{ id: uuidv4(), vector: await this.embed(domain), payload: updated as unknown as Record<string, unknown> }],
        });
    }
    async listDomains(userId: string): Promise<DomainConfig[]> {
        const scroll = await this.client.scroll(this.configCollection, {
            limit: 1000,
            filter: { must: [{ key: 'botId', match: { value: this.botId } }] }
        });
        return (scroll.points || []).map(p => p.payload as unknown as DomainConfig);
    }
    async archiveDomain(domain: string): Promise<void> {
        await this.client.deleteCollection(this.collectionFor(domain));
    }
    async mergeDomains(source: string[], target: string): Promise<number> {
        return 0;
    }
    async searchInDomain(query: string, domain: string, userId: string, options?: SearchOptions): Promise<SearchResult[]> {
        return this.searchMemories(query, userId, { ...options, domain });
    }
    async searchCrossDomain(query: string, userId: string, strategy: SearchStrategy): Promise<SearchResult[]> {
        const domains = [strategy.primaryDomain, ...strategy.relatedDomains];
        let results: SearchResult[] = [];
        for (const d of domains) {
            const found = await this.searchMemories(query, userId, { domain: d, limit: strategy.primaryLimit });
            results = results.concat(found);
            if (results.length >= strategy.primaryLimit) break;
        }
        return results;
    }
    async suggestDomains(query: string, userId: string): Promise<string[]> {
        return [];
    }
    async getDomainStats(userId: string): Promise<DomainStats[]> {
        const domains = await this.listDomains(userId);
        return domains.map(d => ({ domain: d.name, count: d.memoryCount }));
    }
    async getDomainTrends(userId: string, days: number): Promise<DomainTrend[]> {
        return [];
    }
    async cleanupInactiveDomains(userId: string): Promise<string[]> {
        return [];
    }
}
