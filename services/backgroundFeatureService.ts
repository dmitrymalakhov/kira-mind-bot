import { AppDataSource } from '../data-source';
import { BotSettingEntity } from '../entity/BotSettingEntity';
import { BACKGROUND_FEATURES, backgroundFeatureSettingKey, defaultBackgroundFeatureEnabled, type BackgroundFeature } from '../ai/backgroundFeatures';
import { scopedBotKey } from '../utils/botIdentity';
import { isMaximumSavingsEnabled } from './budgetModeService';
const { requiresTelegramSession } = require('../ai/backgroundFeatureState');
const telegramAccess = require('../utils/telegramAccess');

const cache = new Map<BackgroundFeature, { enabled: boolean; expiresAt: number }>();
const pending = new Map<BackgroundFeature, Promise<boolean>>();
const revisions = new Map<BackgroundFeature, number>();

/** The saved choice is independent of budget mode and parent switches. */
export async function getBackgroundFeaturePreference(feature: BackgroundFeature): Promise<boolean> {
    const cached = cache.get(feature);
    if (cached && cached.expiresAt > Date.now()) return cached.enabled;
    if (!AppDataSource.isInitialized) return false;
    const active = pending.get(feature);
    if (active) return active;
    const revision = revisions.get(feature);
    const read = (async () => {
        let enabled = false;
        try {
            const repo = AppDataSource.getRepository(BotSettingEntity);
            let entry = await repo.findOneBy({ key: backgroundFeatureSettingKey(feature) });
            if (!entry && feature === 'reflection') {
                entry = await repo.findOneBy({ key: scopedBotKey('reflection_mode_enabled') });
            }
            enabled = entry ? entry.value === 'true' : defaultBackgroundFeatureEnabled(feature, process.env);
        } catch {
            console.warn(`[background] Настройка ${feature} недоступна; функция приостановлена`);
        }
        if (revision !== revisions.get(feature) && cache.has(feature)) return cache.get(feature)!.enabled;
        cache.set(feature, { enabled, expiresAt: Date.now() + 5000 });
        return enabled;
    })();
    pending.set(feature, read);
    try { return await read; }
    finally { if (pending.get(feature) === read) pending.delete(feature); }
}

export async function setBackgroundFeatureEnabled(feature: BackgroundFeature, enabled: boolean): Promise<void> {
    await AppDataSource.getRepository(BotSettingEntity).upsert({
        key: backgroundFeatureSettingKey(feature), value: String(enabled),
    }, ['key']);
    cacheBackgroundFeaturePreferences({ [feature]: enabled });
}

/** Called only after an atomic settings write commits. In-flight older reads cannot undo it. */
export function cacheBackgroundFeaturePreferences(preferences: Partial<Record<BackgroundFeature, boolean>>): void {
    for (const [key, enabled] of Object.entries(preferences)) {
        const feature = key as BackgroundFeature;
        revisions.set(feature, (revisions.get(feature) ?? 0) + 1);
        cache.set(feature, { enabled: enabled!, expiresAt: Date.now() + 5000 });
    }
}

export async function isBackgroundFeatureEnabled(feature: BackgroundFeature): Promise<boolean> {
    if (requiresTelegramSession(feature) && !telegramAccess.readTelegramUserCredentials(process.env)) return false;
    const definition = BACKGROUND_FEATURES[feature];
    if (definition.budgetPaused && await isMaximumSavingsEnabled()) return false;
    if (!await getBackgroundFeaturePreference(feature)) return false;
    for (const parent of definition.requires) {
        if (!await isBackgroundFeatureEnabled(parent as BackgroundFeature)) return false;
    }
    return true;
}
