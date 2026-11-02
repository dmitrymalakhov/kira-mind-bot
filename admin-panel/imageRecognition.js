'use strict';
const { SETTING_KEY, parseImageRecognitionSettings } = require('../ai/imageRecognition');
const { listLocalModels } = require('./localModels');

async function readImageRecognitionSettings(pool) {
  const { rows } = await pool.query('SELECT value FROM bot_settings WHERE key = $1', [SETTING_KEY]);
  return rows[0] ? parseImageRecognitionSettings(rows[0].value) : null;
}

function registerImageRecognitionRoutes(app, { requireAuth, createDbPool, ensureBotSettingsTable, readEnvFile }) {
  app.get('/api/image-recognition', requireAuth, async (_req, res) => {
    const pool = createDbPool();
    try {
      await ensureBotSettingsTable(pool);
      const settings = await readImageRecognitionSettings(pool);
      let models = [], connectionError = null;
      try { models = (await listLocalModels({ ...process.env, ...readEnvFile() })).filter(model => model.supportsVision); }
      catch { connectionError = 'LM Studio недоступна. Запустите локальный сервер и обновите каталог.'; }
      res.set('Cache-Control', 'no-store').json({ settings, models, connectionError });
    } catch { res.status(500).json({ error: 'Не удалось прочитать настройки распознавания изображений.' }); }
    finally { await pool.end(); }
  });
  app.post('/api/image-recognition', requireAuth, async (req, res) => {
    let settings;
    try {
      if (!req.body || Object.keys(req.body).join(',') !== 'settings') throw new Error('Передайте только settings.');
      settings = parseImageRecognitionSettings(req.body.settings);
    } catch { return res.status(400).json({ error: 'Проверьте модель, лимит и режим рассуждений.' }); }
    const pool = createDbPool();
    try {
      if (settings) {
        let models;
        try { models = await listLocalModels({ ...process.env, ...readEnvFile() }); }
        catch { return res.status(503).json({ error: 'Не удалось проверить каталог LM Studio. Настройки не сохранены.' }); }
        const model = models.find(model => model.id === settings.model || model.loadedIds.includes(settings.model));
        if (!model?.supportsVision) return res.status(400).json({ error: 'Выберите модель с поддержкой изображений из каталога LM Studio.' });
        settings.model = model.id;
      }
      await ensureBotSettingsTable(pool);
      await pool.query('INSERT INTO bot_settings (key,value,"updatedAt") VALUES ($1,$2,now()) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value,"updatedAt"=now()',
        [SETTING_KEY, JSON.stringify(settings)]);
      res.json({ success: true, settings });
    } catch { res.status(500).json({ error: 'Не удалось сохранить настройки распознавания изображений.' }); }
    finally { await pool.end(); }
  });
}
module.exports = { readImageRecognitionSettings, registerImageRecognitionRoutes };
