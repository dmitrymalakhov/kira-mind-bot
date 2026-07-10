import assert from 'assert';

process.env.KIRA_BOT_TOKEN = process.env.KIRA_BOT_TOKEN || 'test-token';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-openai-key';
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-gemini-key';
process.env.ZAI_API_KEY = process.env.ZAI_API_KEY || 'test-zai-key';

function buildConversation(lines: number, payloadSize = 700): string {
  return Array.from({ length: lines }, (_, index) => {
    const payload = `сообщение-${index} `.repeat(payloadSize / 12);
    return `[01.01.2026, 10:00:${String(index % 60).padStart(2, '0')}] Я: ${payload}`;
  }).join('\n');
}

async function main() {
  const chatCompletion = await import('../ai/chatCompletion');
  const { extractFactsAboutUserFromConversation } = await import('../utils/studyChatFlow');

  const originalCreateChatCompletionForTask = chatCompletion.createChatCompletionForTask;
  const originalConsoleWarn = console.warn;
  const originalPreset = process.env.AI_MODEL_PRESET;
  const originalGeminiConcurrency = process.env.AI_STUDY_CHAT_GEMINI_CHUNK_CONCURRENCY;

  try {
    process.env.AI_MODEL_PRESET = 'gemini-full';
    process.env.AI_STUDY_CHAT_GEMINI_CHUNK_CONCURRENCY = '1';

    let activeCalls = 0;
    let maxActiveCalls = 0;
    let callIndex = 0;
    const warnings: Array<{ message: string; payload?: unknown }> = [];

    console.warn = (message?: unknown, payload?: unknown) => {
      warnings.push({ message: String(message ?? ''), payload });
    };

    chatCompletion.createChatCompletionForTask = (async () => {
      const currentCall = callIndex++;
      activeCalls += 1;
      maxActiveCalls = Math.max(maxActiveCalls, activeCalls);
      await new Promise((resolve) => setTimeout(resolve, 10));
      activeCalls -= 1;

      if (currentCall === 2 || currentCall === 3) {
        throw Object.assign(new Error('Gemini 503'), { status: 503, request_id: `gem-study-${currentCall}` });
      }

      return {
        id: `chat-${currentCall}`,
        object: 'chat.completion',
        created: 0,
        model: 'gemini-3.5-flash',
        choices: [{
          index: 0,
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: JSON.stringify({
              facts: [
                {
                  content: `Олег любит порядок ${currentCall}`,
                  domain: 'personal',
                  importance: 0.8,
                  confidence: 0.9,
                  evidence: 'любит порядок',
                  inferenceLevel: 'direct',
                  temporalScope: 'stable',
                  status: 'active',
                  tags: ['test'],
                },
              ],
            }),
          },
        }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      } as any;
    }) as typeof chatCompletion.createChatCompletionForTask;

    const conversationText = buildConversation(30);
    const facts = await extractFactsAboutUserFromConversation(
      conversationText,
      'Артем',
      new Date('2026-01-01T00:00:00.000Z'),
      new Date('2026-01-02T00:00:00.000Z'),
    );

    assert.ok(facts.length > 0, 'должны сохраниться факты из успешных чанков');
    assert.strictEqual(maxActiveCalls, 2, 'gemini-full должен ограничивать burst до одного чанка (2 вызова внутри)');
    assert.ok(
      warnings.some((item) => item.message.includes('[studyChatFlow] degraded mode')),
      'ожидается compact degraded-log при частичном падении chunk-ов',
    );
  } finally {
    chatCompletion.createChatCompletionForTask = originalCreateChatCompletionForTask;
    console.warn = originalConsoleWarn;
    if (originalPreset === undefined) {
      delete process.env.AI_MODEL_PRESET;
    } else {
      process.env.AI_MODEL_PRESET = originalPreset;
    }
    if (originalGeminiConcurrency === undefined) {
      delete process.env.AI_STUDY_CHAT_GEMINI_CHUNK_CONCURRENCY;
    } else {
      process.env.AI_STUDY_CHAT_GEMINI_CHUNK_CONCURRENCY = originalGeminiConcurrency;
    }
  }

  console.log('gemini study chat flow checks passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
