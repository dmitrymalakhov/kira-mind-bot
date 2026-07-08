import { AppDataSource } from '../data-source';
import { BotSettingEntity } from '../entity/BotSettingEntity';
import {
    DEFAULT_MEMORY_EMBEDDING_PROFILE,
    parseMemoryEmbeddingProfileName,
    type MemoryEmbeddingProfileName,
} from '../ai/memoryEmbeddingProfiles';

export const MEMORY_EMBEDDING_PROFILE_SETTING_KEY = 'MEMORY_EMBEDDING_PROFILE';
const PROFILE_CACHE_TTL_MS = 5000;

let cachedProfileName: MemoryEmbeddingProfileName | null = null;
let lastRefreshAt = 0;
let cachedFromDb = false;

function setCachedProfileName(profile: MemoryEmbeddingProfileName, fromDb = false): MemoryEmbeddingProfileName {
    cachedProfileName = profile;
    cachedFromDb = fromDb;
    lastRefreshAt = Date.now();
    return profile;
}

function getFreshCachedProfileName(requireDbBacked = false): MemoryEmbeddingProfileName | null {
    if (!cachedProfileName) return null;
    if (requireDbBacked && !cachedFromDb) return null;
    return Date.now() - lastRefreshAt <= PROFILE_CACHE_TTL_MS ? cachedProfileName : null;
}

export function getEnvMemoryEmbeddingProfileName(): MemoryEmbeddingProfileName {
    return parseMemoryEmbeddingProfileName(process.env.MEMORY_EMBEDDING_PROFILE) ?? DEFAULT_MEMORY_EMBEDDING_PROFILE;
}

async function loadProfileFromDb(fallback: MemoryEmbeddingProfileName): Promise<MemoryEmbeddingProfileName> {
    const repo = AppDataSource.getRepository(BotSettingEntity);
    const entry = await repo.findOneBy({ key: MEMORY_EMBEDDING_PROFILE_SETTING_KEY });
    return setCachedProfileName(parseMemoryEmbeddingProfileName(entry?.value) ?? fallback, true);
}

export async function getActiveMemoryEmbeddingProfileName(): Promise<MemoryEmbeddingProfileName> {
    const fallback = getEnvMemoryEmbeddingProfileName();

    try {
        if (!AppDataSource.isInitialized) return setCachedProfileName(fallback);
        const cached = getFreshCachedProfileName(true);
        if (cached) return cached;
        return await loadProfileFromDb(fallback);
    } catch (error) {
        console.warn('[Memory embedding profile] Не удалось прочитать runtime profile из БД:', error);
        if (cachedProfileName) {
            return setCachedProfileName(cachedProfileName, cachedFromDb);
        }
        return setCachedProfileName(fallback);
    }
}

export async function warmMemoryEmbeddingProfileCache(): Promise<MemoryEmbeddingProfileName> {
    return getActiveMemoryEmbeddingProfileName();
}
