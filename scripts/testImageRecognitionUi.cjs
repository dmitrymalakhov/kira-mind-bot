'use strict';
// Browser regression for the actual React editor with synthetic API responses.
// Run with PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH when using a system Chromium.
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');

async function main() {
    const root = path.resolve(__dirname, '../admin-panel');
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kira-vision-ui-'));
    let server, browser;
    try {
        const { createServer } = await import(pathToFileURL(require.resolve('vite', { paths: [root] })).href);
        const { default: react } = await import(pathToFileURL(require.resolve('@vitejs/plugin-react', { paths: [root] })).href);
        server = await createServer({ root, configFile: false, cacheDir, plugins: [react(), {
            name: 'image-recognition-test',
            resolveId(id) { if (id === '/vision-test.tsx') return '\0vision-test.tsx'; },
            load(id) { if (id === '\0vision-test.tsx') return `
                import React from 'react';
                import { createRoot } from 'react-dom/client';
                import { ImageRecognitionSettings } from '/src/components/ImageRecognitionSettings.tsx';
                createRoot(document.getElementById('root')).render(React.createElement(ImageRecognitionSettings, { onToast() {} }));
            `; },
            configureServer(vite) { vite.middlewares.use(async (req, res, next) => {
                if (req.url !== '/vision-test') return next();
                res.setHeader('Content-Type', 'text/html');
                res.end(await vite.transformIndexHtml('/vision-test', '<html><head></head><body><div id="root"></div><script type="module" src="/vision-test.tsx"></script></body></html>'));
            }); },
        }], server: { host: '127.0.0.1', port: 0 } });
        await server.listen();
        browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, headless: true });
        const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
        const errors = [];
        page.on('pageerror', error => { errors.push(error.message); console.error('Browser:', error.stack); });
        let settings = null, failSave = false, offline = false;
        const writes = [];
        await page.route('**/api/image-recognition', async route => {
            if (route.request().method() === 'POST') {
                const body = route.request().postDataJSON(); writes.push(body);
                if (failSave) return route.fulfill({ status: 500, json: { error: 'Синтетическая ошибка сохранения' } });
                settings = body.settings;
                return route.fulfill({ json: { success: true, settings } });
            }
            return route.fulfill({ json: { settings, connectionError: offline ? 'Синтетическая ошибка подключения' : null,
                models: offline ? [] : [{ id: 'synthetic/vision-a', label: 'Vision A', loaded: true }, { id: 'synthetic/vision-b', label: 'Vision B', loaded: false }] } });
        });
        const url = `http://127.0.0.1:${server.httpServer.address().port}/vision-test`;
        await page.goto(url);
        await page.getByRole('button', { name: 'Настроить: Распознавание изображений' }).click();
        const dialog = page.getByRole('dialog');
        const select = dialog.getByLabel('Модель распознавания');
        await page.waitForFunction(() => document.querySelector('[role="dialog"] [role="combobox"]')?.textContent.includes('По стратегии диалога'));
        await select.click(); await page.getByRole('option', { name: /Vision A/ }).click();
        await dialog.getByLabel('Лимит токенов').fill('3072');
        // A catalogue refresh and a close/reopen preserve a draft without saving it.
        await dialog.getByRole('button', { name: 'Обновить каталог' }).click();
        await dialog.getByRole('button', { name: 'Закрыть', exact: true }).click();
        await page.getByRole('button', { name: 'Настроить: Распознавание изображений' }).click();
        assert.equal(await dialog.getByLabel('Лимит токенов').inputValue(), '3072');
        assert.equal(writes.length, 0);
        await dialog.getByLabel('Лимит токенов').fill('20');
        assert.equal(await dialog.getByRole('button', { name: 'Сохранить модель распознавания' }).isDisabled(), true);
        await dialog.getByLabel('Лимит токенов').fill('3072');
        await Promise.all([
            page.waitForResponse(response => response.url().endsWith('/api/image-recognition') && response.request().method() === 'POST'),
            dialog.getByRole('button', { name: 'Сохранить модель распознавания' }).click(),
        ]);
        assert.deepEqual(writes[0], { settings: { provider: 'lmstudio', model: 'synthetic/vision-a', maxTokens: 3072, reasoningEffort: 'none' } });
        await page.reload();
        await page.getByRole('button', { name: 'Настроить: Распознавание изображений' }).click();
        assert.match(await select.innerText(), /Vision A/);
        assert.equal(await dialog.getByLabel('Лимит токенов').inputValue(), '3072');
        failSave = true;
        await select.click(); await page.getByRole('option', { name: /Vision B/ }).click();
        await dialog.getByRole('button', { name: 'Сохранить модель распознавания' }).click();
        await dialog.getByText('Синтетическая ошибка сохранения').waitFor();
        assert.equal(settings.model, 'synthetic/vision-a');
        failSave = false; offline = true;
        await dialog.getByRole('button', { name: 'Обновить каталог' }).click();
        await dialog.getByText('Синтетическая ошибка подключения').waitFor();
        await select.click(); await page.getByRole('option', { name: 'По стратегии диалога', exact: true }).click();
        await Promise.all([
            page.waitForResponse(response => response.url().endsWith('/api/image-recognition') && response.request().method() === 'POST'),
            dialog.getByRole('button', { name: 'Сохранить модель распознавания' }).click(),
        ]);
        assert.equal(settings, null);
        await page.getByRole('button', { name: 'Настроить: Распознавание изображений', includeHidden: true }).getByText('По стратегии диалога', { exact: true }).waitFor({ state: 'attached' });
        assert.match(await select.innerText(), /По стратегии диалога/);
        assert.equal(await dialog.getByRole('button', { name: 'Сохранить модель распознавания' }).isDisabled(), true);
        await page.setViewportSize({ width: 390, height: 844 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        if (process.env.KIRA_UI_SCREENSHOT_PATH) await page.screenshot({ path: process.env.KIRA_UI_SCREENSHOT_PATH });
        assert.deepEqual(errors, []);
        console.log('Image recognition UI: selection, persistence, draft refresh, errors, offline reset and mobile layout passed');
    } finally {
        if (browser) await browser.close();
        if (server) await server.close();
        await fs.rm(cacheDir, { recursive: true, force: true });
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
