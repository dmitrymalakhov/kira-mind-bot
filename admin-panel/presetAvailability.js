'use strict';

const { providers: AI_PROVIDER_REGISTRY } = require('../ai/provider-registry.json');
const PROVIDER_CAPABILITY_OVERRIDES = require('../ai/provider-capability-overrides.json');
const FALLBACK_MODELS = require('../ai/fallback-models.json');
const { getMemoryEmbeddingProfile } = require('./memoryEmbeddingProfileRegistry');

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
  return FALLBACK_MODELS[taskKey] || null;
}

function getProviderCapabilitiesForModel(provider, model) {
  const descriptor = getProviderDescriptor(provider);
  if (!descriptor) return null;
  const overrides = PROVIDER_CAPABILITY_OVERRIDES[provider]?.[model] || {};
  return {
    ...descriptor.capabilities,
    ...overrides,
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
  const modelCapabilities = getProviderCapabilitiesForModel(modelRef.provider, modelRef.model);
  if (modelCapabilities?.[capabilityKey]) {
    return {
      provider: modelRef.provider,
    };
  }

  const fallbackModelRef = getDeclaredFallbackModel(taskKey);
  if (!fallbackModelRef) {
    return {
      error: `${taskKey}: не найден fallback provider для capability ${capabilityKey}`,
    };
  }

  const fallbackDescriptor = getProviderDescriptor(fallbackModelRef.provider);
  const fallbackCapabilities = getProviderCapabilitiesForModel(fallbackModelRef.provider, fallbackModelRef.model);
  if (fallbackDescriptor && fallbackCapabilities?.[capabilityKey]) {
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
  return getPresetAvailabilityWithRequirements(preset, vars, []);
}

function getPresetAvailabilityWithRequirements(preset, vars, requiredProviders = []) {
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

  for (const provider of requiredProviders) {
    const descriptor = getProviderDescriptor(provider);
    if (!descriptor) {
      invalidTasks.push(`memory: неизвестный provider ${provider}`);
      continue;
    }
    if (!hasConfiguredValue(vars, descriptor.envKey)) {
      missingProviders.add(provider);
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

function getMemoryProfileRequiredProviders(memoryProfile) {
  if (!memoryProfile?.provider) return [];
  return [memoryProfile.provider];
}

function getPresetAvailabilityForMemoryProfile(preset, vars, memoryProfileName) {
  const memoryProfile = getMemoryEmbeddingProfile(memoryProfileName);
  const requiredProviders = getMemoryProfileRequiredProviders(memoryProfile);
  return getPresetAvailabilityWithRequirements(preset, vars, requiredProviders);
}

module.exports = {
  getDeclaredFallbackModel,
  getPresetAvailability,
  getPresetAvailabilityForMemoryProfile,
  getMemoryProfileRequiredProviders,
  getProviderDescriptor,
  getTaskCapabilityKey,
  hasConfiguredValue,
  resolveTaskExecutionProvider,
};
