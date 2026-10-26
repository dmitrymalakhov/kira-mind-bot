import type { BotContext, MessageHistory } from '../../types';
import type { MessageClassification, ProcessingResult } from '../../orchestrator';

export type ToolEffect = 'read' | 'state' | 'external';
export type ToolStatus = 'ok' | 'needs_input' | 'failed' | 'unknown';
export type JsonSchema = {
    type: 'object' | 'string' | 'number' | 'integer' | 'boolean' | 'array';
    properties?: Record<string, JsonSchema>;
    required?: string[];
    additionalProperties?: boolean;
    items?: JsonSchema;
    enum?: Array<string | number | boolean>;
    minLength?: number;
    maxLength?: number;
    minimum?: number;
    maximum?: number;
    maxItems?: number;
    description?: string;
};

export interface KiraRuntimeInput {
    ctx: BotContext;
    message: string;
    isForwarded: boolean;
    forwardFrom: string;
    messageHistory: MessageHistory[];
    classification: MessageClassification;
    lastLocation?: { latitude: number; longitude: number; address?: string };
    enrichedContextFromMemory?: string;
    voiceReplyRequested?: boolean;
    suppressProgress?: boolean;
    recurringTaskRun?: boolean;
    /** Server-bound media from this turn. Tool arguments cannot reference arbitrary paths/URLs. */
    images?: Buffer[];
    continuationAnswer?: string;
}

export interface ToolObservation {
    id: string;
    tool: string;
    status: ToolStatus;
    summary: string;
    data?: unknown;
    confirmationKey?: string;
}

export interface ToolOutput {
    status: ToolStatus;
    summary: string;
    data?: unknown;
    context?: string;
    result?: ProcessingResult;
    confirmationKey?: string;
    /** A missing parameter, as opposed to an existing domain-specific confirmation UI. */
    question?: string;
}

export interface ToolContext extends KiraRuntimeInput {
    runId: string;
    signal: AbortSignal;
    memoryContext: string;
    observations: readonly ToolObservation[];
}

export interface ToolDefinition {
    name: string;
    description: string;
    skill: string;
    effect: ToolEffect;
    ownerOnly: boolean;
    privateOnly?: boolean;
    inputSchema: JsonSchema;
    execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolOutput>;
}

export interface RuntimeToolCall {
    id: string;
    tool: string;
    args: Record<string, unknown>;
    dependsOn?: string[];
}

export interface RuntimeDecision {
    calls?: RuntimeToolCall[];
    finish?: boolean;
    question?: string;
}

export interface AgentRunRecord {
    id: string;
    kind: 'browser' | 'negotiation' | 'study-chat' | 'research';
    status: 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
    parentRunId: string;
    createdAt: number;
    updatedAt: number;
    summary?: string;
}

export interface RuntimeReceipt {
    key: string;
    tool: string;
    status: 'running' | ToolStatus;
    summary?: string;
    waitingForParameter?: boolean;
}

export interface RuntimeSessionState {
    version: 1;
    runId: string;
    requestKey?: string;
    startedAt: number;
    updatedAt: number;
    status: 'running' | 'waiting' | 'completed' | 'failed';
    receipts: RuntimeReceipt[];
    agents: AgentRunRecord[];
    skills: string[];
    toolNames: string[];
    goal?: string;
    observations?: ToolObservation[];
    pendingCalls?: RuntimeToolCall[];
    classification?: MessageClassification;
    question?: string;
    parameterCall?: RuntimeToolCall;
    backgroundRun?: boolean;
    ledgerKey?: string;
    /** Dependency truth survives evidence/context compaction. */
    completedCalls?: Record<string, ToolStatus>;
}
