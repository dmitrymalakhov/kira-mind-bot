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
    message(text: string): Promise<ApiReply>;
    action(token: string): Promise<ApiReply>;
    file(id: string): Promise<{ data: Buffer; filename: string }>;
}

export interface ApiOperationStore {
    run(key: string, fingerprint: string, work: () => Promise<ApiReply>): Promise<ApiReply>;
}
