'use strict';

const SETTING_KEY = 'IMAGE_RECOGNITION_SETTINGS';

// null preserves the existing conversation strategy. A local selection is pinned
// independently of text roles and must never fall back to a cloud recipient.
function parseImageRecognitionSettings(raw) {
  const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== 'maxTokens,model,provider,reasoningEffort'
      || value.provider !== 'lmstudio'
      || typeof value.model !== 'string' || !value.model.trim() || value.model.length > 400 || /[\r\n\0]/.test(value.model)
      || !Number.isInteger(value.maxTokens) || value.maxTokens < 32 || value.maxTokens > 8192
      || !['none', 'low', 'medium', 'high'].includes(value.reasoningEffort)) {
    throw new Error('Выберите локальную модель изображений и лимит от 32 до 8192 токенов.');
  }
  return { provider: 'lmstudio', model: value.model.trim(), maxTokens: value.maxTokens, reasoningEffort: value.reasoningEffort };
}

module.exports = { SETTING_KEY, parseImageRecognitionSettings };
