'use strict';

const { providers: AI_PROVIDER_REGISTRY } = require('./provider-registry.json');
const PROVIDER_CAPABILITY_OVERRIDES = require('./provider-capability-overrides.json');

function getProviderDescriptor(provider) {
  return AI_PROVIDER_REGISTRY[provider] || null;
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

function providerSupportsEmbedding(provider, model) {
  const capabilities = getProviderCapabilitiesForModel(provider, model);
  return Boolean(capabilities?.supportsEmbedding);
}

module.exports = {
  getProviderDescriptor,
  getProviderCapabilitiesForModel,
  providerSupportsEmbedding,
};
