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
    console.error(`[AI DEGRADED] ${JSON.stringify({
        event: 'start',
        taskKey: context.taskKey,
        traceId: context.traceId,
        failedAttempt: context.attempt - 1,
        from: formatModel(context.previousModel),
        to: formatModel(context.degradedModel),
        reason: buildSafeAiErrorLog(error),
    })}`);
}

export function logDegradedSuccess(context: DegradedLogContext, latencyMs: number): void {
    console.info(`[AI DEGRADED] ${JSON.stringify({
        event: 'success',
        taskKey: context.taskKey,
        traceId: context.traceId,
        attempt: context.attempt,
        activeModel: formatModel(context.degradedModel),
        latencyMs,
    })}`);
}
