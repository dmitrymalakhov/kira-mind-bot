export interface AiModelCatalogEntry {
    provider: string;
    model: string;
    modalities: Array<'text' | 'vision' | 'embedding' | 'audio'>;
    maxContextTokens?: number;
    maxOutputTokens?: number;
    supportsReasoning?: boolean;
    supportsCaching?: boolean;
    preferredApi?: 'chat.completions' | 'responses' | 'embeddings' | 'audio.transcriptions';
}

export const AI_MODEL_CATALOG: Readonly<Record<string, AiModelCatalogEntry>> = {
    'openai:gpt-5.4': {
        provider: 'openai',
        model: 'gpt-5.4',
        modalities: ['text'],
        supportsCaching: true,
        preferredApi: 'responses',
    },
    'openai:gpt-5.4-mini': {
        provider: 'openai',
        model: 'gpt-5.4-mini',
        modalities: ['text'],
        supportsCaching: true,
        preferredApi: 'responses',
    },
    'openai:gpt-5.4-nano': {
        provider: 'openai',
        model: 'gpt-5.4-nano',
        modalities: ['text'],
        supportsCaching: true,
        preferredApi: 'responses',
    },
    'openai:gpt-4o': {
        provider: 'openai',
        model: 'gpt-4o',
        modalities: ['text', 'vision'],
        preferredApi: 'chat.completions',
    },
    'openai:text-embedding-3-small': {
        provider: 'openai',
        model: 'text-embedding-3-small',
        modalities: ['embedding'],
        preferredApi: 'embeddings',
    },
    'openai:text-embedding-ada-002': {
        provider: 'openai',
        model: 'text-embedding-ada-002',
        modalities: ['embedding'],
        preferredApi: 'embeddings',
    },
    'openai:whisper-1': {
        provider: 'openai',
        model: 'whisper-1',
        modalities: ['audio'],
        preferredApi: 'audio.transcriptions',
    },
    'gemini:gemini-3.6-flash': {
        provider: 'gemini',
        model: 'gemini-3.6-flash',
        modalities: ['text', 'vision', 'audio'],
        preferredApi: 'chat.completions',
    },
    'gemini:gemini-3.5-flash': {
        provider: 'gemini',
        model: 'gemini-3.5-flash',
        modalities: ['text', 'vision', 'audio'],
        preferredApi: 'chat.completions',
    },
    'gemini:gemini-3.5-flash-lite': {
        provider: 'gemini',
        model: 'gemini-3.5-flash-lite',
        modalities: ['text', 'vision'],
        preferredApi: 'chat.completions',
    },
    'gemini:gemini-3.1-flash-lite': {
        provider: 'gemini',
        model: 'gemini-3.1-flash-lite',
        modalities: ['text', 'vision'],
        preferredApi: 'chat.completions',
    },
    'gemini:gemini-2.5-flash-lite': {
        provider: 'gemini',
        model: 'gemini-2.5-flash-lite',
        modalities: ['text', 'vision'],
        preferredApi: 'chat.completions',
    },
    'gemini:gemini-embedding-2': {
        provider: 'gemini',
        model: 'gemini-embedding-2',
        modalities: ['embedding'],
        preferredApi: 'embeddings',
    },
    'openrouter:openrouter/auto': {
        provider: 'openrouter',
        model: 'openrouter/auto',
        modalities: ['text'],
        preferredApi: 'chat.completions',
    },
    'zai:glm-5.2': {
        provider: 'zai',
        model: 'glm-5.2',
        modalities: ['text'],
        maxContextTokens: 1000000,
        maxOutputTokens: 128000,
        supportsReasoning: true,
        supportsCaching: true,
        preferredApi: 'chat.completions',
    },
};

export function getModelCatalogEntry(provider: string, model: string): AiModelCatalogEntry | null {
    return AI_MODEL_CATALOG[`${provider}:${model}`] ?? null;
}
