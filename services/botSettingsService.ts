import { AppDataSource } from '../data-source';
import { BotSettingEntity } from '../entity/BotSettingEntity';
import { scopedBotKey } from '../utils/botIdentity';

const cache = new Map<string, string>();
const globalCache = new Map<string, { value: string; expiresAt: number }>();
const GLOBAL_SETTING_PREFIX = 'global:';
const GLOBAL_CACHE_TTL_MS = 5000;

function globalKey(key: string): string {
    return `${GLOBAL_SETTING_PREFIX}${key}`;
}

export async function getSetting(key: string, defaultValue: string): Promise<string> {
    const scopedKey = scopedBotKey(key);
    if (cache.has(scopedKey)) return cache.get(scopedKey)!;
    try {
        const repo = AppDataSource.getRepository(BotSettingEntity);
        const entry = await repo.findOneBy({ key: scopedKey });
        const value = entry?.value ?? defaultValue;
        cache.set(scopedKey, value);
        return value;
    } catch {
        return defaultValue;
    }
}

export async function setSetting(key: string, value: string): Promise<void> {
    const scopedKey = scopedBotKey(key);
    cache.set(scopedKey, value);
    try {
        const repo = AppDataSource.getRepository(BotSettingEntity);
        await repo.upsert({ key: scopedKey, value }, ['key']);
    } catch (e) {
        console.error('[botSettings] Failed to persist setting:', e);
    }
}


export async function getGlobalSetting(key: string, defaultValue: string): Promise<string> {
    const scopedKey = globalKey(key);
    const cached = globalCache.get(scopedKey);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    try {
        const repo = AppDataSource.getRepository(BotSettingEntity);
        const entry = await repo.findOneBy({ key: scopedKey });
        const value = entry?.value ?? defaultValue;
        globalCache.set(scopedKey, { value, expiresAt: Date.now() + GLOBAL_CACHE_TTL_MS });
        return value;
    } catch {
        if (cached) return cached.value;
        return defaultValue;
    }
}

export async function setGlobalSetting(key: string, value: string): Promise<void> {
    const scopedKey = globalKey(key);
    globalCache.set(scopedKey, { value, expiresAt: Date.now() + GLOBAL_CACHE_TTL_MS });
    try {
        const repo = AppDataSource.getRepository(BotSettingEntity);
        await repo.upsert({ key: scopedKey, value }, ['key']);
    } catch (e) {
        console.error('[botSettings] Failed to persist global setting:', e);
    }
}
