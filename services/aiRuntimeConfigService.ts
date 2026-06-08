import { AppDataSource } from '../data-source';
import { BotSettingEntity } from '../entity/BotSettingEntity';
import { setSetting } from './botSettingsService';
import { parseAiPresetName, type AiPresetName } from '../ai/modelPresets';

export const AI_MODEL_PRESET_SETTING_KEY = 'AI_MODEL_PRESET';
export const DEFAULT_AI_MODEL_PRESET: AiPresetName = 'gpt-balanced';

export function getEnvAiPresetName(): AiPresetName {
    return parseAiPresetName(process.env.AI_MODEL_PRESET) ?? DEFAULT_AI_MODEL_PRESET;
}

export async function getActiveAiPresetName(): Promise<AiPresetName> {
    const fallback = getEnvAiPresetName();

    try {
        if (!AppDataSource.isInitialized) return fallback;
        const repo = AppDataSource.getRepository(BotSettingEntity);
        const entry = await repo.findOneBy({ key: AI_MODEL_PRESET_SETTING_KEY });
        return parseAiPresetName(entry?.value) ?? fallback;
    } catch (error) {
        console.warn('[AI preset] Не удалось прочитать runtime preset из БД:', error);
        return fallback;
    }
}

export async function setActiveAiPresetName(preset: AiPresetName): Promise<void> {
    await setSetting(AI_MODEL_PRESET_SETTING_KEY, preset);
}
