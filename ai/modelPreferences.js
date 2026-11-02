'use strict';

const registry = require('../admin-panel/src/ai-model-presets.json');
const { getPresetAvailabilityForMemoryProfile } = require('../admin-panel/presetAvailability');
const { getMemoryEmbeddingProfile } = require('../admin-panel/memoryEmbeddingProfileRegistry');
const { providers } = require('./provider-registry.json');
const aggregatorModels = require('./aggregator-text-models.json');
const SETTING_KEY = 'AI_MODEL_POLICY';
const DEFAULT_PREFERENCES = { quality: 'high' };
const QUALITY_LEVELS = [
  { id: 'standard', title: 'Обычное', preset: 'gpt-lean', description: 'Повседневный диалог и короткие задачи. Лёгкие модели и умеренные лимиты ответа.', costNote: 'Самый низкий расход API среди трёх уровней.' },
  { id: 'high', title: 'Высокое', preset: 'gpt-balanced', description: 'Более глубокий разбор сложных вопросов. Сильная модель подключается для сложного анализа.', costNote: 'Стоимость выше, чем у обычного уровня. Сложные ответы могут занимать больше времени.' },
  { id: 'maximum', title: 'Максимальное', preset: 'gpt-max', description: 'Сильные модели для диалога и планирования, больше рассуждений и места для развёрнутого ответа.', costNote: 'Самая высокая стоимость API. Для сложных запросов ответ может быть медленнее.' },
];
const API_PROVIDERS = [
  { id: 'auto', title: 'Автоматически', description: 'Общий пул подключённых моделей: выбор по задаче, качеству, нагрузке и технической доступности.' },
  { id: 'openai', title: 'OpenAI', description: 'Лёгкая модель для быстрых задач, сильная — для сложных; распределение зависит от качества.' },
  { id: 'gemini', title: 'Google Gemini', description: 'Flash-Lite для быстрых задач, Flash для сложных. Уровень меняет распределение и лимиты.' },
  { id: 'zai', title: 'Z.ai · GLM', description: 'FlashX для быстрых задач, GLM для сложных. Память использует отдельный API.' },
  { id: 'openrouter', title: 'OpenRouter', description: 'Gemini, Kimi, GLM и GPT по ролям через один ключ. Для текста отдельный OpenAI API не нужен.' },
  { id: 'kimi', title: 'Kimi · Moonshot API', description: 'Прямой Kimi API; модели Pro и Highspeed участвуют в общем пуле.' },
];
const TEXT_TASKS = ['defaultText', 'lightweightText', 'fastDialogue', 'complexReasoning', 'runtimePlanning',
  'intentClassification', 'intentDedup', 'conversation', 'memoryExtraction', 'memoryConsolidation', 'messageAnalysis', 'browserPlanning'];

function parsePreferences(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['quality', 'provider', 'providers'].includes(key))
    || !QUALITY_LEVELS.some(level => level.id === value.quality)
    || value.provider !== undefined && !API_PROVIDERS.some(provider => provider.id === value.provider)
    || value.providers !== undefined && (value.provider && value.provider !== 'auto'
      || !Array.isArray(value.providers) || !value.providers.length || value.providers.length > Object.keys(providers).length
      || new Set(value.providers).size !== value.providers.length || value.providers.some(id => !Object.hasOwn(providers, id)))) throw new Error('Выберите качество и доступного API-провайдера.');
  return { quality: value.quality, ...(value.provider && value.provider !== 'auto' ? { provider: value.provider } : {}),
    ...(value.providers ? { providers: Object.keys(providers).filter(id => value.providers.includes(id)) } : {}) };
}

function getCustomPresetName(provider, quality) {
  const level = QUALITY_LEVELS.find(level => level.id === quality);
  if (!level || !Object.hasOwn(providers, provider)) throw new Error('Выберите провайдера и качество Custom.');
  return { openai: level.preset, gemini: 'gemini-full', zai: 'glm-full',
    openrouter: 'openrouter-balanced', kimi: 'kimi-full', lmstudio: 'lmstudio-local' }[provider];
}

function parseStrategyRequest(value) {
  if (value?.mode !== 'custom') return parsePreferences(value);
  if (Object.keys(value).some(key => !['mode', 'quality', 'provider', 'routes'].includes(key))
    || !Object.hasOwn(providers, value.provider) || !value.routes || Array.isArray(value.routes)
    || Object.keys(value.routes).length !== TEXT_TASKS.length) throw new Error('Выберите корректную Custom-стратегию.');
  parsePreferences({ quality: value.quality });
  for (const task of TEXT_TASKS) {
    const ref = value.routes[task];
    if (!ref || Object.keys(ref).some(key => !['model', 'maxTokens', 'reasoningEffort'].includes(key))
      || typeof ref.model !== 'string' || !ref.model.trim()
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
  if (context.vars.OPENROUTER_API_KEY?.trim()) catalog.set('openrouter:moonshotai/kimi-k2.5', { provider: 'openrouter', model: 'moonshotai/kimi-k2.5' });
  for (const [provider, entry] of Object.entries(aggregatorModels)) if (context.vars[providers[provider].envKey]?.trim()) {
    for (const model of entry.models) catalog.set(`${provider}:${model}`, { provider, model });
  }
  return [...catalog.values()];
}

function hasPlanResources(models, vars, memoryProfileName, textOnly = false) {
  const required = textOnly ? TEXT_TASKS.map(task => models[task].provider)
    : [...Object.values(models).map(ref => ref.provider), getMemoryEmbeddingProfile(memoryProfileName)?.provider].filter(Boolean);
  return required.every(provider => providers[provider].optionalApiKey || Boolean(vars[providers[provider].envKey]?.trim()));
}

function buildCustomPlan(raw, context) {
  const request = parseStrategyRequest(raw);
  if (request.mode !== 'custom') throw new Error('Выберите Custom-стратегию.');
  const presetName = getCustomPresetName(request.provider, request.quality);
  const base = registry.presets[presetName];
  const models = structuredClone(base.models);
  const catalog = getStrategyCatalog(context);
  const outputTokenLimits = { ...base.outputTokenLimits };
  for (const task of TEXT_TASKS) {
    const route = request.routes[task];
    if (!catalog.some(ref => ref.provider === request.provider && ref.model === route.model)) throw new Error('Недоступен маршрут Custom: выберите модель из подключённого каталога.');
    models[task] = { provider: request.provider, model: route.model, allowFallback: false,
      generation: { maxTokens: route.maxTokens, reasoningEffort: route.reasoningEffort } };
    outputTokenLimits[task] = route.maxTokens;
  }
  if (!hasPlanResources(models, context.vars, context.memoryProfileName, base.textOnlyAvailability)) throw new Error('Недоступен API для сервисных задач или действующего профиля памяти.');
  const validity = getPresetAvailabilityForMemoryProfile({ models, textOnlyAvailability: base.textOnlyAvailability }, context.vars, context.memoryProfileName);
  if (!validity.enabled) throw new Error(validity.unavailableReason);
  return parseModelPolicy({ version: 3, preferences: { quality: request.quality }, presetName, customProvider: request.provider,
    models, outputTokenLimits, source: 'custom', summary: `Custom · ${providers[request.provider].label}: модели, лимиты и рассуждения выбраны вручную. Автоматическая замена текстовых маршрутов отключена.` });
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

function buildFixedModelPlan(raw, { vars, memoryProfileName }) {
  const preferences = parsePreferences(raw);
  const level = QUALITY_LEVELS.find(level => level.id === preferences.quality);
  const desired = level.preset;
  const available = name => hasPlanResources(registry.presets[name].models, vars, memoryProfileName, registry.presets[name].textOnlyAvailability)
    && getPresetAvailabilityForMemoryProfile(registry.presets[name], vars, memoryProfileName).enabled;
  const fixed = { openai: desired, gemini: 'gemini-full', zai: 'glm-full', openrouter: 'openrouter-balanced', kimi: 'kimi-full' }[preferences.provider];
  const presetName = (fixed ? [fixed] : [desired, 'gemini-full', 'glm-full', 'openrouter-balanced', 'kimi-full']).find(available);
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
  const aggregate = preferences.provider || models.conversation.provider;
  if (aggregatorModels[aggregate]) for (const task of TEXT_TASKS) models[task] = aggregatorRoutes(aggregate, task, preferences.quality, outputTokenLimits)[0];
  // A provider explicitly selected by the user must not silently switch on errors.
  if (preferences.provider) for (const task of TEXT_TASKS) models[task].allowFallback = false;
  const validity = getPresetAvailabilityForMemoryProfile({ models, textOnlyAvailability: base.textOnlyAvailability }, vars, memoryProfileName);
  if (!validity.enabled) throw new Error(validity.unavailableReason);
  return parseModelPolicy({ version: preferences.provider ? 3 : 2, preferences, presetName, models, outputTokenLimits, source: 'service',
    summary: `${level.description} ${level.costNote}${presetName !== desired ? ' Модели распределяются в пределах каталога выбранного API.' : ''}` });
}

// These are role priorities, not measured model benchmarks or monetary quotas.
// Semantic complexity is supplied by the existing classifier through the task key.
function automaticProviderOrder(task, quality) {
  if (quality === 'standard') return ['zai', 'lmstudio', 'openai', 'gemini', 'openrouter', 'kimi'];
  if (['complexReasoning', 'memoryConsolidation'].includes(task) || quality === 'maximum'
    && ['conversation', 'defaultText'].includes(task)) return ['openai', 'kimi', 'openrouter', 'zai', 'gemini', 'lmstudio'];
  if (task === 'runtimePlanning') return ['zai', 'kimi', 'openai', 'openrouter', 'gemini', 'lmstudio'];
  if (['conversation', 'defaultText'].includes(task)) return ['kimi', 'openrouter', 'openai', 'zai', 'gemini', 'lmstudio'];
  return ['openai', 'zai', 'lmstudio', 'gemini', 'openrouter', 'kimi'];
}

function aggregatorRoutes(provider, task, quality, caps) {
  const role = ['complexReasoning', 'memoryConsolidation'].includes(task) ? 'reasoning'
    : task === 'runtimePlanning' ? 'planning' : ['conversation', 'defaultText'].includes(task) ? 'dialogue' : 'utility';
  return aggregatorModels[provider][quality][role].map(model => ({ provider, model, allowFallback: false,
    generation: { reasoningEffort: provider === 'kimi' ? role === 'reasoning' && quality !== 'standard' ? 'high' : 'low'
      : role === 'reasoning' && quality !== 'standard' ? quality === 'maximum' ? 'high' : 'medium' : 'none',
    ...(caps[task] ? { maxTokens: caps[task] } : {}) } }));
}

function selectAutomaticProviders(plan, selected) {
  const preferences = parsePreferences({ quality: plan.preferences.quality, ...(selected ? { providers: selected } : {}) });
  const allowed = preferences.providers || Object.keys(providers).filter(id => id !== 'lmstudio');
  const routing = {}, models = structuredClone(plan.models);
  for (const task of TEXT_TASKS) {
    routing[task] = plan.routing[task].filter(ref => allowed.includes(ref.provider));
    if (!routing[task].length) throw new Error('Нет доступного подключения для выбранного пула моделей.');
    models[task] = structuredClone(routing[task][0]);
  }
  return { ...plan, preferences, models, routing };
}

function buildModelPlan(raw, context) {
  const preferences = parsePreferences(raw);
  if (preferences.provider) return buildFixedModelPlan(preferences, context);
  // Specialized search/vision/audio/embedding routes retain their existing service contracts.
  const base = buildFixedModelPlan({ quality: preferences.quality }, context);
  const fixed = {}, economical = {};
  for (const id of Object.keys(providers).filter(id => id !== 'lmstudio')) {
    try {
      fixed[id] = buildFixedModelPlan({ quality: preferences.quality, provider: id }, context);
      if (preferences.quality !== 'standard' && !aggregatorModels[id]) economical[id] = buildFixedModelPlan({ quality: 'standard', provider: id }, context);
    }
    catch { /* A missing service dependency excludes this candidate. */ }
  }
  const localCatalog = getStrategyCatalog(context).filter(ref => ref.provider === 'lmstudio');
  const routing = {};
  for (const task of TEXT_TASKS) {
    const refs = {};
    for (const [id, plan] of Object.entries(fixed)) {
      const ref = structuredClone(plan.models[task]);
      refs[id] = { ...ref, provider: id, allowFallback: false,
        generation: { ...ref.generation, reasoningEffort: ref.generation?.reasoningEffort || 'none' } };
    }
    if (context.localRoutes) {
      const role = ['complexReasoning', 'memoryConsolidation'].includes(task) ? 'deep'
        : ['runtimePlanning', 'memoryExtraction', 'messageAnalysis'].includes(task) ? 'analysis' : 'fast';
      const route = context.localRoutes[role];
      if (route && localCatalog.some(ref => ref.model === route.model)) refs.lmstudio = {
        provider: 'lmstudio', model: route.model, allowFallback: false,
        generation: { maxTokens: Math.min(route.maxTokens, base.outputTokenLimits[task] || route.maxTokens), reasoningEffort: route.reasoningEffort },
      };
    }
    routing[task] = automaticProviderOrder(task, preferences.quality).flatMap(id => refs[id] ? [refs[id]] : []);
    for (const id of automaticProviderOrder(task, preferences.quality)) if (refs[id] && aggregatorModels[id]) {
      routing[task].push(...aggregatorRoutes(id, task, preferences.quality, base.outputTokenLimits).slice(1));
    }
    // Preserve a cheaper model as the last resort, including single-provider accounts.
    // Standard quality never escalates to a heavier model; Kimi remains an explicit OpenRouter route.
    for (const id of automaticProviderOrder(task, preferences.quality)) {
      const ref = economical[id]?.models[task];
      if (!ref || ref.provider !== id || routing[task].some(candidate => candidate.provider === id && candidate.model === ref.model)) continue;
      routing[task].push({ ...structuredClone(ref), allowFallback: false });
    }
  }
  const plan = selectAutomaticProviders({ ...base, version: 4, source: 'service', routing,
    summary: `${base.summary} Автобалансировка выбирает модели по роли задачи и текущей нагрузке; технический сбой допускает замену только внутри сохранённого пула. Отказ модерации останавливает запрос.` }, preferences.providers);
  return parseModelPolicy(plan);
}

function parseModelPolicy(raw) {
  if (!raw) return null;
  const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
  // Reading old policies never recompiles their models, limits or fallback restrictions.
  const preferences = readStoredPreferences(value.preferences, value.version);
  if (![1, 2, 3, 4].includes(value.version) || !registry.presetNames.includes(value.presetName) || !value.models
    || Object.keys(value.models).length !== Object.keys(registry.presets[value.presetName].models).length) throw new Error('Некорректная политика моделей');
  for (const task of Object.keys(registry.presets[value.presetName].models)) {
    const ref = value.models[task];
    if (!ref || !Object.hasOwn(providers, ref.provider)
      || typeof ref.model !== 'string' || !ref.model.trim() || ref.model.length > 400 || /[\r\n\0]/.test(ref.model)) throw new Error('Некорректный маршрут модели');
    if (value.version === 1 && value.preferences.censorship === 'off' && TEXT_TASKS.includes(task) && ref.allowFallback !== false) throw new Error('Свободный диалог не допускает подмену модели');
    if (value.version === 3 && (value.source === 'custom' || preferences.provider) && TEXT_TASKS.includes(task)
      && (ref.allowFallback !== false || ref.localRole || ref.modelEnvKey)) throw new Error('Некорректный закреплённый маршрут модели');
    if (value.customProvider !== undefined && (value.source !== 'custom' || !Object.hasOwn(providers, value.customProvider)
      || TEXT_TASKS.includes(task) && ref.provider !== value.customProvider)) throw new Error('Некорректный провайдер Custom');
    if (ref.generation && (!['none', 'low', 'medium', 'high'].includes(ref.generation.reasoningEffort)
      || ref.generation.maxTokens !== undefined && (!Number.isInteger(ref.generation.maxTokens) || ref.generation.maxTokens < 32 || ref.generation.maxTokens > 16384))) throw new Error('Некорректные параметры модели');
  }
  if (value.version === 4) {
    if (value.source !== 'service' || preferences.provider || value.customProvider || !value.routing
      || Object.keys(value.routing).length !== TEXT_TASKS.length) throw new Error('Некорректный пул моделей');
    const allowed = preferences.providers || Object.keys(providers).filter(id => id !== 'lmstudio');
    for (const task of TEXT_TASKS) {
      const refs = value.routing[task];
      if (!Array.isArray(refs) || !refs.length || refs.length > 16
        || new Set(refs.map(ref => `${ref?.provider}:${ref?.model}`)).size !== refs.length
        || JSON.stringify(refs[0]) !== JSON.stringify(value.models[task])) throw new Error('Некорректный пул моделей');
      for (const ref of refs) {
        if (!ref || !allowed.includes(ref.provider) || ref.allowFallback !== false
          || Object.keys(ref).some(key => !['provider', 'model', 'allowFallback', 'generation'].includes(key))
          || typeof ref.model !== 'string' || !ref.model.trim() || ref.model.length > 400 || /[\r\n\0]/.test(ref.model)
          || !ref.generation || Object.keys(ref.generation).some(key => !['maxTokens', 'reasoningEffort'].includes(key))
          || !['none', 'low', 'medium', 'high'].includes(ref.generation.reasoningEffort)
          || ref.generation.maxTokens !== undefined && (!Number.isInteger(ref.generation.maxTokens) || ref.generation.maxTokens < 32 || ref.generation.maxTokens > 16384)) throw new Error(`Некорректный маршрут пула моделей: ${task}/${ref?.provider}`);
      }
    }
  } else if (value.routing || preferences.providers) throw new Error('Некорректная версия пула моделей');
  return { ...value, preferences };
}

module.exports = { selectAutomaticProviders, getCustomPresetName, API_PROVIDERS, getStrategyCatalog, parseStrategyRequest, buildCustomPlan, SETTING_KEY, DEFAULT_PREFERENCES, QUALITY_LEVELS, TEXT_TASKS, parsePreferences, buildModelPlan, parseModelPolicy };
