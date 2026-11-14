'use strict';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ERRORS = {
  username_unavailable: 'Этот логин уже занят.', invalid_username: 'Логин: 3–40 латинских букв, цифр или _.',
  invalid_body: 'Проверьте заполненные поля.', capacity_reached: 'Достигнут лимит аккаунтов этого инстанса.',
  invalid_bot_token: 'Telegram не принял токен бота. Проверьте токен BotFather.',
  bot_unavailable: 'Этот бот уже занят или зарезервирован.', bot_already_connected: 'Бот уже подтверждён. Обновите список аккаунтов.',
  bot_has_webhook: 'У бота включён webhook. Отключите прежнее приложение перед подключением.',
  bot_in_use: 'Бот уже запущен другим приложением. Остановите его перед подключением.',
  telegram_unavailable: 'Не удалось связаться с Telegram. Проверьте состояние и повторите позже.',
  account_not_found: 'Аккаунт не найден. Обновите список.', account_deleted: 'Созданный аккаунт уже удалён.',
  account_restricted: 'Аккаунт ограничен.', runtime_mode_fixed: 'Этот аккаунт работает без личного Telegram-бота.',
  connection_busy: 'Подключение уже выполняется. Обновите состояние.',
  invalid_display_name: 'Название: от 1 до 80 символов, без управляющих знаков.',
  account_changed: 'Аккаунт изменился. Обновите список перед повтором.',
  confirmation_required: 'Для подтверждения введите логин выбранного аккаунта.',
  bot_not_paired: 'Сначала завершите подтверждение владельца через Start.',
  administration_unavailable: 'Обновите сервис управления аккаунтами.',
  deletion_unavailable: 'Безвозвратное удаление не настроено на сервере.',
  deletion_not_ready: 'Удаление не начато: сначала подтвердите отдельные хранилища этого аккаунта в настройках сервера.',
  idempotency_conflict: 'Параметры запроса изменились. Проверьте состояние перед повтором.',
  operation_uncertain: 'Результат не подтверждён. Обновите список и проверьте ссылку подключения.',
  unauthorized: 'Подтвердите вход оператора.', forbidden: 'У аккаунта нет доступа оператора.', rate_limited: 'Слишком много запросов. Повторите позже.',
};
function accountView(row) {
  if (!row || !UUID.test(row.id) || typeof row.username !== 'string' || row.username.length > 100
    || !['active','registered','restricted','deleting','deleted'].includes(row.accountState)
    || !['telegram','api_only'].includes(row.runtimeMode) || typeof row.status !== 'string' || row.status.length > 80
    || typeof row.canConnectBot !== 'boolean') throw Error('Invalid account');
  const bot = row.bot;
  if (bot !== null && (!bot || !/^[A-Za-z0-9_]{5,32}$/.test(bot.username) || typeof bot.connected !== 'boolean')) throw Error('Invalid bot');
  const extra={};
  if(row.displayName!==undefined){if(typeof row.displayName!=='string'||!row.displayName||[...row.displayName].length>80)throw Error('Invalid display name');extra.displayName=row.displayName;}
  if(row.revision!==undefined){if(typeof row.revision!=='string'||!/^[0-9a-f]{64}$/.test(row.revision))throw Error('Invalid revision');extra.revision=row.revision;}
  for(const field of ['canDelete','canReplaceBot'])if(row[field]!==undefined){if(typeof row[field]!=='boolean')throw Error('Invalid capability');extra[field]=row[field];}
  return { ...extra,id: row.id, username: row.username, accountState: row.accountState, runtimeMode: row.runtimeMode, status: row.status,
    canConnectBot: row.canConnectBot, bot: bot ? { username: bot.username, connected: bot.connected } : null };
}
function pairingView(row, account) {
  if (row === null) return null;
  const expected = account.bot && `https://t.me/${account.bot.username}?start=`;
  if (!row || !expected || typeof row.pairingUrl !== 'string' || !row.pairingUrl.startsWith(expected)
    || !/^[A-Za-z0-9_-]{43}$/.test(row.pairingUrl.slice(expected.length)) || !Number.isFinite(Date.parse(row.expiresAt))) throw Error('Invalid pairing');
  return { pairingUrl: row.pairingUrl, expiresAt: row.expiresAt };
}
function registerAccountsRoutes(app, { requireAuth, operatorAuth }) {
  const handler = operation => async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer');
    if (Object.keys(req.query || {}).length) return res.status(400).json({ error: 'Параметры адреса не поддерживаются.' });
    const mutation = !['list','pairing'].includes(operation), body = mutation ? req.body : {};
    const expected = ({create:['username','password'],connect:['botToken'],rename:['displayName','revision'],delete:['confirmation','revision'],replace_bot:['botToken','confirmation','revision']})[operation] || [];
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !expected.includes(key))
      || expected.some(key => typeof body[key] !== 'string') || (req.params.id && !UUID.test(req.params.id))) {
      return res.status(400).json({ error: 'Проверьте заполненные поля.' });
    }
    const requestKey = req.headers['idempotency-key'];
    if (mutation && (typeof requestKey !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(requestKey))) return res.status(400).json({ error: 'Обновите страницу перед отправкой.' });
    try {
      const result = await operatorAuth.manageAccounts(req, operation, { ...body, ...(req.params.id ? { accountId: req.params.id } : {}) }, requestKey);
      if (result === undefined) {
        if (operation === 'list') return res.json({ version: 1, available: false, accounts: [] });
        return res.status(409).json({ error: 'Сначала включите режим нескольких аккаунтов на сервере.' });
      }
      if (!result.ok) {
        const code = result.body?.error?.code;
        return res.status([400,401,403,404,409,429,502,503].includes(result.status) ? result.status : 503)
          .json({ error: ERRORS[code] || 'Сервис аккаунтов недоступен. Обновите состояние перед повтором.', code: ERRORS[code] ? code : 'accounts_unavailable' });
      }
      if (result.body?.version !== 1) throw Error('Invalid version');
      if(operation==='delete'){
        const {status,deletionId,requestedAt}=result.body;
        if(status!=='deleting'||!UUID.test(deletionId)||!Number.isFinite(Date.parse(requestedAt)))throw Error('Invalid deletion');
        return res.status(202).json({version:1,status,deletionId,requestedAt});
      }
      if (operation === 'list') {
        const { accounts, capacity } = result.body;
        if (!Array.isArray(accounts) || accounts.length > 1000 || !Number.isInteger(capacity) || capacity < 1 || capacity > 1000) throw Error('Invalid list');
        return res.json({ version: 1, available: true, capacity, accounts: accounts.map(accountView) });
      }
      const account = accountView(result.body.account);
      return res.status(operation === 'create' ? 201 : operation === 'connect' ? 202 : 200).json({ version: 1, account,
        ...(['connect','pairing'].includes(operation) ? { pairing: pairingView(result.body.pairing, account) } : {}) });
    } catch { res.status(503).json({ error: 'Результат не подтверждён. Обновите список аккаунтов перед повтором.', code: 'accounts_unavailable' }); }
  };
  app.get('/api/accounts', requireAuth, handler('list'));
  app.post('/api/accounts', requireAuth, handler('create'));
  app.put('/api/accounts/:id/bot', requireAuth, handler('connect'));
  app.get('/api/accounts/:id/pairing', requireAuth, handler('pairing'));
  app.patch('/api/accounts/:id', requireAuth, handler('rename'));
  app.delete('/api/accounts/:id', requireAuth, handler('delete'));
  app.post('/api/accounts/:id/bot/replacement', requireAuth, handler('replace_bot'));
}
module.exports = { registerAccountsRoutes };
