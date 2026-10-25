import assert from 'node:assert/strict';
import test, { TestContext } from 'node:test';
import { AppDataSource } from '../data-source';
import { parseSettingsPatch } from '../api/settings';
import { readUserSettings, updateUserSettings } from '../services/userSettingsService';
import { cacheBackgroundFeaturePreferences, getBackgroundFeaturePreference, isBackgroundFeatureEnabled } from '../services/backgroundFeatureService';
import { cacheBudgetMode, getBudgetMode } from '../services/budgetModeService';
import { BACKGROUND_FEATURE_KEYS, defaultBackgroundFeatureEnabled } from '../ai/backgroundFeatures';
const { readTelegramUserCredentials } = require('../utils/telegramAccess');
const { requiresTelegramSession } = require('../ai/backgroundFeatureState');

function environment(t: TestContext, values: Record<string, string | undefined>) {
    const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
    const apply = (vars: typeof values) => {
        for (const [key, value] of Object.entries(vars)) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
    };
    apply(values); t.after(() => apply(previous));
}

function fixture(t: TestContext) {
    environment(t, { KIRA_TENANT_ID: 'synthetic-account', KIRA_BOT_TOKEN: 'synthetic-bot-token',
        TELEGRAM_API_ID: undefined, TELEGRAM_API_HASH: undefined, TELEGRAM_SESSION_STRING: undefined,
        TELEGRAM_BACKGROUND_READ_ENABLED: undefined });
    const rows = new Map<string, string>();
    let readFailure = false;
    let writeFailure = false;
    let writes = 0;
    const descriptor = Object.getOwnPropertyDescriptor(AppDataSource, 'isInitialized')!;
    Object.defineProperty(AppDataSource, 'isInitialized', { configurable: true, value: true });
    t.after(() => Object.defineProperty(AppDataSource, 'isInitialized', descriptor));
    t.mock.method(AppDataSource, 'getRepository', () => ({
        async findBy() {
            if (readFailure) throw new Error('synthetic private database failure');
            return [...rows].map(([key, value]) => ({ key, value }));
        },
        async findOneBy({ key }: { key: string }) { return rows.has(key) ? { value: rows.get(key) } : null; },
        async upsert(values: { key: string; value: string }[]) {
            writes++;
            if (writeFailure) throw new Error('synthetic private write failure');
            for (const { key, value } of values) rows.set(key, value);
        },
    }) as any);
    cacheBackgroundFeaturePreferences(Object.fromEntries(BACKGROUND_FEATURE_KEYS.map(feature => [feature, defaultBackgroundFeatureEnabled(feature, process.env)])));
    cacheBudgetMode('normal');
    return { rows, writes: () => writes, failRead: () => { readFailure = true; }, failWrite: () => { writeFailure = true; } };
}

test('a new account has no private Telegram access; a bot token or a preference cannot grant it', async t => {
    fixture(t);
    assert.equal(readTelegramUserCredentials({ KIRA_BOT_TOKEN: 'synthetic-token' }), null);
    assert.equal(readTelegramUserCredentials({ TELEGRAM_API_ID: '12345', TELEGRAM_API_HASH: 'synthetic-hash' }), null);
    const defaults = await readUserSettings();
    assert.equal(defaults.telegram.personalSessionConfigured, false);
    assert.equal(defaults.features.find(f => f.key === 'telegramReading')!.enabled, false);
    for (const feature of BACKGROUND_FEATURE_KEYS.filter(requiresTelegramSession)) {
        assert.equal(defaults.features.find(f => f.key === feature)!.effective, false, feature);
        assert.equal(await isBackgroundFeatureEnabled(feature), false, feature);
    }
    assert.equal(defaults.features.find(f => f.key === 'deferredFacts')!.effective, true, 'memory from direct conversations stays available');
    const saved = await updateUserSettings(parseSettingsPatch({ background: { telegramReading: true, reflection: true, personalChatMemory: true } }));
    assert.equal(saved.features.find(f => f.key === 'reflection')!.enabled, true);
    assert.equal(saved.features.find(f => f.key === 'reflection')!.blockedBy, 'telegram');
    assert.equal(await isBackgroundFeatureEnabled('reflection'), false);
    assert.equal(await getBackgroundFeaturePreference('reflection'), true, 'a missing session does not erase the preference');
    Object.assign(process.env, { TELEGRAM_API_ID: '12345', TELEGRAM_API_HASH: 'synthetic-own-hash', TELEGRAM_SESSION_STRING: 'synthetic-own-session' });
    assert.equal((await readUserSettings()).telegram.personalSessionConfigured, true);
    assert.equal(await isBackgroundFeatureEnabled('reflection'), true);
    assert.doesNotMatch(JSON.stringify(await readUserSettings()), /synthetic-own|apiHash|sessionString|KIRA_BOT_TOKEN/);
    delete process.env.TELEGRAM_SESSION_STRING;
    assert.equal(await isBackgroundFeatureEnabled('reflection'), false, 'removing credentials blocks the runtime even with a cached enabled preference');
});

test('budget and selected features update together, preserve omitted choices, and survive a runtime cache refresh', async t => {
    const f = fixture(t);
    let saved = await updateUserSettings(parseSettingsPatch({ budgetMode: 'maximum', background: { kiraLife: false, deferredFacts: true, daytimeReflection: false } }));
    assert.equal(f.writes(), 1, 'the patch is one atomic database upsert');
    assert.equal(saved.budgetMode, 'maximum');
    assert.equal(await getBudgetMode(), 'maximum');
    assert.equal(saved.features.find(feature => feature.key === 'deferredFacts')!.enabled, true);
    assert.equal(saved.features.find(feature => feature.key === 'deferredFacts')!.blockedBy, 'budget');
    assert.equal(await isBackgroundFeatureEnabled('deferredFacts'), false);
    saved = await updateUserSettings(parseSettingsPatch({ budgetMode: 'normal' }));
    assert.equal(saved.features.find(feature => feature.key === 'kiraLife')!.enabled, false);
    assert.equal(saved.features.find(feature => feature.key === 'deferredFacts')!.effective, true);
    assert.equal(await getBackgroundFeaturePreference('daytimeReflection'), false);
    assert.equal(f.rows.get('background:kiraLife'), 'false');
    assert.equal(f.rows.get('BUDGET_MODE'), 'normal');
    // A separate API client reads the stored result, independent of the background cache.
    assert.deepEqual(await readUserSettings(), saved);
});

test('failed writes never change saved preferences or runtime caches; read failures return an error', async t => {
    const f = fixture(t);
    await updateUserSettings(parseSettingsPatch({ budgetMode: 'normal', background: { kiraLife: true } }));
    f.failWrite();
    await assert.rejects(() => updateUserSettings(parseSettingsPatch({ budgetMode: 'maximum', background: { kiraLife: false } })),
        { status: 503, code: 'settings_unavailable' });
    assert.equal(f.rows.get('background:kiraLife'), 'true');
    assert.equal(f.rows.get('BUDGET_MODE'), 'normal');
    assert.equal(await getBackgroundFeaturePreference('kiraLife'), true);
    assert.equal(await getBudgetMode(), 'normal');
    f.failRead();
    await assert.rejects(readUserSettings, { status: 503, code: 'settings_unavailable' });
});

test('settings reject unknown keys, identity overrides, credentials and non-boolean values', () => {
    for (const body of [{}, { budgetMode: 'unknown' }, { background: [] }, { background: null },
        { background: { reflection: 'false' } }, { background: { anyFeature: true } },
        { telegram: { token: 'synthetic-token' } }, { accountId: 'another-account', budgetMode: 'normal' },
        JSON.parse('{"background":{"__proto__":true}}')]) {
        assert.throws(() => parseSettingsPatch(body), { status: 400, code: 'invalid_settings' });
    }
    assert.deepEqual(parseSettingsPatch({ background: { reflection: false } }), { background: { reflection: false } });
});
