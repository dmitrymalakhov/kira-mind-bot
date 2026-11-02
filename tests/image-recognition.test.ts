import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { AppDataSource } from '../data-source';
import { SETTING_KEY, parseImageRecognitionSettings } from '../ai/imageRecognition';
import { getImageRecognitionSettings } from '../services/imageRecognitionConfigService';
import * as settingsService from '../services/imageRecognitionConfigService';
import { resolveImageRecognitionRoute } from '../ai/imageRecognitionRouting';
import { resolveModelForTaskAsync } from '../ai/modelResolver';
import { createChatCompletionForTask, createJsonChatCompletionForTask } from '../ai/chatCompletion';
import { runWithChannelPreset } from '../services/aiRuntimeConfigService';
import { runWithModelPolicy } from '../services/modelPreferenceService';
import { aiPresets } from '../ai/modelPresets';
import type { ModelPolicy } from '../ai/modelPreferences';
import { photoVisionRoute } from '../api/photos';
import { lmstudioProviderAdapter } from '../ai/providers/lmstudio';
import { openaiProviderAdapter } from '../ai/providers/openai';
import * as usage from '../services/aiUsageLogService';
const { listLocalModels } = require('../admin-panel/localModels');
const { registerImageRecognitionRoutes } = require('../admin-panel/imageRecognition');

const selected = { provider: 'lmstudio' as const, model: 'synthetic/vision', maxTokens: 2048, reasoningEffort: 'none' as const };
const catalog = [
    { type: 'llm', key: selected.model, display_name: 'Synthetic Vision', capabilities: { vision: true }, loaded_instances: [{ id: 'synthetic/loaded-vision' }] },
    { type: 'llm', key: 'synthetic/text', capabilities: { vision: false } },
    { type: 'llm', key: 'synthetic/vision-in-name-only' },
    { type: 'embedding', key: 'synthetic/embedding', capabilities: { vision: true } },
];
const imageParams: any = { messages: [{ role: 'user', content: [
    { type: 'text', text: 'Опиши фигуры' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,c3ludGhldGlj' } },
] }], temperature: 0.4 };

test('image selection accepts a pinned local route or explicit reset and rejects credentials, other providers and invalid budgets', () => {
    assert.deepEqual(parseImageRecognitionSettings(JSON.stringify(selected)), selected);
    assert.equal(parseImageRecognitionSettings('null'), null);
    assert.equal(parseImageRecognitionSettings(null), null);
    for (const invalid of [undefined, {}, [], { ...selected, model: '' }, { ...selected, model: 'a\nb' },
        { ...selected, model: 'a'.repeat(401) }, { ...selected, provider: 'openai' }, { ...selected, maxTokens: 31 },
        { ...selected, maxTokens: 8193 }, { ...selected, maxTokens: 32.5 }, { ...selected, reasoningEffort: 'auto' },
        { ...selected, apiKey: 'synthetic-secret' }, { ...selected, baseURL: 'http://synthetic' }, { ...selected, allowFallback: true }]) {
        assert.throws(() => parseImageRecognitionSettings(invalid));
    }
});

function admin(t: TestContext) {
    let stored: string | undefined, failWrite = false, failCatalog = false;
    const queries: any[] = [], handlers: Record<string, any> = {}, auth = () => {};
    const app = Object.fromEntries(['get', 'post'].map(method => [method, (path: string, middleware: unknown, handler: unknown) => {
        assert.equal(middleware, auth); handlers[`${method} ${path}`] = handler;
    }]));
    const pool = { async query(sql: string, params: any[]) {
        queries.push([sql, params]);
        if (sql.startsWith('SELECT')) return { rows: stored === undefined ? [] : [{ value: stored }] };
        if (failWrite) throw new Error('synthetic database failure');
        assert.equal(params[0], SETTING_KEY); stored = params[1]; return { rows: [] };
    }, end: async () => {} };
    const fetch = t.mock.method(globalThis, 'fetch', async () => {
        if (failCatalog) throw new Error('synthetic connection failure');
        return { ok: true, json: async () => ({ models: catalog }) } as any;
    });
    registerImageRecognitionRoutes(app, { requireAuth: auth, createDbPool: () => pool,
        ensureBotSettingsTable: async () => {}, readEnvFile: () => ({ LM_STUDIO_BASE_URL: 'http://synthetic:1234/v1' }) });
    return { queries, fetch, stored: () => stored, failWrite: () => { failWrite = true; }, failCatalog: () => { failCatalog = true; },
        async call(method: string, body?: unknown) {
            let status = 200, result: any;
            const res = { status(value: number) { status = value; return res; }, set() { return res; }, json(value: unknown) { result = value; } };
            await handlers[`${method} /api/image-recognition`]({ body }, res);
            return { status, body: result };
        } };
}

test('authenticated image settings expose only catalog-confirmed vision models and canonicalize loaded instance aliases', async t => {
    const f = admin(t);
    const list = await f.call('get');
    assert.equal(list.status, 200); assert.equal(list.body.settings, null);
    assert.deepEqual(list.body.models.map((m: any) => m.id), [selected.model]);
    const full = await listLocalModels({}, globalThis.fetch);
    assert.equal(full.find((m: any) => m.id === 'synthetic/text').supportsVision, false);
    assert.equal(full.find((m: any) => m.id === 'synthetic/vision-in-name-only').supportsVision, false);
    const saved = await f.call('post', { settings: { ...selected, model: 'synthetic/loaded-vision' } });
    assert.deepEqual(saved.body, { success: true, settings: selected });
    assert.deepEqual((await f.call('get')).body.settings, selected);
    for (const invalid of ['synthetic/text', 'synthetic/vision-in-name-only', 'synthetic/missing', 'synthetic/embedding']) {
        assert.equal((await f.call('post', { settings: { ...selected, model: invalid } })).status, 400);
        assert.equal(f.stored(), JSON.stringify(selected));
    }
    assert.equal((await f.call('post', { settings: selected, userId: 999 })).status, 400);
});

test('catalog and database failures never confirm a save; resetting to inherited strategy works while LM Studio is offline', async t => {
    const f = admin(t);
    await f.call('post', { settings: selected });
    f.failCatalog();
    const offline = await f.call('get');
    assert.deepEqual(offline.body.settings, selected); assert.ok(offline.body.connectionError);
    assert.equal((await f.call('post', { settings: selected })).status, 503);
    assert.equal(f.stored(), JSON.stringify(selected));
    const calls = f.fetch.mock.callCount();
    assert.equal((await f.call('post', { settings: null })).body.success, true);
    assert.equal(f.fetch.mock.callCount(), calls); assert.equal(f.stored(), 'null');
    f.failWrite();
    const failed = await f.call('post', { settings: null });
    assert.equal(failed.status, 500); assert.equal(failed.body.success, undefined);
    assert.ok(f.queries.filter(([sql]) => sql.startsWith('INSERT')).every(([, params]) => params[0] === SETTING_KEY));
});

test('runtime rereads persisted settings for each photo, survives serialization and fails closed on corrupt or unavailable storage', async t => {
    const initialized = Object.getOwnPropertyDescriptor(AppDataSource, 'isInitialized')!;
    Object.defineProperty(AppDataSource, 'isInitialized', { configurable: true, value: true });
    t.after(() => Object.defineProperty(AppDataSource, 'isInitialized', initialized));
    let raw: string | undefined;
    t.mock.method(AppDataSource, 'getRepository', () => ({ findOneBy: async ({ key }: { key: string }) => {
        assert.equal(key, SETTING_KEY); return raw === undefined ? null : { value: raw };
    } }) as any);
    assert.equal(await getImageRecognitionSettings(), null);
    raw = JSON.stringify(selected); assert.deepEqual(await getImageRecognitionSettings(), selected);
    raw = 'null'; assert.equal(await getImageRecognitionSettings(), null);
    raw = '{}'; await assert.rejects(getImageRecognitionSettings());
    t.mock.method(AppDataSource, 'getRepository', () => { throw new Error('synthetic DB offline'); });
    assert.equal((await photoVisionRoute()).available, false);
    await assert.rejects(createChatCompletionForTask('conversation', imageParams), /DB offline/);
});

test('local image selection overrides automatic/custom and app text modes while ordinary text retains its original route', async t => {
    t.mock.method(settingsService, 'getImageRecognitionSettings', async () => selected);
    t.mock.method(usage, 'logAiUsage', async () => {});
    const sent: any[] = [];
    t.mock.method(lmstudioProviderAdapter.client.chat.completions, 'create', async (body: any) => {
        sent.push(body); return { choices: [{ message: { content: '{"description":"Синтетический квадрат"}' } }] } as any;
    });
    const cloud = t.mock.method(openaiProviderAdapter.client.chat.completions, 'create', async () => ({ choices: [{ message: { content: 'Text reply' } }] }) as any);
    const policy = { presetName: 'gpt-balanced', models: aiPresets['gpt-balanced'].models,
        routing: { conversation: [aiPresets['gpt-balanced'].models.conversation] } } as ModelPolicy;
    await runWithModelPolicy(policy, async () => {
        const route = await resolveImageRecognitionRoute();
        assert.equal(route.modelRef.model, selected.model); assert.equal(route.candidates, undefined);
        await runWithChannelPreset('gpt-lean', async () => {
            const photo = await photoVisionRoute({});
            assert.deepEqual([photo.provider, photo.model, photo.location, photo.available], ['lmstudio', selected.model, 'server-local', true]);
            assert.notEqual((await resolveModelForTaskAsync('conversation')).modelRef.model, selected.model);
            await createChatCompletionForTask('conversation', imageParams);
            assert.equal(cloud.mock.callCount(), 0);
            await createChatCompletionForTask('conversation', { messages: [{ role: 'user', content: 'Привет' }] });
            assert.equal(cloud.mock.callCount(), 1);
        });
    });
    assert.equal(sent[0].model, selected.model); assert.equal(sent[0].max_tokens, selected.maxTokens);
    assert.equal(sent[0].reasoning_effort, 'none'); assert.deepEqual(sent[0].messages, imageParams.messages);
});

test('local photo errors and malformed JSON cannot leak pixels to cloud, including a concurrent reset of image settings', async t => {
    const read = t.mock.method(settingsService, 'getImageRecognitionSettings', async () => selected);
    t.mock.method(usage, 'logAiUsage', async () => {});
    const cloud = t.mock.method(openaiProviderAdapter.client.chat.completions, 'create', async () => { assert.fail('No cloud image fallback'); });
    const local = t.mock.method(lmstudioProviderAdapter.client.chat.completions, 'create', async () => {
        read.mock.mockImplementation(async () => null);
        throw Object.assign(new Error('synthetic service unavailable'), { status: 503 });
    });
    await assert.rejects(createChatCompletionForTask('conversation', imageParams), /unavailable/);
    assert.equal(local.mock.callCount(), 2); assert.equal(cloud.mock.callCount(), 0);
    read.mock.mockImplementation(async () => selected);
    local.mock.mockImplementation((async () => ({ choices: [{ message: { content: 'invalid JSON' } }] })) as any);
    assert.equal(await createJsonChatCompletionForTask('conversation', imageParams), null);
    assert.equal(cloud.mock.callCount(), 0);
});

test('unset selection preserves the existing app-scoped conversation route and its vision validation', async t => {
    t.mock.method(settingsService, 'getImageRecognitionSettings', async () => null);
    await runWithChannelPreset('gpt-lean', async () => {
        assert.deepEqual(await resolveImageRecognitionRoute(), await resolveModelForTaskAsync('conversation'));
        assert.equal((await photoVisionRoute({ OPENAI_API_KEY: 'synthetic' })).available, true);
    });
    const policy = { presetName: 'lmstudio-local', models: { ...aiPresets['lmstudio-local'].models,
        conversation: { provider: 'lmstudio', model: 'synthetic/text-only', allowFallback: false } } } as ModelPolicy;
    await runWithModelPolicy(policy, async () => assert.equal((await photoVisionRoute()).available, false));
});
