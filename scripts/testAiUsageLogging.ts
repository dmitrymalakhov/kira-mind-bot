import assert from 'assert';
import fs from 'fs';
import path from 'path';

process.env.KIRA_BOT_TOKEN = process.env.KIRA_BOT_TOKEN || 'test-token';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-openai-key';
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-gemini-key';
process.env.ZAI_API_KEY = process.env.ZAI_API_KEY || 'test-zai-key';
// Детерминированная retry-политика для кейсов gemini-full: primary + 1 retry.
process.env.AI_GEMINI_RETRY_MAX_ATTEMPTS = '1';
process.env.AI_GEMINI_RETRY_BASE_DELAY_MS = '1';
process.env.AI_GEMINI_RETRY_MAX_DELAY_MS = '1';

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

async function main() {
  const { createChatCompletionForTask, createJsonChatCompletionForTask } = await import('../ai/chatCompletion');
  const { createResponseForTask } = await import('../ai/responseCompletion');
  const { createEmbeddingForTask } = await import('../ai/embedding');
  const { createTranscriptionForTask } = await import('../ai/transcription');
  const { openaiClient, geminiClient, zaiClient } = await import('../ai/aiClients');
  const { getAiProviderAdapter } = await import('../ai/providers/registry');
  const aiUsageLogService = await import('../services/aiUsageLogService');

  const loggedPayloads: Array<Record<string, unknown>> = [];
  const originalLogAiUsage = aiUsageLogService.logAiUsage;
  const originalConsoleInfo = console.info;
  const originalConsoleWarn = console.warn;
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  const originalGeminiRetryBaseDelay = process.env.AI_GEMINI_RETRY_BASE_DELAY_MS;
  const originalGeminiRetryMaxDelay = process.env.AI_GEMINI_RETRY_MAX_DELAY_MS;

  const openaiMutableClient = openaiClient as unknown as {
    chat: { completions: { create: (body: Record<string, unknown>) => Promise<unknown> } };
    responses?: { create: (body: Record<string, unknown>) => Promise<unknown> };
    embeddings?: { create: (body: Record<string, unknown>) => Promise<unknown> };
    audio?: { transcriptions: { create: (body: Record<string, unknown>) => Promise<unknown> } };
  };
  const geminiMutableClient = geminiClient as unknown as {
    chat: { completions: { create: (body: Record<string, unknown>) => Promise<unknown> } };
  };
  const zaiMutableClient = zaiClient as unknown as {
    chat: { completions: { create: (body: Record<string, unknown>) => Promise<unknown> } };
    audio?: { transcriptions: { create: (body: Record<string, unknown>) => Promise<unknown> } };
  };

  const originalOpenAiChatCreate = openaiMutableClient.chat.completions.create;
  const originalGeminiChatCreate = geminiMutableClient.chat.completions.create;
  const originalZaiChatCreate = zaiMutableClient.chat.completions.create;
  const hadResponses = Object.prototype.hasOwnProperty.call(openaiMutableClient, 'responses');
  const originalResponses = openaiMutableClient.responses;
  const hadEmbeddings = Object.prototype.hasOwnProperty.call(openaiMutableClient, 'embeddings');
  const originalEmbeddings = openaiMutableClient.embeddings;
  const hadAudio = Object.prototype.hasOwnProperty.call(openaiMutableClient, 'audio');
  const originalAudio = openaiMutableClient.audio;
  const hadZaiAudio = Object.prototype.hasOwnProperty.call(zaiMutableClient, 'audio');
  const originalZaiAudio = zaiMutableClient.audio;
  const geminiAdapter = getAiProviderAdapter('gemini');
  const originalGeminiTranscription = geminiAdapter.createTranscription;

  try {
    aiUsageLogService.logAiUsage = async (payload) => {
      loggedPayloads.push(payload as unknown as Record<string, unknown>);
    };
    console.info = () => undefined;
    console.warn = () => undefined;
    process.env.AI_GEMINI_RETRY_BASE_DELAY_MS = '1';
    process.env.AI_GEMINI_RETRY_MAX_DELAY_MS = '2';

    openaiMutableClient.chat.completions.create = async (body: Record<string, unknown>) => ({
      id: `chat-${body.model}`,
      object: 'chat.completion',
      created: 0,
      model: body.model,
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    });
    geminiMutableClient.chat.completions.create = async () => {
      throw new Error('Gemini failed');
    };
    zaiMutableClient.chat.completions.create = async (body: Record<string, unknown>) => ({
      id: `chat-${body.model}`,
      object: 'chat.completion',
      created: 0,
      model: body.model,
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    });
    openaiMutableClient.responses = {
      create: async (body: Record<string, unknown>) => ({
        id: `resp-${body.model}`,
        output_text: 'ok',
        usage: { input_tokens: 4, output_tokens: 1, total_tokens: 5 },
      }),
    };
    openaiMutableClient.embeddings = {
      create: async () => ({
        data: [{ embedding: [0.1, 0.2] }],
        usage: { prompt_tokens: 6, total_tokens: 6 },
      }),
    };
    openaiMutableClient.audio = {
      transcriptions: {
        create: async () => 'decoded text',
      },
    };
    zaiMutableClient.audio = {
      transcriptions: {
        create: async () => 'decoded by glm',
      },
    };
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:embedContent') {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          headers: new Headers({ 'x-goog-request-id': 'gemini-embed-1' }),
          text: async () => '',
          json: async () => ({
            embedding: { values: [0.5, 0.4] },
            usage_metadata: {
              prompt_token_count: 7,
              total_token_count: 7,
            },
          }),
        } as Response;
      }

      if (url === 'https://generativelanguage.googleapis.com/upload/v1beta/files') {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          headers: new Headers({
            'x-goog-request-id': 'gemini-upload-1',
            'x-goog-upload-url': 'https://upload.example/gemini-file-usage',
          }),
          text: async () => '',
          json: async () => ({}),
        } as Response;
      }

      if (url === 'https://upload.example/gemini-file-usage') {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          headers: new Headers({ 'x-goog-request-id': 'gemini-upload-finalize-usage' }),
          text: async () => '',
          json: async () => ({
            file: {
              name: 'files/gemini-file-usage',
              uri: 'gs://gemini-files/usage-audio',
              mimeType: 'audio/ogg',
            },
          }),
        } as Response;
      }

      if (url === 'https://generativelanguage.googleapis.com/v1beta/files/gemini-file-usage') {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          headers: new Headers({ 'x-goog-request-id': 'gemini-delete-usage' }),
          text: async () => '',
          json: async () => ({}),
        } as Response;
      }

      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'x-goog-request-id': 'gemini-web-1' }),
        text: async () => '',
        json: async () => ({
          id: 'interaction-1',
          output_text: 'ok',
          usage: {
            total_input_tokens: 4,
            total_output_tokens: 2,
            total_tokens: 6,
          },
        }),
      } as Response;
    };

    loggedPayloads.length = 0;
    await withPreset('gpt-balanced', async () => {
      await createChatCompletionForTask('conversation', {
        messages: [{ role: 'user', content: 'hello' }],
      });
    });
    assert.strictEqual(loggedPayloads.at(-1)?.operation, 'chat');
    assert.strictEqual(loggedPayloads.at(-1)?.inputTokens, 3);
    assert.strictEqual(loggedPayloads.at(-1)?.outputTokens, 2);
    assert.strictEqual(loggedPayloads.at(-1)?.totalTokens, 5);
    assert.strictEqual(loggedPayloads.at(-1)?.success, true);

    loggedPayloads.length = 0;
    await withPreset('gpt-balanced', async () => {
      await createResponseForTask('webSearchReasoning', {
        input: 'find docs',
      });
    });
    assert.strictEqual(loggedPayloads.at(-1)?.operation, 'response');
    assert.strictEqual(loggedPayloads.at(-1)?.inputTokens, 4);
    assert.strictEqual(loggedPayloads.at(-1)?.outputTokens, 1);

    loggedPayloads.length = 0;
    await withPreset('gemini-full', async () => {
      await createResponseForTask('webSearchReasoning', {
        input: 'find docs with gemini',
        tools: [{ type: 'web_search_preview' }],
      });
    });
    assert.strictEqual(loggedPayloads.length, 1);
    assert.deepStrictEqual(
      loggedPayloads.map((item) => ({
        operation: item.operation,
        success: item.success,
        stage: item.stage,
        inputTokens: item.inputTokens,
        outputTokens: item.outputTokens,
      })),
      [
        { operation: 'response', success: true, stage: 'primary', inputTokens: 4, outputTokens: 2 },
      ],
    );

    let degradedJsonCalls = 0;
    geminiMutableClient.chat.completions.create = async (body: Record<string, unknown>) => {
      degradedJsonCalls += 1;
      if (body.model === 'gemini-3.6-flash') {
        throw Object.assign(new Error('Gemini heavy 503'), {
          status: 503,
          response: { headers: new Headers({ 'x-goog-request-id': `gem-json-${degradedJsonCalls}` }) },
        });
      }
      return {
        id: 'chat-gemini-json-invalid-degraded',
        object: 'chat.completion',
        created: 0,
        model: body.model,
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '{invalid json' } }],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      };
    };
    loggedPayloads.length = 0;
    await withPreset('gemini-full', async () => {
      const result = await createJsonChatCompletionForTask<{ ok: boolean }>('conversation', {
        messages: [{ role: 'user', content: 'invalid json after degradation' }],
      });
      assert.strictEqual(result, null);
    });
    assert.deepStrictEqual(
      loggedPayloads.slice(-2).map((item) => ({
        model: item.model,
        stage: item.stage,
        attempt: item.attempt,
        success: item.success,
        errorCategory: item.errorCategory,
      })),
      [
        {
          model: 'gemini-3.5-flash-lite',
          stage: 'fallback',
          attempt: 3,
          success: true,
          errorCategory: undefined,
        },
        {
          model: 'gemini-3.5-flash-lite',
          stage: 'fallback',
          attempt: 3,
          success: false,
          errorCategory: 'invalid_response',
        },
      ],
      'JSON resolution должен логировать фактическую degraded-модель и попытку',
    );

    loggedPayloads.length = 0;
    await withPreset('gemini-full', async () => {
      await createEmbeddingForTask('vectorize with gemini');
    });
    assert.strictEqual(loggedPayloads.at(-1)?.operation, 'embedding');
    assert.strictEqual(loggedPayloads.at(-1)?.inputTokens, 6);
    assert.strictEqual(loggedPayloads.at(-1)?.preset, 'memory:stable-1536');
    assert.strictEqual(loggedPayloads.at(-1)?.success, true);

    loggedPayloads.length = 0;
    await withPreset('glm-balanced', async () => {
      await createEmbeddingForTask('vectorize');
    });
    assert.strictEqual(loggedPayloads.at(-1)?.operation, 'embedding');
    assert.strictEqual(loggedPayloads.at(-1)?.inputTokens, 6);
    assert.strictEqual(loggedPayloads.at(-1)?.preset, 'memory:stable-1536');
    assert.strictEqual(loggedPayloads.at(-1)?.success, true);

    const tempAudioPath = path.join(process.cwd(), '.tmp-test-ai-usage.ogg');
    fs.writeFileSync(tempAudioPath, 'test');
    loggedPayloads.length = 0;
    await withPreset('glm-balanced', async () => {
      await createTranscriptionForTask(tempAudioPath);
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    if (fs.existsSync(tempAudioPath)) {
      fs.unlinkSync(tempAudioPath);
    }
    assert.strictEqual(loggedPayloads.at(-1)?.operation, 'transcription');
    assert.strictEqual(loggedPayloads.at(-1)?.success, true);
    assert.strictEqual(loggedPayloads.at(-1)?.inputTokens, undefined);

    const tempGeminiAudioPath = path.join(process.cwd(), '.tmp-test-ai-usage-gemini.ogg');
    fs.writeFileSync(tempGeminiAudioPath, 'test');
    loggedPayloads.length = 0;
    await withPreset('gemini-full', async () => {
      await createTranscriptionForTask(tempGeminiAudioPath);
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    if (fs.existsSync(tempGeminiAudioPath)) {
      fs.unlinkSync(tempGeminiAudioPath);
    }
    assert.strictEqual(loggedPayloads.at(-1)?.operation, 'transcription');
    assert.strictEqual(loggedPayloads.at(-1)?.success, true);

    const tempGlmAudioPath = path.join(process.cwd(), '.tmp-test-ai-usage-glm.ogg');
    fs.writeFileSync(tempGlmAudioPath, 'test');
    loggedPayloads.length = 0;
    await withPreset('glm-full', async () => {
      await createTranscriptionForTask(tempGlmAudioPath);
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    if (fs.existsSync(tempGlmAudioPath)) {
      fs.unlinkSync(tempGlmAudioPath);
    }
    assert.strictEqual(loggedPayloads.at(-1)?.operation, 'transcription');
    assert.strictEqual(loggedPayloads.at(-1)?.success, true);

    geminiMutableClient.chat.completions.create = async () => ({
      id: 'chat-gemini-json-invalid',
      object: 'chat.completion',
      created: 0,
      model: 'gemini-3.1-flash-lite',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '{invalid json' } }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    });
    openaiMutableClient.chat.completions.create = async (body: Record<string, unknown>) => ({
      id: `chat-${body.model}`,
      object: 'chat.completion',
      created: 0,
      model: body.model,
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '{"ok":true}' } }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    });
    loggedPayloads.length = 0;
    await withPreset('hybrid-gemini-gpt', async () => {
      const result = await createJsonChatCompletionForTask<{ ok: boolean }>('conversation', {
        messages: [{ role: 'user', content: 'json please' }],
      });
      assert.deepStrictEqual(result, { ok: true });
    });
    assert.strictEqual(loggedPayloads.length, 2);
    assert.ok(loggedPayloads.every((item) => item.traceId === loggedPayloads[0].traceId));
    assert.deepStrictEqual(
      loggedPayloads.map((item) => ({ stage: item.stage, attempt: item.attempt, success: item.success })),
      [
        { stage: 'primary', attempt: 1, success: true },
        { stage: 'fallback', attempt: 2, success: true },
      ],
    );

    geminiMutableClient.chat.completions.create = async () => ({
      id: 'chat-gemini-json-invalid-primary',
      object: 'chat.completion',
      created: 0,
      model: 'gemini-3.1-flash-lite',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '{invalid json' } }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    });
    openaiMutableClient.chat.completions.create = async (body: Record<string, unknown>) => ({
      id: `chat-${body.model}`,
      object: 'chat.completion',
      created: 0,
      model: body.model,
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '{still invalid json' } }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    });
    loggedPayloads.length = 0;
    await withPreset('hybrid-gemini-gpt', async () => {
      const result = await createJsonChatCompletionForTask<{ ok: boolean }>('conversation', {
        messages: [{ role: 'user', content: 'json fails twice' }],
      });
      assert.strictEqual(result, null);
    });
    assert.strictEqual(loggedPayloads.length, 3);
    assert.ok(loggedPayloads.every((item) => item.traceId === loggedPayloads[0].traceId));
    assert.deepStrictEqual(
      loggedPayloads.map((item) => ({
        stage: item.stage,
        attempt: item.attempt,
        success: item.success,
        fallbackUsed: item.fallbackUsed,
        errorCategory: item.errorCategory,
      })),
      [
        { stage: 'primary', attempt: 1, success: true, fallbackUsed: false, errorCategory: undefined },
        { stage: 'fallback', attempt: 2, success: true, fallbackUsed: true, errorCategory: undefined },
        { stage: 'fallback', attempt: 2, success: false, fallbackUsed: true, errorCategory: 'invalid_response' },
      ],
    );

    geminiMutableClient.chat.completions.create = async () => ({
      id: 'chat-gemini-json-invalid-full',
      object: 'chat.completion',
      created: 0,
      model: 'gemini-3.6-flash',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '{invalid json' } }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    });
    openaiMutableClient.chat.completions.create = async () => {
      throw new Error('OpenAI fallback must not run for full preset');
    };
    loggedPayloads.length = 0;
    await withPreset('gemini-full', async () => {
      const result = await createJsonChatCompletionForTask<{ ok: boolean }>('conversation', {
        messages: [{ role: 'user', content: 'json for full preset' }],
      });
      assert.strictEqual(result, null);
    });
    assert.strictEqual(loggedPayloads.length, 2);
    assert.deepStrictEqual(
      loggedPayloads.map((item) => ({
        stage: item.stage,
        attempt: item.attempt,
        success: item.success,
        fallbackUsed: item.fallbackUsed,
        errorCategory: item.errorCategory,
      })),
      [
        { stage: 'primary', attempt: 1, success: true, fallbackUsed: false, errorCategory: undefined },
        { stage: 'primary', attempt: 1, success: false, fallbackUsed: false, errorCategory: 'invalid_response' },
      ],
    );

    geminiMutableClient.chat.completions.create = async () => {
      throw new Error('Gemini failed');
    };
    openaiMutableClient.chat.completions.create = async (body: Record<string, unknown>) => ({
      id: `chat-${body.model}`,
      object: 'chat.completion',
      created: 0,
      model: body.model,
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    });
    loggedPayloads.length = 0;
    await withPreset('hybrid-gemini-gpt', async () => {
      await createChatCompletionForTask('conversation', {
        messages: [{ role: 'user', content: 'classify this' }],
      });
    });
    assert.strictEqual(loggedPayloads.length, 2);
    assert.deepStrictEqual(
      loggedPayloads.map((item) => ({ operation: item.operation, success: item.success, fallbackUsed: item.fallbackUsed })),
      [
        { operation: 'chat', success: false, fallbackUsed: false },
        { operation: 'chat', success: true, fallbackUsed: true },
      ],
    );

    const gemini503 = Object.assign(new Error('Gemini 503'), {
      status: 503,
      code: 'service_unavailable',
      type: 'ServiceUnavailable',
      request_id: 'gem-503-a',
    });

    let geminiAttempts = 0;
    geminiMutableClient.chat.completions.create = async () => {
      geminiAttempts += 1;
      throw Object.assign({}, gemini503, { request_id: `gem-503-${geminiAttempts}` });
    };

    loggedPayloads.length = 0;
    const scheduledRetryDelays: number[] = [];
    globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      scheduledRetryDelays.push(Number(timeout ?? 0));
      return originalSetTimeout(handler, 0, ...args);
    }) as typeof globalThis.setTimeout;
    await withPreset('hybrid-gemini-gpt', async () => {
      await createChatCompletionForTask('conversation', {
        messages: [{ role: 'user', content: 'need retry flow' }],
      });
    });
    globalThis.setTimeout = originalSetTimeout;

    assert.strictEqual(geminiAttempts, 2);
    assert.strictEqual(scheduledRetryDelays.length, 0);
    assert.strictEqual(loggedPayloads.length, 3);
    assert.ok(loggedPayloads.every((item) => item.traceId === loggedPayloads[0].traceId));
    assert.deepStrictEqual(
      loggedPayloads.map((item) => ({
        stage: item.stage,
        attempt: item.attempt,
        success: item.success,
        errorStatus: item.errorStatus,
        fallbackUsed: item.fallbackUsed,
      })),
      [
        { stage: 'primary', attempt: 1, success: false, errorStatus: 503, fallbackUsed: false },
        { stage: 'retry', attempt: 2, success: false, errorStatus: 503, fallbackUsed: false },
        { stage: 'fallback', attempt: 3, success: true, errorStatus: undefined, fallbackUsed: true },
      ],
    );

    let switchedPresetAfterFailure = false;
    geminiMutableClient.chat.completions.create = async () => {
      if (!switchedPresetAfterFailure) {
        switchedPresetAfterFailure = true;
        process.env.AI_MODEL_PRESET = 'gpt-balanced';
        throw Object.assign(new Error('Gemini 503 before preset switch'), { status: 503 });
      }
      throw new Error('Gemini must not receive a stale retry');
    };
    loggedPayloads.length = 0;
    await withPreset('gemini-full', async () => {
      await createChatCompletionForTask('conversation', {
        messages: [{ role: 'user', content: 'retry on the current preset' }],
      });
    });
    assert.deepStrictEqual(
      loggedPayloads.map((item) => ({
        provider: item.provider,
        stage: item.stage,
        attempt: item.attempt,
        success: item.success,
      })),
      [
        { provider: 'gemini', stage: 'primary', attempt: 1, success: false },
        { provider: 'openai', stage: 'retry', attempt: 2, success: true },
      ],
    );

    let geminiFullAttempts = 0;
    let geminiFullOpenAiCalls = 0;
    geminiMutableClient.chat.completions.create = async () => {
      geminiFullAttempts += 1;
      throw Object.assign(new Error('Gemini full 503'), { status: 503, request_id: `gem-full-${geminiFullAttempts}` });
    };
    openaiMutableClient.chat.completions.create = async () => {
      geminiFullOpenAiCalls += 1;
      return {
        id: 'unexpected-openai-call',
        object: 'chat.completion',
        created: 0,
        model: 'gpt-5.4-mini',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'unexpected fallback' } }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      };
    };

    loggedPayloads.length = 0;
    scheduledRetryDelays.length = 0;
    globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      scheduledRetryDelays.push(Number(timeout ?? 0));
      return originalSetTimeout(handler, 0, ...args);
    }) as typeof globalThis.setTimeout;
    await assert.rejects(async () => {
      await withPreset('gemini-full', async () => {
        await createChatCompletionForTask('conversation', {
          messages: [{ role: 'user', content: 'gemini full retry only' }],
        });
      });
    });
    globalThis.setTimeout = originalSetTimeout;

    // gemini-full: primary + retry (baseline 1) + same-provider degradation chain
    // (gemini-3.5-flash-lite → 3.1-flash-lite → 2.5-flash-lite), все падают → reject.
    // Контракт: ни одного GPT-вызова (cross-provider fallback запрещён для true-full).
    assert.strictEqual(geminiFullOpenAiCalls, 0);
    assert.ok(geminiFullAttempts >= 3, 'gemini-full должен сделать минимум primary + retry + degradation');
    assert.strictEqual(scheduledRetryDelays.length, 1);
    assert.ok(scheduledRetryDelays[0] >= 1);
    assert.ok(
      loggedPayloads.every((item) => item.provider === 'gemini'),
      'Все попытки gemini-full должны идти через Gemini без OpenAI',
    );
    assert.strictEqual(loggedPayloads.at(-1)?.success, false);
    assert.strictEqual(loggedPayloads.at(-1)?.fallbackUsed, true);

    for (const status of [400, 401, 403]) {
      let protectedAttempts = 0;
      geminiMutableClient.chat.completions.create = async () => {
        protectedAttempts += 1;
        throw Object.assign(new Error(`Gemini ${status}`), { status, request_id: `gem-${status}` });
      };
      loggedPayloads.length = 0;
      await withPreset('hybrid-gemini-gpt', async () => {
        await createChatCompletionForTask('conversation', {
          messages: [{ role: 'user', content: `no retry ${status}` }],
        });
      });
      assert.strictEqual(protectedAttempts, 1);
      assert.deepStrictEqual(
        loggedPayloads.map((item) => item.stage),
        ['primary', 'fallback'],
      );
    }

    let fallbackFailureCount = 0;
    geminiMutableClient.chat.completions.create = async () => {
      throw Object.assign(new Error('Gemini 503'), { status: 503, request_id: 'gem-final' });
    };
    openaiMutableClient.chat.completions.create = async () => {
      fallbackFailureCount += 1;
      throw Object.assign(new Error('GPT fallback failed'), { status: 500, request_id: `gpt-fail-${fallbackFailureCount}` });
    };

    loggedPayloads.length = 0;
    await assert.rejects(async () => {
      await withPreset('hybrid-gemini-gpt', async () => {
        await createChatCompletionForTask('conversation', {
          messages: [{ role: 'user', content: 'force total failure' }],
        });
      });
    });
    assert.deepStrictEqual(
      loggedPayloads.map((item) => ({ stage: item.stage, success: item.success })),
      [
        { stage: 'primary', success: false },
        { stage: 'retry', success: false },
        { stage: 'fallback', success: false },
      ],
    );

    let embeddingAttempts = 0;
    openaiMutableClient.embeddings = {
      create: async () => {
        embeddingAttempts += 1;
        if (embeddingAttempts < 3) {
          throw Object.assign(new Error(`Embedding ${embeddingAttempts}`), { status: 503, request_id: `embed-${embeddingAttempts}` });
        }
        return {
          data: [{ embedding: [0.3, 0.4] }],
          usage: { prompt_tokens: 6, total_tokens: 6 },
        };
      },
    };
    loggedPayloads.length = 0;
    await assert.rejects(async () => {
      await withPreset('glm-balanced', async () => {
        await createEmbeddingForTask('retry embedding');
      });
    });
    assert.strictEqual(embeddingAttempts, 2);
    assert.deepStrictEqual(
      loggedPayloads.map((item) => ({ stage: item.stage, attempt: item.attempt, success: item.success })),
      [
        { stage: 'primary', attempt: 1, success: false },
        { stage: 'retry', attempt: 2, success: false },
      ],
    );

    let transcriptionAttempts = 0;
    openaiMutableClient.audio = {
      transcriptions: {
        create: async () => {
          transcriptionAttempts += 1;
          if (transcriptionAttempts < 3) {
            throw Object.assign(new Error(`Transcription ${transcriptionAttempts}`), { status: 503, request_id: `tr-${transcriptionAttempts}` });
          }
          return 'decoded text after fallback';
        },
      },
    };
    const tempRetryAudioPath = path.join(process.cwd(), '.tmp-test-ai-usage-retry.ogg');
    fs.writeFileSync(tempRetryAudioPath, 'test');
    loggedPayloads.length = 0;
    await withPreset('glm-balanced', async () => {
      await createTranscriptionForTask(tempRetryAudioPath);
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    if (fs.existsSync(tempRetryAudioPath)) {
      fs.unlinkSync(tempRetryAudioPath);
    }
    assert.strictEqual(transcriptionAttempts, 3);
    assert.deepStrictEqual(
      loggedPayloads.map((item) => ({ stage: item.stage, attempt: item.attempt, success: item.success })),
      [
        { stage: 'primary', attempt: 1, success: false },
        { stage: 'retry', attempt: 2, success: false },
        { stage: 'fallback', attempt: 3, success: true },
      ],
    );

    let transcriptionRouteSwitchGeminiCalls = 0;
    let transcriptionRouteSwitchOpenAiCalls = 0;
    geminiAdapter.createTranscription = async () => {
      transcriptionRouteSwitchGeminiCalls += 1;
      process.env.AI_MODEL_PRESET = 'glm-balanced';
      throw Object.assign(new Error('Gemini transcription 503 before preset switch'), { status: 503 });
    };
    openaiMutableClient.audio = {
      transcriptions: {
        create: async () => {
          transcriptionRouteSwitchOpenAiCalls += 1;
          return 'decoded after preset switch';
        },
      },
    };
    const tempSwitchAudioPath = path.join(process.cwd(), '.tmp-test-ai-usage-transcription-switch.ogg');
    fs.writeFileSync(tempSwitchAudioPath, 'test');
    try {
      await withPreset('gemini-full', async () => {
        await createTranscriptionForTask(tempSwitchAudioPath);
      });
    } finally {
      await new Promise((resolve) => setTimeout(resolve, 25));
      if (fs.existsSync(tempSwitchAudioPath)) fs.unlinkSync(tempSwitchAudioPath);
    }
    assert.strictEqual(transcriptionRouteSwitchGeminiCalls, 1);
    assert.strictEqual(transcriptionRouteSwitchOpenAiCalls, 1);

    let boundedGeminiTranscriptionAttempts = 0;
    geminiAdapter.createTranscription = async () => {
      boundedGeminiTranscriptionAttempts += 1;
      throw Object.assign(new Error('Gemini transcription remains unavailable'), { status: 503 });
    };
    const tempBoundedAudioPath = path.join(process.cwd(), '.tmp-test-ai-usage-transcription-bounded.ogg');
    fs.writeFileSync(tempBoundedAudioPath, 'test');
    try {
      await assert.rejects(() => withPreset('gemini-full', async () => {
        await createTranscriptionForTask(tempBoundedAudioPath);
      }));
    } finally {
      await new Promise((resolve) => setTimeout(resolve, 25));
      if (fs.existsSync(tempBoundedAudioPath)) fs.unlinkSync(tempBoundedAudioPath);
    }
    assert.strictEqual(
      boundedGeminiTranscriptionAttempts,
      2,
      'File-backed transcription должна ограничиваться primary + одним retry',
    );

    let timedOutGeminiTranscriptionAttempts = 0;
    geminiAdapter.createTranscription = async () => {
      timedOutGeminiTranscriptionAttempts += 1;
      throw Object.assign(new Error('Gemini file operation timed out'), { name: 'TimeoutError' });
    };
    const tempTimedOutAudioPath = path.join(process.cwd(), '.tmp-test-ai-usage-transcription-timeout.ogg');
    fs.writeFileSync(tempTimedOutAudioPath, 'test');
    try {
      await assert.rejects(() => withPreset('gemini-full', async () => {
        await createTranscriptionForTask(tempTimedOutAudioPath);
      }));
    } finally {
      await new Promise((resolve) => setTimeout(resolve, 25));
      if (fs.existsSync(tempTimedOutAudioPath)) fs.unlinkSync(tempTimedOutAudioPath);
    }
    assert.strictEqual(
      timedOutGeminiTranscriptionAttempts,
      1,
      'Истёкший файловый deadline не должен запускать ещё одну долгую попытку',
    );
    geminiAdapter.createTranscription = originalGeminiTranscription;
  } finally {
    aiUsageLogService.logAiUsage = originalLogAiUsage;
    console.info = originalConsoleInfo;
    console.warn = originalConsoleWarn;
    openaiMutableClient.chat.completions.create = originalOpenAiChatCreate;
    geminiMutableClient.chat.completions.create = originalGeminiChatCreate;
    zaiMutableClient.chat.completions.create = originalZaiChatCreate;
    if (hadResponses) {
      openaiMutableClient.responses = originalResponses;
    } else {
      delete openaiMutableClient.responses;
    }
    if (hadEmbeddings) {
      openaiMutableClient.embeddings = originalEmbeddings;
    } else {
      delete openaiMutableClient.embeddings;
    }
    if (hadAudio) {
      openaiMutableClient.audio = originalAudio;
    } else {
      delete openaiMutableClient.audio;
    }
    if (hadZaiAudio) {
      zaiMutableClient.audio = originalZaiAudio;
    } else {
      delete zaiMutableClient.audio;
    }
    geminiAdapter.createTranscription = originalGeminiTranscription;
    if (originalGeminiRetryBaseDelay === undefined) {
      delete process.env.AI_GEMINI_RETRY_BASE_DELAY_MS;
    } else {
      process.env.AI_GEMINI_RETRY_BASE_DELAY_MS = originalGeminiRetryBaseDelay;
    }
    if (originalGeminiRetryMaxDelay === undefined) {
      delete process.env.AI_GEMINI_RETRY_MAX_DELAY_MS;
    } else {
      process.env.AI_GEMINI_RETRY_MAX_DELAY_MS = originalGeminiRetryMaxDelay;
    }
    globalThis.setTimeout = originalSetTimeout;
    globalThis.fetch = originalFetch;
  }
}

main()
  .then(() => console.log('AI usage logging tests passed'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
