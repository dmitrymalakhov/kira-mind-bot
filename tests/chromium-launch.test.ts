import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import { launchChromium } from '../services/chromiumLaunch';

test('browser child receives a private temp directory without changing account environment; cleanup waits for close', async () => {
    const parent = { TMPDIR: '/synthetic/account/long/temp', SYNTHETIC_MARKER: 'preserved' };
    let directory = '', release!: () => void, closes = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const browser = { close: async () => { closes++; await gate; } };
    const owned = await launchChromium(async env => {
        directory = env.TMPDIR!;
        assert.equal(env.SYNTHETIC_MARKER, parent.SYNTHETIC_MARKER);
        assert.notEqual(directory, parent.TMPDIR);
        assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
        return browser;
    }, parent);
    assert.equal(parent.TMPDIR, '/synthetic/account/long/temp');
    assert.equal(owned, browser);
    const closing = owned.close();
    assert.ok((await fs.stat(directory)).isDirectory(), 'child still owns temp files until close resolves');
    release(); await closing; await owned.close();
    assert.equal(closes, 1);
    await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
});

test('failed launch cleans only its own directory and concurrent launches never share one', async () => {
    let failed = '';
    const failure = new Error('Synthetic launch failure');
    await assert.rejects(launchChromium(async env => { failed = env.TMPDIR!; throw failure; }), error => error === failure);
    await assert.rejects(fs.stat(failed), { code: 'ENOENT' });
    const launch = async () => {
        let directory = '';
        const browser = await launchChromium(async env => { directory = env.TMPDIR!; return { close: async () => {} }; });
        return { browser, directory };
    };
    const [first, second] = await Promise.all([launch(), launch()]);
    assert.notEqual(first.directory, second.directory);
    await first.browser.close(); assert.ok((await fs.stat(second.directory)).isDirectory());
    await assert.rejects(fs.stat(first.directory), { code: 'ENOENT' });
    await second.browser.close();
    await assert.rejects(fs.stat(second.directory), { code: 'ENOENT' });
});

for (const synchronous of [true, false]) test(`a ${synchronous ? 'sync' : 'async'} failed close retains the directory and permits retry`, async () => {
    let directory = '', attempts = 0;
    const browser = await launchChromium(async env => {
        directory = env.TMPDIR!;
        return { close: () => {
            if (++attempts !== 1) return Promise.resolve();
            if (synchronous) throw new Error('Synthetic close failure');
            return Promise.reject(new Error('Synthetic close failure'));
        } };
    });
    await assert.rejects(browser.close(), /Synthetic close failure/);
    assert.ok((await fs.stat(directory)).isDirectory());
    await browser.close();
    await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
});

test('cleanup failure does not replace the original launch error and identifies the retained directory', async t => {
    const nativeFs = require('node:fs/promises') as typeof fs;
    const remove = nativeFs.rm.bind(nativeFs);
    let directory = '';
    const diagnostics: unknown[][] = [];
    t.mock.method(console, 'error', (...args: unknown[]) => { diagnostics.push(args); });
    t.mock.method(nativeFs, 'rm', async () => { throw new Error('Synthetic cleanup failure'); });
    const original = new Error('Synthetic original launch failure');
    try {
        await assert.rejects(launchChromium(async env => { directory = env.TMPDIR!; throw original; }), error => error === original);
        assert.ok((await fs.stat(directory)).isDirectory());
        assert.deepEqual(diagnostics, [['[BROWSER] temporary directory retained', { code: 'browser_temp_cleanup_failed', directory }]]);
    } finally { if (directory) await remove(directory, { recursive: true, force: true }); }
});
