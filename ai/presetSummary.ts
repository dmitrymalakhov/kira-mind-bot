import type { AiModelRef, AiProvider, AiTaskKey } from './modelPresets';

export const GENERATIVE_TASK_KEYS: readonly AiTaskKey[] = [
    'defaultText',
    'intentClassification',
    'intentDedup',
    'conversation',
    'memoryExtraction',
    'memoryConsolidation',
    'messageAnalysis',
    'webSearchReasoning',
    'browserPlanning',
    'browserVision',
];

export const SERVICE_TASK_KEYS: readonly AiTaskKey[] = [
    'embedding',
    'transcription',
];

const GENERATIVE_PROVIDER_LABELS: Readonly<Record<AiProvider, string>> = {
    openai: 'GPT',
    gemini: 'Gemini',
    zai: 'GLM',
    openrouter: 'OpenRouter Auto',
};

const SERVICE_MODEL_LABELS: Readonly<Record<string, string>> = {
    'openai:text-embedding-3-small': 'OpenAI Embeddings',
    'openai:text-embedding-ada-002': 'OpenAI Embeddings',
    'openai:whisper-1': 'Whisper',
    'gemini:gemini-embedding-2': 'Gemini Embeddings',
    'gemini:gemini-3.5-flash': 'Gemini Transcription',
    'zai:glm-asr-2512': 'GLM Transcription',
};

export interface PresetProviderCount {
    provider: AiProvider;
    label: string;
    count: number;
}

export function getGenerativeProviderLabel(provider: AiProvider): string {
    return GENERATIVE_PROVIDER_LABELS[provider] ?? provider;
}

function getTiePriority(provider: AiProvider, models: Record<string, AiModelRef>): number {
    const defaultTextProvider = models.defaultText?.provider;
    const conversationProvider = models.conversation?.provider;
    if (provider === defaultTextProvider) return 2;
    if (provider === conversationProvider) return 1;
    return 0;
}

export function getGenerativeProviderCounts(models: Record<string, AiModelRef>): PresetProviderCount[] {
    const counts = new Map<AiProvider, number>();

    for (const taskKey of GENERATIVE_TASK_KEYS) {
        const modelRef = models[taskKey];
        if (!modelRef) continue;
        counts.set(modelRef.provider, (counts.get(modelRef.provider) ?? 0) + 1);
    }

    return [...counts.entries()]
        .map(([provider, count]) => ({
            provider,
            label: getGenerativeProviderLabel(provider),
            count,
        }))
        .sort((left, right) => {
            if (right.count !== left.count) {
                return right.count - left.count;
            }

            const rightPriority = getTiePriority(right.provider, models);
            const leftPriority = getTiePriority(left.provider, models);
            if (rightPriority !== leftPriority) {
                return rightPriority - leftPriority;
            }

            return left.label.localeCompare(right.label, 'ru');
        });
}

export function formatGenerativeProviderChain(models: Record<string, AiModelRef>): string {
    return getGenerativeProviderCounts(models)
        .map(({ label }) => label)
        .join(' + ');
}

export function buildPresetTitle(models: Record<string, AiModelRef>, strategyLabel: string): string {
    const providerChain = formatGenerativeProviderChain(models);
    return strategyLabel ? `${providerChain} · ${strategyLabel}` : providerChain;
}

export function formatGenerativeUsageSummary(models: Record<string, AiModelRef>): string {
    const items = getGenerativeProviderCounts(models).map(({ label, count }) => `${label} ${count}`);
    return items.length > 0 ? items.join(' · ') : '—';
}

function getFallbackServiceLabel(modelRef: AiModelRef): string {
    if (modelRef.provider === 'openai') return 'OpenAI';
    if (modelRef.provider === 'gemini') return 'Gemini';
    if (modelRef.provider === 'zai') return 'GLM';
    if (modelRef.provider === 'openrouter') return 'OpenRouter Auto';
    return `${modelRef.provider} · ${modelRef.model}`;
}

export function getServiceLabels(models: Record<string, AiModelRef>): string[] {
    const labels: string[] = [];
    for (const taskKey of SERVICE_TASK_KEYS) {
        const modelRef = models[taskKey];
        if (!modelRef) continue;
        const key = `${modelRef.provider}:${modelRef.model}`;
        labels.push(SERVICE_MODEL_LABELS[key] ?? `${getFallbackServiceLabel(modelRef)} · ${modelRef.model}`);
    }
    return labels;
}

export function formatServiceSummary(models: Record<string, AiModelRef>): string {
    const labels = getServiceLabels(models);
    return labels.length > 0 ? labels.join(' · ') : '—';
}
