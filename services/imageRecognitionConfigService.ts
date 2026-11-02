import { AppDataSource } from '../data-source';
import { BotSettingEntity } from '../entity/BotSettingEntity';
import { SETTING_KEY, parseImageRecognitionSettings, type ImageRecognitionSettings } from '../ai/imageRecognition';

/** Read for every photo, including app-scoped turns. Failed reads cannot authorize a different recipient. */
export async function getImageRecognitionSettings(): Promise<ImageRecognitionSettings> {
    if (!AppDataSource.isInitialized) return null;
    const row = await AppDataSource.getRepository(BotSettingEntity).findOneBy({ key: SETTING_KEY });
    return row ? parseImageRecognitionSettings(row.value) : null;
}
