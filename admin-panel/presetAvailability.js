'use strict';

const { providers: AI_PROVIDER_REGISTRY } = require('../ai/provider-registry.json');

function getProviderDescriptor(provider) {
  return AI_PROVIDER_REGISTRY[provider] || null;
}

function getTaskCapabilityKey(taskKey) {
  if (taskKey === 'embedding') return 'supportsEmbedding';
  if (taskKey === 'transcription') return 'supportsTranscription';
  if (taskKey === 'browserVision') return 'supportsVision';
  if (taskKey === 'webSearchReasoning') return 'supportsResponsesApi';
  return 'supportsChatCompletions';
}

function getDeclaredFallbackModel(taskKey) {
  if (
    taskKey === 'intentClassification' ||
    taskKey === 'intentDedup' ||
    taskKey === 'memoryExtraction' ||
    taskKey === 'browserPlanning'
  ) {
    return {
      provider: 'openai',
      model: 'gpt-5.4-nano',
    };
  }

  if (taskKey === 'browserVision') {
    return {
      provider: 'openai',
      model: 'gpt-4o',
    };
  }

  if (taskKey === 'embedding') {
    return {
      provider: 'openai',
      model: 'text-embedding-3-small',
    };
  }

  if (taskKey === 'transcription') {
    return {
      provider: 'openai',
      model: 'whisper-1',
    };
  }

  return {
    provider: 'openai',
    model: 'gpt-5.4-mini',
  };
}

function hasConfiguredValue(vars, key) {
  const value = vars[key] || process.env[key] || '';
  return typeof value === 'string' ? value.trim().length > 0 : Boolean(value);
}

function resolveTaskExecutionProvider(taskKey, modelRef) {
  const descriptor = getProviderDescriptor(modelRef.provider);
  if (!descriptor) {
    return {
      error: `${taskKey}: неизвестный provider ${modelRef.provider}`,
    };
  }

  const capabilityKey = getTaskCapabilityKey(taskKey);
  if (descriptor.capabilities?.[capabilityKey]) {
    return {
      provider: modelRef.provider,
    };
  }

  const fallbackModelRef = getDeclaredFallbackModel(taskKey);
  const fallbackDescriptor = getProviderDescriptor(fallbackModelRef.provider);
  if (fallbackDescriptor?.capabilities?.[capabilityKey]) {
    return {
      provider: fallbackModelRef.provider,
      fallbackUsed: true,
    };
  }

  return {
    error: `${taskKey}: ${descriptor.label} не поддерживает ${capabilityKey}`,
  };
}

function getPresetAvailability(preset, vars) {
  const missingProviders = new Set();
  const invalidTasks = [];

  for (const [taskKey, modelRef] of Object.entries(preset.models || {})) {
    const executionProvider = resolveTaskExecutionProvider(taskKey, modelRef);
    if (executionProvider.error) {
      invalidTasks.push(executionProvider.error);
      continue;
    }

    const descriptor = getProviderDescriptor(executionProvider.provider);
    if (!descriptor) {
      invalidTasks.push(`${taskKey}: неизвестный provider ${executionProvider.provider}`);
      continue;
    }

    if (!hasConfiguredValue(vars, descriptor.envKey)) {
      missingProviders.add(executionProvider.provider);
    }
  }

  if (invalidTasks.length > 0) {
    return {
      enabled: false,
      unavailableReason: `Недоступен: ${invalidTasks.join(', ')}`,
    };
  }

  if (missingProviders.size === 0) {
    return { enabled: true, unavailableReason: undefined };
  }

  const missingKeys = [...missingProviders].map((provider) => {
    const descriptor = getProviderDescriptor(provider);
    return `${descriptor?.label || provider}: ${descriptor?.envKey || provider}`;
  });

  return {
    enabled: false,
    unavailableReason: `Недоступен: не задан ${missingKeys.join(', ')}`,
  };
}

module.exports = {
  getDeclaredFallbackModel,
  getPresetAvailability,
  getProviderDescriptor,
  getTaskCapabilityKey,
  hasConfiguredValue,
  resolveTaskExecutionProvider,
};
