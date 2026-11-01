'use strict';
// Run in the finished server image. Static fixtures only; the dead proxy rejects accidental network access.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');
const { launchChromium } = require('../services/chromiumLaunch');

for (const persistent of [true, false]) test(`installed Chromium: tenant temp path with ${persistent ? 'persistent' : 'ephemeral'} browser and owned cleanup`, { timeout: 30000 }, async () => {
    const root = await fs.mkdtemp('/tmp/k-');
    const parentTemp = path.join(root, 'kt_00000000_0000_0000_0000_000000000000', 'temp');
    const previousTemp = process.env.TMPDIR;
    await fs.mkdir(parentTemp, { recursive: true });
    assert.equal(parentTemp.length, 58, 'matches deployed worker temp path length');
    process.env.TMPDIR = parentTemp;
    const profile = path.join(root, 'persistent-profile');
    let owner;
    const launch = async () => {
        let childTemp;
        owner = await launchChromium(async env => {
            childTemp = env.TMPDIR;
            const options = { env, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
                headless: true, proxy: { server: 'http://127.0.0.1:9' },
                args: ['--no-sandbox', '--disable-dev-shm-usage', '--proxy-bypass-list=<-loopback>', '--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] };
            return persistent ? chromium.launchPersistentContext(profile, options) : chromium.launch(options);
        });
        assert.equal(process.env.TMPDIR, parentTemp);
        assert.equal((await fs.stat(childTemp)).mode & 0o777, 0o700);
        return { context: persistent ? owner : await owner.newContext(), childTemp };
    };
    try {
        const first = await launch();
        const page = first.context.pages()[0] || await first.context.newPage();
        await page.setContent('<title>TEST tenant browser</title><input aria-label="TEST name">');
        await page.locator('input').fill('Anna Harness');
        assert.equal(await page.locator('input').inputValue(), 'Anna Harness');
        const jpeg = await page.screenshot({ type: 'jpeg' });
        assert.equal(jpeg.readUInt16BE(0), 0xffd8);
        assert.ok(jpeg.length > 1000);
        await first.context.addCookies([{ name: 'synthetic_preference', value: 'preserved', domain: 'fixture.example', path: '/', expires: Math.floor(Date.now() / 1000) + 3600 }]);
        await owner.close();
        await assert.rejects(fs.stat(first.childTemp), { code: 'ENOENT' });
        assert.ok((await fs.stat(parentTemp)).isDirectory());
        if (persistent) {
            const second = await launch();
            assert.notEqual(first.childTemp, second.childTemp);
            assert.equal((await second.context.cookies()).find(c => c.name === 'synthetic_preference')?.value, 'preserved');
            await owner.close();
            await assert.rejects(fs.stat(second.childTemp), { code: 'ENOENT' });
        }
    } finally {
        await owner?.close().catch(() => {});
        if (previousTemp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTemp;
        await fs.rm(root, { recursive: true, force: true });
    }
});
