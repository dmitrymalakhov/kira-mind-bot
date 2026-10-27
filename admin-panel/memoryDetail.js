'use strict';

function registerMemoryDetailRoute(app, { requireAuth, getMemoryProfile, getMemoryUserId, normalizeMemoryDomain, fetchExistingMemoryPayload, normalizeMemoryPoint }) {
  app.get('/api/memory/:domain/:id', requireAuth, async (req, res) => {
    try {
      const profile = getMemoryProfile(req.query.profile);
      const userId = getMemoryUserId(profile, req.query.userId);
      const domain = normalizeMemoryDomain(req.params.domain);
      const id = String(req.params.id || '').trim();
      if (!id) return res.status(400).json({ error: 'Укажите ID воспоминания' });
      const payload = await fetchExistingMemoryPayload(profile, domain, id);
      if (!payload || userId && String(payload.userId || '') !== userId) {
        return res.status(404).json({ error: 'Воспоминание не найдено' });
      }
      res.set('Cache-Control', 'private, no-store');
      res.json({ record: normalizeMemoryPoint({ id, payload }, domain) });
    } catch (error) {
      res.status(error.statusCode || 500).json({ error: 'Не удалось прочитать воспоминание' });
    }
  });
}
module.exports = { registerMemoryDetailRoute };
