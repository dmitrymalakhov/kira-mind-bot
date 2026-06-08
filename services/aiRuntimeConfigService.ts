import { AppDataSource } from '../data-source';
import { BotSettingEntity } from '../entity/BotSettingEntity';
import { parseAiPresetName, type AiPresetName } from '../ai/modelPresets';

export const AI_MODEL_PRESET_SETTING_KEY = 'AI_MODEL_PRESET';
export const DEFAULT_AI_MODEL_PRESET: AiPresetName = 'gpt-balanced';
const PRESET_CACHE_TTL_MS = 5000;

let cachedPresetName: AiPresetName | null = null;
let lastRefreshAt = 0;

function setCachedPresetName(preset: AiPresetName): AiPresetName {
    cachedPresetName = preset;
    lastRefreshAt = Date.now();
    return preset;
}

export function getEnvAiPresetName(): AiPresetName {
    return parseAiPresetName(process.env.AI_MODEL_PRESET) ?? DEFAULT_AI_MODEL_PRESET;
}

async function loadPresetFromDb(fallback: AiPresetName): Promise<AiPresetName> {
    const repo = AppDataSource.getRepository(BotSettingEntity);
    const entry = await repo.findOneBy({ key: AI_MODEL_PRESET_SETTING_KEY });
    return setCachedPresetName(parseAiPresetName(entry?.value) ?? fallback);
}

export function getCachedAiPresetName(): AiPresetName {
    const fallback = cachedPresetName ?? getEnvAiPresetName();

    if (!AppDataSource.isInitialized) {
        return setCachedPresetName(fallback);
    }

    const isStale = Date.now() - lastRefreshAt > PRESET_CACHE_TTL_MS;
    if (isStale) {
        void loadPresetFromDb(fallback).catch((error) => {
            console.warn('[AI preset] Не удалось обновить runtime preset из БД:', error);
        });
    }

    return fallback;
}

export async function getActiveAiPresetName(): Promise<AiPresetName> {
    const fallback = getEnvAiPresetName();

    try {
        if (!AppDataSource.isInitialized) return setCachedPresetName(fallback);
        return await loadPresetFromDb(fallback);
    } catch (error) {
        console.warn('[AI preset] Не удалось прочитать runtime preset из БД:', error);
        return setCachedPresetName(fallback);
    }
}

export async function setActiveAiPresetName(preset: AiPresetName): Promise<void> {
    setCachedPresetName(preset);

    if (!AppDataSource.isInitialized) {
        return;
    }

    const repo = AppDataSource.getRepository(BotSettingEntity);
    await repo.upsert({ key: AI_MODEL_PRESET_SETTING_KEY, value: preset }, ['key']);
}
