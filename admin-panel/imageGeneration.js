'use strict';
const path = require('node:path');
const express = require('express');
const { SETTING_KEY, MODELS, SIZES, QUALITIES, MAX_REFERENCE_BYTES, parseImageSettings,
  defaultImageSettings, imageConnection, readReference, saveReference, deleteReference } = require('../ai/imageGeneration');

async function readImageSettings(pool, vars) {
  const { rows } = await pool.query('SELECT value FROM bot_settings WHERE key = $1', [SETTING_KEY]);
  return rows[0] ? parseImageSettings(rows[0].value) : defaultImageSettings(vars);
}
function registerImageGenerationRoutes(app, { requireAuth, createDbPool, ensureBotSettingsTable, readEnvFile }) {
  const runtimeDir = process.env.KIRA_RUNTIME_DATA_DIR || path.join(__dirname, '..', 'data');
  app.get('/api/image-generation', requireAuth, async (_req, res) => {
    const pool = createDbPool();
    try {
      await ensureBotSettingsTable(pool);
      const vars = { ...process.env, ...readEnvFile() };
      const settings = await readImageSettings(pool, vars);
      const reference = await readReference(runtimeDir);
      let configured = false;
      try { imageConnection(vars); configured = true; } catch {}
      res.set('Cache-Control', 'no-store').json({ settings, models: MODELS, sizes: SIZES, qualities: QUALITIES,
        connection: { configured, baseUrlSource: vars.OPENAI_IMAGE_BASE_URL ? 'OPENAI_IMAGE_BASE_URL' : vars.OPENAI_BASE_URL ? 'OPENAI_BASE_URL' : 'OpenAI',
          keySource: vars.OPENAI_IMAGE_API_KEY ? 'OPENAI_IMAGE_API_KEY' : 'OPENAI_API_KEY' },
        reference: { present: Boolean(reference), sha256: reference?.sha256, source: reference?.source } });
    } catch { res.status(500).json({ error: 'Не удалось прочитать настройки изображений' }); }
    finally { await pool.end(); }
  });
  app.post('/api/image-generation', requireAuth, async (req, res) => {
    let settings;
    try { settings = parseImageSettings(req.body?.settings); }
    catch (error) { return res.status(400).json({ error: error.message }); }
    const pool = createDbPool();
    try {
      await ensureBotSettingsTable(pool);
      await pool.query('INSERT INTO bot_settings (key, value, "updatedAt") VALUES ($1, $2, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, "updatedAt" = now()', [SETTING_KEY, JSON.stringify(settings)]);
      res.json({ success: true, settings });
    } catch { res.status(500).json({ error: 'Не удалось сохранить настройки изображений' }); }
    finally { await pool.end(); }
  });
  app.get('/api/image-generation/connection', requireAuth, async (_req, res) => {
    try {
      const { baseURL, apiKey } = imageConnection({ ...process.env, ...readEnvFile() });
      const response = await fetch(`${baseURL}/models`, { headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(10000), redirect: 'error' });
      if (!response.ok) return res.status(502).json({ error: `OpenAI Image gateway: HTTP ${response.status}` });
      const data = await response.json();
      res.json({ success: true, models: (data.data || []).map(m => m.id).filter(id => MODELS.includes(id)) });
    } catch { res.status(502).json({ error: 'Не удалось подключиться к OpenAI Image gateway. Проверьте ключ и адрес в API-ключах.' }); }
  });
  app.get('/api/image-generation/reference', requireAuth, async (_req, res) => {
    try {
      const reference = await readReference(runtimeDir);
      if (!reference) return res.status(404).end();
      res.set({ 'Content-Type': reference.mime, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }).send(reference.data);
    } catch { res.status(500).json({ error: 'Не удалось прочитать референс' }); }
  });
  const upload = express.raw({ type: ['image/png', 'image/jpeg', 'image/webp', 'application/octet-stream'], limit: MAX_REFERENCE_BYTES });
  app.post('/api/image-generation/reference', requireAuth, (req, res, next) => {
    upload(req, res, error => error ? res.status(400).json({ error: 'Загрузите PNG, JPEG или WebP не больше 10 MiB' }) : next());
  }, async (req, res) => {
    if (!Buffer.isBuffer(req.body)) return res.status(400).json({ error: 'Ожидается файл изображения' });
    try { await saveReference(runtimeDir, req.body); res.json({ success: true }); }
    catch { res.status(400).json({ error: 'Не удалось сохранить референс. Используйте PNG, JPEG или WebP не больше 10 MiB.' }); }
  });
  app.delete('/api/image-generation/reference', requireAuth, async (_req, res) => {
    try { await deleteReference(runtimeDir); res.json({ success: true }); }
    catch { res.status(500).json({ error: 'Не удалось удалить референс' }); }
  });
}
module.exports = { readImageSettings, registerImageGenerationRoutes };
