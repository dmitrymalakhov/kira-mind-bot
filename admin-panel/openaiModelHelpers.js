'use strict';

const openAiModelRegistry = require('./src/openai-model-registry.json');

const OPENAI_MODEL_FIELDS = openAiModelRegistry.fields;
const OPENAI_MODEL_KEYS = OPENAI_MODEL_FIELDS.map((field) => field.envKey);
const OPENAI_MODEL_FIELD_MAP = Object.fromEntries(
  OPENAI_MODEL_FIELDS.map((field) => [field.envKey, field])
);
const OPENAI_MODEL_PRESETS = openAiModelRegistry.presets;

function hasEnvVar(vars, key) {
  return Object.prototype.hasOwnProperty.call(vars, key);
}

function toOptionalString(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function getDefaultTextEffectiveValue(vars) {
  const field = OPENAI_MODEL_FIELD_MAP.OPENAI_MODEL_DEFAULT_TEXT;
  const rawValue = hasEnvVar(vars, field.envKey) ? vars[field.envKey] : null;
  return toOptionalString(rawValue) || field.systemDefault;
}

function resolveFieldEntry(vars, field) {
  const rawValue = hasEnvVar(vars, field.envKey) ? vars[field.envKey] : null;
  const explicitValue = toOptionalString(rawValue);
  const defaultTextValue = getDefaultTextEffectiveValue(vars);
  let value = '';
  let source = 'system_default';

  if (field.kind === 'default_text') {
    value = explicitValue || field.systemDefault;
    source = explicitValue ? 'env_file' : 'system_default';
  } else if (field.kind === 'fixed') {
    value = explicitValue || field.systemDefault;
    source = explicitValue ? 'env_file' : 'system_default';
  } else if (explicitValue) {
    value = explicitValue;
    source = 'env_file';
  } else if (rawValue === '') {
    value = defaultTextValue;
    source = 'inherited_default_text';
  } else if (field.resolution === 'system_default') {
    value = field.systemDefault;
    source = 'system_default';
  } else {
    value = defaultTextValue;
    source = 'inherited_default_text';
  }

  return {
    value,
    rawValue,
    rawState: rawValue === null ? 'missing' : explicitValue ? 'value' : 'empty',
    masked: false,
    source,
  };
}

function buildOpenAIModelEntries(vars, configPath) {
  const result = {};

  for (const field of OPENAI_MODEL_FIELDS) {
    result[field.envKey] = {
      ...resolveFieldEntry(vars, field),
      configPath,
    };
  }

  return result;
}

function buildNormalizedOpenAIRawValues(vars) {
  const result = {};

  for (const field of OPENAI_MODEL_FIELDS) {
    result[field.envKey] = hasEnvVar(vars, field.envKey) ? vars[field.envKey] : null;
  }

  return result;
}

function findActiveModelPresetId(vars) {
  const normalizedValues = buildNormalizedOpenAIRawValues(vars);

  for (const preset of OPENAI_MODEL_PRESETS) {
    const matches = OPENAI_MODEL_KEYS.every((key) => preset.values[key] === normalizedValues[key]);
    if (matches) return preset.id;
  }

  return null;
}

module.exports = {
  OPENAI_MODEL_FIELDS,
  OPENAI_MODEL_KEYS,
  OPENAI_MODEL_PRESETS,
  buildOpenAIModelEntries,
  findActiveModelPresetId,
};
