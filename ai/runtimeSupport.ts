import { getFallbackModel } from './fallbackModels';
import { getDegradedModel } from './degradedModels';
import { isTrueFullAiPreset, parseAiPresetName, type AiModelRef, type AiTaskKey } from './modelPresets';

export type FallbackPolicyMode = 'task-default';

export function getTaskFallbackModel(taskKey: AiTaskKey): AiModelRef {
    return getFallbackModel(taskKey);
}

export function getTransitionalTaskFallbackModel(taskKey: AiTaskKey): AiModelRef {
    return getTaskFallbackModel(taskKey);
}

export function allowsCrossProviderFallback(presetName: string): boolean {
    const parsedPresetName = parseAiPresetName(presetName);
    if (!parsedPresetName) return true;
    return !isTrueFullAiPreset(parsedPresetName);
}

/**
 * True-full preset остаётся provider-pure и при деградации: после исчерпанного
 * retry тяжёлая Gemini-модель может перейти на более доступную Gemini Flash
 * Lite. Повторять тот же lite-маршрут ещё раз бессмысленно.
 */
export function getSameProviderDegradedModel(
    presetName: string,
    currentModel: AiModelRef,
    retryable: boolean,
): AiModelRef | null {
    const parsedPresetName = parseAiPresetName(presetName);
    if (!retryable || !parsedPresetName || !isTrueFullAiPreset(parsedPresetName)) return null;
    const degradedModel = getDegradedModel(parsedPresetName);
    if (!degradedModel || degradedModel.provider !== currentModel.provider) return null;
    if (currentModel.model === degradedModel.model) return null;
    return degradedModel;
}

const MAX_AI_ERROR_MESSAGE_LENGTH = 320;

function truncateErrorMessage(message: string): string {
    const normalized = message.replace(/\s+/g, ' ').trim();
    if (normalized.length <= MAX_AI_ERROR_MESSAGE_LENGTH) return normalized;
    return `${normalized.slice(0, MAX_AI_ERROR_MESSAGE_LENGTH - 1)}…`;
}

function getRecordValue(record: Record<string, unknown>, key: string): unknown {
    return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

function stringifyErrorValue(value: unknown): string | null {
    if (typeof value === 'string') {
        const normalized = value.trim();
        return normalized.length > 0 ? normalized : null;
    }

    if (typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
    }

    return null;
}

function summarizeErrorDetails(error: unknown): string | null {
    if (!error || typeof error !== 'object') return null;

    const record = error as Record<string, unknown>;
    const details: string[] = [];

    const status = stringifyErrorValue(getRecordValue(record, 'status'));
    const code = stringifyErrorValue(getRecordValue(record, 'code'));
    const type = stringifyErrorValue(getRecordValue(record, 'type'));
    const requestId = stringifyErrorValue(getRecordValue(record, 'request_id'))
        ?? stringifyErrorValue(getRecordValue(record, 'requestId'));

    const nestedError = getRecordValue(record, 'error');
    const nestedErrorRecord = nestedError && typeof nestedError === 'object'
        ? nestedError as Record<string, unknown>
        : null;

    const nestedCode = nestedErrorRecord
        ? stringifyErrorValue(getRecordValue(nestedErrorRecord, 'code'))
        : null;
    const nestedType = nestedErrorRecord
        ? stringifyErrorValue(getRecordValue(nestedErrorRecord, 'type'))
        : null;
    const nestedMessage = nestedErrorRecord
        ? stringifyErrorValue(getRecordValue(nestedErrorRecord, 'message'))
        : null;

    if (status) details.push(`status=${status}`);
    if (code) details.push(`code=${code}`);
    if (type) details.push(`type=${type}`);
    if (nestedCode && nestedCode !== code) details.push(`provider_code=${nestedCode}`);
    if (nestedType && nestedType !== type) details.push(`provider_type=${nestedType}`);
    if (requestId) details.push(`request_id=${requestId}`);
    if (nestedMessage) details.push(`provider_message=${nestedMessage}`);

    return details.length > 0 ? details.join('; ') : null;
}

export function errorToMessage(error: unknown): string {
    const baseMessage = error instanceof Error
        ? error.message
        : (() => {
            try {
                return JSON.stringify(error);
            } catch {
                return String(error);
            }
        })();

    const details = summarizeErrorDetails(error);
    if (details && !baseMessage.includes(details)) {
        return truncateErrorMessage(`${baseMessage}; ${details}`);
    }

    return truncateErrorMessage(baseMessage);
}
