'use strict';
const { SETTING_KEY, DEFAULT_PREFERENCES, buildModelPlan, parseModelPolicy, parsePreferences } = require('../ai/modelPreferences');
const { readLocalRoutes, listLocalModels } = require('./localModels');

async function resources(pool, vars, memoryProfileName) {
  const localRoutes = await readLocalRoutes(pool, vars);
  let localModels = [], localError = null;
  if (vars.LM_STUDIO_MODEL || vars.LM_STUDIO_BASE_URL || Object.values(localRoutes).some(route => route.model)) {
    try { localModels = await listLocalModels(vars); }
    catch { localError = 'Локальная модель сейчас недоступна.'; }
  }
  return { vars, memoryProfileName, localRoutes, localModels, localError };
}
async function readModelPreferences(pool, vars, memoryProfileName) {
  const { rows } = await pool.query('SELECT key,value FROM bot_settings WHERE key IN ($1,$2)', [SETTING_KEY, 'AI_MODEL_PRESET']);
  const policy = parseModelPolicy(rows.find(row => row.key === SETTING_KEY)?.value);
  const context = await resources(pool, vars, memoryProfileName);
  const manualPreset = rows.find(row => row.key === 'AI_MODEL_PRESET')?.value || vars.AI_MODEL_PRESET || 'gpt-balanced';
  const inferred = { ...DEFAULT_PREFERENCES,
    cost: ['gpt-lean','lmstudio-local'].includes(manualPreset) ? 'low' : manualPreset === 'gpt-max' ? 'high' : 'medium',
    quality: ['gpt-lean','lmstudio-local'].includes(manualPreset) ? 'standard' : 'high' };
  const plans = [];
  for (const cost of ['low','medium','high']) for (const quality of ['standard','high']) {
    const preferences = { cost, quality };
    try { plans.push({ ...buildModelPlan(preferences, context), available: true }); }
    catch (error) { plans.push({ preferences, available: false, unavailableReason: error.message }); }
  }
  return { scope: 'account', scopeNote: 'Общие настройки Киры. Явный режим отдельного приложения имеет приоритет только в его диалоге.',
    mode: policy ? 'automatic' : 'manual', preferences: policy?.preferences || inferred,
    activePlan: policy, manualPreset,
    plans, localConnected: context.localModels.length > 0, localError: context.localError,
    serviceConnected: Boolean(vars.OPENAI_API_KEY || vars.GEMINI_API_KEY || vars.ZAI_API_KEY) };
}
async function saveModelPreferences(pool, vars, memoryProfileName, body) {
  const preferences = parsePreferences(body);
  const plan = buildModelPlan(preferences, await resources(pool, vars, memoryProfileName));
  // A single statement makes the selected preset and its task policy atomic, including on imported DB roles.
  await pool.query('INSERT INTO bot_settings (key,value,"updatedAt") VALUES ($1,$2,now()),($3,$4,now()) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value,"updatedAt"=now()',
    ['AI_MODEL_PRESET', plan.presetName, SETTING_KEY, JSON.stringify(plan)]);
  return { success: true, preferences, activePlan: plan };
}
function registerModelPreferenceRoutes(app, { requireAuth, createDbPool, ensureBotSettingsTable, readEnvFile, memoryProfile }) {
  app.get('/api/model-preferences', requireAuth, async (_req,res) => {
    const pool = createDbPool();
    try { await ensureBotSettingsTable(pool); const vars = { ...process.env, ...readEnvFile() };
      res.json(await readModelPreferences(pool, vars, await memoryProfile(pool, vars))); }
    catch { res.status(500).json({ error: 'Не удалось загрузить настройки моделей.' }); }
    finally { await pool.end(); }
  });
  app.put('/api/model-preferences', requireAuth, async (req,res) => {
    try { parsePreferences(req.body); } catch (error) { return res.status(400).json({ error: error.message }); }
    const pool = createDbPool();
    try { await ensureBotSettingsTable(pool); const vars = { ...process.env, ...readEnvFile() };
      res.json(await saveModelPreferences(pool, vars, await memoryProfile(pool, vars), req.body)); }
    catch (error) { const known = /^Для свободного|^Нет доступного|^Недоступен/.test(error.message);
      res.status(known ? 400 : 500).json({ error: known ? error.message : 'Не удалось сохранить настройки моделей.' }); }
    finally { await pool.end(); }
  });
}
module.exports = { readModelPreferences, saveModelPreferences, registerModelPreferenceRoutes };
