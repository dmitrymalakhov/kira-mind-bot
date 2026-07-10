import assert from 'assert';
import fs from 'fs';
import path from 'path';
import type OpenAI from 'openai';
import type { AiModelRef } from '../ai/modelPresets';

process.env.KIRA_BOT_TOKEN = process.env.KIRA_BOT_TOKEN || 'test-token';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-openai-key';
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-gemini-key';
process.env.ZAI_API_KEY = process.env.ZAI_API_KEY || 'test-zai-key';
process.env.AI_GEMINI_REQUEST_TIMEOUT_MS = '12345';

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
    maxRetries?: number;
    timeout?: number;
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

function recordCall(call: RecordedCall): void {
    (calls as RecordedCall[]).push(call);
}

async function main() {
    const { createChatCompletionForTask, createJsonChatCompletionForTask } = await import('../ai/chatCompletion');
    const { createResponseForTask } = await import('../ai/responseCompletion');
    const { createEmbeddingForTask } = await import('../ai/embedding');
    const { createTranscriptionForTask } = await import('../ai/transcription');
    const { openaiClient, geminiClient, zaiClient } = await import('../ai/aiClients');
    const { aiPresets } = await import('../ai/modelPresets');

    const openaiMutableClient = openaiClient as unknown as MutableAiClient;
    const geminiMutableClient = geminiClient as unknown as MutableAiClient;
    const zaiMutableClient = zaiClient as unknown as MutableAiClient;

    assert.strictEqual(geminiMutableClient.maxRetries, 0, 'Gemini SDK retries must be disabled');
    assert.strictEqual(geminiMutableClient.timeout, 12345, 'Gemini SDK must use the configured request timeout');

    const originalOpenAiChatCreate = openaiMutableClient.chat.completions.create;
    const originalGeminiChatCreate = geminiMutableClient.chat.completions.create;
    const originalZaiChatCreate = zaiMutableClient.chat.completions.create;
    const hadZaiAudio = Object.prototype.hasOwnProperty.call(zaiMutableClient, 'audio');
    const originalZaiAudio = zaiMutableClient.audio;
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
    const originalConsoleError = console.error;
    const originalFetch = globalThis.fetch;
    const degradedConsoleLogs: string[] = [];
    let lastTranscriptionStream: { destroyed?: boolean } | null = null;

    try {
        console.info = (...args: unknown[]) => {
            if (String(args[0]).startsWith('[AI DEGRADED] ')) degradedConsoleLogs.push(String(args[0]));
        };
        console.warn = () => undefined;
        console.error = (...args: unknown[]) => {
            if (String(args[0]).startsWith('[AI DEGRADED] ')) degradedConsoleLogs.push(String(args[0]));
        };

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
        zaiMutableClient.audio = {
            transcriptions: {
                create: async (body: Record<string, unknown>) => {
                    lastTranscriptionStream = body.file as { destroyed?: boolean };
                    calls.push({ provider: 'zai', method: 'audio.transcriptions.create', body: { ...body, file: '[stream]' } });
                    return 'decoded by glm';
                },
            },
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
        globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
            const url = String(input);
            const parsedBody = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
            if (url === 'https://generativelanguage.googleapis.com/v1beta/interactions') {
                assert.ok(init?.signal instanceof AbortSignal, 'Gemini Interactions request must have an abort signal');
                calls.push({
                    provider: 'gemini',
                    method: 'interactions.create',
                    body: {
                        url,
                        method: init?.method,
                        body: parsedBody,
                    },
                });
                return {
                    ok: true,
                    status: 200,
                    statusText: 'OK',
                    headers: new Headers({ 'x-goog-request-id': 'gemini-interaction-1' }),
                    text: async () => '',
                    json: async () => ({
                        id: 'interaction-1',
                        output_text: 'ok',
                        usage_metadata: {
                            prompt_token_count: 4,
                            candidates_token_count: 2,
                            total_token_count: 6,
                        },
                    }),
                } as Response;
            }

            if (url === 'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:embedContent') {
                calls.push({
                    provider: 'gemini',
                    method: 'embeddings.embedContent',
                    body: {
                        url,
                        method: init?.method,
                        body: parsedBody,
                    },
                });
                return {
                    ok: true,
                    status: 200,
                    statusText: 'OK',
                    headers: new Headers({ 'x-goog-request-id': 'gemini-embedding-1' }),
                    text: async () => '',
                    json: async () => ({
                        embedding: { values: [0.9, 0.8, 0.7] },
                        usage_metadata: {
                            prompt_token_count: 3,
                            total_token_count: 3,
                        },
                    }),
                } as Response;
            }

            if (url === 'https://generativelanguage.googleapis.com/upload/v1beta/files') {
                calls.push({
                    provider: 'gemini',
                    method: 'files.upload.start',
                    body: {
                        url,
                        method: init?.method,
                        body: parsedBody,
                    },
                });
                return {
                    ok: true,
                    status: 200,
                    statusText: 'OK',
                    headers: new Headers({
                        'x-goog-request-id': 'gemini-upload-start-1',
                        'x-goog-upload-url': 'https://upload.example/gemini-file-1',
                    }),
                    text: async () => '',
                    json: async () => ({}),
                } as Response;
            }

            if (url === 'https://upload.example/gemini-file-1') {
                calls.push({
                    provider: 'gemini',
                    method: 'files.upload.finalize',
                    body: {
                        url,
                        method: init?.method,
                        body: '[binary]',
                    },
                });
                return {
                    ok: true,
                    status: 200,
                    statusText: 'OK',
                    headers: new Headers({ 'x-goog-request-id': 'gemini-upload-finalize-1' }),
                    text: async () => '',
                    json: async () => ({
                        file: {
                            name: 'files/gemini-file-1',
                            uri: 'gs://gemini-files/audio-1',
                            mimeType: 'audio/ogg',
                        },
                    }),
                } as Response;
            }

            if (url === 'https://generativelanguage.googleapis.com/v1beta/files/gemini-file-1') {
                calls.push({
                    provider: 'gemini',
                    method: 'files.delete',
                    body: {
                        url,
                        method: init?.method,
                    },
                });
                return {
                    ok: true,
                    status: 200,
                    statusText: 'OK',
                    headers: new Headers({ 'x-goog-request-id': 'gemini-delete-1' }),
                    text: async () => '',
                    json: async () => ({}),
                } as Response;
            }

            throw new Error(`Unexpected fetch URL in test: ${url}`);
        };

        calls.length = 0;
        let switchedPresetAfterGeminiFailure = false;
        geminiMutableClient.chat.completions.create = async (body: Record<string, unknown>) => {
            calls.push({ provider: 'gemini', method: 'chat.completions.create', body });
            if (!switchedPresetAfterGeminiFailure) {
                switchedPresetAfterGeminiFailure = true;
                process.env.AI_MODEL_PRESET = 'gpt-balanced';
                throw Object.assign(new Error('Gemini temporarily unavailable'), { status: 503 });
            }
            return chatResult(String(body.model));
        };
        await withPreset('gemini-full', async () => {
            await createChatCompletionForTask('conversation', {
                messages: [{ role: 'user', content: 'переключи preset без повторного Gemini' }],
            } satisfies ChatParamsWithoutModel);
        });
        assert.deepStrictEqual(
            calls.map((call) => `${call.provider}:${call.method}`),
            ['gemini:chat.completions.create', 'openai:chat.completions.create'],
            'После смены preset retry не должен повторно обращаться к Gemini',
        );

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
        await withPreset('hybrid-gemini-gpt', async () => {
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
        degradedConsoleLogs.length = 0;
        geminiMutableClient.chat.completions.create = async (body: Record<string, unknown>) => {
            calls.push({ provider: 'gemini', method: 'chat.completions.create', body });
            throw new Error('Gemini returned 400');
        };
        await withPreset('hybrid-gemini-gpt', async () => {
            await createChatCompletionForTask('conversation', {
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
                model: 'gemini-3-flash-preview',
            },
        });
        assert.deepStrictEqual(calls[1], {
            provider: 'openai',
            method: 'chat.completions.create',
            body: {
                messages: [{ role: 'user', content: 'classify' }],
                max_completion_tokens: 64,
                model: 'gpt-5.4-mini',
            },
        });
        geminiMutableClient.chat.completions.create = originalGeminiChatCreate;
        geminiMutableClient.chat.completions.create = async (body: Record<string, unknown>) => {
            calls.push({ provider: 'gemini', method: 'chat.completions.create', body });
            return chatResult(String(body.model));
        };

        calls.length = 0;
        await withPreset('hybrid-gemini-gpt', async () => {
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
        const webSearchModel = aiPresets['hybrid-gemini-gpt'].models.webSearchReasoning;
        const originalWebSearchModel: AiModelRef = { ...webSearchModel };
        aiPresets['hybrid-gemini-gpt'].models.webSearchReasoning = {
            provider: 'gemini',
            model: 'gemini-3-flash-preview',
        };
        try {
            await withPreset('hybrid-gemini-gpt', async () => {
                await createResponseForTask('webSearchReasoning', {
                    input: 'find current docs',
                    tools: [{ type: 'web_search_preview' }],
                } satisfies ResponseParamsWithoutModel);
            });
        } finally {
            aiPresets['hybrid-gemini-gpt'].models.webSearchReasoning = originalWebSearchModel;
        }
        assert.deepStrictEqual(calls, [
            {
                provider: 'gemini',
                method: 'interactions.create',
                body: {
                    url: 'https://generativelanguage.googleapis.com/v1beta/interactions',
                    method: 'POST',
                    body: {
                        model: 'gemini-3-flash-preview',
                        input: 'find current docs',
                        tools: [{ type: 'google_search' }],
                    },
                },
            },
        ]);

        calls.length = 0;
        await withPreset('gemini-full', async () => {
            await createResponseForTask('webSearchReasoning', {
                input: [
                    {
                        role: 'system',
                        content: [{ type: 'input_text', text: 'Use fresh web data.' }],
                    },
                    {
                        role: 'user',
                        content: [{ type: 'input_text', text: 'find current docs' }],
                    },
                ],
                tools: [{ type: 'web_search_preview' }],
            } satisfies ResponseParamsWithoutModel);
        });
        assert.deepStrictEqual(lastCall(), {
            provider: 'gemini',
            method: 'interactions.create',
            body: {
                url: 'https://generativelanguage.googleapis.com/v1beta/interactions',
                method: 'POST',
                body: {
                    model: 'gemini-3.5-flash',
                    input: 'find current docs',
                    system_instruction: 'Use fresh web data.',
                    tools: [{ type: 'google_search' }],
                },
            },
        });

        calls.length = 0;
        await withPreset('gemini-full', async () => {
            await createResponseForTask('webSearchReasoning', {
                input: [
                    {
                        role: 'system',
                        content: [{ type: 'input_text', text: 'Use fresh web data.' }],
                    },
                    {
                        role: 'user',
                        content: [{ type: 'input_text', text: 'find current docs' }],
                    },
                ],
                tools: [{ type: 'web_search_preview' }],
                temperature: 0.6,
                top_p: 0.8,
                max_output_tokens: 512,
            } satisfies ResponseParamsWithoutModel);
        });
        assert.deepStrictEqual(lastCall(), {
            provider: 'gemini',
            method: 'interactions.create',
            body: {
                url: 'https://generativelanguage.googleapis.com/v1beta/interactions',
                method: 'POST',
                body: {
                    model: 'gemini-3.5-flash',
                    input: 'find current docs',
                    system_instruction: 'Use fresh web data.',
                    tools: [{ type: 'google_search' }],
                    generation_config: {
                        temperature: 0.6,
                        top_p: 0.8,
                        max_output_tokens: 512,
                    },
                },
            },
        });

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
        await withPreset('glm-full', async () => {
            await createResponseForTask('webSearchReasoning', {
                input: [
                    {
                        role: 'system',
                        content: [{ type: 'input_text', text: 'Use fresh web data.' }],
                    },
                    {
                        role: 'user',
                        content: [{ type: 'input_text', text: 'find current docs' }],
                    },
                ],
                tools: [{ type: 'web_search_preview' }],
                temperature: 0.3,
                max_output_tokens: 256,
            } satisfies ResponseParamsWithoutModel);
        });
        assert.deepStrictEqual(lastCall(), {
            provider: 'zai',
            method: 'chat.completions.create',
            body: {
                model: 'glm-5.2',
                messages: [
                    { role: 'user', content: 'find current docs' },
                ],
                tools: [{
                    type: 'web_search',
                    web_search: {
                        enable: 'True',
                        search_engine: 'search-prime',
                        search_result: 'True',
                        content_size: 'high',
                        count: '8',
                        search_prompt: 'Use fresh web data.\n\nUse {{search_result}} from web search as the grounding source.\n\nSummarize the results, keep links/citations when possible, and do not invent unsupported facts.',
                    },
                }],
                temperature: 0.3,
                top_p: undefined,
                max_tokens: 256,
            },
        });

        calls.length = 0;
        const originalGlmWebSearchModel = { ...aiPresets['glm-balanced'].models.webSearchReasoning };
        aiPresets['glm-balanced'].models.webSearchReasoning = {
            provider: 'zai',
            model: 'glm-5.2',
        };
        try {
            await withPreset('glm-balanced', async () => {
                await createResponseForTask('webSearchReasoning', {
                    input: [
                        {
                            role: 'system',
                            content: [{ type: 'input_text', text: 'No search tool here.' }],
                        },
                        {
                            role: 'user',
                            content: [{ type: 'input_text', text: 'plain response only' }],
                        },
                    ],
                    temperature: 0.1,
                    max_output_tokens: 64,
                } satisfies ResponseParamsWithoutModel);
            });
        } finally {
            aiPresets['glm-balanced'].models.webSearchReasoning = originalGlmWebSearchModel;
        }
        assert.deepStrictEqual(lastCall(), {
            provider: 'zai',
            method: 'chat.completions.create',
            body: {
                model: 'glm-5.2',
                messages: [
                    { role: 'user', content: 'plain response only' },
                ],
                tools: undefined,
                temperature: 0.1,
                top_p: undefined,
                max_tokens: 64,
            },
        });

        calls.length = 0;
        await withPreset('gemini-full', async () => {
            await createEmbeddingForTask('vectorize me with gemini');
        });
        assert.deepStrictEqual(lastCall(), {
            provider: 'openai',
            method: 'embeddings.create',
            body: {
                model: 'text-embedding-3-small',
                input: 'vectorize me with gemini',
                dimensions: 1536,
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
                dimensions: 1536,
            },
        });

        const tempAudioPath = path.join(process.cwd(), '.tmp-test-zai-transcription.ogg');
        fs.writeFileSync(tempAudioPath, 'test');
        calls.length = 0;
        await withPreset('gemini-full', async () => {
            await createTranscriptionForTask(tempAudioPath);
        });
        assert.deepStrictEqual(calls, [
            {
                provider: 'gemini',
                method: 'files.upload.start',
                body: {
                    url: 'https://generativelanguage.googleapis.com/upload/v1beta/files',
                    method: 'POST',
                    body: {
                        file: {
                            display_name: '.tmp-test-zai-transcription.ogg',
                        },
                    },
                },
            },
            {
                provider: 'gemini',
                method: 'files.upload.finalize',
                body: {
                    url: 'https://upload.example/gemini-file-1',
                    method: 'POST',
                    body: '[binary]',
                },
            },
            {
                provider: 'gemini',
                method: 'interactions.create',
                body: {
                    url: 'https://generativelanguage.googleapis.com/v1beta/interactions',
                    method: 'POST',
                    body: {
                        model: 'gemini-3.5-flash',
                        input: [
                            {
                                type: 'text',
                                text: 'Transcribe this audio file in ru. Return only the transcript text without commentary.',
                            },
                            {
                                type: 'audio',
                                uri: 'gs://gemini-files/audio-1',
                                mime_type: 'audio/ogg',
                            },
                        ],
                    },
                },
            },
            {
                provider: 'gemini',
                method: 'files.delete',
                body: {
                    url: 'https://generativelanguage.googleapis.com/v1beta/files/gemini-file-1',
                    method: 'DELETE',
                },
            },
        ]);

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

        calls.length = 0;
        await withPreset('glm-full', async () => {
            await createTranscriptionForTask(tempAudioPath);
        });
        assert.deepStrictEqual(lastCall(), {
            provider: 'zai',
            method: 'audio.transcriptions.create',
            body: {
                file: '[stream]',
                model: 'glm-asr-2512',
                language: 'ru',
                response_format: 'text',
            },
        });

        calls.length = 0;
        geminiMutableClient.chat.completions.create = async (body: Record<string, unknown>) => {
            const recordedCall: RecordedCall = {
                provider: 'gemini',
                method: 'chat.completions.create',
                body: body as Record<string, unknown>,
            };
            recordCall(recordedCall);
            if (body.model === 'gemini-3.1-flash-lite') {
                return chatResult(String(body.model));
            }
            const error = new Error('Gemini temporary failure') as Error & { status?: number };
            error.status = 503;
            throw error;
        };
        await withPreset('gemini-full', async () => {
            await createChatCompletionForTask('conversation', {
                messages: [{ role: 'user', content: 'hello' }],
            } satisfies ChatParamsWithoutModel);
        });
        assert.deepStrictEqual(
            calls.map((call) => `${call.provider}:${call.method}`),
            [
                'gemini:chat.completions.create',
                'gemini:chat.completions.create',
                'gemini:chat.completions.create',
            ],
        );
        assert.strictEqual((calls[2] as RecordedCall).body.model, 'gemini-3.1-flash-lite');
        assert.ok(degradedConsoleLogs[0]?.startsWith('[AI DEGRADED] '));
        assert.ok(degradedConsoleLogs[0]?.includes('"event":"start"'));
        assert.ok(degradedConsoleLogs[0]?.includes('"from":"gemini:gemini-3.5-flash"'));
        assert.ok(degradedConsoleLogs[0]?.includes('"to":"gemini:gemini-3.1-flash-lite"'));
        assert.ok(degradedConsoleLogs[1]?.startsWith('[AI DEGRADED] '));
        assert.ok(degradedConsoleLogs[1]?.includes('"event":"success"'));
        assert.ok(degradedConsoleLogs[1]?.includes('"activeModel":"gemini:gemini-3.1-flash-lite"'));

        calls.length = 0;
        await withPreset('gemini-full', async () => {
            await createChatCompletionForTask('browserPlanning', {
                messages: [{ role: 'user', content: 'plan resiliently' }],
            } satisfies ChatParamsWithoutModel);
        });
        assert.deepStrictEqual(
            calls.map((call) => `${call.provider}:${call.method}`),
            [
                'gemini:chat.completions.create',
                'gemini:chat.completions.create',
                'gemini:chat.completions.create',
            ],
        );
        assert.strictEqual((calls[2] as RecordedCall).body.model, 'gemini-3.1-flash-lite');
        geminiMutableClient.chat.completions.create = async (body: Record<string, unknown>) => {
            const recordedCall: RecordedCall = {
                provider: 'gemini',
                method: 'chat.completions.create',
                body: body as Record<string, unknown>,
            };
            recordCall(recordedCall);
            return chatResult(String(body.model));
        };

        calls.length = 0;
        degradedConsoleLogs.length = 0;
        globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
            const url = String(input);
            const parsedBody = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
            if (url === 'https://generativelanguage.googleapis.com/v1beta/interactions') {
                recordCall({
                    provider: 'gemini',
                    method: 'interactions.create',
                    body: {
                        url,
                        method: init?.method ?? 'POST',
                        body: parsedBody,
                    },
                });
                if (parsedBody?.model === 'gemini-3.1-flash-lite') {
                    return {
                        ok: true,
                        status: 200,
                        statusText: 'OK',
                        headers: new Headers({ 'x-goog-request-id': 'gemini-interaction-lite' }),
                        json: async () => ({
                            id: 'interaction-lite',
                            output_text: 'degraded search result',
                        }),
                    } as Response;
                }
                return {
                    ok: false,
                    status: 503,
                    statusText: 'Service Unavailable',
                    headers: new Headers({ 'x-goog-request-id': 'gemini-interaction-fail' }),
                    text: async () => 'temporarily unavailable',
                } as Response;
            }

            throw new Error(`Unexpected fetch URL in test: ${url}`);
        };
        await withPreset('gemini-full', async () => {
            await createResponseForTask('webSearchReasoning', {
                input: 'find current docs',
                tools: [{ type: 'web_search_preview' }],
            } satisfies ResponseParamsWithoutModel);
        });
        assert.deepStrictEqual(
            calls.map((call) => `${call.provider}:${call.method}`),
            [
                'gemini:interactions.create',
                'gemini:interactions.create',
                'gemini:interactions.create',
            ],
        );
        assert.strictEqual((calls[2]?.body.body as Record<string, unknown>)?.model, 'gemini-3.1-flash-lite');
        assert.ok(degradedConsoleLogs[0]?.startsWith('[AI DEGRADED] '));
        assert.ok(degradedConsoleLogs[0]?.includes('"event":"start"'));
        assert.ok(degradedConsoleLogs[1]?.startsWith('[AI DEGRADED] '));
        assert.ok(degradedConsoleLogs[1]?.includes('"event":"success"'));
        assert.ok(degradedConsoleLogs[1]?.includes('"activeModel":"gemini:gemini-3.1-flash-lite"'));

        calls.length = 0;
        geminiMutableClient.chat.completions.create = async (body: Record<string, unknown>) => {
            recordCall({
                provider: 'gemini',
                method: 'chat.completions.create',
                body: body as Record<string, unknown>,
            });
            return chatResult(String(body.model), '{invalid json');
        };
        await withPreset('gemini-full', async () => {
            const result = await createJsonChatCompletionForTask<{ ok: boolean }>('conversation', {
                messages: [{ role: 'user', content: 'json please' }],
            } satisfies ChatParamsWithoutModel);
            assert.strictEqual(result, null);
        });
        assert.deepStrictEqual(
            calls.map((call) => `${call.provider}:${call.method}`),
            ['gemini:chat.completions.create'],
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
        if (hadZaiAudio) {
            zaiMutableClient.audio = originalZaiAudio;
        } else {
            delete zaiMutableClient.audio;
        }
        globalThis.fetch = originalFetch;
        console.info = originalConsoleInfo;
        console.warn = originalConsoleWarn;
        console.error = originalConsoleError;
    }
}

main()
    .then(() => console.log('AI runtime routing tests passed'))
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
