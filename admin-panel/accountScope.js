'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const fs = require('node:fs');
const path = require('node:path');
const {globalAdminRoute:globalRoute,instanceAdminRoute:instanceRoute}=require('./accountRoutes');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const contexts = new AsyncLocalStorage();
const currentAccountScope = () => contexts.getStore();
const currentEnvironment = () => currentAccountScope()?.env || process.env;
const message = code => ({ account_not_ready: 'Завершите подключение и запуск выбранной Киры.', settings_changed: 'Настройки изменились. Обновите их перед сохранением.',
  account_not_found: 'Выбранный аккаунт недоступен.', forbidden: 'Нет доступа оператора.', account_changed: 'Настройки аккаунта изменились. Обновите страницу.' }[code] || 'Управление выбранным аккаунтом временно недоступно.');

function createAccountScope({ operatorAuth, env = process.env, accountsRoot = path.join(env.KIRA_RUNTIME_DATA_DIR || path.join(__dirname,'..','data'), 'accounts') }) {
  const enabled = Boolean(env.KIRA_ACCOUNT_AUTH_URL);
  function validate(raw, id) {
    if (!raw || raw.id !== id || !UUID.test(raw.id) || raw.profile !== 'KiraMindBot' || !/^-?\d+$/.test(raw.ownerId)
      || !Number.isSafeInteger(Number(raw.ownerId)) || Number(raw.ownerId) === 0 || raw.directory !== 'kira_u_' + id.replaceAll('-','')
      || !/^[a-z0-9_-]{1,100}$/.test(raw.memoryNamespace) || !/^[a-z0-9_-]{1,100}$/.test(raw.memoryBotId)
      || !/^[0-9a-f]{64}$/.test(raw.settingsRevision) || !raw.env || Array.isArray(raw.env)) throw Error('Invalid account scope');
    const values = { ...raw.env };
    if (Object.values(values).some(value => typeof value !== 'string') || !/^[A-Za-z0-9_-]{1,63}$/.test(values.DB_NAME || '')
      || values.DB_USER !== raw.directory || !/^[0-9a-f]{64}$/.test(values.DB_PASSWORD || '')
      || values.KIRA_MEMORY_NAMESPACE !== raw.memoryNamespace || values.KIRA_MEMORY_BOT_ID !== raw.memoryBotId) throw Error('Invalid storage binding');
    const root = path.resolve(accountsRoot), directory = path.join(root, raw.directory);
    // Bind mounts may have another prefix in the manager. Only a derived UUID directory is remapped here.
    const rootReal = fs.realpathSync(root);
    if (fs.lstatSync(directory).isSymbolicLink() || fs.realpathSync(directory) !== path.join(rootReal,raw.directory)) throw Error('Invalid runtime binding');
    for (const item of [path.join(directory,'data'),path.join(directory,'personality.json')]) {
      if (fs.existsSync(item) && fs.lstatSync(item).isSymbolicLink()) throw Error('Invalid runtime binding');
    }
    values.KIRA_RUNTIME_DATA_DIR = path.join(directory,'data'); values.PERSONALITY_FILE = path.join(directory,'personality.json');
    return Object.freeze({ ...raw, directory, env: Object.freeze(values) });
  }
  async function resolve(req,res,next) {
    if (!enabled || globalRoute(req.path)) return next();
    const supplied = req.headers['x-kira-account-id'];
    if (supplied === 'instance') {
      if (!instanceRoute(req.path)) return res.status(409).json({ error: 'Выберите аккаунт для работы с данными Киры.', code: 'account_selection_required' });
      res.setHeader('X-Kira-Account-Id','instance'); return next();
    }
    if (typeof supplied !== 'string' || !UUID.test(supplied)) return res.status(409).json({ error: 'Выберите аккаунт в панели управления.', code: 'account_selection_required' });
    const id = supplied.toLowerCase();
    try {
      const result = await operatorAuth.manageAccounts(req,'scope',{accountId:id});
      if (!result?.ok) return res.status([400,401,403,404,409].includes(result?.status)?result.status:503).json({ error: message(result?.body?.error?.code), code: result?.body?.error?.code || 'account_scope_unavailable' });
      if (result.body?.version !== 1) throw Error('Invalid scope version');
      const validated = validate(result.body.scope,id);
      const scope=Object.freeze({...validated,request:req,assertActive:async()=>{
        const fresh=await operatorAuth.manageAccounts(req,'scope',{accountId:id});
        if(!fresh?.ok || fresh.body?.scope?.memoryNamespace!==validated.memoryNamespace || fresh.body.scope.env?.DB_NAME!==validated.env.DB_NAME) throw Error('Selected account unavailable');
      }});
      res.setHeader('X-Kira-Account-Id',id);
      return contexts.run(scope,next);
    } catch { return res.status(503).json({ error: 'Не удалось подтвердить область аккаунта. Данные другой Киры не загружались.', code:'account_scope_unavailable' }); }
  }
  function rewrite(req,res,next){
    if(!req.url.startsWith('/api/account-scopes/'))return next();
    if(req.url.split('?')[0].split('/').some(part=>part==='.'||part==='..'))return res.status(404).json({error:'Ресурс не найден.'});
    const match=/^\/api\/account-scopes\/(instance|[0-9a-f-]{36})\/(.+)$/i.exec(req.url);
    if(!enabled || !match || (match[1]!=='instance'&&!UUID.test(match[1])) || /[%\\]/.test(req.url.split('?')[0]) || req.url.split('?')[0].includes('//'))return res.status(404).json({error:'Ресурс не найден.'});
    const id=match[1].toLowerCase(),url='/api/'+match[2];
    if(globalRoute(url) || url.startsWith('/api/account-scopes/') || req.headers['x-kira-account-id']&&req.headers['x-kira-account-id'].toLowerCase()!==id)return res.status(400).json({error:'Область запроса не соответствует выбранной Кире.'});
    req.headers['x-kira-account-id']=id;req.url=url;next();
  }
  return { enabled, resolve, rewrite, current:currentAccountScope, environment:currentEnvironment, run:(value,work)=>contexts.run(value,work) };
}
module.exports = { createAccountScope, currentAccountScope, currentEnvironment, globalRoute, instanceRoute };
