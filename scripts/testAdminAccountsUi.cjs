'use strict';
// Real React component and browser; all accounts, tokens and HTTP replies are synthetic.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');

async function buildHarness(outDir) {
  const root = path.resolve(__dirname, '../admin-panel');
  const { build } = await import(pathToFileURL(require.resolve('vite', { paths: [root] })).href);
  const { default: react } = await import(pathToFileURL(require.resolve('@vitejs/plugin-react', { paths: [root] })).href);
  const result = await build({ root, configFile: false, plugins: [react(), {
    name: 'accounts-ui-fixture', resolveId(id) { if (id === 'virtual:accounts-ui') return '\0accounts-ui.tsx'; },
    load(id) { if (id === '\0accounts-ui.tsx') return `
      import React from 'react';import {createRoot} from 'react-dom/client';
      import {ThemeProvider,CssBaseline} from '@mui/material';import {theme} from '/src/theme.ts';
      import {Dashboard} from '/src/components/Dashboard.tsx';
      function App(){return <ThemeProvider theme={theme}><CssBaseline/>
        <Dashboard config={{}} onLogout={()=>{}} onConfigUpdate={()=>{}}/></ThemeProvider>}
      createRoot(document.getElementById('root')).render(<App/>);
    `; },
  }], build: { outDir, emptyOutDir: true, rollupOptions: { input: 'virtual:accounts-ui' } } });
  const output = (Array.isArray(result) ? result[0] : result).output;
  const entry = output.find(item => item.type === 'chunk' && item.isEntry);
  await fs.writeFile(path.join(outDir, 'index.html'), `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/${entry.fileName}"></script></html>`);
}
async function run(harness) {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, headless: true, args: ['--no-sandbox','--disable-dev-shm-usage'] });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 950 } });
    const origin = 'https://synthetic.example.invalid';
    let accounts = [], capacity = 3, failList = false, loseCreateResponse = true, sequence = 0, standalone = false;
    const creates = [], connections = [], createReceipts = new Map(), connectReceipts = new Map(), pairings = new Map();
    const errors = [];
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url()), endpoint = url.pathname;
      const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      if (url.origin !== origin) return route.abort();
      if (endpoint === '/api/auth/context') return json({ csrfEnabled: true, csrfToken: 'synthetic-csrf' });
      if (endpoint === '/api/accounts') {
        if (request.method() === 'GET') return failList ? json({ error: 'Синтетическая ошибка чтения' }, 503) : json({ version: 1, available: !standalone, capacity, accounts });
        assert.equal(request.headers()['x-csrf-token'], 'synthetic-csrf');
        const body = request.postDataJSON(), key = request.headers()['idempotency-key']; creates.push({ ...body, key });
        assert.ok(key);
        let account = createReceipts.get(key);
        if (!account) {
          account = { id: `${String(++sequence).padStart(8,'0')}-1111-4111-8111-111111111111`, username: body.username.toLowerCase(),
            accountState: 'active', runtimeMode: 'telegram', status: 'not_connected', bot: null, canConnectBot: true };
          accounts.push(account); createReceipts.set(key, account);
        }
        if (loseCreateResponse) { loseCreateResponse = false; return json({ error: 'Синтетическая потеря ответа. Обновите список перед повтором.' }, 503); }
        return json({ version: 1, account }, 201);
      }
      const match = /^\/api\/accounts\/([^/]+)\/(bot|pairing)$/.exec(endpoint);
      if (match) {
        const account = accounts.find(a => a.id === match[1]); assert.ok(account);
        if (match[2] === 'pairing') return json({ version: 1, account, pairing: pairings.get(account.id) || null });
        assert.equal(request.method(), 'PUT'); assert.equal(request.headers()['x-csrf-token'], 'synthetic-csrf');
        const body = request.postDataJSON(), key = request.headers()['idempotency-key']; connections.push({ id: account.id, ...body, key });
        if (body.botToken === 'synthetic-invalid') return json({ error: 'Telegram не принял токен бота.' }, 400);
        let pairing = connectReceipts.get(key);
        if (!pairing) {
          account.bot = { username: `synthetic_${sequence}_bot`, connected: false }; account.status = 'awaiting_telegram';
          pairing = { pairingUrl: `https://t.me/${account.bot.username}?start=${'a'.repeat(42)}${sequence}`, expiresAt: new Date(Date.now()+900000).toISOString() };
          pairings.set(account.id, pairing); connectReceipts.set(key, pairing);
        }
        return json({ version: 1, account, pairing }, 202);
      }
      if (endpoint === '/api/status') return json({ containers: [], serverTime: '2037-01-01T12:00:00Z' });
      if (endpoint.startsWith('/api/')) return json({ error: 'Синтетическая недоступность остальных настроек' }, 503);
      const file = endpoint.startsWith('/brand/') ? path.resolve(__dirname, '../admin-panel/public', endpoint.slice(1))
        : path.join(harness, endpoint === '/' ? 'index.html' : endpoint.slice(1));
      await route.fulfill({ contentType: endpoint.endsWith('.js') ? 'application/javascript' : endpoint.endsWith('.css') ? 'text/css' : 'text/html', body: await fs.readFile(file) });
    });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    const enterAccounts = async () => {
      if (await page.getByRole('button', { name: 'Открыть меню', exact: true }).isVisible()) await page.getByRole('button', { name: 'Открыть меню', exact: true }).click();
      await page.getByRole('button', { name: 'Аккаунты и боты', exact: true }).click();
      await page.getByRole('heading', { name: 'Аккаунты и боты', exact: true }).waitFor();
    };
    const dialog = () => page.getByRole('dialog');
    const openCreate = async username => {
      await page.getByRole('button', { name: 'Создать аккаунт', exact: true }).click();
      await page.getByLabel(/^Логин аккаунта/).fill(username);
      await page.getByLabel(/^Пароль аккаунта/).fill('synthetic-owner-password-123');
    };
    await page.goto(origin); await enterAccounts(); await page.getByText('Добавьте первую Киру', { exact: true }).waitFor();
    await page.setViewportSize({ width: 360, height: 780 });
    await openCreate('synthetic_first');
    assert.equal(await page.getByRole('dialog', { name: 'Новый аккаунт', exact: true }).evaluate(element => element.scrollWidth <= element.clientWidth), true);
    if (process.env.KIRA_UI_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.KIRA_UI_SCREENSHOT_DIR, 'accounts-create-mobile.png'), fullPage: true, animations: 'disabled' });
    await page.getByRole('button', { name: 'Создать и подключить бота', exact: true }).click();
    await page.getByText('Синтетическая потеря ответа. Обновите список перед повтором.', { exact: true }).waitFor();
    assert.equal(await page.getByLabel(/^Пароль аккаунта/).inputValue(), 'synthetic-owner-password-123');
    await page.getByRole('button', { name: 'Создать и подключить бота', exact: true }).click();
    await page.getByLabel(/^Токен BotFather/).waitFor();
    assert.equal(accounts.length, 1); assert.equal(creates[0].key, creates[1].key, 'lost create responses retain the same operation key');
    await page.getByLabel(/^Токен BotFather/).fill('synthetic-invalid');
    await page.getByRole('button', { name: 'Получить ссылку подключения', exact: true }).click();
    await page.getByRole('dialog', { name: /^Telegram-бот/ }).getByText('Telegram не принял токен бота.', { exact: true }).waitFor();
    await page.getByLabel(/^Токен BotFather/).fill('synthetic-token-one');
    await page.getByRole('button', { name: 'Получить ссылку подключения', exact: true }).click();
    await page.getByRole('link', { name: 'Подтвердить в Telegram', exact: true }).waitFor();
    assert.equal(await page.getByRole('dialog', { name: /^Telegram-бот/ }).evaluate(element => element.scrollWidth <= element.clientWidth), true);
    if (process.env.KIRA_UI_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.KIRA_UI_SCREENSHOT_DIR, 'accounts-pairing-mobile.png'), fullPage: true, animations: 'disabled' });
    const firstUrl = await page.getByRole('link', { name: 'Подтвердить в Telegram', exact: true }).getAttribute('href');
    assert.notEqual(connections[0].key, connections[1].key, 'correcting a token starts a different reviewed operation');
    await dialog().getByRole('button', { name: 'Закрыть', exact: true }).click();
    await page.reload(); await enterAccounts();
    await page.locator(`[data-account="${accounts[0].id}"]`).getByRole('button', { name: 'Продолжить подключение', exact: true }).click();
    await page.getByRole('link', { name: 'Подтвердить в Telegram', exact: true }).waitFor();
    assert.equal(await page.getByRole('link', { name: 'Подтвердить в Telegram', exact: true }).getAttribute('href'), firstUrl);
    assert.equal(connections.length, 2, 'reload restores the existing link without issuing a new bot connection');
    accounts[0] = { ...accounts[0], bot: { ...accounts[0].bot, connected: true }, status: 'ready', canConnectBot: false };
    await page.getByText(/Владелец подтверждён. Кира работает/).waitFor();
    await dialog().getByRole('button', { name: 'Закрыть', exact: true }).click();
    await page.setViewportSize({ width: 1280, height: 950 });
    await openCreate('synthetic_second'); await page.getByRole('button', { name: 'Создать и подключить бота', exact: true }).click();
    await page.getByLabel(/^Токен BotFather/).fill('synthetic-token-two');
    await page.getByRole('button', { name: 'Получить ссылку подключения', exact: true }).click();
    await page.getByRole('link', { name: 'Подтвердить в Telegram', exact: true }).waitFor();
    assert.notEqual(await page.getByRole('link', { name: 'Подтвердить в Telegram', exact: true }).getAttribute('href'), firstUrl);
    await dialog().getByRole('button', { name: 'Закрыть', exact: true }).click();
    const second = accounts[1]; second.status = 'pairing_expired'; pairings.set(second.id, null);
    await page.getByRole('button', { name: 'Обновить аккаунты', exact: true }).click();
    await page.locator(`[data-account="${second.id}"]`).getByRole('button', { name: 'Продолжить подключение', exact: true }).click();
    await page.getByLabel(/^Токен BotFather/).fill('synthetic-new-token-draft');
    failList = true; await dialog().getByRole('button', { name: 'Закрыть', exact: true }).click();
    await page.getByRole('button', { name: 'Обновить аккаунты', exact: true }).click();
    await page.getByText('Синтетическая ошибка чтения', { exact: true }).waitFor();
    assert.equal(accounts.length, 2);
    failList = false; capacity = 2; await page.getByRole('button', { name: 'Обновить аккаунты', exact: true }).click();
    await page.getByText('Достигнут лимит аккаунтов этого инстанса. Уже созданные аккаунты продолжают работать.', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Создать аккаунт', exact: true }).isDisabled(), true);
    await page.setViewportSize({ width: 360, height: 780 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    if (process.env.KIRA_UI_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.KIRA_UI_SCREENSHOT_DIR, 'accounts-mobile.png'), fullPage: true });
    await page.setViewportSize({ width: 1280, height: 950 });
    if (process.env.KIRA_UI_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.KIRA_UI_SCREENSHOT_DIR, 'accounts-desktop.png'), fullPage: true });
    standalone = true; await page.reload(); await enterAccounts();
    await page.getByText(/На этом инстансе запущена одна Кира/).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Создать аккаунт', exact: true }).isDisabled(), true);
    assert.deepEqual(errors, []);
    await context.close();
    console.log('Admin accounts UI passed: create/retry, token correction, two isolated bots, link recovery, pairing, expiration, failures, capacity and mobile layout');
  } finally { await browser.close(); }
}
async function main() {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'kira-admin-accounts-ui-'));
  try { await buildHarness(scratch); await run(scratch); }
  finally { await fs.rm(scratch, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
