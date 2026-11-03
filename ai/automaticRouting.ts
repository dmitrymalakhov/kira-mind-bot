import { accountPolicyError } from './accountPolicy';
import type { AiModelRef } from './modelPresets';
import type { AiResolvedTaskRoute } from './modelResolver';
import { getAiProviderAdapter } from './providers/registry';
import { classifyAiError } from './errorDiagnostics';
import { isAiContentSafetyError } from './contentSafety';
import { assertAiExecutionActive } from './executionScope';

const states = new Map<string, { active: number; unavailableUntil: number; touched: number }>();
const key = (ref: AiModelRef) => `${ref.provider}:${ref.model}`;
export class AiInvalidResponseError extends Error {
    readonly code = 'invalid_response';
    constructor() { super('AI response contained invalid JSON'); }
}
export class AiRouteChangedError extends Error {}

export function assertAutomaticRouteCurrent(route: AiResolvedTaskRoute, current: AiResolvedTaskRoute): void {
    if (JSON.stringify(route) !== JSON.stringify(current)) throw new AiRouteChangedError('AI strategy changed during request');
}

export function configuredCandidate(ref: AiModelRef, env: NodeJS.ProcessEnv = process.env): boolean {
    const descriptor = getAiProviderAdapter(ref.provider).descriptor;
    return Boolean(descriptor.optionalApiKey || env[descriptor.envKey]?.trim());
}

function recoverable(error: unknown): boolean {
    const diagnostics = classifyAiError(error);
    return !accountPolicyError(error) && !isAiContentSafetyError(error) && (diagnostics.retryable || error instanceof AiInvalidResponseError
        || [401, 403, 404].includes(diagnostics.errorStatus || 0));
}

/** Bounded account-worker state contains no prompts or results. No network discovery or AI router. */
export async function runAutomaticModels<T>(route: AiResolvedTaskRoute,
    supports: (model: AiModelRef) => boolean,
    execute: (model: AiModelRef, attempt: number) => Promise<T>,
): Promise<{ result: T; model: AiModelRef; attempt: number }> {
    const now = Date.now();
    for (const [id, state] of states) if (!state.active && now - state.touched > 60_000) states.delete(id);
    const eligible = (route.candidates || []).filter(ref => configuredCandidate(ref) && supports(ref));
    if (!eligible.length) throw new Error('Нет доступной модели выбранного пула для этой операции.');
    const ready = eligible.filter(ref => (states.get(key(ref))?.unavailableUntil || 0) <= now);
    // Permit one recovery probe if every eligible model is cooling down.
    const candidates = ready.length ? ready : [eligible.reduce((a, b) =>
        (states.get(key(a))?.unavailableUntil || 0) <= (states.get(key(b))?.unavailableUntil || 0) ? a : b)];
    const ordered = candidates.map((model, index) => ({ model, score: index + (states.get(key(model))?.active || 0) * 2 }))
        .sort((a, b) => a.score - b.score).map(item => item.model);
    let lastError: unknown;
    let attempt = 0;
    for (const model of ordered) {
        const state = states.get(key(model)) || { active: 0, unavailableUntil: 0, touched: now };
        states.set(key(model), state);
        const repeats = ordered.length === 1 ? 2 : 1;
        for (let retry = 0; retry < repeats; retry++) {
            assertAiExecutionActive();
            state.active++; state.touched = Date.now(); attempt++;
            try {
                const result = await execute(model, attempt);
                assertAiExecutionActive();
                state.unavailableUntil = 0;
                return { result, model, attempt };
            } catch (error) {
                assertAiExecutionActive();
                if (!recoverable(error)) throw error;
                lastError = error;
                // Invalid output is request-specific; it must not disable a healthy model globally.
                if (!(error instanceof AiInvalidResponseError)) state.unavailableUntil = Date.now() + 30_000;
                if (!classifyAiError(error).retryable) break;
            } finally { state.active--; state.touched = Date.now(); }
        }
    }
    throw lastError;
}

export function supportsAutomaticChat(ref: AiModelRef, params: Record<string, any>): boolean {
    const capabilities = getAiProviderAdapter(ref.provider).getModelCapabilities(ref.model);
    const vision = isVisionChat(params);
    return capabilities.supportsChatCompletions && (!vision || capabilities.supportsVision)
        && (!params.tools?.length || capabilities.supportsFunctionCalling);
}

export function isVisionChat(params: Record<string, any>): boolean {
    return Boolean(params.messages?.some((message: any) => Array.isArray(message.content)
        && message.content.some((part: any) => part.type === 'image_url' || part.type === 'input_image')));
}

export function supportsAutomaticResponse(ref: AiModelRef, params: Record<string, any>): boolean {
    const adapter = getAiProviderAdapter(ref.provider);
    const capabilities = adapter.getModelCapabilities(ref.model);
    if (!capabilities.supportsResponsesApi) return false;
    // Compatibility adapters flatten Responses input and support only web search.
    // Preserve native tool calls, attachments and multimodal content on the native endpoint.
    if (!adapter.capabilities.supportsNativeResponses) {
        if (params.tools?.some((tool: any) => tool.type !== 'web_search_preview')) return false;
        if (Array.isArray(params.input) && params.input.some((item: any) => item.type && item.type !== 'message'
            || Array.isArray(item.content) && item.content.some((part: any) => part.type !== 'input_text' && part.type !== 'text'))) return false;
    }
    return true;
}
