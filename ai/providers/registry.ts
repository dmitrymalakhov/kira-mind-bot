import type { AiProvider } from '../modelPresets';
import { geminiProviderAdapter } from './gemini';
import { openaiProviderAdapter } from './openai';
import { openrouterProviderAdapter } from './openrouter';
import type { AiProviderAdapter } from './types';

const AI_PROVIDER_ADAPTERS: Record<AiProvider, AiProviderAdapter> = {
    openai: openaiProviderAdapter,
    openrouter: openrouterProviderAdapter,
    gemini: geminiProviderAdapter,
};

export function getAiProviderAdapter(provider: AiProvider): AiProviderAdapter {
    return AI_PROVIDER_ADAPTERS[provider];
}

export { geminiProviderAdapter, openaiProviderAdapter, openrouterProviderAdapter };
