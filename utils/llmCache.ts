/**
 * Простой in-process TTL-кэш для результатов LLM-вызовов.
 *
 * Зачем: классификация интента, генерация плана, генерация поисковых запросов
 * и проверка противоречий — дорогие операции, которые для одинаковых входных
 * данных всегда вернут тот же ответ. Кэш срезает 30-50% LLM-вызовов при
 * повторных или похожих сообщениях.
 *
 * Не использует Redis — только Map в памяти процесса. При рестарте кэш сбрасывается,
 * что приемлемо: кэш не является источником истины, только ускорением.
 */

interface CacheEntry<T> {
    value: T;
    expiresAt: number;
}

class LLMCache {
    private readonly cache = new Map<string, CacheEntry<unknown>>();

    get<T>(key: string): T | undefined {
        const entry = this.cache.get(key);
        if (!entry) return undefined;
        if (Date.now() > entry.expiresAt) {
            this.cache.delete(key);
            return undefined;
        }
        return entry.value as T;
    }

    set<T>(key: string, value: T, ttlMs: number): void {
        this.cache.set(key, { value, expiresAt: Date.now() + ttlMs });
    }

    /** Удаляет просроченные записи. Вызывается автоматически каждые 5 минут. */
    prune(): void {
        const now = Date.now();
        for (const [key, entry] of this.cache) {
            if (now > entry.expiresAt) this.cache.delete(key);
        }
    }

    get size(): number {
        return this.cache.size;
    }
}

export const llmCache = new LLMCache();

// Автоматическая очистка устаревших записей
setInterval(() => llmCache.prune(), 5 * 60 * 1000).unref();

// TTL-константы (мс)
export const LLM_CACHE_TTL = {
    /** Классификация интента: одно и то же сообщение → один и тот же интент */
    CLASSIFY: 10 * 60 * 1000,        // 10 мин
    /** Генерация плана: (интент + сообщение) → тот же план */
    PLAN: 10 * 60 * 1000,            // 10 мин
    /** Поисковые запросы для памяти: одно сообщение → те же запросы */
    MEMORY_QUERIES: 15 * 60 * 1000,  // 15 мин
    /** Проверка противоречий: одна пара фактов → тот же вердикт */
    CONTRADICTION: 60 * 60 * 1000,   // 60 мин
    /** Быстрая LLM-проверка: повторяет ли пользователь тот же intent */
    INTENT_DEDUP: 2 * 60 * 1000,     // 2 мин
} as const;
