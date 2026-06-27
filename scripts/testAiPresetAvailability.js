const assert = require('assert');
const { AI_PRESETS } = require('../admin-panel/aiPresetRegistry');
const { getPresetAvailability } = require('../admin-panel/presetAvailability');

function createPreset(models) {
  return {
    name: 'test-preset',
    title: 'Test Preset',
    description: 'test',
    models,
  };
}

function testCapabilityFallbackKeepsPresetAvailable() {
  const preset = createPreset({
    webSearchReasoning: { provider: 'gemini', model: 'gemini-3-flash-preview' },
  });

  assert.deepStrictEqual(getPresetAvailability(preset, { OPENAI_API_KEY: 'openai-key' }), {
    enabled: true,
    unavailableReason: undefined,
  });
}

function testCapabilityFallbackStillRequiresFallbackKey() {
  const preset = createPreset({
    webSearchReasoning: { provider: 'gemini', model: 'gemini-3-flash-preview' },
  });

  const availability = getPresetAvailability(preset, {});
  assert.strictEqual(availability.enabled, false);
  assert.match(availability.unavailableReason || '', /OPENAI_API_KEY/);
}

function testTransitionalTranscriptionFallback() {
  const preset = createPreset({
    transcription: { provider: 'zai', model: 'glm-5.2' },
  });

  assert.deepStrictEqual(getPresetAvailability(preset, { OPENAI_API_KEY: 'openai-key' }), {
    enabled: true,
    unavailableReason: undefined,
  });
}

function testGlmBalancedUsesMixedProviders() {
  const availability = getPresetAvailability(AI_PRESETS['glm-balanced'], {
    OPENAI_API_KEY: 'openai-key',
    ZAI_API_KEY: 'zai-key',
  });

  assert.deepStrictEqual(availability, {
    enabled: true,
    unavailableReason: undefined,
  });
}

function main() {
  testCapabilityFallbackKeepsPresetAvailable();
  testCapabilityFallbackStillRequiresFallbackKey();
  testTransitionalTranscriptionFallback();
  testGlmBalancedUsesMixedProviders();
  console.log('AI preset availability tests passed');
}

main();
