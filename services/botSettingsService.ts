import { AppDataSource } from '../data-source';
import { BotSettingEntity } from '../entity/BotSettingEntity';
import { scopedBotKey } from '../utils/botIdentity';

const cache = new Map<string, string>();

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
