'use strict';
const registry = require('../ai/background-features.json');
const { resolveBudgetMode } = require('./budgetMode');
const { buildFeatureStates } = require('../ai/backgroundFeatureState');
const { readTelegramUserCredentials } = require('../utils/telegramAccess');
const settingKey = feature => `background:${feature}`;

function resolvePreferences(rows, vars) {
  const stored = new Map(rows.map(row => [row.key, row.value]));
  return Object.fromEntries(Object.entries(registry).map(([key, definition]) => {
    const value = stored.get(settingKey(key)) ?? (key === 'reflection' ? stored.get('KiraMindBot:reflection_mode_enabled') : undefined);
    const raw = vars[definition.envKey];
    const enabled = value === undefined
      ? (raw == null || raw === '' ? !(key === 'telegramReading' && vars.KIRA_TENANT_ID)
        : ['true', '1', 'yes', 'on'].includes(String(raw).trim().toLowerCase()))
      : value === 'true';
    return [key, enabled];
  }));
}

function registerBackgroundFeatureRoutes(app, { requireAuth, createDbPool, ensureBotSettingsTable, readEnvFile }) {
  app.get('/api/background-features', requireAuth, async (_req, res) => {
    const pool = createDbPool();
    try {
      await ensureBotSettingsTable(pool);
      const keys = [...Object.keys(registry).map(settingKey), 'KiraMindBot:reflection_mode_enabled', 'BUDGET_MODE'];
      const { rows } = await pool.query('SELECT key, value FROM bot_settings WHERE key = ANY($1::text[])', [keys]);
      const mode = resolveBudgetMode(rows.find(row => row.key === 'BUDGET_MODE')?.value);
      const vars = { ...process.env, ...readEnvFile() };
      res.json({ mode, features: buildFeatureStates(resolvePreferences(rows, vars), mode, Boolean(readTelegramUserCredentials(vars))) });
    } catch {
      res.status(500).json({ error: 'Не удалось загрузить фоновые функции. Повторите попытку.' });
    } finally { await pool.end(); }
  });
  app.post('/api/background-features', requireAuth, async (req, res) => {
    const { feature, enabled } = req.body || {};
    if (typeof feature !== 'string' || !Object.prototype.hasOwnProperty.call(registry, feature) || typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'Укажите известную функцию и значение true или false' });
    }
    const pool = createDbPool();
    try {
      await ensureBotSettingsTable(pool);
      const previousRows = await pool.query('SELECT key,value FROM bot_settings WHERE key=$1', [settingKey(feature)]);
      const previous = resolvePreferences(previousRows.rows, { ...process.env, ...readEnvFile() })[feature];
      await pool.query('INSERT INTO bot_settings (key, value, "updatedAt") VALUES ($1, $2, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, "updatedAt" = now()', [settingKey(feature), String(enabled)]);
      if (previous !== enabled) {
        try {
          const actors = await pool.query('SELECT DISTINCT actor FROM product_analytics_tasks LIMIT 2');
          if (actors.rows.length === 1) await require('./productAnalyticsStore').recordPreference(pool, actors.rows[0].actor, feature, enabled);
        } catch { /* Optional telemetry never changes the result of a saved preference. */ }
      }
      res.json({ success: true, feature, enabled, message: 'Настройка сохранена. Применится в течение 5 секунд без перезапуска.' });
    } catch {
      res.status(500).json({ error: 'Не удалось сохранить функцию. Повторите попытку.' });
    } finally { await pool.end(); }
  });
}
module.exports = { registerBackgroundFeatureRoutes, resolvePreferences, buildFeatureStates };
