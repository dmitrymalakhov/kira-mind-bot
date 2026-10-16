'use strict';

const registry = require('../ai/budget-modes.json');
const parseBudgetMode = (value) => typeof value === 'string'
  && Object.prototype.hasOwnProperty.call(registry.modes, value) ? value : null;
const resolveBudgetMode = (value) => value == null
  ? registry.defaultMode : parseBudgetMode(value) || 'maximum';

function registerBudgetModeRoutes(app, { requireAuth, createDbPool, ensureBotSettingsTable }) {
  app.get('/api/budget-mode', requireAuth, async (_req, res) => {
    const pool = createDbPool();
    try {
      await ensureBotSettingsTable(pool);
      const result = await pool.query('SELECT value FROM bot_settings WHERE key = $1', [registry.settingKey]);
      res.json({ mode: resolveBudgetMode(result.rows[0]?.value) });
    } catch {
      res.status(500).json({ error: 'Не удалось загрузить режим бюджета. Повторите попытку.' });
    } finally {
      await pool.end();
    }
  });

  app.post('/api/budget-mode', requireAuth, async (req, res) => {
    const mode = parseBudgetMode(req.body?.mode);
    if (!mode) return res.status(400).json({ error: 'Неизвестный режим бюджета' });
    const pool = createDbPool();
    try {
      await ensureBotSettingsTable(pool);
      await pool.query(
        'INSERT INTO bot_settings (key, value, "updatedAt") VALUES ($1, $2, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, "updatedAt" = now()',
        [registry.settingKey, mode],
      );
      res.json({ success: true, mode, message: 'Режим бюджета сохранён. Применится в течение 5 секунд без перезапуска.' });
    } catch {
      res.status(500).json({ error: 'Не удалось сохранить режим бюджета. Повторите попытку.' });
    } finally {
      await pool.end();
    }
  });
}

module.exports = { registerBudgetModeRoutes, parseBudgetMode, resolveBudgetMode };
