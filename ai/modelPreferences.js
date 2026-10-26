'use strict';

const registry = require('../admin-panel/src/ai-model-presets.json');
const { getPresetAvailabilityForMemoryProfile } = require('../admin-panel/presetAvailability');
const { getMemoryEmbeddingProfile } = require('../admin-panel/memoryEmbeddingProfileRegistry');
const { providers } = require('./provider-registry.json');
const SETTING_KEY = 'AI_MODEL_POLICY';
const DEFAULT_PREFERENCES = { quality: 'high' };
const QUALITY_LEVELS = [
  { id: 'standard', title: 'Обычное', preset: 'gpt-lean', description: 'Повседневный диалог и короткие задачи. Лёгкие модели и умеренные лимиты ответа.', costNote: 'Самый низкий расход API среди трёх уровней.' },
  { id: 'high', title: 'Высокое', preset: 'gpt-balanced', description: 'Более глубокий разбор сложных вопросов. Сильная модель подключается для сложного анализа.', costNote: 'Стоимость выше, чем у обычного уровня. Сложные ответы могут занимать больше времени.' },
  { id: 'maximum', title: 'Максимальное', preset: 'gpt-max', description: 'Сильные модели для диалога и планирования, больше рассуждений и места для развёрнутого ответа.', costNote: 'Самая высокая стоимость API. Для сложных запросов ответ может быть медленнее.' },
];
const API_PROVIDERS = [
  { id: 'auto', title: 'Выбор Киры', description: 'Системные API-профили сервиса; модели распределяются по уровню качества.' },
  { id: 'openai', title: 'OpenAI', description: 'Лёгкая модель для быстрых задач, сильная — для сложных; распределение зависит от качества.' },
  { id: 'gemini', title: 'Google Gemini', description: 'Flash-Lite для быстрых задач, Flash для сложных. Уровень меняет распределение и лимиты.' },
  { id: 'zai', title: 'Z.ai · GLM', description: 'FlashX для быстрых задач, GLM для сложных. Память использует отдельный API.' },
  { id: 'openrouter', title: 'OpenRouter + OpenAI', description: 'Auto для диалога, OpenAI для служебных задач. Модель и цена Auto определяются OpenRouter.' },
];
const TEXT_TASKS = ['defaultText', 'lightweightText', 'fastDialogue', 'complexReasoning', 'runtimePlanning',
  'intentClassification', 'intentDedup', 'conversation', 'memoryExtraction', 'memoryConsolidation', 'messageAnalysis', 'browserPlanning'];

function parsePreferences(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['quality', 'provider'].includes(key))
    || !QUALITY_LEVELS.some(level => level.id === value.quality)
    || value.provider !== undefined && !API_PROVIDERS.some(provider => provider.id === value.provider)) throw new Error('Выберите качество и доступного API-провайдера.');
  return { quality: value.quality, ...(value.provider && value.provider !== 'auto' ? { provider: value.provider } : {}) };
}

function parseStrategyRequest(value) {
  if (value?.mode !== 'custom') return parsePreferences(value);
  if (Object.keys(value).some(key => !['mode', 'quality', 'presetName', 'routes'].includes(key))
    || !registry.presetNames.includes(value.presetName) || !value.routes || Array.isArray(value.routes)
    || Object.keys(value.routes).length !== TEXT_TASKS.length) throw new Error('Выберите корректную Custom-стратегию.');
  parsePreferences({ quality: value.quality });
  for (const task of TEXT_TASKS) {
    const ref = value.routes[task];
    if (!ref || Object.keys(ref).some(key => !['provider', 'model', 'maxTokens', 'reasoningEffort'].includes(key))
      || !Object.hasOwn(providers, ref.provider) || typeof ref.model !== 'string' || !ref.model.trim()
      || ref.model.length > 400 || /[\r\n\0]/.test(ref.model)
      || !Number.isInteger(ref.maxTokens) || ref.maxTokens < 32 || ref.maxTokens > 16384
      || !['none', 'low', 'medium', 'high'].includes(ref.reasoningEffort)) throw new Error('Выберите модель, лимит и рассуждения для каждой задачи Custom.');
  }
  return structuredClone(value);
}

function getStrategyCatalog(context) {
  const catalog = new Map();
  for (const preset of Object.values(registry.presets)) for (const task of TEXT_TASKS) {
    const ref = preset.models[task];
    if (ref.provider === 'lmstudio' || !context.vars[providers[ref.provider].envKey]) continue;
    catalog.set(`${ref.provider}:${ref.model}`, { provider: ref.provider, model: ref.model });
  }
  for (const model of context.localModels || []) for (const id of [model.id, ...(model.loadedIds || [])]) {
    catalog.set(`lmstudio:${id}`, { provider: 'lmstudio', model: id });
  }
  return [...catalog.values()];
}

function hasPlanResources(models, vars, memoryProfileName) {
  const required = [...Object.values(models).map(ref => ref.provider), getMemoryEmbeddingProfile(memoryProfileName)?.provider].filter(Boolean);
  return required.every(provider => providers[provider].optionalApiKey || Boolean(vars[providers[provider].envKey]?.trim()));
}

function buildCustomPlan(raw, context) {
  const request = parseStrategyRequest(raw);
  if (request.mode !== 'custom') throw new Error('Выберите Custom-стратегию.');
  const base = registry.presets[request.presetName];
  const models = structuredClone(base.models);
  const catalog = getStrategyCatalog(context);
  const outputTokenLimits = { ...base.outputTokenLimits };
  for (const task of TEXT_TASKS) {
    const route = request.routes[task];
    if (!catalog.some(ref => ref.provider === route.provider && ref.model === route.model)) throw new Error('Недоступен маршрут Custom: выберите модель из подключённого каталога.');
    models[task] = { provider: route.provider, model: route.model, allowFallback: false,
      generation: { maxTokens: route.maxTokens, reasoningEffort: route.reasoningEffort } };
    outputTokenLimits[task] = route.maxTokens;
  }
  if (!hasPlanResources(models, context.vars, context.memoryProfileName)) throw new Error('Недоступен API для сервисных задач или действующего профиля памяти.');
  const validity = getPresetAvailabilityForMemoryProfile({ models }, context.vars, context.memoryProfileName);
  if (!validity.enabled) throw new Error(validity.unavailableReason);
  return parseModelPolicy({ version: 3, preferences: { quality: request.quality }, presetName: request.presetName,
    models, outputTokenLimits, source: 'custom', summary: 'Custom: модели, лимиты и рассуждения выбраны вручную. Автоматическая замена текстовых маршрутов отключена.' });
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
  const available = name => hasPlanResources(registry.presets[name].models, vars, memoryProfileName)
    && getPresetAvailabilityForMemoryProfile(registry.presets[name], vars, memoryProfileName).enabled;
  const fixed = { openai: desired, gemini: 'gemini-full', zai: 'glm-full', openrouter: 'hybrid-openrouter-gpt' }[preferences.provider];
  const presetName = (fixed ? [fixed] : [desired, 'gemini-full', 'glm-full', 'hybrid-openrouter-gpt']).find(available);
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
  if (['gemini', 'zai'].includes(preferences.provider) || ['gemini-full', 'glm-full'].includes(presetName)) {
    const light = models.lightweightText;
    const deep = models.complexReasoning;
    for (const task of TEXT_TASKS) {
      const heavy = ['complexReasoning', 'memoryConsolidation'].includes(task)
        || preferences.quality === 'maximum' && ['conversation', 'defaultText', 'runtimePlanning'].includes(task);
      const chosen = preferences.quality === 'standard' || !heavy ? light : deep;
      models[task] = { provider: chosen.provider, model: chosen.model, allowFallback: false,
        generation: { reasoningEffort: 'none', ...(outputTokenLimits[task] ? { maxTokens: outputTokenLimits[task] } : {}) } };
    }
  }
  // A provider explicitly selected by the user must not silently switch on errors.
  if (preferences.provider) for (const task of TEXT_TASKS) models[task].allowFallback = false;
  const validity = getPresetAvailabilityForMemoryProfile({ models }, vars, memoryProfileName);
  if (!validity.enabled) throw new Error(validity.unavailableReason);
  return parseModelPolicy({ version: preferences.provider ? 3 : 2, preferences, presetName, models, outputTokenLimits, source: 'service',
    summary: `${level.description} ${level.costNote}${presetName !== desired ? ' Модели распределяются в пределах каталога выбранного API.' : ''}` });
}

function parseModelPolicy(raw) {
  if (!raw) return null;
  const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
  // Reading old policies never recompiles their models, limits or fallback restrictions.
  const preferences = readStoredPreferences(value.preferences, value.version);
  if (![1, 2, 3].includes(value.version) || !registry.presetNames.includes(value.presetName) || !value.models
    || Object.keys(value.models).length !== Object.keys(registry.presets[value.presetName].models).length) throw new Error('Некорректная политика моделей');
  for (const task of Object.keys(registry.presets[value.presetName].models)) {
    const ref = value.models[task];
    if (!ref || !['openai', 'openrouter', 'gemini', 'zai', 'lmstudio'].includes(ref.provider)
      || typeof ref.model !== 'string' || !ref.model.trim() || ref.model.length > 400 || /[\r\n\0]/.test(ref.model)) throw new Error('Некорректный маршрут модели');
    if (value.version === 1 && value.preferences.censorship === 'off' && TEXT_TASKS.includes(task) && ref.allowFallback !== false) throw new Error('Свободный диалог не допускает подмену модели');
    if (value.version === 3 && (value.source === 'custom' || preferences.provider) && TEXT_TASKS.includes(task)
      && (ref.allowFallback !== false || ref.localRole || ref.modelEnvKey)) throw new Error('Некорректный закреплённый маршрут модели');
    if (ref.generation && (!['none', 'low', 'medium', 'high'].includes(ref.generation.reasoningEffort)
      || ref.generation.maxTokens !== undefined && (!Number.isInteger(ref.generation.maxTokens) || ref.generation.maxTokens < 32 || ref.generation.maxTokens > 16384))) throw new Error('Некорректные параметры модели');
  }
  return { ...value, preferences };
}

module.exports = { API_PROVIDERS, getStrategyCatalog, parseStrategyRequest, buildCustomPlan, SETTING_KEY, DEFAULT_PREFERENCES, QUALITY_LEVELS, TEXT_TASKS, parsePreferences, buildModelPlan, parseModelPolicy };
