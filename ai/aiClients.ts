import { OpenAI } from 'openai';
import { config } from '../config';
import type { AiProvider } from './modelPresets';

export const openaiClient = new OpenAI({
    apiKey: config.openAiApiKey || process.env.OPENAI_API_KEY,
});

export const openrouterClient = new OpenAI({
    apiKey: process.env.OPENROUTER_API_KEY || 'missing-openrouter-api-key',
    baseURL: 'https://openrouter.ai/api/v1',
});

export const geminiClient = new OpenAI({
    apiKey: process.env.GEMINI_API_KEY || 'missing-gemini-api-key',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
});

export function getAiClient(provider: AiProvider): OpenAI {
    switch (provider) {
        case 'openai':
            return openaiClient;
        case 'openrouter':
            return openrouterClient;
        case 'gemini':
            return geminiClient;
    }
}
