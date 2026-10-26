'use strict';

const registry = require('../admin-panel/src/ai-model-presets.json');
const { roles } = require('./localModelRouting');
const { getPresetAvailabilityForMemoryProfile } = require('../admin-panel/presetAvailability');
const { providers } = require('./provider-registry.json');
const SETTING_KEY = 'AI_MODEL_POLICY';
const DEFAULT_PREFERENCES = { censorship: 'on', cost: 'medium', quality: 'high' };
const TEXT_TASKS = ['defaultText', 'lightweightText', 'fastDialogue', 'complexReasoning', 'runtimePlanning',
  'intentClassification', 'intentDedup', 'conversation', 'memoryExtraction', 'memoryConsolidation', 'messageAnalysis', 'browserPlanning'];

function parsePreferences(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 3
    || !['on', 'off'].includes(value.censorship) || !['low', 'medium', 'high'].includes(value.cost)
    || !['standard', 'high'].includes(value.quality)) throw new Error('Выберите цензуру, стоимость и качество.');
  return { censorship: value.censorship, cost: value.cost, quality: value.quality };
}

function buildModelPlan(raw, { vars, localRoutes, localModels = [], memoryProfileName }) {
  const preferences = parsePreferences(raw);
  const desired = { low: 'gpt-lean', medium: 'gpt-balanced', high: 'gpt-max' }[preferences.cost];
  const available = name => Object.values(registry.presets[name].models).every(ref => providers[ref.provider].optionalApiKey || Boolean(vars[providers[ref.provider].envKey]))
    && getPresetAvailabilityForMemoryProfile(registry.presets[name], vars, memoryProfileName).enabled;
  let presetName = [desired, 'gemini-full', 'glm-full'].find(available);
  const freeLocal = localModels.filter(model => model.uncensored || model.id === vars.LM_STUDIO_FREE_MODEL
    || Object.values(localRoutes).some(route => route.freeDialogue && (route.model === model.id || model.loadedIds?.includes(route.model))));
  const freeCloud = String(vars.KIRA_FREE_DIALOGUE_MODEL || '').trim();
  if (preferences.censorship === 'off' && freeLocal.length) presetName = 'lmstudio-local';
  if (!presetName) throw new Error('Нет доступного подключения для этих настроек. Подключите API или проверьте общий API сервиса.');
  if (preferences.censorship === 'off' && !freeLocal.length && !(freeCloud && vars.OPENAI_API_KEY)) {
    throw new Error('Для свободного диалога нужна подходящая локальная модель или модель свободного диалога в API сервиса. Обычная облачная модель не будет включена вместо неё.');
  }
  const base = registry.presets[presetName];
  const models = structuredClone(base.models);
  const outputTokenLimits = { ...(base.outputTokenLimits || registry.presets[desired].outputTokenLimits) };
  for (const [task, ref] of Object.entries(models)) {
    if (ref.provider === 'lmstudio') continue;
    const cap = outputTokenLimits[task];
    if (cap) ref.generation = { ...ref.generation, maxTokens: cap, reasoningEffort: ref.generation?.reasoningEffort || 'none' };
    if (ref.provider === 'openai' && /^gpt-6(?:\.1)?-(?:luna|sol)$/.test(ref.model)) {
      const thinking = ['complexReasoning', 'memoryConsolidation'].includes(task);
      if (thinking && preferences.quality === 'high') ref.generation = { ...ref.generation,
        reasoningEffort: preferences.cost === 'high' ? 'high' : 'medium' };
    }
  }
  let source = 'service';
  if (preferences.censorship === 'off') {
    source = freeLocal.length ? 'local' : 'service-free';
    for (const task of TEXT_TASKS) {
      if (source === 'service-free') {
        models[task] = { provider: 'openai', model: freeCloud, allowFallback: false };
        continue;
      }
      const role = registry.presets['lmstudio-local'].models[task].localRole || 'fast';
      const chosenRole = task === 'conversation' && preferences.quality === 'high' ? 'analysis' : role;
      const route = localRoutes[chosenRole];
      const selected = freeLocal.find(model => model.id === route?.model || model.loadedIds?.includes(route?.model)) || freeLocal[0];
      models[task] = { provider: 'lmstudio', model: selected.loadedIds?.includes(route?.model) ? route.model : selected.id, localRole: chosenRole, allowFallback: false,
        generation: { maxTokens: route?.maxTokens ?? roles[chosenRole].maxTokens,
          reasoningEffort: route?.reasoningEffort ?? roles[chosenRole].reasoningEffort, temperature: roles[chosenRole].temperature } };
    }
  }
  const validity = getPresetAvailabilityForMemoryProfile({ models }, vars, memoryProfileName);
  if (!validity.enabled) throw new Error(validity.unavailableReason);
  return parseModelPolicy({ version: 1, preferences, presetName, models, outputTokenLimits, source,
    summary: source === 'local' ? 'Общение и понимание запросов — на вашем компьютере. Поиск, изображения и голос используют свои подключения.'
      : source === 'service-free' ? 'Общение — через модель свободного диалога в API сервиса.'
        : 'Кира выбирает модели подключённого API по задаче. Для простых реплик используются самые лёгкие маршруты.' });
}

function parseModelPolicy(raw) {
  if (!raw) return null;
  const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
  parsePreferences(value.preferences);
  if (value.version !== 1 || !registry.presetNames.includes(value.presetName) || !value.models
    || Object.keys(value.models).length !== Object.keys(registry.presets[value.presetName].models).length) throw new Error('Некорректная политика моделей');
  for (const task of Object.keys(registry.presets[value.presetName].models)) {
    const ref = value.models[task];
    if (!ref || !['openai', 'openrouter', 'gemini', 'zai', 'lmstudio'].includes(ref.provider)
      || typeof ref.model !== 'string' || !ref.model.trim() || ref.model.length > 400 || /[\r\n\0]/.test(ref.model)) throw new Error('Некорректный маршрут модели');
    if (value.preferences.censorship === 'off' && TEXT_TASKS.includes(task) && ref.allowFallback !== false) throw new Error('Свободный диалог не допускает подмену модели');
    if (ref.generation && (!['none', 'low', 'medium', 'high'].includes(ref.generation.reasoningEffort)
      || ref.generation.maxTokens !== undefined && (!Number.isInteger(ref.generation.maxTokens) || ref.generation.maxTokens < 32 || ref.generation.maxTokens > 16384))) throw new Error('Некорректные параметры модели');
  }
  return value;
}

module.exports = { SETTING_KEY, DEFAULT_PREFERENCES, TEXT_TASKS, parsePreferences, buildModelPlan, parseModelPolicy };
