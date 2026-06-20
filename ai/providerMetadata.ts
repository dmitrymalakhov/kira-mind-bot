import providerRegistry from './provider-registry.json';
import type { AiProvider } from './modelPresets';

export type AiMonitoringAuthMode = 'bearer' | 'query_key';

export interface AiCapabilityMap {
    supportsChatCompletions: boolean;
    supportsResponsesApi: boolean;
    supportsEmbedding: boolean;
    supportsTranscription: boolean;
    supportsVision: boolean;
    supportsFunctionCalling: boolean;
    supportsThinkingMode: boolean;
    supportsReasoningEffort: boolean;
    supportsPromptCaching: boolean;
    supportsOpenAiCompatibleTransport: boolean;
}

export interface AiProviderMonitoringConfig {
    kind: 'openai-models' | 'openrouter-auth-key' | 'gemini-models';
    url: string;
    auth: AiMonitoringAuthMode;
}

export interface AiProviderDescriptor {
    id: AiProvider;
    label: string;
    envKey: string;
    baseURL: string | null;
    monitoring: AiProviderMonitoringConfig;
    capabilities: AiCapabilityMap;
}

interface ProviderRegistryFile {
    providers: Record<AiProvider, AiProviderDescriptor>;
}

const registry = providerRegistry as ProviderRegistryFile;

export const AI_PROVIDER_DESCRIPTORS: Readonly<Record<AiProvider, AiProviderDescriptor>> = registry.providers;
export const AI_PROVIDER_IDS = Object.keys(AI_PROVIDER_DESCRIPTORS) as AiProvider[];

export function getAiProviderDescriptor(provider: AiProvider): AiProviderDescriptor {
    return AI_PROVIDER_DESCRIPTORS[provider];
}
