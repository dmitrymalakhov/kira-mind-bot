'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const base = '/api/v1/web';
  const labels = { password: 'Пароль', google: 'Google', telegram: 'Telegram' };
  const state = { config: null, session: null, page: 'account', view: 0, sequence: 0, flow: null, intent: null, grant: null, operatorSubmission: null };
  const hintKey = 'kira-account-intent-v1';
  const scripts = new Map();
  let refreshing;
  const token = () => window.crypto.randomUUID();
  const node = (tag, text, className) => { const value = document.createElement(tag); if (text !== undefined) value.textContent = text; if (className) value.className = className; return value; };
  const button = (text, run, className) => { const value = node('button', text, className); value.type = 'button'; value.addEventListener('click', () => { void Promise.resolve(run()).catch(report); }); return value; };
  const title = (text, description) => { const box = node('div'); box.append(node('h2', text)); if (description) box.append(node('p', description, 'secondary')); return box; };
  const field = (caption, input) => { const label = node('label', caption); label.append(input); return label; };
  const date = value => { try { return new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value)); } catch { return ''; } };
  const provider = name => state.config.providers.find(value => value.provider === name);
  const available = name => name === 'password' || provider(name)?.available === true;
  const readHint = () => { try { const value = JSON.parse(sessionStorage.getItem(hintKey) || 'null'); return value && ['login','link','unlink','operator','operator-revoke'].includes(value.kind) && value.expiresAt > Date.now() ? value : null; } catch { return null; } };
  function saveHint(value) { state.intent = value; try { if (value) sessionStorage.setItem(hintKey, JSON.stringify(value)); else sessionStorage.removeItem(hintKey); } catch { /* Only nonsecret UI intent is cached; authentication never depends on storage. */ } }
  function notice(text, error = false, retry) { const box = $('notice'); box.replaceChildren(node('span', text)); box.className = error ? 'error' : ''; box.hidden = false; if (retry) box.append(button('Повторить', retry, 'quiet')); }
  function report(error) { notice(error?.message || 'Не удалось выполнить действие. Повтори позже.', true); }
  async function bootstrap() {
    const response = await fetch(base + '/config', { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) throw Error('Не удалось подключиться к Кире. Проверь соединение.');
    state.config = await response.json();
    for (const name of ['privacy','support']) { const url = state.config.links?.[name]; if (url?.startsWith('https://')) $(name).href = url; }
  }
  function refresh() {
    if (refreshing) return refreshing;
    refreshing = fetch(base + '/auth/refresh', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': state.config.csrfToken }, body: JSON.stringify({ version: 1 }) })
      .then(response => response.ok).catch(() => false).finally(() => { refreshing = undefined; });
    return refreshing;
  }
  async function api(path, options = {}) {
    const method = options.method || (options.body === undefined ? 'GET' : 'POST');
    const headers = new Headers(options.headers);
    const mutates = !['GET','HEAD'].includes(method);
    if (mutates) { headers.set('content-type', 'application/json'); headers.set('x-csrf-token', state.config.csrfToken); headers.set('idempotency-key', options.key || token()); }
    const request = { method, credentials: 'same-origin', cache: 'no-store', headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }), ...(options.signal ? { signal: options.signal } : {}) };
    let response;
    try {
      response = await fetch(base + path, request);
      if (response.status === 401 && (path === '/session' || path === '/auth/logout' || path.startsWith('/api/')) && await refresh()) response = await fetch(base + path, request);
    } catch (cause) {
      if (cause?.name === 'AbortError') throw cause;
      const error = Error(mutates ? 'Результат пока не подтверждён. Проверь соединение и состояние аккаунта.' : 'Нет соединения с Кирой. Попробуй ещё раз.'); error.uncertain = mutates; throw error;
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) { const error = Error(data.error?.message || 'Сервер временно недоступен. Повтори позже.'); error.status = response.status; error.code = data.error?.code; error.uncertain = mutates && response.status >= 500; throw error; }
    return data;
  }
  const own = (path, options) => api('/api/' + path, options);
  async function session(expected) {
    const current = await api('/session');
    if (expected && current.account.id !== expected) { const error = Error('Сейчас открыта другая Кира. Обнови страницу и выбери действие заново.'); error.code = 'account_changed'; throw error; }
    state.session = current;
    return current;
  }
  function loginView() {
    $('loading').hidden = true; $('workspace').hidden = true; $('login').hidden = false; $('logout').hidden = !state.config.hasBrowserSession;
    const methods = $('login-methods'); methods.replaceChildren();
    if (available('google')) methods.append(button('Войти через Google', () => startLogin('google'), 'secondary-button provider-button'));
    if (available('telegram')) { const value = button('Войти через Telegram', () => startLogin('telegram'), 'secondary-button provider-button'); value.prepend(telegramMark()); methods.append(value); }
    methods.append(button('Войти по паролю', () => { $('password-login').hidden = false; $('password-login').elements.username.focus(); }, 'quiet'));
  }
  function workspace() {
    $('loading').hidden = true; $('login').hidden = true; $('workspace').hidden = false; $('logout').hidden = false;
    $('account-name').textContent = state.session.account.username;
    $('account-state').textContent = state.session.account.runtimeState === 'ready' ? 'Память, история и настройки твоей Киры' : 'Кира подключена. Некоторые разделы могут быть доступны после запуска.';
    $('operator-entry').hidden = !state.session.operatorAccess;
    const nav = $('navigation'); nav.replaceChildren();
    for (const [id, caption] of [['account','Аккаунт'],['methods','Способы входа'],['sessions','Устройства'],['settings','Настройки'],['models','Модели'],['history','История']]) {
      const value = button(caption, () => render(id), 'quiet'); if (id === state.page) value.setAttribute('aria-current', 'page'); nav.append(value);
    }
  }
  async function render(page = state.page) {
    if (!state.session) return loginView();
    state.page = page; const version = ++state.view, expected = state.session.account.id;
    workspace(); $('content').replaceChildren(node('section', 'Загружаем…', 'card loading'));
    try {
      let content;
      if (page === 'methods') content = await methodsView(expected);
      else if (page === 'sessions') content = await sessionsView(expected);
      else if (page === 'settings') content = await settingsView(expected);
      else if (page === 'models') content = await modelsView(expected);
      else if (page === 'history') content = await historyView(expected);
      else content = await accountView(expected);
      if (version !== state.view || state.session?.account.id !== expected) return;
      $('content').replaceChildren(content);
    } catch (error) {
      if (version !== state.view) return;
      if (error.status === 401) { state.session = null; loginView(); }
      else { const box = node('section', undefined, 'card'); box.append(node('p', error.message), button('Повторить', () => render(page))); $('content').replaceChildren(box); }
    }
  }
  async function accountView(expected) {
    await session(expected);
    const box = node('section', undefined, 'card'); box.append(title('Твоя Кира', 'Все подключённые способы входа ведут в одно личное пространство.'));
    const status = state.session.account.consent.aiAllowed ? 'Согласие на AI подключено' : 'Согласие на AI пока не подключено';
    box.append(node('p', status));
    const quota = state.session.account.quota;
    if (quota?.ai) box.append(node('p', `AI-запросов осталось сегодня: ${quota.ai.remaining}`, 'secondary'));
    const consent = button('Настроить согласие на AI', () => consentView(box, expected), 'secondary-button'); box.append(consent);
    if (state.session.operatorLinkingAvailable) {
      const section = node('details'); section.append(node('summary', 'Доступ оператора'));
      section.append(node('p', 'Оператор управляет общими настройками установки. Для привязки нужны действующий пароль оператора и подтверждение текущей Киры.', 'secondary'));
      section.append(button(state.session.operatorAccess ? 'Отвязать доступ оператора' : 'Привязать доступ оператора', () => queue({ kind: state.session.operatorAccess ? 'operator-revoke' : 'operator', accountId: expected }), 'secondary-button'));
      box.append(section);
    }
    return box;
  }
  async function consentView(box, expected) {
    const data = await own('account/consents'); await session(expected);
    const section = node('section', undefined, 'card'); section.append(title('Согласие на AI', 'Выбери получателей и явно сохрани своё решение.'));
    const checks = [];
    for (const recipient of data.catalog.recipients) {
      const input = document.createElement('input'); input.type = 'checkbox'; input.checked = data.aiAllowed === true; checks.push([recipient.id,input]);
      const label = node('label', undefined, 'checkbox'); label.append(input, node('span', recipient.name)); section.append(label);
      const details = node('details'); details.append(node('summary', 'Какие данные и для чего'));
      const list = node('ul', undefined, 'checklist'); for (const text of [...recipient.data, ...recipient.purposes]) list.append(node('li', text)); details.append(list);
      const link = node('a', 'Политика получателя'); link.href = recipient.policyUrl; link.target = '_blank'; link.rel = 'noopener noreferrer'; details.append(link); section.append(details);
    }
    section.append(button('Сохранить согласие', async () => { await session(expected); const ids = checks.filter(([,input]) => input.checked).map(([id]) => id);
      await own('account/consents', { method: 'PUT', body: { version: 1, consentVersion: data.catalog.version, accepted: ids.length > 0, recipientIds: ids } });
      notice('Согласие сохранено.'); await render('account'); }));
    box.replaceWith(section);
  }
  async function methodsView(expected) {
    const data = await own('account/identities'); await session(expected);
    const box = node('section', undefined, 'card'); box.append(title('Способы входа', 'Добавленный способ открывает ту же Киру с её памятью и историей.'));
    const identities = data.identities || [];
    for (const name of ['google','telegram','password']) {
      const identity = identities.find(value => value.provider === name);
      if (name === 'password' && !identity) continue;
      const row = node('div', undefined, 'row'), info = node('div', undefined, 'row-info'); info.append(node('h3', labels[name]));
      info.append(node('span', identity ? 'Подключено' : 'Не подключено', identity ? 'badge' : 'secondary'));
      if (identity && identities.length === 1) info.append(node('p', 'Единственный способ входа. Сначала добавь другой.', 'secondary'));
      row.append(info);
      if (identity) { const remove = button('Отключить', () => queue({ kind: 'unlink', identityId: identity.id, accountId: expected }), 'danger'); remove.disabled = identities.length === 1; row.append(remove); }
      else { const add = button('Добавить', () => queue({ kind: 'link', provider: name, accountId: expected }), 'secondary-button'); add.disabled = !available(name); row.append(add); }
      box.append(row);
    }
    return box;
  }
  async function sessionsView(expected) {
    const data = await own('account/sessions'); await session(expected);
    const box = node('section', undefined, 'card'); box.append(title('Устройства и входы', 'Можно завершить отдельный вход, сохранив остальные подключения.'));
    for (const item of data.sessions || []) {
      const row = node('div', undefined, 'row'), info = node('div', undefined, 'row-info'); info.append(node('h3', item.deviceName || 'Устройство'));
      info.append(node('p', `${labels[item.provider] || 'Вход'} · ${date(item.lastUsedAt)}`, 'secondary')); if (item.current) info.append(node('span', 'Этот браузер', 'badge'));
      row.append(info, button('Выйти', async () => { await session(expected); if (item.current) return logout();
        await own(`account/sessions/${item.id}`, { method: 'DELETE', body: { version: 1 } }); notice('Вход завершён.'); await render('sessions'); }, 'quiet')); box.append(row);
    }
    return box;
  }
  async function settingsView(expected) {
    const data = await own('settings'); await session(expected);
    const box = node('section', undefined, 'card'), form = node('form', undefined, 'stack'); box.append(title('Настройки Киры'));
    const budget = document.createElement('select'); budget.setAttribute('aria-label', 'Экономия AI');
    for (const option of data.budgetModes || []) { const value = node('option', option.title); value.value = option.key; budget.append(value); } budget.value = data.budgetMode;
    form.append(field('Экономия AI', budget)); const checks = [];
    for (const feature of data.features || []) {
      const input = document.createElement('input'); input.type = 'checkbox'; input.checked = feature.enabled; const key = feature.key || feature.id;
      if (!key) continue;
      checks.push([key,input]); const label = node('label', undefined, 'checkbox'); label.append(input,node('span',feature.title || feature.name || key)); form.append(label);
    }
    const save = node('button', 'Сохранить настройки'); save.type = 'submit'; form.append(save);
    form.addEventListener('submit', async event => { event.preventDefault(); save.disabled = true; try { await session(expected);
      const background = Object.fromEntries(checks.map(([key,input]) => [key,input.checked])); await own('settings', { method: 'PATCH', body: { budgetMode: budget.value, ...(checks.length ? { background } : {}) } }); notice('Настройки сохранены.'); }
      catch (error) { report(error); } finally { save.disabled = false; } }); box.append(form); return box;
  }
  async function modelsView(expected) {
    const data = await own('model-preferences'); await session(expected);
    const box = node('section', undefined, 'card'), form = node('form', undefined, 'stack'); box.append(title('Модели', 'Автовыбор подбирает модели под задачу и выбранное качество. Изменения применяются после сохранения.'));
    if (data.mode === 'custom' || data.mode === 'manual') box.append(node('p', 'Сейчас сохранён индивидуальный выбор моделей.', 'secondary'));
    const quality = document.createElement('select'); for (const item of data.qualityLevels || []) { const option = node('option', item.title); option.value = item.id; quality.append(option); } quality.value = data.preferences?.quality || 'high';
    const service = document.createElement('select');
    for (const item of data.providers || []) { const option = node('option', item.title); option.value = item.id;
      option.disabled = item.id !== 'auto' && !(data.providerPlans || []).some(plan => plan.preferences?.provider === item.id && plan.available !== false); service.append(option); } service.value = data.preferences?.provider || 'auto';
    form.append(field('Качество', quality), field('Подключение', service));
    const save = node('button', 'Применить автовыбор'); save.type = 'submit'; form.append(save);
    form.addEventListener('submit', async event => { event.preventDefault(); save.disabled = true; try { await session(expected); await own('model-preferences', { method: 'PUT', body: { quality: quality.value, provider: service.value } }); notice('Выбор моделей сохранён.'); await render('models'); } catch (error) { report(error); } finally { save.disabled = false; } });
    box.append(form); for (const warning of data.serviceWarnings || []) box.append(node('p', warning, 'secondary')); return box;
  }
  async function historyView(expected) {
    const data = await own('history?limit=20'); await session(expected);
    const box = node('section', undefined, 'card'); box.append(title('История', 'Последние сообщения личного API-диалога с Кирой.'));
    if (!data.messages?.length) box.append(node('p', 'В этом диалоге пока нет сообщений.', 'secondary'));
    for (const item of data.messages || []) { const row = node('article', undefined, 'history-item'); row.append(node('small', `${item.role === 'assistant' ? 'Кира' : 'Ты'} · ${date(item.createdAt)}`), node('p', item.text || 'Сообщение')); box.append(row); } return box;
  }
  function telegramMark() {
    // Reuse the installed MUI Telegram mark (Apache-2.0), without remote image requests.
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox','0 0 24 24'); svg.setAttribute('aria-hidden','true'); svg.classList.add('telegram-mark');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d','M9.78 18.65l.28-4.23 7.68-6.92c.34-.31-.07-.46-.52-.19L7.74 13.3 3.64 12c-.88-.25-.89-.86.2-1.3l15.97-6.16c.73-.33 1.43.18 1.15 1.3l-2.72 12.81c-.19.91-.74 1.13-1.5.71L12.6 16.3l-1.99 1.93c-.23.23-.42.42-.83.42z'); svg.append(path); return svg;
  }
  function loadScript(key, url, ready) {
    if (ready()) return Promise.resolve(); if (scripts.has(key)) return scripts.get(key);
    const promise = new Promise((resolve,reject) => { const script = document.createElement('script'); const timer = setTimeout(() => { script.remove(); scripts.delete(key); reject(Error('Не удалось загрузить подтверждение. Проверь соединение и попробуй снова.')); }, 15000);
      const done = () => { clearTimeout(timer); resolve(); };
      if (key === 'captcha') window.__kiraCaptchaReady = done; else script.onload = done;
      script.onerror = () => { clearTimeout(timer); scripts.delete(key); reject(Error('Не удалось загрузить подтверждение.')); }; script.src = url; script.async = true; document.head.append(script); }); scripts.set(key,promise); return promise;
  }
  function active(context) { return state.flow === context && context.sequence === state.sequence; }
  function closeFlow(context) {
    if (!context || state.flow !== context) return;
    if (context.widget !== undefined && window.hcaptcha) window.hcaptcha.remove(context.widget);
    context.credentials = null; context.identityToken = null;
    state.flow = null; $('proof-dialog').close(); $('proof-content').replaceChildren(); $('proof-status').textContent = '';
  }
  function cancelFlow() {
    const current = state.flow; state.sequence++;
    if (current) { current.credentials = null; current.identityToken = null; current.controller.abort(); if (current.widget !== undefined && window.hcaptcha) window.hcaptcha.remove(current.widget); }
    state.flow = null; state.grant = null; saveHint(null); $('proof-dialog').close(); $('proof-content').replaceChildren();
    notice(current?.sending ? 'Результат пока не подтверждён. Проверь список способов входа.' : 'Подтверждение отменено.'); if (state.session) void render('methods');
  }
  function validTelegramUrl(flow) {
    const url = new URL(flow.authorizationUrl), q = url.searchParams, keys = ['client_id','redirect_uri','response_type','scope','state','nonce','code_challenge','code_challenge_method'];
    if (url.protocol !== 'https:' || url.hostname !== 'oauth.telegram.org' || url.port || url.username || url.password || url.hash || url.pathname !== '/auth'
      || [...q.keys()].some(key => !keys.includes(key) || q.getAll(key).length !== 1) || keys.some(key => !q.has(key))
      || q.get('client_id') !== provider('telegram').clientId || q.get('redirect_uri') !== location.origin + '/api/v1/web/auth/telegram/callback'
      || q.get('response_type') !== 'code' || q.get('scope') !== 'openid profile' || q.get('nonce') !== flow.nonce
      || q.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(q.get('code_challenge')) || !/^[A-Za-z0-9_-]{32,128}$/.test(q.get('state'))) throw Error('Ссылка подтверждения не прошла проверку. Попробуй позже.');
    return url.href;
  }
  function tokenNonce(jwt, nonce) { try { const encoded = jwt.split('.')[1].replace(/-/g,'+').replace(/_/g,'/'); const decoded = Uint8Array.from(atob(encoded.padEnd(encoded.length + (4 - encoded.length % 4) % 4, '=')), c => c.charCodeAt(0)); return JSON.parse(new TextDecoder().decode(decoded)).nonce === nonce; } catch { return false; } }
  async function captcha(context) {
    await loadScript('captcha', 'https://js.hcaptcha.com/1/api.js?onload=__kiraCaptchaReady&render=explicit', () => Boolean(window.hcaptcha?.render));
    if (!active(context)) return;
    $('proof-status').textContent = 'Пройди проверку, чтобы продолжить.';
    const slot = node('div', undefined, 'captcha-slot'); $('proof-content').append(slot);
    context.widget = window.hcaptcha.render(slot, { sitekey: state.config.proof.hcaptchaSiteKey, size: slot.clientWidth < 304 ? 'compact' : 'normal', theme: matchMedia('(prefers-color-scheme:dark)').matches ? 'dark' : 'light',
      callback: value => { if (active(context)) void finish(context,value); }, 'expired-callback': () => { if (active(context)) $('proof-status').textContent = 'Проверка истекла. Пройди её ещё раз.'; },
      'error-callback': () => { if (active(context)) $('proof-status').textContent = 'Не удалось загрузить проверку. Отмени и попробуй ещё раз.'; } });
  }
  async function google(context) {
    await loadScript('google','https://accounts.google.com/gsi/client?hl=ru', () => Boolean(window.google?.accounts?.id)); if (!active(context)) return;
    const slot = node('div', undefined, 'google-slot'); $('proof-content').append(slot);
    window.google.accounts.id.initialize({ client_id: provider('google').clientId, nonce: context.flow.nonce, auto_select: false, callback: response => {
      if (!active(context) || !tokenNonce(response.credential,context.flow.nonce)) return;
      context.identityToken = response.credential; slot.remove(); void captcha(context).catch(report);
    } });
    window.google.accounts.id.renderButton(slot, { type: 'standard', theme: 'outline', size: 'large', text: 'continue_with', width: 320, locale: 'ru' });
    $('proof-status').textContent = 'Выбери аккаунт Google.';
  }
  async function flow(purpose, name, grant, credentials) {
    const previous = state.flow; if (previous) closeFlow(previous);
    const context = { sequence: ++state.sequence, purpose, provider: name, controller: new AbortController(), credentials, flow: null, sending: false }; state.flow = context;
    $('proof-title').textContent = purpose === 'link' ? `Добавить ${labels[name]}` : purpose === 'reauthenticate' ? 'Подтверди текущий вход' : `Войти через ${labels[name]}`;
    $('proof-description').textContent = purpose === 'link' ? 'Этот способ будет связан с текущей Кирой.' : 'Подтверди вход и пройди проверку.';
    $('proof-content').replaceChildren(); $('proof-status').textContent = 'Подготавливаем подтверждение…'; if (!$('proof-dialog').open) $('proof-dialog').showModal();
    try {
      if (purpose !== 'login') await session(state.intent.accountId);
      if (!active(context)) return;
      context.flow = await api('/auth/challenges', { body: { version:1,provider:name,purpose,...(grant ? { reauthenticationToken: grant } : {}) }, signal: context.controller.signal });
      if (!active(context)) return;
      saveHint({ ...(state.intent || { kind: 'login', provider: name }), flowId: context.flow.flowId, flowProvider: name, expiresAt: Date.now() + 300000 });
      if (name === 'telegram') { const url = validTelegramUrl(context.flow); location.assign(url); return; }
      if (name === 'google') await google(context); else await captcha(context);
    } catch (error) { if (active(context)) { closeFlow(context); report(error); } }
  }
  async function finish(context, captchaToken, recovery = false) {
    if (!active(context) || context.sending) return;
    context.sending = true; $('proof-status').textContent = 'Проверяем подтверждение…';
    try {
      if (context.purpose !== 'login') await session(state.intent.accountId);
      if (!active(context)) return;
      const result = await api('/auth/' + context.provider, { body: { version:1,flowId:context.flow.flowId,
        ...(recovery ? {} : { captchaToken, ...(context.identityToken ? { identityToken: context.identityToken } : {}), ...(context.credentials || {}) }) }, signal: context.controller.signal });
      context.credentials = null; context.identityToken = null;
      if (!active(context)) return;
      const expected = state.intent?.accountId;
      closeFlow(context);
      if (result.reauthenticationToken) { state.grant = { value:result.reauthenticationToken,expiresAt:Date.parse(result.expiresAt),accountId:expected }; await applyIntent(); }
      else if (result.provider && result.id) { await session(expected); const methods = await own('account/identities');
        if (!methods.identities.some(item => item.id === result.id && item.provider === result.provider)) throw Error('Результат ещё не подтверждён. Проверь список способов входа.');
        saveHint(null); state.grant = null; notice(`${labels[result.provider]} подключён к твоей Кире.`); await render('methods'); }
      else { state.session = null; saveHint(null); await session(); notice('Вход выполнен.'); await render('account'); }
    } catch (error) {
      context.credentials = null; context.identityToken = null;
      if (active(context)) { closeFlow(context); state.grant = null; report(error); if (state.session) await render('methods'); }
    }
  }
  async function startLogin(name, credentials) { saveHint({ kind:'login',provider:name,expiresAt:Date.now()+300000 }); await flow('login',name,undefined,credentials); }
  async function queue(intent) {
    const sequence = ++state.sequence, view = state.view;
    await session(intent.accountId); if (sequence !== state.sequence || view !== state.view) return;
    saveHint({ ...intent,expiresAt:Date.now()+300000 }); state.grant = null;
    const data = await own('account/identities');
    if (sequence !== state.sequence || view !== state.view) return;
    $('proof-content').replaceChildren(); $('proof-title').textContent = 'Подтверди текущий вход'; $('proof-description').textContent = 'Выбери уже подключённый способ.'; $('proof-status').textContent = '';
    if (!$('proof-dialog').open) $('proof-dialog').showModal();
    for (const item of data.identities) {
      if (item.provider === 'password') $('proof-content').append(button('Пароль', () => passwordReauth(intent.accountId), 'secondary-button'));
      else if (available(item.provider)) $('proof-content').append(button(labels[item.provider], () => flow('reauthenticate',item.provider), 'secondary-button'));
    }
  }
  function passwordReauth(expected) {
    const sequence = state.sequence;
    const form = node('form',undefined,'stack'), input = document.createElement('input'); input.type='password'; input.autocomplete='current-password'; input.required=true; input.minLength=12; input.maxLength=256;
    form.append(field('Текущий пароль',input)); const submit=node('button','Продолжить');submit.type='submit';form.append(submit);
    form.addEventListener('submit',event=>{event.preventDefault();const password=input.value;input.value='';void session(expected).then(()=>{if(sequence===state.sequence&&state.intent)return flow('reauthenticate','password',undefined,{username:state.session.account.username,password});}).catch(error=>{if(sequence===state.sequence)report(error);});});
    $('proof-content').replaceChildren(form);input.focus();
  }
  async function applyIntent() {
    const intent = state.intent, grant = state.grant, sequence = state.sequence;
    const current = () => state.intent === intent && state.grant === grant && state.sequence === sequence;
    if (!intent || !grant || grant.expiresAt <= Date.now()) throw Error('Подтверди вход ещё раз.');
    await session(intent.accountId);
    if (!current()) return;
    if (intent.kind === 'link') { state.grant = null; await flow('link',intent.provider,grant.value); }
    else if (intent.kind === 'unlink') { await own(`account/identities/${intent.identityId}`,{method:'DELETE',body:{version:1,reauthenticationToken:grant.value}}); if (!current()) return; state.grant=null;saveHint(null);notice('Способ входа отключён.');await render('methods'); }
    else if (intent.kind === 'operator' || intent.kind === 'operator-revoke') {
      $('operator-target-name').textContent=state.session.account.username;$('operator-target-id').textContent=state.session.account.id;
      $('operator-submit').textContent=intent.kind==='operator'?'Подтвердить привязку':'Подтвердить отключение';$('operator-status').textContent='';$('operator-dialog').showModal();
    }
  }
  async function operatorRequest(path, body, csrf) {
    let response;try { response=await fetch('/operator/api/'+path,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json','x-csrf-token':csrf},body:JSON.stringify(body)}); }
    catch { throw Error('Результат не подтверждён. Проверь доступ аккаунта.'); }
    const data=await response.json().catch(()=>({}));if(!response.ok)throw Error(data.error||'Результат не подтверждён. Проверь доступ аккаунта.');return data;
  }
  async function logout() {
    // The server revokes only this browser's recorded canonical family even
    // when both access and refresh credentials are no longer usable.
    await api('/auth/logout',{body:{version:1}});state.sequence++;state.view++;state.session=null;state.grant=null;saveHint(null);$('password-login').reset();await bootstrap();loginView();notice('Вход в этом браузере завершён.');
  }
  async function resume() {
    const hint=readHint();state.intent=hint;
    const pending=await api('/auth/pending'+(hint?.flowId?'?flowId='+encodeURIComponent(hint.flowId):''));
    const value=pending.pending;if(!value || (hint?.flowId&&hint.flowId!==value.flowId)) { if(hint){saveHint(null);notice('Подтверждение не завершено. Можно начать ещё раз.');}return; }
    if(value.purpose==='login'&&state.session){saveHint(null);return;}
    if(value.consumed&&!value.outcomeAvailable){saveHint(null);notice('Результат старого подтверждения не удалось восстановить. Начни вход ещё раз.',true);return;}
    if(value.purpose!=='login'&&(!state.session||!hint||hint.accountId!==state.session.account.id)){saveHint(null);return;}
    if (!value.outcomeAvailable && !(value.provider==='telegram'&&value.callbackReceived)) return;
    const context={sequence:++state.sequence,purpose:value.purpose,provider:value.provider,flow:{flowId:value.flowId},controller:new AbortController(),sending:false};state.flow=context;
    $('proof-title').textContent='Продолжить подтверждение';$('proof-description').textContent='Проверь вход, чтобы закончить действие.';$('proof-content').replaceChildren();$('proof-dialog').showModal();
    if(value.outcomeAvailable)await finish(context,undefined,true);else await captcha(context);
  }
  $('password-login').addEventListener('submit',event=>{event.preventDefault();const form=event.currentTarget;const credentials={username:form.elements.username.value,password:form.elements.password.value};form.elements.password.value='';void startLogin('password',credentials).catch(report);});
  $('proof-cancel').addEventListener('click',cancelFlow);$('proof-dialog').addEventListener('cancel',event=>{event.preventDefault();cancelFlow();});
  $('logout').addEventListener('click',()=>{void logout().catch(report);});
  function cancelOperator() { state.sequence++; if(state.operatorSubmission)state.operatorSubmission.cancelled=true; $('operator-dialog').close();state.grant=null;saveHint(null);$('operator-form').reset();notice(state.operatorSubmission?.sending?'Результат пока не подтверждён. Проверь доступ аккаунта.':'Привязка отменена.'); }
  $('operator-cancel').addEventListener('click',cancelOperator);
  $('operator-dialog').addEventListener('cancel',event=>{event.preventDefault();cancelOperator();});
  $('operator-form').addEventListener('submit',async event=>{
    event.preventDefault();const form=event.currentTarget,intent=state.intent,grant=state.grant,submit=$('operator-submit'),submission={sequence:state.sequence,cancelled:false,sending:false};state.operatorSubmission=submission;submit.disabled=true;
    const currentIntent=()=>state.operatorSubmission===submission&&!submission.cancelled&&state.intent===intent&&state.sequence===submission.sequence&&$('operator-dialog').open;
    const username=form.elements.username.value,password=form.elements.password.value;form.elements.password.value='';
    try {
      if(!intent||!grant||grant.expiresAt<=Date.now())throw Error('Подтверди вход в Киру ещё раз.');await session(intent.accountId);if(!currentIntent())return;$('operator-status').textContent='Проверяем доступ…';
      const context=await fetch('/operator/api/auth/context',{credentials:'same-origin',cache:'no-store'}).then(response=>{if(!response.ok)throw Error('Панель оператора пока недоступна.');return response.json();});
      if(!currentIntent())return;
      const signed=await operatorRequest('login',{username,password},context.csrfToken);if(!signed.success)throw Error('Не удалось подтвердить пароль оператора.');
      if(!currentIntent())return;
      await session(intent.accountId);
      if(!currentIntent())return;submission.sending=true;
      await operatorRequest('operator/'+(intent.kind==='operator'?'link-account':'unlink-account'),{operatorPassword:password,reauthenticationToken:grant.value,confirmedAccountId:intent.accountId},signed.csrfToken);
      if(!currentIntent())return;
      const current=await session(intent.accountId),wanted=intent.kind==='operator';if(!currentIntent())return;if(current.operatorAccess!==wanted)throw Error('Результат не подтверждён. Проверь доступ аккаунта.');
      state.grant=null;saveHint(null);$('operator-dialog').close();form.reset();notice(wanted?'Доступ оператора привязан.':'Привязка доступа оператора отключена.');await render('account');
    }catch(error){if(currentIntent()){$('operator-status').textContent=error.message;state.grant=null;try{await session(intent?.accountId);}catch{} }}
    finally{if(state.operatorSubmission===submission){state.operatorSubmission=null;submit.disabled=false;}}
  });
  async function start() {
    try { await bootstrap();try{await session();workspace();await render('account');}catch(error){if(error.status===401)loginView();else throw error;}await resume(); }
    catch(error){$('loading').hidden=true;notice(error.message,true,start);}
  }
  void start();
})();
