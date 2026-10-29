import type { ApiSettings, ApiSettingsPatch } from './settings';

export class ApiError extends Error {
    /** `released`: refused before anything ran, so a durable receipt for the request is dropped, not kept as failed,
     *  and a corrected retry may run. */
    constructor(public readonly status: number, public readonly code: string, message: string, public readonly released = false) {
        super(message);
    }
}
/** The same refusal, marked as having run nothing (a validation or availability error). */
export function released(error: unknown): unknown {
    return error instanceof ApiError && !error.released && error.status < 500 || error instanceof ApiError && error.code === 'vision_unavailable'
        ? new ApiError(error.status, error.code, error.message, true) : error;
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
    backgroundJob?: { id: string; status: string; required: boolean };
}

export interface ApiBackend {
    status(): Promise<unknown>;
    capabilities(): Promise<unknown>;
    history(limit: number): Promise<unknown>;
    reminders(): Promise<unknown>;
    tasks(): Promise<unknown>;
    dialogueJobs?(): Promise<unknown>;
    cancelDialogueJob?(id: string): Promise<unknown>;
    settings?(): Promise<ApiSettings>;
    modelPreferences?(): Promise<unknown>;
    updateModelPreferences?(body: unknown): Promise<unknown>;
    updateSettings?(patch: ApiSettingsPatch): Promise<ApiSettings>;
    message(text: string, options?: { deferredDialogue?: boolean }): Promise<ApiReply>;
    photoReady(): Promise<import('../ai/modelPresets').AiPresetName | null>;
    photo(buffer: Buffer, caption?: string, preset?: import('../ai/modelPresets').AiPresetName | null): Promise<ApiReply>;
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
    /** Stage "prepare" of a scene turn: what the words ask for, before any frame; nothing answered, stored or done. */
    scenePrepare?(turn: import('./scene').ScenePreparation): Promise<unknown>;
    /** Stage "cancel": a prepared turn the owner stopped can no longer be executed. */
    sceneCancel?(target: { plan: string } | { roomId: string; coordinateSpaceId: string }): Promise<unknown>;
    sceneActionResult(body: Record<string, unknown>): Promise<unknown>;
    saveModelSettings(body: Record<string, unknown>): Promise<unknown>;
}

export interface ApiOperationStore {
    run(key: string, fingerprint: string, work: () => Promise<ApiReply>, options?: { releaseRefusals?: boolean }): Promise<ApiReply>;
}
