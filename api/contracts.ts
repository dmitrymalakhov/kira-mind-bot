import type { ApiSettings, ApiSettingsPatch } from './settings';

export class ApiError extends Error {
    constructor(public readonly status: number, public readonly code: string, message: string) {
        super(message);
    }
}

export interface ApiButton {
    text: string;
    actionToken?: string;
    url?: string;
}

export interface ApiMessage {
    id: number;
    type: 'text' | 'photo' | 'document' | 'voice' | 'notice' | 'delete';
    text?: string;
    format?: 'plain' | 'html';
    buttons?: ApiButton[][];
    fileUrl?: string;
    filename?: string;
    replacesMessageId?: number;
}

export interface ApiReply {
    messages: ApiMessage[];
}

export interface ApiBackend {
    status(): Promise<unknown>;
    capabilities(): Promise<unknown>;
    history(limit: number): Promise<unknown>;
    reminders(): Promise<unknown>;
    tasks(): Promise<unknown>;
    settings?(): Promise<ApiSettings>;
    updateSettings?(patch: ApiSettingsPatch): Promise<ApiSettings>;
    message(text: string): Promise<ApiReply>;
    action(token: string): Promise<ApiReply>;
    file(id: string): Promise<{ data: Buffer; filename: string }>;
    /** The app's text mode (API_AI_MODEL_PRESET): catalog, its selection and the server's global mode. */
    modelSettings(): Promise<unknown>;
    /** Throws before any receipt exists when the app's stored mode cannot run, so the turn is surely not executed. */
    turnReady(): Promise<void>;
    /** AR scene (api/scene.ts): capabilities with the vision route, a scene turn and the phone's action results. */
    sceneCapabilities(): Promise<unknown>;
    sceneReady(turn: import('./scene').SceneTurn): Promise<import('../ai/modelPresets').AiPresetName | null>;
    sceneTurn(turn: import('./scene').SceneTurn, preset: import('../ai/modelPresets').AiPresetName | null): Promise<ApiReply>;
    sceneActionResult(body: Record<string, unknown>): Promise<unknown>;
    saveModelSettings(body: Record<string, unknown>): Promise<unknown>;
}

export interface ApiOperationStore {
    run(key: string, fingerprint: string, work: () => Promise<ApiReply>): Promise<ApiReply>;
}
