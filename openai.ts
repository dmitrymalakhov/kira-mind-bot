import { OpenAI } from "openai";
import { config, resolveOpenAIModelsFromAiPreset, type OpenAIModelsConfig } from "./config";

export const openAiModels = new Proxy({} as OpenAIModelsConfig, {
    get(_target, prop, receiver) {
        return Reflect.get(resolveOpenAIModelsFromAiPreset(), prop, receiver);
    },
    ownKeys() {
        return Reflect.ownKeys(resolveOpenAIModelsFromAiPreset());
    },
    getOwnPropertyDescriptor(_target, prop) {
        return Object.getOwnPropertyDescriptor(resolveOpenAIModelsFromAiPreset(), prop);
    },
});

// Centralized OpenAI client to reuse a single instance across the project
export const openai = new OpenAI({
    apiKey: config.openAiApiKey || process.env.OPENAI_API_KEY,
});

export default openai;
