'use strict';

const registry = require('../admin-panel/src/ai-model-presets.json');
const { getPresetAvailabilityForMemoryProfile } = require('../admin-panel/presetAvailability');
const { providers } = require('./provider-registry.json');
const SETTING_KEY = 'AI_MODEL_POLICY';
const DEFAULT_PREFERENCES = { quality: 'high' };
const QUALITY_LEVELS = [
  { id: 'standard', title: 'Обычное', preset: 'gpt-lean', description: 'Повседневный диалог и короткие задачи. Лёгкие модели и умеренные лимиты ответа.', costNote: 'Самый низкий расход API среди трёх уровней.' },
  { id: 'high', title: 'Высокое', preset: 'gpt-balanced', description: 'Более глубокий разбор сложных вопросов. Сильная модель подключается для сложного анализа.', costNote: 'Стоимость выше, чем у обычного уровня. Сложные ответы могут занимать больше времени.' },
  { id: 'maximum', title: 'Максимальное', preset: 'gpt-max', description: 'Сильные модели для диалога и планирования, больше рассуждений и места для развёрнутого ответа.', costNote: 'Самая высокая стоимость API. Для сложных запросов ответ может быть медленнее.' },
];
const TEXT_TASKS = ['defaultText', 'lightweightText', 'fastDialogue', 'complexReasoning', 'runtimePlanning',
  'intentClassification', 'intentDedup', 'conversation', 'memoryExtraction', 'memoryConsolidation', 'messageAnalysis', 'browserPlanning'];

function parsePreferences(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1
    || !QUALITY_LEVELS.some(level => level.id === value.quality)) throw new Error('Выберите качество: обычное, высокое или максимальное.');
  return { quality: value.quality };
}

function readStoredPreferences(value, version) {
  if (version === 1 && value && Object.hasOwn(value, 'cost')) {
    const { cost, quality, censorship, ...extra } = value;
    if (Object.keys(extra).length || !['low', 'medium', 'high'].includes(cost) || !['standard', 'high'].includes(quality)
      || censorship !== undefined && !['on', 'off'].includes(censorship)) throw new Error('Некорректная политика моделей');
    return { quality: { low: 'standard', medium: 'high', high: 'maximum' }[cost] };
  }
  return parsePreferences(value);
}

function buildModelPlan(raw, { vars, memoryProfileName }) {
  const preferences = parsePreferences(raw);
  const level = QUALITY_LEVELS.find(level => level.id === preferences.quality);
  const desired = level.preset;
  const available = name => Object.values(registry.presets[name].models).every(ref => providers[ref.provider].optionalApiKey || Boolean(vars[providers[ref.provider].envKey]))
    && getPresetAvailabilityForMemoryProfile(registry.presets[name], vars, memoryProfileName).enabled;
  const presetName = [desired, 'gemini-full', 'glm-full'].find(available);
  if (!presetName) throw new Error('Нет доступного подключения для этих настроек. Подключите API или проверьте общий API сервиса.');
  const base = registry.presets[presetName];
  const models = structuredClone(base.models);
  const outputTokenLimits = { ...registry.presets[desired].outputTokenLimits };
  for (const [task, ref] of Object.entries(models)) {
    if (ref.provider === 'lmstudio') continue;
    const cap = outputTokenLimits[task];
    if (cap) ref.generation = { ...ref.generation, maxTokens: cap, reasoningEffort: ref.generation?.reasoningEffort || 'none' };
    if (ref.provider === 'openai' && /^gpt-6(?:\.1)?-(?:luna|sol)$/.test(ref.model)) {
      const thinking = ['complexReasoning', 'memoryConsolidation'].includes(task);
      if (thinking && preferences.quality !== 'standard') ref.generation = { ...ref.generation,
        reasoningEffort: preferences.quality === 'maximum' ? 'high' : 'medium' };
    }
  }
  const validity = getPresetAvailabilityForMemoryProfile({ models }, vars, memoryProfileName);
  if (!validity.enabled) throw new Error(validity.unavailableReason);
  return parseModelPolicy({ version: 2, preferences, presetName, models, outputTokenLimits, source: 'service',
    summary: `${level.description} ${level.costNote}${presetName !== desired ? ' Используется доступный провайдер; класс моделей ограничен его каталогом, уровни меняют лимиты ответа.' : ''}` });
}

function parseModelPolicy(raw) {
  if (!raw) return null;
  const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
  // Reading old policies never recompiles their models, limits or fallback restrictions.
  const preferences = readStoredPreferences(value.preferences, value.version);
  if (![1, 2].includes(value.version) || !registry.presetNames.includes(value.presetName) || !value.models
    || Object.keys(value.models).length !== Object.keys(registry.presets[value.presetName].models).length) throw new Error('Некорректная политика моделей');
  for (const task of Object.keys(registry.presets[value.presetName].models)) {
    const ref = value.models[task];
    if (!ref || !['openai', 'openrouter', 'gemini', 'zai', 'lmstudio'].includes(ref.provider)
      || typeof ref.model !== 'string' || !ref.model.trim() || ref.model.length > 400 || /[\r\n\0]/.test(ref.model)) throw new Error('Некорректный маршрут модели');
    if (value.version === 1 && value.preferences.censorship === 'off' && TEXT_TASKS.includes(task) && ref.allowFallback !== false) throw new Error('Свободный диалог не допускает подмену модели');
    if (ref.generation && (!['none', 'low', 'medium', 'high'].includes(ref.generation.reasoningEffort)
      || ref.generation.maxTokens !== undefined && (!Number.isInteger(ref.generation.maxTokens) || ref.generation.maxTokens < 32 || ref.generation.maxTokens > 16384))) throw new Error('Некорректные параметры модели');
  }
  return { ...value, preferences };
}

module.exports = { SETTING_KEY, DEFAULT_PREFERENCES, QUALITY_LEVELS, TEXT_TASKS, parsePreferences, buildModelPlan, parseModelPolicy };
