export interface ImageSettings { enabled: boolean; model: string; size: string; quality: string; }
export interface CharacterReference { data: Buffer; mime: string; sha256?: string; source?: 'default' | 'custom'; }
export const SETTING_KEY: string;
export const MODELS: string[];
export const SIZES: string[];
export const QUALITIES: string[];
export const MAX_REFERENCE_BYTES: number;
export const DEFAULT_REFERENCE_PATH: string;
export const IDENTITY_INSTRUCTION: string;
export function parseImageSettings(raw: unknown): ImageSettings;
export function defaultImageSettings(env?: NodeJS.ProcessEnv): ImageSettings;
export function imageConnection(env?: NodeJS.ProcessEnv): { apiKey: string; baseURL: string };
export function imageMime(data: Buffer): string;
export function readReference(runtimeDir: string, defaultFile?: string | null): Promise<CharacterReference | null>;
export function saveReference(runtimeDir: string, data: Buffer): Promise<void>;
export function deleteReference(runtimeDir: string): Promise<void>;
export function buildImageRequest(settings: ImageSettings, prompt: string, reference?: CharacterReference | null): Record<string, unknown>;
export function requestImage(input: { settings: ImageSettings; prompt: string; reference?: CharacterReference | null; env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch }): Promise<{ data: Buffer; mime: string; usage?: unknown }>;
