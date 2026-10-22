'use strict';
const { roles, SETTING_KEY, parseLocalRoutes, defaultLocalRoutes } = require('../ai/localModelRouting');

async function listLocalModels(vars, fetchImpl = globalThis.fetch) {
  const base = String(vars.LM_STUDIO_BASE_URL || 'http://host.docker.internal:1234/v1').replace(/\/v1\/?$/, '').replace(/\/$/, '');
  const response = await fetchImpl(`${base}/api/v1/models`, {
    headers: vars.LM_STUDIO_API_KEY ? { Authorization: `Bearer ${vars.LM_STUDIO_API_KEY}` } : {},
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`LM Studio: HTTP ${response.status}`);
  const data = await response.json();
  if (!Array.isArray(data.models)) throw new Error('LM Studio не вернула каталог моделей');
  return data.models.filter(m => m.type === 'llm' && typeof m.key === 'string').map(m => ({
    id: m.key, label: m.display_name || m.key, sizeBytes: m.size_bytes,
    loaded: Boolean(m.loaded_instances?.length),
    loadedIds: (m.loaded_instances || []).map(instance => instance.id),
    contextLength: m.loaded_instances?.[0]?.config?.context_length ?? null,
    uncensored: /uncensored|obliterated|heretic/i.test(`${m.key} ${m.display_name}`),
  })).sort((a, b) => Number(b.uncensored) - Number(a.uncensored) || a.label.localeCompare(b.label));
}

async function readLocalRoutes(pool, vars) {
  const { rows } = await pool.query('SELECT value FROM bot_settings WHERE key = $1', [SETTING_KEY]);
  return rows[0] ? parseLocalRoutes(rows[0].value) : defaultLocalRoutes(vars.LM_STUDIO_MODEL);
}

function resolveLocalPreset(preset, settings) {
  return { ...preset, models: Object.fromEntries(Object.entries(preset.models).map(([task, ref]) => {
    const route = settings?.[ref.localRole];
    return [task, route?.model ? { ...ref, model: route.model, modelEnvKey: undefined } : ref];
  })) };
}

function registerLocalModelRoutes(app, { requireAuth, createDbPool, ensureBotSettingsTable, readEnvFile }) {
  app.get('/api/local-models', requireAuth, async (_req, res) => {
    const pool = createDbPool();
    try {
      await ensureBotSettingsTable(pool);
      const vars = { ...process.env, ...readEnvFile() };
      const settings = await readLocalRoutes(pool, vars);
      let models = [], connectionError = null;
      try { models = await listLocalModels(vars); }
      catch { connectionError = 'LM Studio недоступна. Запустите её локальный сервер и обновите список.'; }
      res.json({ roles, settings, models, connectionError });
    } catch { res.status(500).json({ error: 'Не удалось прочитать настройки локальных моделей' }); }
    finally { await pool.end(); }
  });
  app.post('/api/local-models', requireAuth, async (req, res) => {
    let settings;
    try { settings = parseLocalRoutes(req.body?.settings); }
    catch (error) { return res.status(400).json({ error: error.message }); }
    const pool = createDbPool();
    try {
      const models = await listLocalModels({ ...process.env, ...readEnvFile() });
      const known = new Set(models.flatMap(m => [m.id, ...m.loadedIds]));
      if (Object.values(settings).some(route => !known.has(route.model))) return res.status(400).json({ error: 'Выберите текстовую модель из каталога LM Studio' });
      await ensureBotSettingsTable(pool);
      await pool.query('INSERT INTO bot_settings (key, value, "updatedAt") VALUES ($1, $2, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, "updatedAt" = now()', [SETTING_KEY, JSON.stringify(settings)]);
      res.json({ success: true, settings });
    } catch { res.status(500).json({ error: 'Не удалось сохранить модели. Проверьте соединение с LM Studio.' }); }
    finally { await pool.end(); }
  });
}
module.exports = { registerLocalModelRoutes, readLocalRoutes, listLocalModels, resolveLocalPreset };
