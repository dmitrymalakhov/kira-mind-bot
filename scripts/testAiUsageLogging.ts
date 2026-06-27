import assert from 'assert';
import fs from 'fs';
import path from 'path';

process.env.KIRA_BOT_TOKEN = process.env.KIRA_BOT_TOKEN || 'test-token';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-openai-key';
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-gemini-key';
process.env.ZAI_API_KEY = process.env.ZAI_API_KEY || 'test-zai-key';

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
  const { createChatCompletionForTask } = await import('../ai/chatCompletion');
  const { createResponseForTask } = await import('../ai/responseCompletion');
  const { createEmbeddingForTask } = await import('../ai/embedding');
  const { createTranscriptionForTask } = await import('../ai/transcription');
  const { openaiClient, geminiClient } = await import('../ai/aiClients');
  const aiUsageLogService = await import('../services/aiUsageLogService');

  const loggedPayloads: Array<Record<string, unknown>> = [];
  const originalLogAiUsage = aiUsageLogService.logAiUsage;
  const originalConsoleWarn = console.warn;

  const openaiMutableClient = openaiClient as unknown as {
    chat: { completions: { create: (body: Record<string, unknown>) => Promise<unknown> } };
    responses?: { create: (body: Record<string, unknown>) => Promise<unknown> };
    embeddings?: { create: (body: Record<string, unknown>) => Promise<unknown> };
    audio?: { transcriptions: { create: (body: Record<string, unknown>) => Promise<unknown> } };
  };
  const geminiMutableClient = geminiClient as unknown as {
    chat: { completions: { create: (body: Record<string, unknown>) => Promise<unknown> } };
  };

  const originalOpenAiChatCreate = openaiMutableClient.chat.completions.create;
  const originalGeminiChatCreate = geminiMutableClient.chat.completions.create;
  const hadResponses = Object.prototype.hasOwnProperty.call(openaiMutableClient, 'responses');
  const originalResponses = openaiMutableClient.responses;
  const hadEmbeddings = Object.prototype.hasOwnProperty.call(openaiMutableClient, 'embeddings');
  const originalEmbeddings = openaiMutableClient.embeddings;
  const hadAudio = Object.prototype.hasOwnProperty.call(openaiMutableClient, 'audio');
  const originalAudio = openaiMutableClient.audio;

  try {
    aiUsageLogService.logAiUsage = async (payload) => {
      loggedPayloads.push(payload as unknown as Record<string, unknown>);
    };
    console.warn = () => undefined;

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
    await withPreset('glm-balanced', async () => {
      await createEmbeddingForTask('vectorize');
    });
    assert.strictEqual(loggedPayloads.at(-1)?.operation, 'embedding');
    assert.strictEqual(loggedPayloads.at(-1)?.inputTokens, 6);
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

    loggedPayloads.length = 0;
    await withPreset('gemini-direct-balanced', async () => {
      await createChatCompletionForTask('intentClassification', {
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
  } finally {
    aiUsageLogService.logAiUsage = originalLogAiUsage;
    console.warn = originalConsoleWarn;
    openaiMutableClient.chat.completions.create = originalOpenAiChatCreate;
    geminiMutableClient.chat.completions.create = originalGeminiChatCreate;
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
  }
}

main()
  .then(() => console.log('AI usage logging tests passed'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
