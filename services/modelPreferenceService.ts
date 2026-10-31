import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { AppDataSource } from '../data-source';
import { BotSettingEntity } from '../entity/BotSettingEntity';
import { SETTING_KEY, parseModelPolicy, parseStrategyRequest, type ModelPolicy } from '../ai/modelPreferences';
import { hasChannelPresetOverride, invalidateActiveAiPresetCache } from './aiRuntimeConfigService';
import { getEnvMemoryEmbeddingProfileName, MEMORY_EMBEDDING_PROFILE_SETTING_KEY } from './memoryEmbeddingRuntimeConfigService';
import { parseMemoryEmbeddingProfileName, type MemoryEmbeddingProfileName } from '../ai/memoryEmbeddingProfiles';
import { API_AI_MODEL_PRESET_SETTING_KEY, parseStoredApiModelSelection } from '../api/modelSettings';
import { publicModelPreferences } from '../api/modelPreferenceView';
import { ApiError } from '../api/contracts';

const scope = new AsyncLocalStorage<{ policy: ModelPolicy | null }>();
let cache: { value: ModelPolicy | null; at: number } | undefined;
let cacheGeneration = 0;
export function runWithModelPolicy<T>(policy: ModelPolicy | null, work: () => Promise<T>): Promise<T> {
    return scope.run({ policy }, work);
}
export async function getModelPolicy(fresh = false): Promise<ModelPolicy | null> {
    const scoped = scope.getStore();
    if (scoped) return scoped.policy;
    if (hasChannelPresetOverride() || !AppDataSource.isInitialized) return null;
    if (!fresh && cache && Date.now() - cache.at < 5000) return cache.value;
    const generation = cacheGeneration;
    const row = await AppDataSource.getRepository(BotSettingEntity).findOneBy({ key: SETTING_KEY });
    const policy = parseModelPolicy(row?.value);
    if (generation === cacheGeneration) cache = { value: policy, at: Date.now() };
    return policy;
}

const controller = require('../admin-panel/modelPreferences') as {
    readModelPreferences(pool: unknown, env: NodeJS.ProcessEnv, memoryProfile: string): Promise<Record<string, any>>;
    saveModelPreferences(pool: unknown, env: NodeJS.ProcessEnv, memoryProfile: string, body: unknown): Promise<unknown>;
};
const pool = () => ({ query: async (sql: string, values?: unknown[]) => ({ rows: await AppDataSource.query(sql, values) }) });
type PreferencePool = ReturnType<typeof pool>;
async function memoryProfile(db: PreferencePool): Promise<MemoryEmbeddingProfileName> {
    const { rows } = await db.query('SELECT value FROM bot_settings WHERE key = $1', [MEMORY_EMBEDDING_PROFILE_SETTING_KEY]);
    return parseMemoryEmbeddingProfileName(rows[0]?.value) ?? getEnvMemoryEmbeddingProfileName();
}
async function normalized(db: PreferencePool, memory: MemoryEmbeddingProfileName) {
    const state = await controller.readModelPreferences(db, process.env, memory);
    const { rows } = await db.query('SELECT value FROM bot_settings WHERE key = $1', [API_AI_MODEL_PRESET_SETTING_KEY]);
    return publicModelPreferences(state, parseStoredApiModelSelection(rows[0]?.value), memory);
}
export async function readModelPreferences(): Promise<unknown> {
    try { const db = pool(); return await normalized(db, await memoryProfile(db)); }
    catch { throw new ApiError(503, 'model_preferences_unavailable', 'Не удалось загрузить настройки моделей. Повтори позже.'); }
}
export async function saveModelPreferences(body: unknown): Promise<unknown> {
    try { parseStrategyRequest(body); }
    catch { throw new ApiError(400, 'invalid_model_preferences', 'Проверь качество, провайдера и параметры выбранной стратегии.'); }
    try {
        // Policy + server preset + removal of the old app override commit together in this account database.
        // Other settings (including memory embeddings and background switches) are not replaced.
        const result = await AppDataSource.transaction(async manager => {
            const db = { query: async (sql: string, values?: unknown[]) => ({ rows: await manager.query(sql, values) }) };
            const memory = await memoryProfile(db);
            await controller.saveModelPreferences(db, process.env, memory, body);
            await db.query('INSERT INTO bot_settings (key,value,"updatedAt") VALUES ($1,$2,now()) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value,"updatedAt"=now()',
                [API_AI_MODEL_PRESET_SETTING_KEY, JSON.stringify({ preset: null, revision: randomUUID() })]);
            return normalized(db, memory);
        });
        cacheGeneration++; cache = undefined;
        invalidateActiveAiPresetCache();
        return { ...result, success: true };
    } catch (error) {
        const message = error instanceof Error ? error.message : '';
        const known = /^(Выберите|Для свободного|Нет доступного|Недоступен)/.test(message);
        throw new ApiError(known ? 400 : 503, 'model_preferences_unavailable', known
            ? 'Выбранная стратегия сейчас недоступна. Проверь подключённые сервисы и модели.' : 'Не удалось сохранить настройки моделей. Повтори позже.');
    }
}
