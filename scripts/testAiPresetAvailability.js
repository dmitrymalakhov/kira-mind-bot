const assert = require('assert');
const { AI_PRESETS } = require('../admin-panel/aiPresetRegistry');
const {
  getPresetAvailability,
  getPresetAvailabilityForMemoryProfile,
} = require('../admin-panel/presetAvailability');

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
    webSearchReasoning: { provider: 'openrouter', model: 'openrouter/auto' },
  });

  assert.deepStrictEqual(getPresetAvailability(preset, { OPENAI_API_KEY: 'openai-key' }), {
    enabled: true,
    unavailableReason: undefined,
  });
}

function testCapabilityFallbackStillRequiresFallbackKey() {
  const preset = createPreset({
    webSearchReasoning: { provider: 'openrouter', model: 'openrouter/auto' },
  });

  const availability = getPresetAvailability(preset, {});
  assert.strictEqual(availability.enabled, false);
  assert.match(availability.unavailableReason || '', /OPENAI_API_KEY/);
}

function testTransitionalTranscriptionFallback() {
  const preset = createPreset({
    transcription: { provider: 'openrouter', model: 'openrouter/auto' },
  });

  assert.deepStrictEqual(getPresetAvailability(preset, { OPENAI_API_KEY: 'openai-key' }), {
    enabled: true,
    unavailableReason: undefined,
  });
}

function testModelLevelCapabilityOverrideMarksPresetUnavailable() {
  const preset = createPreset({
    transcription: { provider: 'zai', model: 'glm-5.2' },
  });

  const availability = getPresetAvailability(preset, { ZAI_API_KEY: 'zai-key' });
  assert.strictEqual(availability.enabled, false);
  assert.match(availability.unavailableReason || '', /OPENAI_API_KEY/);
}

function testGlmBalancedUsesMixedProviders() {
  const availability = getPresetAvailabilityForMemoryProfile(AI_PRESETS['glm-balanced'], {
    OPENAI_API_KEY: 'openai-key',
    ZAI_API_KEY: 'zai-key',
  }, 'stable-1536');

  assert.deepStrictEqual(availability, {
    enabled: true,
    unavailableReason: undefined,
  });
}

function testHybridGeminiGptRequiresGeminiAndOpenAi() {
  const availability = getPresetAvailabilityForMemoryProfile(AI_PRESETS['hybrid-gemini-gpt'], {
    OPENAI_API_KEY: 'openai-key',
    GEMINI_API_KEY: 'gemini-key',
  }, 'stable-1536');

  assert.deepStrictEqual(availability, {
    enabled: true,
    unavailableReason: undefined,
  });
}

function testPureGeminiRequiresOpenAiForStableMemoryProfile() {
  const availability = getPresetAvailabilityForMemoryProfile(AI_PRESETS['gemini-full'], {
    GEMINI_API_KEY: 'gemini-key',
  }, 'stable-1536');

  assert.strictEqual(availability.enabled, false);
  assert.match(availability.unavailableReason || '', /OPENAI_API_KEY/);
}

function testPureGlmRequiresZaiAndOpenAi() {
  const availability = getPresetAvailabilityForMemoryProfile(AI_PRESETS['glm-full'], {
    OPENAI_API_KEY: 'openai-key',
    ZAI_API_KEY: 'zai-key',
  }, 'stable-1536');

  assert.deepStrictEqual(availability, {
    enabled: true,
    unavailableReason: undefined,
  });
}

function testBaseAvailabilityStillSupportsPresetOnlyChecks() {
  const availability = getPresetAvailability(AI_PRESETS['gemini-full'], {
    GEMINI_API_KEY: 'gemini-key',
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
  testModelLevelCapabilityOverrideMarksPresetUnavailable();
  testGlmBalancedUsesMixedProviders();
  testHybridGeminiGptRequiresGeminiAndOpenAi();
  testPureGeminiRequiresOpenAiForStableMemoryProfile();
  testPureGlmRequiresZaiAndOpenAi();
  testBaseAvailabilityStillSupportsPresetOnlyChecks();
  console.log('AI preset availability tests passed');
}

main();
