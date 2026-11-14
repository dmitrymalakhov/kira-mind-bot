'use strict';

function validQuota(quota) {
  return quota && /^\d{4}-\d\d-\d\d$/.test(quota.day) && Number.isFinite(Date.parse(quota.resetAt))
    && ['dialogue', 'background', 'images'].every(key => {
      const value = quota[key];
      return value && ['used', 'reserved', 'remaining', 'limit'].every(field => Number.isSafeInteger(value[field]) && value[field] >= 0)
        && value.remaining === Math.max(0, value.limit - value.used - value.reserved);
    });
}
function registerAccountQuotaRoutes(app, { requireAuth, operatorAuth, readEnvFile, env = process.env, fetcher = fetch, getAccountId = () => undefined }) {
  app.get('/api/account-quota', requireAuth, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (Object.keys(req.query || {}).length) return res.status(400).json({ error: 'Выбор другого аккаунта не поддерживается.' });
    try {
      const selected=getAccountId();
      if (selected) {
        const result=await operatorAuth.manageAccounts(req,'quota',{accountId:selected});
        if(!result?.ok || result.body?.version!==1 || !validQuota(result.body.quota)) throw Error('Unavailable account quota');
        return res.json({available:true,version:1,quota:result.body.quota});
      }
      let result = await operatorAuth.accountQuota(req);
      if (result === undefined) {
        if (!env.KIRA_ACCOUNT_AUTH_URL) return res.json({ available: false, reason: 'standalone' });
        const config = readEnvFile(), token = String(env.KIRA_API_TOKEN || config.KIRA_API_TOKEN || '').trim().replace(/^(['"])([\s\S]*)\1$/, '$2');
        const target = new URL(env.KIRA_ACCOUNT_AUTH_URL);
        if (!token || !['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.pathname !== '/' || target.search || target.hash) throw Error('Unavailable authority');
        const response = await fetcher(new URL('/api/v1/account/quota', target), { redirect: 'error', signal: AbortSignal.timeout(5000), headers: { Authorization: `Bearer ${token}` } });
        const text = await response.text();
        if (text.length > 16_384) throw Error('Oversized quota response');
        result = { ok: response.ok, status: response.status, body: JSON.parse(text) };
      }
      if (!result.ok || result.body?.version !== 1 || !validQuota(result.body.quota)) throw Error('Unavailable quota');
      res.json({ available: true, version: 1, quota: result.body.quota });
    } catch { res.status(503).json({ error: 'Не удалось загрузить квоты. Повторите обновление.' }); }
  });
}
module.exports = { registerAccountQuotaRoutes, validQuota };
