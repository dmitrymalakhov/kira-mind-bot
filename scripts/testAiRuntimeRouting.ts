import assert from 'assert';
import fs from 'fs';
import path from 'path';
import type OpenAI from 'openai';
import type { AiModelRef } from '../ai/modelPresets';

process.env.KIRA_BOT_TOKEN = process.env.KIRA_BOT_TOKEN || 'test-token';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-openai-key';
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-gemini-key';
process.env.ZAI_API_KEY = process.env.ZAI_API_KEY || 'test-zai-key';

interface RecordedCall {
    provider: string;
    method: string;
    body: Record<string, unknown>;
}

type ChatParamsWithoutModel = Omit<OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming, 'model'> & {
    max_completion_tokens?: number;
};
type ResponseParamsWithoutModel = Omit<OpenAI.Responses.ResponseCreateParamsNonStreaming, 'model'>;

interface MutableAiClient {
    chat: {
        completions: {
            create: (body: Record<string, unknown>) => Promise<unknown>;
        };
    };
    responses?: {
        create: (body: Record<string, unknown>) => Promise<unknown>;
    };
    embeddings?: {
        create: (body: Record<string, unknown>) => Promise<unknown>;
    };
    audio?: {
        transcriptions: {
            create: (body: Record<string, unknown>) => Promise<unknown>;
        };
    };
}

const calls: RecordedCall[] = [];
const chatResult = (model: string, content = 'ok') => ({
    id: `chatcmpl-test-${model}`,
    object: 'chat.completion',
    created: 0,
    model,
    choices: [
        {
            index: 0,
            finish_reason: 'stop',
            message: {
                role: 'assistant',
                content,
            },
        },
    ],
    usage: {
        prompt_tokens: 1,
        completion_tokens: 1,
        total_tokens: 2,
    },
});

const responseResult = (model: string) => ({
    id: `resp-test-${model}`,
    output_text: 'ok',
    usage: {
        input_tokens: 1,
        output_tokens: 1,
        total_tokens: 2,
    },
});

async function withPreset<T>(preset: string, fn: () => Promise<T>): Promise<T> {
    const previous = process.env.AI_MODEL_PRESET;
    process.env.AI_MODEL_PRESET = preset;
    try {
        return await fn();
    } finally {
        if (previous === undefined) {
            delete process.env.AI_MODEL_PRESET;
        } else {
            process.env.AI_MODEL_PRESET = previous;
        }
    }
}

function lastCall(): RecordedCall {
    const call = calls.at(-1);
    assert.ok(call, 'Expected at least one recorded AI client call');
    return call;
}

async function main() {
    const { createChatCompletionForTask } = await import('../ai/chatCompletion');
    const { createResponseForTask } = await import('../ai/responseCompletion');
    const { createEmbeddingForTask } = await import('../ai/embedding');
    const { createTranscriptionForTask } = await import('../ai/transcription');
    const { openaiClient, geminiClient, zaiClient } = await import('../ai/aiClients');
    const { aiPresets } = await import('../ai/modelPresets');

    const openaiMutableClient = openaiClient as unknown as MutableAiClient;
    const geminiMutableClient = geminiClient as unknown as MutableAiClient;
    const zaiMutableClient = zaiClient as unknown as MutableAiClient;

    const originalOpenAiChatCreate = openaiMutableClient.chat.completions.create;
    const originalGeminiChatCreate = geminiMutableClient.chat.completions.create;
    const originalZaiChatCreate = zaiMutableClient.chat.completions.create;
    const hadOpenAiResponses = Object.prototype.hasOwnProperty.call(openaiMutableClient, 'responses');
    const originalOpenAiResponses = openaiMutableClient.responses;
    const hadGeminiResponses = Object.prototype.hasOwnProperty.call(geminiMutableClient, 'responses');
    const originalGeminiResponses = geminiMutableClient.responses;
    const hadOpenAiEmbeddings = Object.prototype.hasOwnProperty.call(openaiMutableClient, 'embeddings');
    const originalOpenAiEmbeddings = openaiMutableClient.embeddings;
    const hadOpenAiAudio = Object.prototype.hasOwnProperty.call(openaiMutableClient, 'audio');
    const originalOpenAiAudio = openaiMutableClient.audio;
    const originalConsoleInfo = console.info;
    const originalConsoleWarn = console.warn;
    let lastTranscriptionStream: { destroyed?: boolean } | null = null;

    try {
        console.info = () => undefined;
        console.warn = () => undefined;

        openaiMutableClient.chat.completions.create = async (body: Record<string, unknown>) => {
            calls.push({ provider: 'openai', method: 'chat.completions.create', body });
            return chatResult(String(body.model));
        };
        geminiMutableClient.chat.completions.create = async (body: Record<string, unknown>) => {
            calls.push({ provider: 'gemini', method: 'chat.completions.create', body });
            return chatResult(String(body.model));
        };
        zaiMutableClient.chat.completions.create = async (body: Record<string, unknown>) => {
            calls.push({ provider: 'zai', method: 'chat.completions.create', body });
            return chatResult(String(body.model));
        };
        openaiMutableClient.responses = {
            create: async (body: Record<string, unknown>) => {
                calls.push({ provider: 'openai', method: 'responses.create', body });
                return responseResult(String(body.model));
            },
        };
        geminiMutableClient.responses = {
            create: async (body: Record<string, unknown>) => {
                calls.push({ provider: 'gemini', method: 'responses.create', body });
                throw new Error('Gemini Responses API must not be called');
            },
        };
        openaiMutableClient.embeddings = {
            create: async (body: Record<string, unknown>) => {
                calls.push({ provider: 'openai', method: 'embeddings.create', body });
                return {
                    data: [{ embedding: [0.1, 0.2, 0.3] }],
                    usage: { prompt_tokens: 3, total_tokens: 3 },
                };
            },
        };
        openaiMutableClient.audio = {
            transcriptions: {
                create: async (body: Record<string, unknown>) => {
                    lastTranscriptionStream = body.file as { destroyed?: boolean };
                    calls.push({ provider: 'openai', method: 'audio.transcriptions.create', body: { ...body, file: '[stream]' } });
                    return 'decoded text';
                },
            },
        };

        calls.length = 0;
        await withPreset('gpt-balanced', async () => {
            await createChatCompletionForTask('conversation', {
                messages: [{ role: 'user', content: 'hello' }],
                max_tokens: 128,
                temperature: 1,
            } satisfies ChatParamsWithoutModel);
        });
        assert.deepStrictEqual(lastCall(), {
            provider: 'openai',
            method: 'chat.completions.create',
            body: {
                messages: [{ role: 'user', content: 'hello' }],
                max_completion_tokens: 128,
                temperature: 1,
                model: 'gpt-5.4-mini',
            },
        });

        calls.length = 0;
        await withPreset('gemini-direct-balanced', async () => {
            await createChatCompletionForTask('conversation', {
                messages: [{ role: 'user', content: 'hello' }],
                max_completion_tokens: 321,
                temperature: 0.4,
                store: true,
                metadata: { trace: 'drop-me' },
                user: 'drop-me-too',
            } satisfies ChatParamsWithoutModel);
        });
        assert.deepStrictEqual(lastCall(), {
            provider: 'gemini',
            method: 'chat.completions.create',
            body: {
                messages: [{ role: 'user', content: 'hello' }],
                temperature: 0.4,
                max_tokens: 321,
                model: 'gemini-3-flash-preview',
            },
        });

        calls.length = 0;
        geminiMutableClient.chat.completions.create = async (body: Record<string, unknown>) => {
            calls.push({ provider: 'gemini', method: 'chat.completions.create', body });
            throw new Error('Gemini returned 400');
        };
        await withPreset('gemini-direct-balanced', async () => {
            await createChatCompletionForTask('intentClassification', {
                messages: [{ role: 'user', content: 'classify' }],
                max_tokens: 64,
            } satisfies ChatParamsWithoutModel);
        });
        assert.strictEqual(calls.length, 2);
        assert.deepStrictEqual(calls[0], {
            provider: 'gemini',
            method: 'chat.completions.create',
            body: {
                messages: [{ role: 'user', content: 'classify' }],
                max_tokens: 64,
                model: 'gemini-3.1-flash-lite',
            },
        });
        assert.deepStrictEqual(calls[1], {
            provider: 'openai',
            method: 'chat.completions.create',
            body: {
                messages: [{ role: 'user', content: 'classify' }],
                max_completion_tokens: 64,
                model: 'gpt-5.4-nano',
            },
        });
        geminiMutableClient.chat.completions.create = originalGeminiChatCreate;
        geminiMutableClient.chat.completions.create = async (body: Record<string, unknown>) => {
            calls.push({ provider: 'gemini', method: 'chat.completions.create', body });
            return chatResult(String(body.model));
        };

        calls.length = 0;
        await withPreset('gemini-direct-balanced', async () => {
            await createResponseForTask('webSearchReasoning', {
                input: 'find current docs',
                tools: [{ type: 'web_search_preview' }],
            } satisfies ResponseParamsWithoutModel);
        });
        assert.deepStrictEqual(lastCall(), {
            provider: 'openai',
            method: 'responses.create',
            body: {
                input: 'find current docs',
                tools: [{ type: 'web_search_preview' }],
                model: 'gpt-5.4-mini',
            },
        });

        calls.length = 0;
        const webSearchModel = aiPresets['gemini-direct-balanced'].models.webSearchReasoning;
        const originalWebSearchModel: AiModelRef = { ...webSearchModel };
        aiPresets['gemini-direct-balanced'].models.webSearchReasoning = {
            provider: 'gemini',
            model: 'gemini-3-flash-preview',
        };
        try {
            await withPreset('gemini-direct-balanced', async () => {
                await createResponseForTask('webSearchReasoning', {
                    input: 'find current docs',
                    tools: [{ type: 'web_search_preview' }],
                } satisfies ResponseParamsWithoutModel);
            });
        } finally {
            aiPresets['gemini-direct-balanced'].models.webSearchReasoning = originalWebSearchModel;
        }
        assert.deepStrictEqual(calls, [
            {
                provider: 'openai',
                method: 'responses.create',
                body: {
                    input: 'find current docs',
                    tools: [{ type: 'web_search_preview' }],
                    model: 'gpt-5.4-mini',
                },
            },
        ]);

        calls.length = 0;
        await withPreset('glm-balanced', async () => {
            await createChatCompletionForTask('conversation', {
                messages: [{ role: 'user', content: 'plan this task' }],
                max_tokens: 512,
                temperature: 0.2,
                extra_body: {
                    thinking: { type: 'enabled' },
                    reasoning_effort: 'max',
                },
            } as ChatParamsWithoutModel);
        });
        assert.deepStrictEqual(lastCall(), {
            provider: 'zai',
            method: 'chat.completions.create',
            body: {
                messages: [{ role: 'user', content: 'plan this task' }],
                max_tokens: 512,
                temperature: 0.2,
                extra_body: {
                    thinking: { type: 'enabled' },
                    reasoning_effort: 'max',
                },
                model: 'glm-5.2',
            },
        });

        calls.length = 0;
        await withPreset('glm-balanced', async () => {
            await createEmbeddingForTask('vectorize me');
        });
        assert.deepStrictEqual(lastCall(), {
            provider: 'openai',
            method: 'embeddings.create',
            body: {
                model: 'text-embedding-3-small',
                input: 'vectorize me',
            },
        });

        const tempAudioPath = path.join(process.cwd(), '.tmp-test-zai-transcription.ogg');
        fs.writeFileSync(tempAudioPath, 'test');
        calls.length = 0;
        await withPreset('glm-balanced', async () => {
            await createTranscriptionForTask(tempAudioPath);
        });
        assert.deepStrictEqual(lastCall(), {
            provider: 'openai',
            method: 'audio.transcriptions.create',
            body: {
                file: '[stream]',
                model: 'whisper-1',
                language: 'ru',
                response_format: 'text',
            },
        });
        assert.ok(lastTranscriptionStream, 'Expected transcription request to pass a file stream');
        assert.strictEqual(
            (lastTranscriptionStream as { destroyed?: boolean }).destroyed,
            true,
            'Transcription stream must be closed after request completion',
        );
        await new Promise((resolve) => setTimeout(resolve, 25));
        fs.unlinkSync(tempAudioPath);
    } finally {
        openaiMutableClient.chat.completions.create = originalOpenAiChatCreate;
        geminiMutableClient.chat.completions.create = originalGeminiChatCreate;
        zaiMutableClient.chat.completions.create = originalZaiChatCreate;
        if (hadOpenAiResponses) {
            openaiMutableClient.responses = originalOpenAiResponses;
        } else {
            delete openaiMutableClient.responses;
        }
        if (hadGeminiResponses) {
            geminiMutableClient.responses = originalGeminiResponses;
        } else {
            delete geminiMutableClient.responses;
        }
        if (hadOpenAiEmbeddings) {
            openaiMutableClient.embeddings = originalOpenAiEmbeddings;
        } else {
            delete openaiMutableClient.embeddings;
        }
        if (hadOpenAiAudio) {
            openaiMutableClient.audio = originalOpenAiAudio;
        } else {
            delete openaiMutableClient.audio;
        }
        console.info = originalConsoleInfo;
        console.warn = originalConsoleWarn;
    }
}

main()
    .then(() => console.log('AI runtime routing tests passed'))
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
