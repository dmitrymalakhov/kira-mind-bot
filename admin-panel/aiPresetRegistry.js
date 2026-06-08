'use strict';

const modelPresetRegistry = require('./src/ai-model-presets.json');

const AI_PRESET_NAMES = modelPresetRegistry.presetNames;
const AI_PRESETS = modelPresetRegistry.presets;

function parseAiPresetName(raw) {
  return AI_PRESET_NAMES.includes(raw) ? raw : null;
}

module.exports = { AI_PRESET_NAMES, AI_PRESETS, parseAiPresetName };
