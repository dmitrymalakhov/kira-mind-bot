import { InputFile } from 'grammy';
import type { ProcessingResult } from '../orchestrator';

export function generatedImageInput(result: Pick<ProcessingResult, 'generatedImagePath' | 'generatedImageUrl'>): InputFile | string | undefined {
    return result.generatedImagePath ? new InputFile(result.generatedImagePath) : result.generatedImageUrl;
}

export function normalizeImageDescription(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const text = value.replace(/\s+/g, ' ').trim();
    if (!text || text.length > 700 || !/[а-яё]/iu.test(text) || /^[{[]|```|https?:\/\/|data:image|"prompt"|"includesCharacter"/iu.test(text)) return undefined;
    return text;
}

/** Human-readable history only: internal prompts, file paths and URLs never belong here. */
export function generatedImageHistoryText(result: Pick<ProcessingResult, 'generatedImageDescription' | 'generatedImageRequest'>): string {
    const description = normalizeImageDescription(result.generatedImageDescription);
    if (description) return description;
    const request = result.generatedImageRequest?.replace(/\s+/g, ' ').trim();
    if (request) return `Изображение по твоей просьбе: «${request.slice(0, 600)}${request.length > 600 ? '…' : ''}».`;
    return 'Картинка отправлена.';
}
