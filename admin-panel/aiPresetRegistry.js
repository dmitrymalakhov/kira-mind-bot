'use strict';

const modelPresetRegistry = require('./src/ai-model-presets.json');

const AI_PRESET_NAMES = modelPresetRegistry.presetNames;
const AI_PRESETS = modelPresetRegistry.presets;
const LEGACY_AI_PRESET_ALIASES = {
  'hybrid-gemini-extended': 'hybrid-gemini-gpt',
  'gemini-direct-balanced': 'hybrid-gemini-gpt',
};

function parseAiPresetName(raw) {
  const normalized = LEGACY_AI_PRESET_ALIASES[raw] || raw;
  return AI_PRESET_NAMES.includes(normalized) ? normalized : null;
}

module.exports = { AI_PRESET_NAMES, AI_PRESETS, parseAiPresetName };
