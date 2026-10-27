import { ApiError } from './contracts';
import { resolveModelForTaskAsync } from '../ai/modelResolver';
import { getAiProviderAdapter } from '../ai/providers/registry';
import type { VisionRoute } from './scene';

export const MAX_PHOTO_BYTES = 2_000_000;
export const MAX_PHOTO_BODY_BYTES = 3 * 1024 * 1024;
export const PHOTO_STORAGE_NOTE = 'Фото анализируется один раз и не сохраняется; в историю попадает только текст.';

export interface PhotoTurn {
    text?: string;
    photo: { mime: 'image/jpeg'; data: Buffer; width: number; height: number };
}

function invalid(): ApiError { return new ApiError(400, 'invalid_photo', 'Передай одно фото JPEG с размерами и необязательной подписью до 8000 символов.'); }

export function parsePhotoTurn(value: unknown): PhotoTurn {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
    const root = value as Record<string, unknown>;
    if (Object.keys(root).some(key => !['text', 'photo'].includes(key))) throw invalid();
    if (root.text !== undefined && (typeof root.text !== 'string' || !root.text.trim() || root.text.trim().length > 8000)) throw invalid();
    if (!root.photo || typeof root.photo !== 'object' || Array.isArray(root.photo)) throw invalid();
    const photo = root.photo as Record<string, unknown>;
    if (Object.keys(photo).length !== 4 || Object.keys(photo).some(key => !['mime', 'data', 'width', 'height'].includes(key))) throw invalid();
    if (photo.mime !== 'image/jpeg') throw new ApiError(415, 'unsupported_photo', 'Фото принимается только в JPEG.');
    if (typeof photo.data !== 'string' || !/^[A-Za-z0-9+/]+=*$/.test(photo.data)) throw invalid();
    const data = Buffer.from(photo.data, 'base64');
    if (data.length > MAX_PHOTO_BYTES) throw new ApiError(413, 'photo_too_large', 'Фото больше 2 МБ. Уменьши его размер и отправь снова.');
    if (data.length < 3 || data[0] !== 0xff || data[1] !== 0xd8 || data[2] !== 0xff) throw new ApiError(415, 'unsupported_photo', 'Данные фото не являются JPEG.');
    if (!Number.isInteger(photo.width) || !Number.isInteger(photo.height) || Number(photo.width) < 16 || Number(photo.width) > 4096
        || Number(photo.height) < 16 || Number(photo.height) > 4096) throw invalid();
    return { ...(typeof root.text === 'string' ? { text: root.text.trim() } : {}), photo: { mime: 'image/jpeg', data, width: Number(photo.width), height: Number(photo.height) } };
}

/** Both imageAgent and healthPhotoAgent read pixels through the conversation task, including skills runtime. */
export async function photoVisionRoute(env: NodeJS.ProcessEnv = process.env): Promise<VisionRoute> {
    try {
        // Resolve the same policy, app scope, local role and model env override as the actual inference call.
        const { modelRef } = await resolveModelForTaskAsync('conversation');
        const adapter = getAiProviderAdapter(modelRef.provider);
        const route: VisionRoute = { available: true, provider: modelRef.provider, providerLabel: adapter.descriptor.label,
            model: modelRef.model, location: modelRef.provider === 'lmstudio' ? 'server-local' : 'cloud' };
        if (!adapter.getModelCapabilities(modelRef.model).supportsVision) {
            return { ...route, available: false, reason: `Модель ${modelRef.model} не поддерживает изображения.` };
        }
        if (!adapter.descriptor.optionalApiKey && !env[adapter.descriptor.envKey]?.trim()) {
            return { ...route, available: false, reason: `На сервере не задан ключ ${adapter.descriptor.label}.` };
        }
        return route;
    } catch {
        return { available: false, reason: 'Не удалось определить доступную модель для анализа фото.' };
    }
}
