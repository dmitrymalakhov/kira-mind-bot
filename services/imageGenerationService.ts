import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppDataSource } from '../data-source';
import { BotSettingEntity } from '../entity/BotSettingEntity';
import { RUNTIME_DATA_DIR } from '../utils/runtimeData';
import { SETTING_KEY, defaultImageSettings, parseImageSettings, readReference, requestImage, type ImageSettings } from '../ai/imageGeneration';

let cached: ImageSettings | undefined;
let refreshedAt = 0;
export async function getImageSettings(): Promise<ImageSettings> {
    if (!AppDataSource.isInitialized) return defaultImageSettings();
    if (cached && Date.now() - refreshedAt < 5000) return cached;
    const row = await AppDataSource.getRepository(BotSettingEntity).findOneBy({ key: SETTING_KEY });
    cached = row ? parseImageSettings(row.value) : defaultImageSettings();
    refreshedAt = Date.now();
    return cached;
}

export class CharacterReferenceRequiredError extends Error {}
export async function generateOpenAiImage(prompt: string, includesCharacter: boolean): Promise<string> {
    const settings = await getImageSettings();
    const reference = includesCharacter ? await readReference(RUNTIME_DATA_DIR) : null;
    if (includesCharacter && !reference) throw new CharacterReferenceRequiredError('Добавьте эталон внешности в админке: «Настройки → Генерация изображений → Референс Киры».');
    const image = await requestImage({ settings, prompt, reference });
    const directory = path.join(RUNTIME_DATA_DIR, 'image-generation', 'generated');
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const filename = path.join(directory, `${randomUUID()}.${image.mime === 'image/jpeg' ? 'jpg' : image.mime === 'image/png' ? 'png' : 'webp'}`);
    await fs.writeFile(filename, image.data, { mode: 0o600, flag: 'wx' });
    // Generated photos are transient. The canonical reference is kept separately.
    for (const name of await fs.readdir(directory)) {
        if (!/^[a-f0-9-]{36}\.(jpg|png|webp)$/.test(name)) continue;
        const file = path.join(directory, name);
        const stat = await fs.stat(file).catch(() => undefined);
        if (stat && Date.now() - stat.mtimeMs > 24 * 60 * 60_000) await fs.unlink(file).catch(() => {});
    }
    return filename;
}
