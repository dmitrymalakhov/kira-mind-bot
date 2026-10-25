import { AsyncLocalStorage } from 'node:async_hooks';
import { AppDataSource } from '../data-source';
import { BotSettingEntity } from '../entity/BotSettingEntity';
import { parseAiPresetName, type AiPresetName } from '../ai/modelPresets';

export const AI_MODEL_PRESET_SETTING_KEY = 'AI_MODEL_PRESET';
export const DEFAULT_AI_MODEL_PRESET: AiPresetName = 'gpt-balanced';
const PRESET_CACHE_TTL_MS = 5000;

/**
 * A channel's own preset (the mobile app's, API_AI_MODEL_PRESET) for exactly one turn. Every model choice of the
 * turn reads it through the getters below, including the fallback policy. Timers and deferred work started during
 * the turn inherit the async context but see `active: false` once the turn ends, so they run on the global preset.
 */
const channelPreset = new AsyncLocalStorage<{ preset: AiPresetName; active: boolean }>();

export async function runWithChannelPreset<T>(preset: AiPresetName | null, work: () => Promise<T>): Promise<T> {
    if (!preset) return work();
    const scope = { preset, active: true };
    try { return await channelPreset.run(scope, work); }
    finally { scope.active = false; }
}

function getChannelPresetName(): AiPresetName | null {
    const scope = channelPreset.getStore();
    return scope?.active ? scope.preset : null;
}

let cachedPresetName: AiPresetName | null = null;
let lastRefreshAt = 0;
let cachedFromDb = false;
let activePresetRefreshPromise: Promise<AiPresetName> | null = null;

function setCachedPresetName(preset: AiPresetName, fromDb = false): AiPresetName {
    cachedPresetName = preset;
    lastRefreshAt = Date.now();
    cachedFromDb = fromDb;
    return preset;
}

function getFreshCachedPresetName(requireDbBacked = false): AiPresetName | null {
    if (!cachedPresetName) return null;
    if (requireDbBacked && !cachedFromDb) return null;
    return Date.now() - lastRefreshAt <= PRESET_CACHE_TTL_MS ? cachedPresetName : null;
}

export function getEnvAiPresetName(): AiPresetName {
    return parseAiPresetName(process.env.AI_MODEL_PRESET) ?? DEFAULT_AI_MODEL_PRESET;
}

async function loadPresetFromDb(fallback: AiPresetName): Promise<AiPresetName> {
    const repo = AppDataSource.getRepository(BotSettingEntity);
    const entry = await repo.findOneBy({ key: AI_MODEL_PRESET_SETTING_KEY });
    return setCachedPresetName(parseAiPresetName(entry?.value) ?? fallback, true);
}

export function getCachedAiPresetName(): AiPresetName {
    const channel = getChannelPresetName();
    if (channel) return channel;
    const fallback = cachedPresetName ?? getEnvAiPresetName();

    if (!AppDataSource.isInitialized) {
        return setCachedPresetName(fallback);
    }

    const isStale = Date.now() - lastRefreshAt > PRESET_CACHE_TTL_MS;
    if (isStale || !cachedFromDb) {
        void loadPresetFromDb(fallback).catch((error) => {
            console.warn('[AI preset] Не удалось обновить runtime preset из БД:', error);
        });
    }

    return fallback;
}

export async function getActiveAiPresetName(): Promise<AiPresetName> {
    const channel = getChannelPresetName();
    if (channel) return channel;
    const fallback = getEnvAiPresetName();

    try {
        if (!AppDataSource.isInitialized) return setCachedPresetName(fallback);
        const cached = getFreshCachedPresetName(true);
        if (cached) return cached;
        return await loadPresetFromDb(fallback);
    } catch (error) {
        console.warn('[AI preset] Не удалось прочитать runtime preset из БД:', error);
        if (cachedPresetName) {
            return setCachedPresetName(cachedPresetName, cachedFromDb);
        }
        return setCachedPresetName(fallback);
    }
}

/**
 * Читает preset напрямую из БД и обновляет runtime-кеш.
 * Используется только на error-path, когда retry не должен продолжать
 * маршрут, который пользователь уже сменил в админке. Ошибка чтения
 * намеренно пробрасывается: при неизвестном preset нельзя безопасно
 * повторять запрос по потенциально устаревшему маршруту.
 */
export async function refreshActiveAiPresetName(): Promise<AiPresetName> {
    const channel = getChannelPresetName();
    if (channel) return channel; // fixed for the whole turn; the app changes it only between turns
    const fallback = getEnvAiPresetName();

    if (!AppDataSource.isInitialized) return setCachedPresetName(fallback);
    if (activePresetRefreshPromise) return activePresetRefreshPromise;

    const refreshPromise = loadPresetFromDb(fallback).catch((error) => {
        console.warn('[AI preset] Не удалось принудительно обновить runtime preset из БД:', error);
        throw error;
    });
    activePresetRefreshPromise = refreshPromise;

    try {
        return await refreshPromise;
    } finally {
        if (activePresetRefreshPromise === refreshPromise) {
            activePresetRefreshPromise = null;
        }
    }
}

export async function warmAiPresetCache(): Promise<AiPresetName> {
    return getActiveAiPresetName();
}

export async function setActiveAiPresetName(preset: AiPresetName): Promise<void> {
    if (!AppDataSource.isInitialized) {
        setCachedPresetName(preset);
        return;
    }

    const repo = AppDataSource.getRepository(BotSettingEntity);
    await repo.upsert({ key: AI_MODEL_PRESET_SETTING_KEY, value: preset }, ['key']);
    setCachedPresetName(preset, true);
}
