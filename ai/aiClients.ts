import type { AiProvider } from './modelPresets';
import type OpenAI from 'openai';
import { getAiProviderAdapter } from './providers/registry';
import {
    geminiProviderAdapter,
    openaiProviderAdapter,
    openrouterProviderAdapter,
} from './providers/registry';

export const openaiClient = openaiProviderAdapter.client;
export const openrouterClient = openrouterProviderAdapter.client;
export const geminiClient = geminiProviderAdapter.client;

export function getAiClient(provider: AiProvider): OpenAI {
    return getAiProviderAdapter(provider).client;
}
