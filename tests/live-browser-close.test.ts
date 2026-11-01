import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import type { Browser, BrowserContext, Page } from 'playwright';
import { LivePlaywrightAdapter } from '../services/liveBrowserPlaywright';
import type { LiveBrowserSession } from '../services/liveBrowserSession';
import { launchChromium } from '../services/chromiumLaunch';

const adapter = (context: unknown, browser: unknown) => new LivePlaywrightAdapter(
    { stop: () => { throw new Error('Intentional close must not become a user stop'); } } as unknown as LiveBrowserSession,
    browser as Browser, context as BrowserContext, new EventEmitter() as unknown as Page);

test('concurrent adapter shutdowns wait for the same context and browser close', async () => {
    let release!: () => void, contextCloses = 0, browserCloses = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const context = Object.assign(new EventEmitter(), { close: async () => { contextCloses++; await gate; context.emit('close'); } });
    const bridge = adapter(context, { close: async () => { browserCloses++; } });
    const first = bridge.close(), second = bridge.close();
    assert.equal(first, second);
    let finished = false; void second.then(() => { finished = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(finished, false); assert.equal(contextCloses, 1); assert.equal(browserCloses, 0);
    release(); await Promise.all([first, second]); await bridge.close();
    assert.equal(browserCloses, 1);
});

for (const synchronous of [true, false]) test(`adapter retries after ${synchronous ? 'sync' : 'async'} context-close failure and retains owned temp`, async t => {
    let directory = '', attempts = 0, browserCloses = 0;
    t.mock.method(console, 'error', () => {});
    const failure = new Error('Synthetic context-close failure');
    const context = await launchChromium(async env => {
        directory = env.TMPDIR!;
        return Object.assign(new EventEmitter(), { close: () => {
            if (++attempts > 1) return Promise.resolve();
            if (synchronous) throw failure;
            return Promise.reject(failure);
        } });
    });
    const bridge = adapter(context, { close: async () => { browserCloses++; } });
    try {
        await assert.rejects(bridge.close(), error => error === failure);
        assert.equal(browserCloses, 1); assert.ok((await fs.stat(directory)).isDirectory());
        await bridge.close(); assert.equal(browserCloses, 2);
        await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
    } finally { await context.close(); }
});
