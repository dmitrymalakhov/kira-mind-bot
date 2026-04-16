import { AppDataSource } from '../data-source';
import { BotSettingEntity } from '../entity/BotSettingEntity';

const cache = new Map<string, string>();

export async function getSetting(key: string, defaultValue: string): Promise<string> {
    if (cache.has(key)) return cache.get(key)!;
    try {
        const repo = AppDataSource.getRepository(BotSettingEntity);
        const entry = await repo.findOneBy({ key });
        const value = entry?.value ?? defaultValue;
        cache.set(key, value);
        return value;
    } catch {
        return defaultValue;
    }
}

export async function setSetting(key: string, value: string): Promise<void> {
    cache.set(key, value);
    try {
        const repo = AppDataSource.getRepository(BotSettingEntity);
        await repo.upsert({ key, value }, ['key']);
    } catch (e) {
        console.error('[botSettings] Failed to persist setting:', e);
    }
}
