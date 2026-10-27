import type { MessageClassification } from '../orchestrator';
import type { AiPresetName } from '../ai/modelPresets';

export type DialogueJobStatus = 'staged' | 'queued' | 'running' | 'ready' | 'delivering' | 'completed' | 'cancelled' | 'superseded' | 'failed' | 'unknown';
export interface FastReplyDecision {
    mode: 'answer' | 'review' | 'defer' | 'route';
    answer?: string;
}
export interface DialogueJobInput {
    message: string;
    initialAnswer: string;
    required: boolean;
    classification: MessageClassification;
    history: Array<{ role: string; content: string }>;
    topic?: string;
    memoryRecallFocus?: import('./memoryRecallTypes').MemoryRecallFocus;
    preset: AiPresetName;
    modelPolicy?: import('../ai/modelPreferences').ModelPolicy | null;
}
export interface DialogueJob {
    id: string;
    profile: string;
    channel: string;
    turnId: string;
    userId: number;
    chatId: number;
    messageId?: number;
    input: DialogueJobInput;
    status: DialogueJobStatus;
    phase: 'review' | 'deep';
    attempts: number;
    lease?: string | null;
    lockedAt?: Date | null;
    announced: boolean;
    notice?: string | null;
    resultText?: string | null;
    error?: string | null;
    createdAt: Date;
    expiresAt: Date;
    updatedAt: Date;
}
