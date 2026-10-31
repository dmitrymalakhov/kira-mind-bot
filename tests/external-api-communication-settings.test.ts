import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { AddressInfo } from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Bot } from 'grammy';
import { ApiBackend, ApiOperationStore } from '../api/contracts';
import { createExternalApiServer } from '../api/server';
import { BotApiBackend } from '../api/backend';
import { CommunicationProfileService, COMMUNICATION_CAPABILITY, type CommunicationProfileStore } from '../services/communicationProfileService';
import { readModelPreferences, saveModelPreferences, getModelPolicy, runWithModelPolicy } from '../services/modelPreferenceService';
import { BotSettingsApiModelStore, apiTurnPreset } from '../api/modelSettings';
import { AppDataSource } from '../data-source';
import { BotSettingEntity } from '../entity/BotSettingEntity';
import { buildModelPlan, buildCustomPlan, TEXT_TASKS } from '../ai/modelPreferences';
import { defaultLocalRoutes } from '../ai/localModelRouting';
import { getSameProviderDegradedModel } from '../ai/runtimeSupport';
import { runWithChannelPreset } from '../services/aiRuntimeConfigService';
import { createChatCompletionForTask } from '../ai/chatCompletion';
import { openaiProviderAdapter } from '../ai/providers/openai';
import { geminiProviderAdapter } from '../ai/providers/gemini';
import * as usage from '../services/aiUsageLogService';

const token = 'synthetic-only-token-for-communication-contract-tests';
const owner = 741902;
const examples: Record<string, unknown> = {};
function example(key: string, value: unknown) {
    examples[key] = value;
    const directory = process.env.KIRA_API_CONTRACT_OUTPUT_DIR;
    if (directory) { mkdirSync(directory, { recursive: true }); writeFileSync(path.join(directory, 'wire-examples.synthetic.json'), JSON.stringify(examples, null, 2)); }
}
async function http(t: TestContext, changes: Partial<ApiBackend>) {
    const backend: ApiBackend = { status: async () => ({}), capabilities: async () => ({}), history: async () => ({}), reminders: async () => ({}), tasks: async () => ({}),
        message: async () => ({ messages: [] }), photo: async () => ({ messages: [] }), photoReady: async () => null,
        action: async () => ({ messages: [] }), file: async () => ({ data: Buffer.alloc(0), filename: '' }), modelSettings: async () => ({}),
        saveModelSettings: async () => ({}), turnReady: async () => {}, sceneCapabilities: async () => ({}), sceneReady: async () => null,
        sceneTurn: async () => ({ messages: [] }), sceneActionResult: async () => ({}), ...changes };
    const receipts: ApiOperationStore = { run: async (_key, _fingerprint, work) => work() };
    const server = createExternalApiServer({ token, ownerId: owner, host: '127.0.0.1', port: 0 }, backend, receipts);
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    t.after(() => { server.closeAllConnections(); return new Promise<void>(r => server.close(() => r())); });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
    return async (route: string, method = 'GET', body?: unknown, auth = true) => {
        const response = await fetch(base + route, { method, headers: { ...(auth ? { Authorization: 'Bearer ' + token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
            ...(body ? { body: JSON.stringify(body) } : {}) });
        return { status: response.status, body: await response.json() as any, allow: response.headers.get('allow') };
    };
}

test('profile GET/PATCH is authenticated, revisioned, strict, and returns the current profile on conflict', async t => {
    const rows = new Map<string, string>();
    const store: CommunicationProfileStore = { read: async k => rows.get(k), insert: async (k, v) => { if (rows.has(k)) return false; rows.set(k, v); return true; },
        replace: async (k, previous, value) => { if (rows.get(k) !== previous) return false; rows.set(k, value); return true; } };
    const profile = new CommunicationProfileService(owner, store, async () => ({
        name: { value: 'Лис', state: 'known', source: 'memory', updatedAt: '2026-01-01T00:00:00.000Z' },
    }));
    const request = await http(t, { communicationProfile: () => profile.read(), updateCommunicationProfile: p => profile.patch(p) });
    assert.equal((await request('/profile/communication', 'GET', undefined, false)).status, 401);
    assert.equal(rows.size, 0);
    const known = await request('/profile/communication'); assert.equal(known.status, 200); example('profile.get.known', known.body);
    const saved = await request('/profile/communication', 'PATCH', { expectedRevision: known.body.revision, address: 'formal', replyLength: 'short' });
    assert.equal(saved.status, 200); assert.deepEqual(saved.body.name, known.body.name); example('profile.patch.success', saved.body);
    const cleared = await request('/profile/communication', 'PATCH', { expectedRevision: saved.body.revision, name: null });
    assert.equal(cleared.status, 200); assert.equal(cleared.body.name.value, null); assert.equal(cleared.body.name.state, 'unknown');
    const reread = await request('/profile/communication'); assert.deepEqual(reread.body, cleared.body); example('profile.get.cleared', reread.body);
    const stale = await request('/profile/communication', 'PATCH', { expectedRevision: known.body.revision, name: 'Сокол' });
    assert.equal(stale.status, 409); assert.equal(stale.body.error.code, 'revision_conflict'); assert.deepEqual(stale.body.profile, cleared.body);
    assert.match(stale.body.requestId, /^[0-9a-f-]{36}$/); example('profile.patch.conflict', stale.body);
    for (const input of [{ expectedRevision: cleared.body.revision, ownerId: owner + 1, name: 'Чужой' }, { expectedRevision: cleared.body.revision, name: { value: 'Не scalar' } }, { expectedRevision: cleared.body.revision }])
        assert.equal((await request('/profile/communication', 'PATCH', input)).status, 400);
    assert.deepEqual((await request('/profile/communication')).body, cleared.body);
    const wrongMethod = await request('/profile/communication', 'PUT', { name: 'Лис' }); assert.equal(wrongMethod.status, 405); assert.equal(wrongMethod.allow, 'GET, PATCH');
    assert.equal((await request('/profile/communication', 'PATCH', { expectedRevision: cleared.body.revision, name: null }, false)).status, 401);
});

test('the actual backend advertises the canonical communication capability without a model call', async () => {
    const bot = new Bot<any>('1234567890:abcdefghijklmnopqrstuvwxyzABCDE', { botInfo: { id: 1234567890, is_bot: true, first_name: 'Synthetic', username: 'synthetic_bot' } as any });
    const backend = new BotApiBackend(bot, { token, ownerId: owner, host: '127.0.0.1', port: 0 });
    assert.deepEqual((await backend.capabilities()).profile.communication, COMMUNICATION_CAPABILITY);
    example('capabilities.profile', { profile: { communication: COMMUNICATION_CAPABILITY } });
});

function account(t: TestContext) {
    const oldEnv = { ...process.env };
    for (const key of Object.keys(process.env)) if (/^(OPENAI|GEMINI|ZAI|OPENROUTER|LM_STUDIO)_/.test(key)) delete process.env[key];
    process.env.OPENAI_API_KEY = 'synthetic-account-key';
    t.after(() => { for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key]; Object.assign(process.env, oldEnv); });
    const oldInitialized = AppDataSource.isInitialized; (AppDataSource as any).isInitialized = true; t.after(() => { (AppDataSource as any).isInitialized = oldInitialized; });
    const state = new Map<string, string>([['AI_MODEL_PRESET', 'gpt-balanced'], ['API_AI_MODEL_PRESET', JSON.stringify({ preset: 'gpt-lean', revision: 'old-app-revision' })],
        ['MEMORY_EMBEDDING_PROFILE', 'stable-1536'], ['unrelated-setting', 'must-survive']]);
    let failOverride = false, readsFail = false, transactions = 0;
    const query = async (rows: Map<string, string>, sql: string, params: any[] = []) => {
        if (readsFail) throw Error('synthetic-private-database-detail');
        if (sql.startsWith('SELECT')) return sql.includes('key IN') ? params.filter(k => rows.has(k)).map(key => ({ key, value: rows.get(key) })) : rows.has(params[0]) ? [{ value: rows.get(params[0]) }] : [];
        assert.ok(sql.startsWith('INSERT INTO bot_settings'));
        if (params[0] === 'API_AI_MODEL_PRESET' && failOverride) throw Error('synthetic app write failure');
        rows.set(params[0], params[1]); if (params.length === 4) rows.set(params[2], params[3]); return [];
    };
    t.mock.method(AppDataSource, 'query', (sql: string, params?: any[]) => query(state, sql, params));
    t.mock.method(AppDataSource, 'getRepository', (entity: any) => { assert.equal(entity, BotSettingEntity); return { findOneBy: async ({ key }: any) => state.has(key) ? { value: state.get(key) } : null } as any; });
    t.mock.method(AppDataSource, 'transaction', (async (work: any) => {
        transactions++; const draft = new Map(state);
        const result = await work({ query: (sql: string, params: any[]) => query(draft, sql, params) });
        state.clear(); for (const [k, v] of draft) state.set(k, v); return result;
    }) as any);
    return { state, failOverride: () => { failOverride = true; }, readsFail: () => { readsFail = true; }, transactions: () => transactions };
}

test('shared model GET preserves manual/custom until explicit PUT; automatic save atomically clears the app override and applies on the next SDK call', async t => {
    const db = account(t), request = await http(t, { modelPreferences: readModelPreferences, updateModelPreferences: saveModelPreferences });
    const before = await request('/model-preferences'); assert.equal(before.status, 200); assert.equal(before.body.mode, 'manual');
    assert.equal(before.body.appOverride.preset, 'gpt-lean'); assert.equal(db.transactions(), 0);
    assert.deepEqual(before.body.qualityLevels.map((l: any) => l.id), ['standard', 'high', 'maximum']);
    assert.deepEqual(before.body.textTasks, TEXT_TASKS); example('models.get.manual', before.body);
    for (const invalid of [{ mode: 'automatic', quality: 'high', provider: 'auto' }, { quality: 'high', provider: 'auto', accountId: 'foreign' }])
        assert.equal((await request('/model-preferences', 'PUT', invalid)).status, 400);
    assert.equal(db.transactions(), 0);
    const saved = await request('/model-preferences', 'PUT', { quality: 'high', provider: 'auto' });
    assert.equal(saved.status, 200); assert.equal(saved.body.success, true); assert.equal(saved.body.mode, 'automatic');
    assert.equal(saved.body.appOverride.preset, null); assert.notEqual(saved.body.appOverride.revision, 'old-app-revision');
    assert.equal(db.state.get('unrelated-setting'), 'must-survive'); assert.equal(db.state.get('MEMORY_EMBEDDING_PROFILE'), 'stable-1536');
    assert.equal(saved.body.effectivePlan.app.overridden, false); assert.deepEqual(saved.body.effectivePlan.account.routes, saved.body.effectivePlan.app.routes);
    assert.equal(saved.body.effectivePlan.memoryEmbedding.provider, 'openai'); assert.equal(saved.body.recipientDisclosure.complete, false);
    const read = await request('/model-preferences'); const { success, ...normal } = saved.body; assert.equal(success, true); assert.deepEqual(read.body, normal);
    example('models.put.automatic.request', { quality: 'high', provider: 'auto' }); example('models.put.automatic.success', saved.body); example('models.get.automatic', read.body);
    const calls: any[] = [];
    t.mock.method(usage, 'logAiUsage', async () => {});
    t.mock.method(openaiProviderAdapter.client.chat.completions, 'create', async (body: any) => { calls.push(body); return { choices: [{ message: { content: 'Synthetic reply' } }] } as any; });
    const selection = await apiTurnPreset(new BotSettingsApiModelStore()); assert.equal(selection, null);
    await runWithChannelPreset(selection, () => createChatCompletionForTask('conversation', { messages: [{ role: 'user', content: 'Synthetic request' }] }));
    assert.equal(calls.length, 1); assert.equal(calls[0].model, saved.body.effectivePlan.app.routes.conversation.model);
    assert.equal((await getModelPolicy())?.preferences.quality, 'high');
});

test('model failures roll back both settings; unavailable output and errors never expose environment names or private diagnostics', async t => {
    const db = account(t), old = new Map(db.state); db.failOverride();
    await assert.rejects(saveModelPreferences({ quality: 'maximum', provider: 'auto' }), (e: any) => e.status === 503 && !/synthetic|API_KEY/.test(e.message));
    assert.deepEqual(db.state, old);
    const unavailable = await readModelPreferences() as any;
    assert.ok(unavailable.providerPlans.some((p: any) => p.available === false));
    for (const p of unavailable.providerPlans.filter((p: any) => p.available === false)) {
        assert.equal(p.unavailableCode, 'model_connection_unavailable'); assert.doesNotMatch(p.unavailableReason, /[A-Z][A-Z0-9]+_[A-Z0-9_]+/);
    }
    const request = await http(t, { modelPreferences: readModelPreferences, updateModelPreferences: saveModelPreferences });
    const badProvider = await request('/model-preferences', 'PUT', { quality: 'high', provider: 'gemini' });
    assert.equal(badProvider.status, 400); assert.equal(badProvider.body.error.code, 'model_preferences_unavailable');
    assert.doesNotMatch(JSON.stringify(badProvider.body), /GEMINI_API_KEY|synthetic-private|synthetic-account-key/); example('models.put.provider-unavailable', badProvider.body);
    db.readsFail(); await assert.rejects(readModelPreferences(), (e: any) => e.status === 503);
});

test('Custom GET retains exact task settings, provider and fallback restrictions; explicit pins cannot degrade to another model', async t => {
    const db = account(t);
    const plan = buildModelPlan({ quality: 'high' }, { vars: { OPENAI_API_KEY: 'synthetic' }, localRoutes: defaultLocalRoutes(), localModels: [], memoryProfileName: 'stable-1536' });
    const custom = { ...plan, version: 3, source: 'custom', customProvider: 'openai' };
    for (const task of TEXT_TASKS) custom.models[task].allowFallback = false;
    db.state.set('AI_MODEL_POLICY', JSON.stringify(custom)); const snapshot = new Map(db.state);
    const result = await readModelPreferences() as any;
    assert.equal(result.mode, 'custom'); assert.deepEqual(result.activePlan, custom); assert.deepEqual(db.state, snapshot); assert.equal(db.transactions(), 0);
    for (const task of TEXT_TASKS) { assert.equal(result.effectivePlan.account.routes[task].crossProviderFallback, false); assert.deepEqual(result.effectivePlan.account.routes[task].fallbacks, []); }
    assert.equal(getSameProviderDegradedModel('gemini-full', { provider: 'gemini', model: 'gemini-3.6-flash', allowFallback: false }, true), null);
});

test('an old policy read finishing after a successful save cannot replace the next-turn policy cache', async t => {
    const db = account(t);
    const old = buildModelPlan({ quality: 'standard' }, { vars: { OPENAI_API_KEY: 'synthetic' }, localRoutes: defaultLocalRoutes(), memoryProfileName: 'stable-1536' });
    db.state.set('AI_MODEL_POLICY', JSON.stringify(old));
    let entered!: () => void, release!: () => void, slow = true;
    const started = new Promise<void>(r => { entered = r; }), gate = new Promise<void>(r => { release = r; });
    t.mock.method(AppDataSource, 'getRepository', () => ({ findOneBy: async ({ key }: any) => {
        const value = db.state.get(key);
        if (key === 'AI_MODEL_POLICY' && slow) { slow = false; entered(); await gate; }
        return value ? { value } : null;
    } }) as any);
    const delayed = getModelPolicy(true); await started;
    await saveModelPreferences({ quality: 'maximum', provider: 'auto' });
    assert.equal((await getModelPolicy(true))?.preferences.quality, 'maximum');
    release(); assert.equal((await delayed)?.preferences.quality, 'standard');
    assert.equal((await getModelPolicy())?.preferences.quality, 'maximum');
});

test('a failed SDK request under Custom never executes another model, matching the recipient metadata', async t => {
    account(t); process.env.GEMINI_API_KEY = 'synthetic';
    const resources = { vars: { OPENAI_API_KEY: 'synthetic', GEMINI_API_KEY: 'synthetic' }, localRoutes: defaultLocalRoutes(), memoryProfileName: 'stable-1536' };
    const base = buildModelPlan({ quality: 'maximum', provider: 'gemini' }, resources);
    const plan = buildCustomPlan({ mode: 'custom', quality: 'maximum', provider: 'gemini',
        routes: Object.fromEntries(TEXT_TASKS.map(task => [task, { model: base.models[task].model, maxTokens: 512, reasoningEffort: 'none' }])) }, resources);
    const calls: string[] = [];
    t.mock.method(usage, 'logAiUsage', async () => {});
    t.mock.method(geminiProviderAdapter as Required<typeof geminiProviderAdapter>, 'getRetryPolicy', () => ({ enabled: true, maxAttempts: 0, getDelayMs: () => 0 }));
    t.mock.method(geminiProviderAdapter as Required<typeof geminiProviderAdapter>, 'getSameProviderDegradationChain', () => [{ provider: 'gemini' as const, model: 'synthetic-must-not-execute' }]);
    t.mock.method(geminiProviderAdapter, 'createChatCompletion', async (model: string) => { calls.push(model); throw Object.assign(Error('synthetic temporary failure'), { status: 503 }); });
    await assert.rejects(runWithModelPolicy(plan, () => createChatCompletionForTask('conversation', { messages: [{ role: 'user', content: 'Synthetic request' }] })));
    assert.deepEqual(calls, [plan.models.conversation.model]);
});
