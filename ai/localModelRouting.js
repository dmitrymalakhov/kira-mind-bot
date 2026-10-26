'use strict';
const roles = require('./local-model-roles.json');
const SETTING_KEY = 'LM_STUDIO_ROUTES';
function parseLocalRoutes(raw) {
  const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 3) throw new Error('Укажите три роли моделей');
  const result = {};
  for (const key of Object.keys(roles)) {
    const route = value[key];
    if (!route || typeof route.model !== 'string' || !route.model.trim() || route.model.length > 400 || /[\r\n\0]/.test(route.model)) throw new Error(`Укажите модель для роли ${roles[key].label}`);
    if (!Number.isInteger(route.maxTokens) || route.maxTokens < 32 || route.maxTokens > 8192) throw new Error('Лимит ответа должен быть от 32 до 8192 токенов');
    if (!['none', 'low', 'medium', 'high'].includes(route.reasoningEffort)) throw new Error('Неизвестный режим рассуждения');
    if (route.freeDialogue !== undefined && typeof route.freeDialogue !== 'boolean') throw new Error('Неизвестная настройка свободного диалога');
    result[key] = { model: route.model.trim(), maxTokens: route.maxTokens, reasoningEffort: route.reasoningEffort,
      ...(route.freeDialogue ? { freeDialogue: true } : {}) };
  }
  return result;
}
function defaultLocalRoutes(model) {
  return Object.fromEntries(Object.entries(roles).map(([key, defaults]) => [key, { model: model || '', maxTokens: defaults.maxTokens, reasoningEffort: defaults.reasoningEffort }]));
}
module.exports = { roles, SETTING_KEY, parseLocalRoutes, defaultLocalRoutes };
