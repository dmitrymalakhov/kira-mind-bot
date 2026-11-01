import assert from 'node:assert/strict';
import test, { after, type TestContext } from 'node:test';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { chromium } from 'playwright';
import type { BotContext } from '../types';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kira-startup-synthetic-'));
Object.assign(process.env, {
    BROWSER_PROFILE_DIR: path.join(scratch, 'profiles'), BROWSER_TRAJECTORY: 'false',
    KIRA_RUNTIME_DATA_DIR: path.join(scratch, 'data'), KIRA_TENANT_ID: '',
});
// Import the actual startup path only after selecting disposable synthetic storage.
const { createBrowserRun, browserAgent, cancelBrowserRunForContext, hasActiveBrowserRunForContext } =
    require('../agents/browserAgent') as typeof import('../agents/browserAgent');
const { BrowserCredentialService } = require('../services/BrowserCredentialService') as typeof import('../services/BrowserCredentialService');
const { LiveBrowserSession } = require('../services/liveBrowserSession') as typeof import('../services/liveBrowserSession');
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

type Fault = 'launch' | 'browser_handle' | 'context' | 'context_setup' | 'page' | 'page_setup' | 'credentials' | 'adapter' | 'attach' | 'registration';
function fixture(t: TestContext, persistent: boolean, fault?: Fault, closeFailure?: 'sync' | 'async', reusePage = false) {
    process.env.BROWSER_PERSISTENT_PROFILE = String(persistent);
    const failure = new Error(`synthetic startup ${fault}`);
    const closes: string[] = [], launches: string[] = [];
    const ctx = { from: { id: 94041 }, chat: { id: 94041, type: 'private' }, session: {} } as unknown as BotContext;
    const page = Object.assign(new EventEmitter(), {
        isClosed: () => false, url: () => 'about:blank',
        setDefaultTimeout: () => { if (fault === 'page_setup') throw failure; },
        setDefaultNavigationTimeout: () => {},
    });
    const close = (kind: string): Promise<void> => {
        closes.push(kind);
        if (closeFailure === 'sync') throw Error(`synthetic ${kind} close`);
        return closeFailure === 'async' ? Promise.reject(Error(`synthetic ${kind} close`)) : Promise.resolve();
    };
    const browser = { close: () => close('browser'), newContext: async () => {
        if (fault === 'context') throw failure;
        return context;
    } };
    const context = Object.assign(new EventEmitter(), {
        close: () => close('context'), browser: () => fault === 'browser_handle' ? null : browser,
        addInitScript: async () => {},
        setDefaultTimeout: () => { if (fault === 'context_setup') throw failure; },
        setDefaultNavigationTimeout: () => {},
        pages: () => reusePage ? [page] : [],
        newPage: async () => { if (fault === 'page') throw failure; return page; },
    });
    const profile = path.join(process.env.BROWSER_PROFILE_DIR!, '94041_94041');
    fs.mkdirSync(profile, { recursive: true });
    const marker = path.join(profile, 'synthetic-cookie-marker');
    fs.writeFileSync(marker, 'synthetic persisted session');
    t.mock.method(chromium, 'launchPersistentContext', async (directory: string) => {
        assert.equal(directory, profile); launches.push('persistent');
        if (fault === 'launch') throw failure;
        return context;
    });
    t.mock.method(chromium, 'launch', async () => {
        launches.push('ephemeral'); if (fault === 'launch') throw failure; return browser;
    });
    t.mock.method(BrowserCredentialService, 'parseAndSave', () => { if (fault === 'credentials') throw failure; return null; });
    t.mock.method(BrowserCredentialService, 'get', () => null);
    if (fault === 'adapter') t.mock.method(context, 'on', () => { throw failure; });
    if (fault === 'attach') t.mock.method(LiveBrowserSession.prototype, 'attach', () => { throw failure; });
    if (fault === 'registration') {
        let task: unknown;
        Object.defineProperty(ctx.session, 'activeBrowserTask', { configurable: true, get: () => task, set: value => {
            task = value; if (value) throw failure;
        } });
    }
    const start = () => createBrowserRun(ctx, 94041, 'Открой синтетическую тестовую страницу');
    return { ctx, page, browser, context, failure, closes, launches, start, marker };
}

for (const persistent of [true, false]) {
    const mode = persistent ? 'persistent' : 'ephemeral';
    for (const fault of ['launch', ...(persistent ? ['browser_handle'] : ['context']), 'context_setup', 'page', 'page_setup', 'credentials'] as Fault[]) {
        test(`${mode}: ${fault} failure closes only acquired handles and retains stored profile`, async t => {
            const f = fixture(t, persistent, fault);
            if (fault === 'browser_handle') await assert.rejects(f.start(), /Browser для persistent profile/);
            else await assert.rejects(f.start(), error => error === f.failure);
            assert.deepEqual(f.launches, [persistent ? 'persistent' : 'ephemeral']);
            assert.deepEqual(f.closes, fault === 'launch' ? [] : fault === 'context' ? ['browser'] :
                fault === 'browser_handle' ? ['context'] : ['context', 'browser']);
            assert.equal(hasActiveBrowserRunForContext(f.ctx), false);
            assert.equal(f.ctx.session.activeBrowserTask, undefined);
            assert.equal(fs.readFileSync(f.marker, 'utf8'), 'synthetic persisted session');
        });
    }
    for (const closeFailure of ['sync', 'async'] as const) for (const fault of ['page', 'credentials'] as const) {
        test(`${mode}: ${closeFailure} close failures do not replace the original ${fault} error`, async t => {
            const f = fixture(t, persistent, fault, closeFailure);
            await assert.rejects(f.start(), error => error === f.failure);
            assert.deepEqual(f.closes, ['context', 'browser']);
        });
    }
    test(`${mode}: successful registration transfers live resources to the run`, async t => {
        const f = fixture(t, persistent, undefined, undefined, persistent);
        const state = await f.start();
        t.after(() => cancelBrowserRunForContext(f.ctx));
        assert.equal(state.page, f.page); assert.equal(state.browser, f.browser); assert.equal(state.browserCtx, f.context);
        assert.equal(state.persistentProfile, persistent);
        assert.equal(hasActiveBrowserRunForContext(f.ctx), true);
        assert.equal(f.ctx.session.activeBrowserTask?.sessionId, state.id);
        assert.deepEqual(f.closes, []);
        await cancelBrowserRunForContext(f.ctx);
        assert.deepEqual(f.closes, ['context', 'browser']);
        assert.equal(fs.readFileSync(f.marker, 'utf8'), 'synthetic persisted session');
    });
}

for (const persistent of [true, false]) for (const fault of ['adapter', 'attach', 'registration'] as const) {
    test(`shared ${persistent ? 'persistent' : 'ephemeral'} run: ${fault} failure before handoff closes resources and removes partial registration`, async t => {
        const f = fixture(t, persistent, fault);
        const session = new LiveBrowserSession(94041, 'synthetic-startup-scope', 'synthetic-operation');
        t.after(() => session.dispose());
        await assert.rejects(session.runAgent(f.start), error => error === f.failure);
        assert.deepEqual(f.closes, ['context', 'browser']);
        assert.equal(hasActiveBrowserRunForContext(f.ctx), false);
        assert.equal(f.ctx.session.activeBrowserTask, undefined);
        assert.equal(fs.readFileSync(f.marker, 'utf8'), 'synthetic persisted session');
    });
}

test('a failed new attempt does not close or unregister a previously owned run', async t => {
    const previous = fixture(t, false);
    const state = await previous.start();
    t.after(() => cancelBrowserRunForContext(previous.ctx));
    const next = fixture(t, false, 'credentials');
    await assert.rejects(next.start(), error => error === next.failure);
    assert.deepEqual(previous.closes, []);
    assert.deepEqual(next.closes, ['context', 'browser']);
    assert.equal(hasActiveBrowserRunForContext(previous.ctx), true);
    assert.equal(previous.ctx.session.activeBrowserTask?.sessionId, state.id);
    await cancelBrowserRunForContext(previous.ctx);
    assert.deepEqual(previous.closes, ['context', 'browser']);
});

for (const shared of [false, true]) test(`public ${shared ? 'shared' : 'plain'} browserAgent releases partial resources and returns a safe failure`, async t => {
    const f = fixture(t, true, shared ? 'registration' : 'page');
    const operationId = 'synthetic-public-startup';
    if (shared) f.ctx.liveBrowserRequest = { operationId };
    const memory = require('../utils/agentMemoryContext') as typeof import('../utils/agentMemoryContext');
    t.mock.method(memory, 'fetchAgentMemoryContext', async () => ({ text: '', memories: [], memoryContext: '' }));
    t.mock.method(memory, 'buildMemoryContextBlock', () => '');
    t.mock.method(console, 'error', () => {});
    const result = await browserAgent(f.ctx, 'Открой синтетическую тестовую страницу');
    assert.equal(result.operationStatus, 'unknown');
    assert.equal(result.responseText, 'Не удалось завершить задачу в браузере; попробуй ещё раз позже.');
    assert.deepEqual(f.closes, ['context', 'browser']);
    assert.equal(hasActiveBrowserRunForContext(f.ctx), false);
    if (shared) {
        const { liveBrowserSessions } = require('../services/liveBrowserSession') as typeof import('../services/liveBrowserSession');
        const session = liveBrowserSessions.active(94041, '94041', operationId)!;
        t.after(() => session.dispose());
        assert.equal(session.state, 'failed');
    }
});
