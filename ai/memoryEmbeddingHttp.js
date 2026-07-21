'use strict';

const { getProviderDescriptor, providerSupportsEmbedding } = require('./memoryEmbeddingProviderSupport');

function normalizeGeminiEmbeddingDimension(value) {
  if (!Number.isFinite(value)) return undefined;
  const normalized = Math.round(Number(value));
  return normalized > 0 ? normalized : undefined;
}

function buildUnsupportedProviderError(provider, model) {
  const error = new Error(`Memory embedding provider ${provider} не поддерживает embeddings для модели ${model}`);
  error.statusCode = 400;
  return error;
}

function buildUnknownProviderError(provider) {
  const error = new Error(`Memory embedding provider ${provider} не зарегистрирован`);
  error.statusCode = 500;
  return error;
}

function buildMissingApiKeyError(provider) {
  const error = new Error(`Не задан API key для memory profile provider ${provider}`);
  error.statusCode = 400;
  return error;
}

function buildHttpError(prefix, status, body) {
  const error = new Error(`${prefix} HTTP ${status}${body ? `: ${body.slice(0, 300)}` : ''}`);
  error.statusCode = 502;
  return error;
}

async function parseEmbeddingResponse(response, provider) {
  const data = await response.json();
  if (provider === 'gemini') {
    const embedding = Array.isArray(data?.embedding?.values)
      ? data.embedding.values
      : Array.isArray(data?.embeddings?.[0]?.values)
        ? data.embeddings[0].values
        : null;
    if (!Array.isArray(embedding)) {
      throw buildHttpError('Gemini embeddings', response.status, 'Gemini не вернул embedding');
    }
    return embedding;
  }

  const embedding = data?.data?.[0]?.embedding;
  if (!Array.isArray(embedding)) {
    throw buildHttpError(`${provider} embeddings`, response.status, 'Provider не вернул embedding');
  }
  return embedding;
}

async function createMemoryEmbeddingHttp(text, memoryProfile, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const resolveApiKey = options.resolveApiKey || ((provider) => {
    const descriptor = getProviderDescriptor(provider);
    if (!descriptor?.envKey) return '';
    return process.env[descriptor.envKey] || '';
  });

  const descriptor = getProviderDescriptor(memoryProfile.provider);
  if (!descriptor) throw buildUnknownProviderError(memoryProfile.provider);
  if (!providerSupportsEmbedding(memoryProfile.provider, memoryProfile.model)) {
    throw buildUnsupportedProviderError(memoryProfile.provider, memoryProfile.model);
  }

  const apiKey = resolveApiKey(memoryProfile.provider);
  if (!apiKey) throw buildMissingApiKeyError(memoryProfile.provider);

  if (memoryProfile.provider === 'gemini') {
    const response = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${memoryProfile.model}:embedContent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        model: `models/${memoryProfile.model}`,
        content: {
          parts: [{ text }],
        },
        output_dimensionality: normalizeGeminiEmbeddingDimension(memoryProfile.outputDimension),
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw buildHttpError('Gemini embeddings', response.status, body);
    }

    return parseEmbeddingResponse(response, 'gemini');
  }

  const baseURL = String(descriptor.baseURL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const response = await fetchImpl(`${baseURL}/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: memoryProfile.model,
      input: text,
      dimensions: memoryProfile.outputDimension,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw buildHttpError(`${descriptor.label || memoryProfile.provider} embeddings`, response.status, body);
  }

  return parseEmbeddingResponse(response, memoryProfile.provider);
}

module.exports = {
  createMemoryEmbeddingHttp,
  normalizeGeminiEmbeddingDimension,
};
