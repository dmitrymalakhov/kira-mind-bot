'use strict';
const crypto = require('node:crypto');
const { isIP } = require('node:net');
const session = require('express-session');

const ACCESS_COOKIE = '__Host-kira.access';
const BROWSER_COOKIE = '__Host-kira.browser';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPERATOR_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; "
  + "font-src 'self'; connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'self'";

function equal(a, b) {
  const left = Buffer.from(typeof a === 'string' ? a : ''), right = Buffer.from(typeof b === 'string' ? b : '');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
function cookie(req, name) {
  const raw = req.headers.cookie || '';
  if (raw.length > 8192) return undefined;
  const entries = raw.split(';').map(value => value.trim()).filter(value => value.startsWith(name + '='));
  const value = entries[0]?.slice(name.length + 1);
  return entries.length === 1 && /^[A-Za-z0-9_-]{32,128}$/.test(value) ? value : undefined;
}
function fields(body, names) { return body && typeof body === 'object' && !Array.isArray(body)
  && Object.keys(body).every(key => names.includes(key)) && names.every(key => typeof body[key] === 'string'); }

function createOperatorAuth({ username, password, sessionSecret, cookieName, env = process.env, fetcher = fetch }) {
  const publicRequested = env.KIRA_PUBLIC_OPERATOR_ENABLED === 'true';
  const origin = publicRequested ? new URL(env.KIRA_PUBLIC_WEB_ORIGIN || 'https://invalid.invalid').origin : '';
  const bridgeSecret = env.KIRA_OPERATOR_BRIDGE_SECRET || '';
  const enabled = publicRequested && /^[0-9a-f]{64}$/i.test(bridgeSecret) && origin !== 'https://invalid.invalid';
  const central = new URL(env.KIRA_ACCOUNT_AUTH_URL || 'http://kira-accounts:3300');
  if (!['http:', 'https:'].includes(central.protocol) || central.username || central.password || central.pathname !== '/' || central.search || central.hash) throw Error('Invalid account-auth server');
  const attempts = new Map();
  // Each middleware owns its store: express-session installs store.generate
  // with that middleware's cookie policy (public HTTPS versus private recovery).
  const options = { secret: sessionSecret, resave: false, saveUninitialized: false };
  const privateSession = session({ ...options, name: cookieName,
    cookie: { maxAge: 8 * 3600_000, httpOnly: true, sameSite: 'strict', secure: false, path: '/' } });
  const publicSession = session({ ...options, name: '__Host-kira.operator',
    cookie: { maxAge: 8 * 3600_000, httpOnly: true, sameSite: 'strict', secure: true, path: '/' } });
  const trusted = req => enabled && equal(req.headers['x-kira-operator-bridge'], bridgeSecret);
  const ip = req => trusted(req) && typeof req.headers['x-kira-client-ip'] === 'string' && isIP(req.headers['x-kira-client-ip'])
    ? req.headers['x-kira-client-ip'] : req.socket.remoteAddress || 'unknown-local-peer';
  const attemptKey = req => crypto.createHmac('sha256', sessionSecret).update(ip(req)).digest('hex');
  const csrf = req => crypto.createHmac('sha256', sessionSecret).update('kira-operator-csrf-v1\n' + req.sessionID).digest('hex');
  const failAttempt = req => {
    const key = attemptKey(req), now = Date.now(), previous = attempts.get(key);
    const row = previous && previous.until > now ? previous : { count: 0, until: now + 10 * 60_000 };
    row.count++; attempts.set(key, row);
  };
  const rateLimit = (req, res, next) => {
    const now = Date.now();
    if (attempts.size > 10_000) for (const [key, row] of attempts) if (row.until <= now) attempts.delete(key);
    const row = attempts.get(attemptKey(req));
    if (row && row.until > now && row.count >= 5) return res.status(429).json({ error: 'Слишком много попыток. Повторите позже.' });
    if (attempts.size > 10_000 && !row) return res.status(429).json({ error: 'Повторите позже.' });
    next();
  };
  const validPassword = (name, value) => equal(name, username) && equal(value, password);
  const safe = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(() => {
    if (!res.headersSent) res.status(503).json({ error: 'Панель временно недоступна. Повторите позже.' });
  });
  const internal = async (path, body) => {
    if (!enabled) return { ok: false, status: 503, body: {} };
    try {
      const response = await fetcher(new URL(path, central), { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
        headers: { 'content-type': 'application/json', 'x-kira-operator-bridge': bridgeSecret }, body: JSON.stringify({ version: 1, ...body }) });
      const text = await response.text();
      if (text.length > 16_384) return { ok: false, status: 503, body: {} };
      const parsed = JSON.parse(text);
      return { ok: response.ok, status: response.status, body: parsed };
    } catch { return { ok: false, status: 503, body: {} }; }
  };
  const account = async req => {
    const accessToken = cookie(req, ACCESS_COOKIE), browserCookie = cookie(req, BROWSER_COOKIE);
    if (!enabled || !accessToken || !browserCookie) return { authorized: false };
    const result = await internal('/internal/operator/session', { accessToken, browserCookie });
    if (!result.ok || result.body.version !== 1 || typeof result.body.authorized !== 'boolean') return { authorized: false };
    if (result.body.authorized && (!UUID.test(result.body.accountId) || !UUID.test(result.body.sessionId))) return { authorized: false };
    return result.body;
  };
  const prepare = (req, res, next) => {
    if (trusted(req)) Object.defineProperty(req, 'protocol', { configurable: true, value: 'https' });
    res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', OPERATOR_CSP);
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    next();
  };
  const csrfGuard = (req, res, next) => {
    if (!publicRequested || ['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    let expected = origin;
    if (!trusted(req)) {
      // The original loopback recovery surface remains usable. Untrusted Host
      // names never establish an alternate public origin.
      const host = String(req.headers.host || '');
      if (!/^(127\.0\.0\.1|localhost|\[::1\])(?::[0-9]+)?$/.test(host)) return res.status(403).json({ error: 'Недопустимый источник запроса.' });
      expected = `${req.socket.encrypted ? 'https' : 'http'}://${host}`;
    }
    if (req.headers.origin !== expected || (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin') || !equal(req.headers['x-csrf-token'], csrf(req))) {
      return res.status(403).json({ error: 'Обновите страницу и повторите действие.' });
    }
    next();
  };
  const requireAuth = async (req, res, next) => {
    if (req.session.authenticated === true) { req.operatorAuthentication = 'password'; return next(); }
    if (req.session.accountSessionId) {
      const current = await account(req);
      if (current.authorized && current.sessionId === req.session.accountSessionId) {
        req.operatorAccountId = current.accountId; req.operatorAuthentication = 'account'; return next();
      }
    }
    res.status(401).json({ error: 'Войдите в панель оператора.' });
  };
  const establish = (req, values) => new Promise((resolve, reject) => req.session.regenerate(error => {
    if (error) return reject(error);
    Object.assign(req.session, values, { csrfIssued: true });
    req.session.save(error => error ? reject(error) : resolve());
  }));
  const login = async (req, res) => {
    if (!fields(req.body, ['username', 'password']) || req.body.password.length > 256 || req.body.username.length > 100 || !validPassword(req.body.username, req.body.password)) {
      failAttempt(req); return res.status(401).json({ error: 'Неверный логин или пароль.' });
    }
    await establish(req, { authenticated: true }); attempts.delete(attemptKey(req));
    res.json({ success: true, csrfToken: csrf(req) });
  };
  const register = app => {
    app.get('/api/auth/context', safe(async (req, res) => {
      req.session.csrfIssued = true;
      const current = await account(req);
      res.json({ csrfToken: csrf(req), csrfEnabled: publicRequested, accountLoginEnabled: enabled,
        accountAuthorized: current.authorized === true, legacyAuthenticated: req.session.authenticated === true, accountConsoleUrl: '/account/' });
    }));
    app.post('/api/operator/login-account', rateLimit, safe(async (req, res) => {
      if (!fields(req.body || {}, [])) return res.status(400).json({ error: 'Некорректный запрос.' });
      const current = await account(req);
      if (!current.authorized) return res.status(401).json({ error: 'У этого аккаунта нет доступа оператора.' });
      await establish(req, { accountSessionId: current.sessionId });
      res.json({ success: true, csrfToken: csrf(req) });
    }));
    for (const [route, operation] of [['/api/operator/link-account', 'grant'], ['/api/operator/unlink-account', 'revoke']]) {
      app.post(route, rateLimit, safe(async (req, res) => {
        if (req.session.authenticated !== true) return res.status(401).json({ error: 'Сначала подтвердите вход действующим паролем оператора.' });
        if (!fields(req.body, ['operatorPassword', 'reauthenticationToken', 'confirmedAccountId']) || !UUID.test(req.body.confirmedAccountId)
          || req.body.operatorPassword.length > 256 || req.body.reauthenticationToken.length > 128) return res.status(400).json({ error: 'Некорректный запрос.' });
        if (!equal(req.body.operatorPassword, password)) { failAttempt(req); return res.status(401).json({ error: 'Неверный пароль оператора.' }); }
        const accessToken = cookie(req, ACCESS_COOKIE), browserCookie = cookie(req, BROWSER_COOKIE);
        if (!accessToken || !browserCookie) return res.status(401).json({ error: 'Подтвердите вход в выбранную Киру.' });
        const result = await internal('/internal/operator/grants', { accessToken, browserCookie,
          reauthenticationToken: req.body.reauthenticationToken, confirmedAccountId: req.body.confirmedAccountId, operation });
        if (!result.ok) {
          const safe = result.body?.error;
          return res.status([400, 401, 403, 409].includes(result.status) ? result.status : 503).json({
            error: safe?.code === 'reauthentication_required' ? 'Подтвердите вход в Киру ещё раз.' : 'Результат не подтверждён. Проверьте доступ аккаунта.' });
        }
        if (result.body.version !== 1 || result.body.accountId !== req.body.confirmedAccountId || result.body.operatorAccess !== (operation === 'grant')) {
          return res.status(503).json({ error: 'Результат не подтверждён. Проверьте доступ аккаунта.' });
        }
        res.json(result.body);
      }));
    }
  };
  return { prepare, csrfGuard, requireAuth: safe(requireAuth), rateLimit, login: safe(login), register, csrf,
    session: (req, res, next) => trusted(req) ? publicSession(req, res, next) : privateSession(req, res, next) };
}
module.exports = { createOperatorAuth, OPERATOR_CSP };
