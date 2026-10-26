import { AsyncLocalStorage } from 'node:async_hooks';
import { AppDataSource } from '../data-source';
import { BotSettingEntity } from '../entity/BotSettingEntity';
import { SETTING_KEY, parseModelPolicy, type ModelPolicy } from '../ai/modelPreferences';
import { hasChannelPresetOverride } from './aiRuntimeConfigService';
import { getActiveMemoryEmbeddingProfileName } from './memoryEmbeddingRuntimeConfigService';
import { ApiError } from '../api/contracts';

const scope = new AsyncLocalStorage<{ policy: ModelPolicy | null }>();
let cache: { value: ModelPolicy | null; at: number } | undefined;
export function runWithModelPolicy<T>(policy: ModelPolicy | null, work: () => Promise<T>): Promise<T> {
    return scope.run({ policy }, work);
}
export async function getModelPolicy(fresh = false): Promise<ModelPolicy | null> {
    const scoped = scope.getStore();
    if (scoped) return scoped.policy;
    if (hasChannelPresetOverride() || !AppDataSource.isInitialized) return null;
    if (!fresh && cache && Date.now() - cache.at < 5000) return cache.value;
    const row = await AppDataSource.getRepository(BotSettingEntity).findOneBy({ key: SETTING_KEY });
    const policy = parseModelPolicy(row?.value);
    cache = { value: policy, at: Date.now() };
    return policy;
}

const controller = require('../admin-panel/modelPreferences') as {
    readModelPreferences(pool: unknown, env: NodeJS.ProcessEnv, memoryProfile: string): Promise<unknown>;
    saveModelPreferences(pool: unknown, env: NodeJS.ProcessEnv, memoryProfile: string, body: unknown): Promise<unknown>;
};
const pool = () => ({ query: async (sql: string, values?: unknown[]) => ({ rows: await AppDataSource.query(sql, values) }) });
export async function readModelPreferences(): Promise<unknown> {
    return controller.readModelPreferences(pool(), process.env, await getActiveMemoryEmbeddingProfileName());
}
export async function saveModelPreferences(body: unknown): Promise<unknown> {
    try {
        const result = await controller.saveModelPreferences(pool(), process.env, await getActiveMemoryEmbeddingProfileName(), body);
        cache = undefined;
        return result;
    } catch (error) {
        const message = error instanceof Error ? error.message : '';
        const known = /^(Выберите|Для свободного|Нет доступного|Недоступен)/.test(message);
        throw new ApiError(known ? 400 : 500, 'model_preferences_unavailable', known
            ? message : 'Не удалось сохранить настройки моделей.');
    }
}
