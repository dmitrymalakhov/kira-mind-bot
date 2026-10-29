import { In } from 'typeorm';
import { AppDataSource } from '../data-source';
import { BotSettingEntity } from '../entity/BotSettingEntity';
import { BACKGROUND_FEATURE_KEYS, backgroundFeatureSettingKey, defaultBackgroundFeatureEnabled } from '../ai/backgroundFeatures';
import { BUDGET_MODE_SETTING_KEY, BUDGET_MODES, resolveBudgetMode, type BudgetMode } from '../ai/budgetMode';
import { ApiError } from '../api/contracts';
import { ApiSettings, ApiSettingsPatch } from '../api/settings';
import { scopedBotKey } from '../utils/botIdentity';
import { cacheBackgroundFeaturePreferences } from './backgroundFeatureService';
import { cacheBudgetMode } from './budgetModeService';
const { buildFeatureStates } = require('../ai/backgroundFeatureState');
const { readTelegramUserCredentials } = require('../utils/telegramAccess');

/** Read a fresh snapshot for API clients; storage failures must never look like saved defaults. */
export async function readUserSettings(): Promise<ApiSettings> {
    try {
        const legacyReflection = scopedBotKey('reflection_mode_enabled');
        const rows = await AppDataSource.getRepository(BotSettingEntity).findBy({
            key: In([BUDGET_MODE_SETTING_KEY, legacyReflection, ...BACKGROUND_FEATURE_KEYS.map(backgroundFeatureSettingKey)]),
        });
        const stored = new Map(rows.map(row => [row.key, row.value]));
        const preferences = Object.fromEntries(BACKGROUND_FEATURE_KEYS.map(feature => {
            const value = stored.get(backgroundFeatureSettingKey(feature))
                ?? (feature === 'reflection' ? stored.get(legacyReflection) : undefined);
            return [feature, value === undefined ? defaultBackgroundFeatureEnabled(feature, process.env) : value === 'true'];
        }));
        const budgetMode = resolveBudgetMode(stored.get(BUDGET_MODE_SETTING_KEY));
        const personalSessionConfigured = Boolean(readTelegramUserCredentials(process.env));
        return {
            budgetMode,
            budgetModes: Object.entries(BUDGET_MODES).map(([key, mode]) => ({ key: key as BudgetMode, title: mode.title })),
            telegram: { personalSessionConfigured },
            features: buildFeatureStates(preferences, budgetMode, personalSessionConfigured).map(
                ({ key, title, description, group, enabled, effective, blockedBy }: ApiSettings['features'][number]) =>
                    ({ key, title, description, group, enabled, effective, blockedBy })),
        };
    } catch {
        throw new ApiError(503, 'settings_unavailable', 'Не удалось прочитать настройки. Повтори позже.');
    }
}

export async function updateUserSettings(patch: ApiSettingsPatch): Promise<ApiSettings> {
    const previous = patch.background ? await readUserSettings() : undefined;
    const rows = Object.entries(patch.background || {}).map(([key, enabled]) => ({ key: `background:${key}`, value: String(enabled) }));
    if (patch.budgetMode) rows.push({ key: BUDGET_MODE_SETTING_KEY, value: patch.budgetMode });
    try {
        // One PostgreSQL statement updates the whole validated patch atomically.
        await AppDataSource.getRepository(BotSettingEntity).upsert(rows, ['key']);
    } catch {
        throw new ApiError(503, 'settings_unavailable', 'Не удалось сохранить настройки. Повтори позже.');
    }
    cacheBackgroundFeaturePreferences(patch.background || {});
    if (patch.budgetMode) cacheBudgetMode(patch.budgetMode);
    for (const [feature, enabled] of Object.entries(patch.background || {})) {
        if (previous?.features.find(item => item.key === feature)?.enabled !== enabled)
            await (await import('./productAnalytics')).recordPreferenceChange(feature, enabled);
    }
    return readUserSettings();
}
