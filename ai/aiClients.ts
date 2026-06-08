import { OpenAI } from 'openai';
import { config } from '../config';
import type { AiProvider } from './modelPresets';

export const openaiClient = new OpenAI({
    apiKey: config.openAiApiKey || process.env.OPENAI_API_KEY,
});

export const deepseekClient = new OpenAI({
    apiKey: process.env.DEEPSEEK_API_KEY || 'missing-deepseek-api-key',
    baseURL: 'https://api.deepseek.com',
});

export const geminiClient = new OpenAI({
    apiKey: process.env.GEMINI_API_KEY || 'missing-gemini-api-key',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
});

export function getAiClient(provider: AiProvider): OpenAI {
    switch (provider) {
        case 'openai':
            return openaiClient;
        case 'deepseek':
            return deepseekClient;
        case 'gemini':
            return geminiClient;
    }
}
