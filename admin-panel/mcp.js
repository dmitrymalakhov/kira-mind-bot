'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const MONEY_MAKER_TOOLS = ['get_candles', 'get_price_summary', 'get_indicator', 'list_available_indicators',
  'get_technical_decision_brief', 'get_market_trap_context', 'get_market_regime', 'search_news', 'get_news_decision_brief',
  'get_news_impulse_signal', 'get_company_report', 'get_investment_events_calendar'];
class McpSettingsError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
const digest = text => crypto.createHash('sha256').update(text).digest('hex');

async function mcpSettingsFile(root, accountMode = false) {
  if (!accountMode) return path.join(root, 'mcp.json');
  // A trusted migration binding, never an account/path supplied through HTTP.
  let state;
  try { state = JSON.parse(await fs.readFile(path.join(root, 'accounts/import/current-account.json'), 'utf8')); }
  catch { throw new McpSettingsError('Не найдено подключение админки к аккаунту. Проверь локальную миграцию.', 503); }
  if (state.phase !== 'active' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(state.accountId)) throw new McpSettingsError('Некорректное подключение админки к аккаунту.', 503);
  return path.join(root, 'accounts', `kira_u_${state.accountId.replaceAll('-', '')}`, 'data/mcp.json');
}

async function readSettings(file) {
  let text;
  try {
    const stat = await fs.stat(file);
    if (stat.size > 128000) throw new Error();
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') text = '{"servers":{}}';
    else throw new McpSettingsError('Не удалось прочитать файл MCP.', 500);
  }
  try {
    const value = JSON.parse(text, (key, item) => {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error();
      return item;
    });
    if (!value || typeof value.servers !== 'object' || Array.isArray(value.servers) || !value.servers) throw new Error();
    return { value, revision: digest(text) };
  } catch { throw new McpSettingsError('Файл MCP повреждён. Существующие подключения не изменены.', 500); }
}

function publicSettings(snapshot) {
  const server = snapshot.value.servers['money-maker'];
  let url = '';
  try {
    const parsed = new URL(server?.url);
    if (!parsed.username && !parsed.password && !parsed.search && !parsed.hash) url = parsed.toString();
  } catch {}
  return { revision: snapshot.revision, configured: Boolean(server), url,
    tokenConfigured: Boolean(server?.headers && Object.entries(server.headers).some(([key, value]) => key.toLowerCase() === 'authorization' && /^Bearer\s+\S+/i.test(value))),
    toolCount: server ? Object.keys(server.tools || {}).length : 0 };
}

function connectionFromDraft(snapshot, draft) {
  if (!draft || Object.keys(draft).some(key => !['url', 'token', 'revision'].includes(key))) throw new McpSettingsError('Некорректные поля подключения.');
  let url;
  try { url = new URL(String(draft.url)); } catch { throw new McpSettingsError('Укажи полный адрес MCP Money Maker.'); }
  if (!(url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]', 'host.docker.internal'].includes(url.hostname)) ||
    url.username || url.password || url.search || url.hash || url.pathname.replace(/\/$/, '') !== '/api/stocks/money-maker/mcp') throw new McpSettingsError('Нужен HTTPS-адрес /api/stocks/money-maker/mcp без credentials и query. HTTP допустим только локально.');
  const previous = snapshot.value.servers['money-maker'];
  const oldHeader = Object.entries(previous?.headers || {}).find(([key]) => key.toLowerCase() === 'authorization')?.[1];
  if (draft.token !== undefined && (typeof draft.token !== 'string' || draft.token.length > 8000 || /[^\x21-\x7e]/.test(draft.token))) throw new McpSettingsError('Некорректный токен MCP.');
  const token = draft.token || (typeof oldHeader === 'string' ? oldHeader.replace(/^Bearer\s+/i, '') : '');
  if (!token) throw new McpSettingsError('Вставь токен, выпущенный в Money Maker.');
  if (!draft.token && previous?.url !== url.toString()) throw new McpSettingsError('При смене адреса вставь токен заново, чтобы не передать прежний токен другому серверу.');
  return { description: 'Money Maker: аналитика рынка и акций, новости с доступными текстами, отчётность, индикаторы и календарь событий. Для цены и индикаторов нужны реальные входные candles.',
    transport: 'jsonrpc', url: url.toString(), headers: { Authorization: `Bearer ${token}` },
    fixedArguments: { responseMode: 'full' }, timeoutMs: 60000,
    tools: Object.fromEntries(MONEY_MAKER_TOOLS.map(name => [name, 'read'])) };
}

function createMcpSettingsStore(fileProvider) {
  let lane = Promise.resolve();
  const serial = operation => { const result = lane.then(operation, operation); lane = result.catch(() => {}); return result; };
  return {
    async get() { return publicSettings(await readSettings(await fileProvider())); },
    async draft(draft) {
      const snapshot = await readSettings(await fileProvider());
      return connectionFromDraft(snapshot, draft);
    },
    save(draft, remove = false) { return serial(async () => {
      const file = await fileProvider();
      const snapshot = await readSettings(file);
      if (draft?.revision !== snapshot.revision) throw new McpSettingsError('Подключение уже изменилось. Обнови настройки перед сохранением.', 409);
      if (remove) delete snapshot.value.servers['money-maker'];
      else snapshot.value.servers['money-maker'] = connectionFromDraft(snapshot, draft);
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const temp = `${file}.${crypto.randomBytes(8).toString('hex')}.tmp`;
      try {
        await fs.writeFile(temp, JSON.stringify(snapshot.value, null, 2), { mode: 0o600, flag: 'wx' });
        // Manual edits made during the write must not be silently replaced.
        if ((await readSettings(file)).revision !== snapshot.revision) throw new McpSettingsError('Файл MCP изменился во время сохранения. Обнови настройки.', 409);
        await fs.rename(temp, file);
      } finally { await fs.unlink(temp).catch(() => {}); }
      return publicSettings(await readSettings(file));
    }); },
  };
}

async function probeMoneyMaker(server, request = fetch) {
  const signal = AbortSignal.timeout(15000);
  const rpc = async (method, params, id) => {
    const response = await request(server.url, { method: 'POST', redirect: 'error', signal,
      headers: { ...server.headers, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, params }) });
    if (!response.ok) { await response.body?.cancel(); throw new McpSettingsError(`Money Maker: HTTP ${response.status}. Проверь токен и доступ к MCP.`, 502); }
    if (id === undefined) { await response.body?.cancel(); return; }
    if (!response.body) throw new Error();
    const reader = response.body.getReader(); const chunks = []; let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length; if (size > 2_000_000) throw new Error();
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = JSON.parse(raw);
    if (body.jsonrpc !== '2.0' || body.id !== id || body.error || !body.result) throw new McpSettingsError('Money Maker вернул ошибку MCP.', 502);
    return body.result;
  };
  const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'kira-admin', version: '1.0.0' } }, 1);
  if (init.protocolVersion !== '2024-11-05' || !init.capabilities?.tools) throw new McpSettingsError('Сервер вернул несовместимые MCP capabilities.', 502);
  await rpc('notifications/initialized', {}, undefined);
  const page = await rpc('tools/list', {}, 2);
  if (!Array.isArray(page.tools)) throw new McpSettingsError('Money Maker не вернул каталог инструментов.', 502);
  return { success: true, toolCount: page.tools.filter(tool => MONEY_MAKER_TOOLS.includes(tool.name)).length };
}

function registerMcpRoutes(app, { requireAuth, runtimeDir, accountMode = false, probe = probeMoneyMaker }) {
  const store = createMcpSettingsStore(() => mcpSettingsFile(runtimeDir, accountMode));
  const route = handler => async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try { res.json(await handler(req)); }
    catch (error) { res.status(error instanceof McpSettingsError ? error.status : 500).json({ error: error instanceof McpSettingsError ? error.message : 'Не удалось выполнить операцию MCP. Credentials скрыты.' }); }
  };
  app.get('/api/mcp/money-maker', requireAuth, route(() => store.get()));
  app.put('/api/mcp/money-maker', requireAuth, route(req => store.save(req.body)));
  app.delete('/api/mcp/money-maker', requireAuth, route(req => store.save(req.body, true)));
  app.post('/api/mcp/money-maker/check', requireAuth, route(async req => probe(await store.draft(req.body))));
}
module.exports = { MONEY_MAKER_TOOLS, McpSettingsError, mcpSettingsFile, publicSettings, connectionFromDraft, createMcpSettingsStore, probeMoneyMaker, registerMcpRoutes };
