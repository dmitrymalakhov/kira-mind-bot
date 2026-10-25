import assert from 'node:assert/strict';
import test from 'node:test';
import { AppDataSource } from '../data-source';
import { BACKGROUND_FEATURE_KEYS, backgroundFeatureSettingKey, defaultBackgroundFeatureEnabled } from '../ai/backgroundFeatures';
import { getBackgroundFeaturePreference, isBackgroundFeatureEnabled, setBackgroundFeatureEnabled } from '../services/backgroundFeatureService';
import { setBudgetMode } from '../services/budgetModeService';
import { processBuffers } from '../services/reflectionModeService';
import { runPersonalChatMemoryIndexingCycle } from '../services/personalChatMemoryIndexer';
import * as telegram from '../services/telegram';
const { resolvePreferences, buildFeatureStates, registerBackgroundFeatureRoutes } = require('../admin-panel/backgroundFeatures');
const telegramAccess = require('../utils/telegramAccess');

test('feature preferences survive budget changes, propagate live, and gate Telegram reading', async t => {
  t.mock.method(telegramAccess, 'readTelegramUserCredentials', () => ({ apiId: 12345, apiHash: 'synthetic-hash', sessionString: 'synthetic-session' }));
  const rows = new Map<string, string>([['KiraMindBot:reflection_mode_enabled', 'false']]);
  let failWrite = false;
  let failRead = false;
  let now = Date.now();
  const descriptor = Object.getOwnPropertyDescriptor(AppDataSource, 'isInitialized')!;
  Object.defineProperty(AppDataSource, 'isInitialized', { configurable: true, value: true });
  t.after(() => Object.defineProperty(AppDataSource, 'isInitialized', descriptor));
  t.mock.method(Date, 'now', () => now);
  t.mock.method(console, 'warn', () => undefined);
  t.mock.method(AppDataSource, 'getRepository', () => ({
    async findOneBy({ key }: { key: string }) {
      if (failRead) throw new Error('synthetic read failure');
      return rows.has(key) ? { value: rows.get(key) } : null;
    },
    async upsert({ key, value }: { key: string; value: string }) {
      if (failWrite) throw new Error('synthetic write failure');
      rows.set(key, value);
    },
  }) as any);
  await setBudgetMode('normal');
  assert.equal(await getBackgroundFeaturePreference('reflection'), false, 'legacy reflection choice is preserved');
  await setBackgroundFeatureEnabled('reflection', true);
  assert.equal(await isBackgroundFeatureEnabled('reflection'), true);
  await setBackgroundFeatureEnabled('telegramReading', false);
  assert.equal(await isBackgroundFeatureEnabled('reflection'), false);
  assert.equal(await isBackgroundFeatureEnabled('personalChatMemory'), false);
  assert.equal(await isBackgroundFeatureEnabled('dmReport'), false);
  assert.equal(await getBackgroundFeaturePreference('reflection'), true, 'parent pause does not erase the child choice');
  await processBuffers({} as any);
  const init = t.mock.method(telegram, 'initTelegramClient', async () => { throw new Error('must not read Telegram'); });
  assert.equal((await runPersonalChatMemoryIndexingCycle()).enabled, false);
  assert.equal(init.mock.callCount(), 0);

  await setBackgroundFeatureEnabled('telegramReading', true);
  await setBackgroundFeatureEnabled('personalChatMemory', false);
  await setBackgroundFeatureEnabled('dmReport', true);
  await setBudgetMode('maximum');
  assert.equal(await isBackgroundFeatureEnabled('reflection'), false);
  assert.equal(await isBackgroundFeatureEnabled('dmReport'), true, 'non-AI unread report keeps its existing budget contract');
  await setBudgetMode('normal');
  assert.equal(await isBackgroundFeatureEnabled('reflection'), true);
  assert.equal(await isBackgroundFeatureEnabled('personalChatMemory'), false, 'disabled features stay disabled after resuming');

  rows.set(backgroundFeatureSettingKey('reflection'), 'false'); // admin write
  assert.equal(await getBackgroundFeaturePreference('reflection'), true);
  now += 5001;
  assert.equal(await getBackgroundFeaturePreference('reflection'), false);
  failWrite = true;
  await assert.rejects(setBackgroundFeatureEnabled('reflection', true), /write failure/);
  assert.equal(await getBackgroundFeaturePreference('reflection'), false);
  failWrite = false;
  await setBackgroundFeatureEnabled('reflection', true);
  failRead = true;
  now += 5001;
  assert.equal(await getBackgroundFeaturePreference('reflection'), false, 'database outage pauses the feature');
  failRead = false;
  now += 5001;
  assert.equal(await getBackgroundFeaturePreference('reflection'), true);
});

test('admin shows saved choices separately from effective budget and dependency state', () => {
  const vars = { PERSONAL_CHAT_MEMORY_ENABLED: 'false' };
  const preferences = resolvePreferences([], vars);
  for (const key of BACKGROUND_FEATURE_KEYS) {
    assert.equal(preferences[key], defaultBackgroundFeatureEnabled(key, vars), key);
  }
  const paused = buildFeatureStates(preferences, 'maximum');
  assert.equal(paused.find((f: any) => f.key === 'reflection').enabled, true);
  assert.equal(paused.find((f: any) => f.key === 'reflection').effective, false);
  assert.equal(paused.find((f: any) => f.key === 'reflection').blockedBy, 'budget');
  preferences.telegramReading = false;
  const selective = buildFeatureStates(preferences, 'normal');
  assert.equal(selective.find((f: any) => f.key === 'reflection').blockedBy, 'telegramReading');
  assert.equal(selective.find((f: any) => f.key === 'personalChatMemory').enabled, false);
  assert.equal(resolvePreferences([{ key: 'background:reflection', value: 'invalid' }], {}).reflection, false);
  preferences.telegramReading = true;
  const withoutSession = buildFeatureStates(preferences, 'normal', false);
  assert.equal(withoutSession.find((f: any) => f.key === 'reflection').blockedBy, 'telegram');
  assert.equal(withoutSession.find((f: any) => f.key === 'deferredFacts').effective, true);
});

test('missing personal credentials prevent background readers from opening Telegram even when preferences are enabled', async t => {
  t.mock.method(telegramAccess, 'readTelegramUserCredentials', () => null);
  const init = t.mock.method(telegram, 'initTelegramClient', async () => { throw new Error('must not open personal Telegram'); });
  await processBuffers({} as any);
  assert.equal((await runPersonalChatMemoryIndexingCycle()).enabled, false);
  assert.equal(init.mock.callCount(), 0);
});

test('feature API validates input, uses auth and never reports a failed write as saved', async () => {
  const routes = new Map<string, Function>();
  const rows = new Map<string, string>();
  const auth = () => undefined;
  let failWrite = false;
  registerBackgroundFeatureRoutes({
    get(path: string, middleware: Function, handler: Function) { assert.equal(middleware, auth); routes.set('GET', handler); },
    post(path: string, middleware: Function, handler: Function) { assert.equal(middleware, auth); routes.set('POST', handler); },
  }, {
    requireAuth: auth, ensureBotSettingsTable: async () => {}, readEnvFile: () => ({}),
    createDbPool: () => ({
      async query(sql: string, values: any[]) {
        if (sql.startsWith('SELECT')) return { rows: [...rows].map(([key, value]) => ({ key, value })) };
        if (failWrite) throw new Error('synthetic write failure');
        rows.set(values[0], values[1]); return { rows: [] };
      }, async end() {},
    }),
  });
  let status = 200;
  let body: any;
  const response = { status(value: number) { status = value; return response; }, json(value: any) { body = value; } };
  await routes.get('POST')!({ body: { feature: '__proto__', enabled: false } }, response);
  assert.equal(status, 400); assert.equal(rows.size, 0);
  await routes.get('POST')!({ body: { feature: 'reflection', enabled: 'false' } }, response);
  assert.equal(status, 400); assert.equal(rows.size, 0);
  await routes.get('POST')!({ body: { feature: 'reflection', enabled: false } }, response);
  assert.equal(body.success, true); assert.equal(rows.get('background:reflection'), 'false');
  failWrite = true;
  await routes.get('POST')!({ body: { feature: 'reflection', enabled: true } }, response);
  assert.equal(status, 500); assert.equal(rows.get('background:reflection'), 'false');
  await routes.get('GET')!({}, response);
  assert.equal(body.features.find((f: any) => f.key === 'reflection').enabled, false);
});
