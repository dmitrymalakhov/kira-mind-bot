const assert = require('assert');
const { createMemoryEmbeddingHttp } = require('../ai/memoryEmbeddingHttp');

function createJsonResponse(status, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return text;
    },
    async json() {
      return typeof body === 'string' ? JSON.parse(body) : body;
    },
  };
}

async function testOpenAiTransport() {
  const calls = [];
  const embedding = await createMemoryEmbeddingHttp(
    'hello',
    {
      provider: 'openai',
      model: 'text-embedding-3-small',
      outputDimension: 1536,
    },
    {
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return createJsonResponse(200, {
          data: [{ embedding: [0.1, 0.2, 0.3] }],
        });
      },
      resolveApiKey: () => 'openai-key',
    }
  );

  assert.deepStrictEqual(embedding, [0.1, 0.2, 0.3]);
  assert.strictEqual(calls[0].url, 'https://api.openai.com/v1/embeddings');
  assert.deepStrictEqual(JSON.parse(calls[0].init.body), {
    model: 'text-embedding-3-small',
    input: 'hello',
    dimensions: 1536,
  });
}

async function testGeminiTransport() {
  const calls = [];
  const embedding = await createMemoryEmbeddingHttp(
    'hello',
    {
      provider: 'gemini',
      model: 'gemini-embedding-2',
      outputDimension: 1536,
    },
    {
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return createJsonResponse(200, {
          embedding: { values: [0.9, 0.8] },
        });
      },
      resolveApiKey: () => 'gemini-key',
    }
  );

  assert.deepStrictEqual(embedding, [0.9, 0.8]);
  assert.strictEqual(calls[0].url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:embedContent');
  assert.deepStrictEqual(JSON.parse(calls[0].init.body), {
    model: 'models/gemini-embedding-2',
    content: {
      parts: [{ text: 'hello' }],
    },
    output_dimensionality: 1536,
  });
}

async function testUnsupportedProviderFailsExplicitly() {
  await assert.rejects(
    () => createMemoryEmbeddingHttp(
      'hello',
      {
        provider: 'openrouter',
        model: 'openrouter/auto',
        outputDimension: 1536,
      },
      {
        fetchImpl: async () => {
          throw new Error('should not fetch');
        },
        resolveApiKey: () => 'openrouter-key',
      }
    ),
    /не поддерживает embeddings/
  );
}

async function main() {
  await testOpenAiTransport();
  await testGeminiTransport();
  await testUnsupportedProviderFailsExplicitly();
  console.log('memory embedding HTTP helper tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
