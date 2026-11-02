export const SETTING_KEY: string;
export type ImageRecognitionSettings = {
    provider: 'lmstudio';
    model: string;
    maxTokens: number;
    reasoningEffort: 'none' | 'low' | 'medium' | 'high';
} | null;
export function parseImageRecognitionSettings(raw: unknown): ImageRecognitionSettings;
