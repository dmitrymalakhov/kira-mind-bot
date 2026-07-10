import type { AiModelRef, AiTaskKey } from './modelPresets';
import { buildSafeAiErrorLog } from './errorDiagnostics';

interface DegradedLogContext {
    taskKey: AiTaskKey;
    traceId: string;
    attempt: number;
    previousModel: AiModelRef;
    degradedModel: AiModelRef;
}

function formatModel(modelRef: AiModelRef): string {
    return `${modelRef.provider}:${modelRef.model}`;
}

export function logDegradedStart(context: DegradedLogContext, error: unknown): void {
    console.error(
        `[AI DEGRADED] SWITCH | task=${context.taskKey}`
        + ` | ${formatModel(context.previousModel)} → ${formatModel(context.degradedModel)}`
        + ` | failedAttempt=${context.attempt - 1}`
        + ` | reason=${formatReason(error)}`
        + ` | traceId=${context.traceId}`,
    );
}

export function logDegradedSuccess(context: DegradedLogContext, latencyMs: number): void {
    console.info(
        `[AI DEGRADED] ACTIVE | task=${context.taskKey}`
        + ` | model=${formatModel(context.degradedModel)}`
        + ` | attempt=${context.attempt}`
        + ` | latency=${latencyMs}ms`
        + ` | traceId=${context.traceId}`,
    );
}

export function logDegradedFailure(context: DegradedLogContext, error: unknown, latencyMs: number): void {
    console.error(
        `[AI DEGRADED] FAILED | task=${context.taskKey}`
        + ` | model=${formatModel(context.degradedModel)}`
        + ` | attempt=${context.attempt}`
        + ` | reason=${formatReason(error)}`
        + ` | latency=${latencyMs}ms`
        + ` | traceId=${context.traceId}`,
    );
}

function formatReason(error: unknown): string {
    const diagnostics = buildSafeAiErrorLog(error);
    const parts = [
        typeof diagnostics.errorStatus === 'number' ? `HTTP ${diagnostics.errorStatus}` : undefined,
        typeof diagnostics.errorCode === 'string' ? diagnostics.errorCode : undefined,
        typeof diagnostics.errorCategory === 'string' ? diagnostics.errorCategory : undefined,
        typeof diagnostics.errorType === 'string' ? diagnostics.errorType : undefined,
        diagnostics.retryable === true ? 'retryable' : 'not-retryable',
        typeof diagnostics.providerRequestId === 'string' ? `requestId=${diagnostics.providerRequestId}` : undefined,
    ];
    return parts.filter((part): part is string => Boolean(part)).join(', ');
}
