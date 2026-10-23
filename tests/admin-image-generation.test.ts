import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
const express = require('../admin-panel/node_modules/express');
const { registerImageGenerationRoutes } = require('../admin-panel/imageGeneration');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j/NkAAAAASUVORK5CYII=', 'base64');

test('image admin authenticates uploads, hides secrets, persists settings and serves private references', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kira-admin-image-'));
  const previous = process.env.KIRA_RUNTIME_DATA_DIR;
  process.env.KIRA_RUNTIME_DATA_DIR = directory;
  let saved: string | undefined;
  const app = express(); app.use(express.json());
  registerImageGenerationRoutes(app, {
    requireAuth: (req: any, res: any, next: any) => req.headers.authorization === 'Bearer synthetic-admin' ? next() : res.status(401).end(),
    createDbPool: () => ({ query: async (sql: string, params: string[]) => { if (sql.startsWith('INSERT')) saved = params[1]; return { rows: saved ? [{ value: saved }] : [] }; }, end: async () => {} }),
    ensureBotSettingsTable: async () => {}, readEnvFile: () => ({ OPENAI_API_KEY: 'synthetic-private-api-key', OPENAI_BASE_URL: 'https://gateway.invalid/v1' }),
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(async () => {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(resolve));
    if (previous === undefined) delete process.env.KIRA_RUNTIME_DATA_DIR; else process.env.KIRA_RUNTIME_DATA_DIR = previous;
    await fs.rm(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/image-generation`;
  const request = (suffix = '', init: RequestInit = {}) => fetch(base + suffix, { ...init, headers: { Authorization: 'Bearer synthetic-admin', ...init.headers } });
  assert.equal((await fetch(base)).status, 401);
  assert.equal((await fetch(base + '/reference', { method: 'POST', body: png })).status, 401);
  const first = await request();
  const body = await first.json();
  assert.equal(body.reference.present, true);
  assert.equal(body.reference.source, 'default');
  const defaultHash = body.reference.sha256;
  assert.equal(body.connection.configured, true);
  assert.doesNotMatch(JSON.stringify(body), /synthetic-private-api-key/);
  const settings = { ...body.settings, quality: 'high', size: '1024x1024' };
  assert.equal((await request('', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ settings }) })).status, 200);
  assert.equal((await (await request()).json()).settings.quality, 'high');
  assert.equal((await request('/reference', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: png })).status, 200);
  const reference = await request('/reference');
  assert.equal(reference.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Buffer.from(await reference.arrayBuffer()), png);
  assert.equal((await (await request()).json()).reference.present, true);
  assert.equal((await (await request()).json()).reference.source, 'custom');
  assert.equal((await request('/reference', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: '<svg>bad</svg>' })).status, 400);
  assert.deepEqual(Buffer.from(await (await request('/reference')).arrayBuffer()), png);
  assert.equal((await request('/reference', { method: 'DELETE' })).status, 200);
  assert.equal((await request('/reference')).status, 200);
  const reset = await (await request()).json();
  assert.equal(reset.reference.source, 'default');
  assert.equal(reset.reference.sha256, defaultHash);
});
