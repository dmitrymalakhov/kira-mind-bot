import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildModelPlan, parseModelPolicy, parsePreferences, TEXT_TASKS, type ModelPreferences } from '../ai/modelPreferences';
import { defaultLocalRoutes } from '../ai/localModelRouting';
import { runWithModelPolicy } from '../services/modelPreferenceService';
import { runWithChannelPreset } from '../services/aiRuntimeConfigService';
import { createChatCompletionForTask, createJsonChatCompletionForTask } from '../ai/chatCompletion';
import { createResponseForTask } from '../ai/responseCompletion';
import { openaiProviderAdapter } from '../ai/providers/openai';
import { lmstudioProviderAdapter } from '../ai/providers/lmstudio';
import * as usage from '../services/aiUsageLogService';
import { AppDataSource } from '../data-source';
import { getModelPolicy } from '../services/modelPreferenceService';

const resources = () => ({ vars: { OPENAI_API_KEY: 'synthetic-api-key' }, memoryProfileName: 'stable-1536',
    localRoutes: defaultLocalRoutes('synthetic/local-standard'), localModels: [] as Array<{ id: string; uncensored: boolean }> });
const preferences: ModelPreferences = { cost: 'medium', quality: 'high' };
const messages = [{ role: 'user' as const, content: 'Synthetic request' }];

test('cost limits the model class while quality changes reasoning without adding a routing call', () => {
    for (const cost of ['low', 'medium', 'high'] as const) {
        const normal = buildModelPlan({ ...preferences, cost, quality: 'standard' }, resources());
        const high = buildModelPlan({ ...preferences, cost }, resources());
        assert.equal(high.models.complexReasoning.model, cost === 'low' ? 'gpt-6-luna' : 'gpt-6.1-sol');
        assert.equal(high.models.fastDialogue.model, 'gpt-6-luna');
        assert.equal(high.models.fastDialogue.generation?.reasoningEffort, 'none');
        assert.notEqual(high.models.complexReasoning.generation?.reasoningEffort, normal.models.complexReasoning.generation?.reasoningEffort);
        assert.ok(Object.values(high.models).every(ref => !ref.model.includes('astra')));
        assert.deepEqual(parseModelPolicy(JSON.stringify(high)), high);
    }
});

function legacyPlan(local = true) {
    const plan = buildModelPlan(preferences, resources());
    const raw = { ...plan, preferences: { ...preferences, censorship: 'off' }, source: local ? 'local' : 'service-free' };
    for (const task of TEXT_TASKS) raw.models[task] = local
        ? { provider: 'lmstudio', model: 'synthetic/local-pinned', localRole: 'fast', allowFallback: false }
        : { provider: 'openai', model: 'synthetic/service-pinned', allowFallback: false };
    return raw;
}

test('local catalog and obsolete free-model flags never silently change automatic API routing', () => {
    const context = resources();
    context.localModels = [{ id: 'synthetic/local-free', uncensored: true }];
    (context.vars as NodeJS.ProcessEnv).LM_STUDIO_FREE_MODEL = 'synthetic/local-free';
    (context.vars as NodeJS.ProcessEnv).KIRA_FREE_DIALOGUE_MODEL = 'synthetic/service-free';
    assert.deepEqual(buildModelPlan(preferences, context), buildModelPlan(preferences, resources()));
    assert.throws(() => parsePreferences({ ...preferences, censorship: 'off' }));
});

test('saved version-1 policies retain pinned local and API routes while exposing only cost and quality', () => {
    for (const local of [true, false]) {
        const legacy = legacyPlan(local);
        const parsed = parseModelPolicy(JSON.stringify(legacy))!;
        assert.deepEqual(parsed.preferences, preferences);
        assert.deepEqual(parsed.models, legacy.models);
        assert.deepEqual(parseModelPolicy(parsed), parsed);
        const altered = structuredClone(legacy); altered.models.fastDialogue.allowFallback = true;
        assert.throws(() => parseModelPolicy(altered), /подмену/);
        assert.throws(() => parseModelPolicy({ ...legacy, preferences: { ...legacy.preferences, accountId: 'other' } }));
    }
    const on = buildModelPlan(preferences, resources());
    assert.deepEqual(parseModelPolicy({ ...on, preferences: { ...preferences, censorship: 'on' } }), on);
});

test('preferences reject credentials, identity, arbitrary model IDs and unknown values', () => {
    for (const invalid of [null, { ...preferences, cost: 'unlimited' }, { ...preferences, apiKey: 'secret' },
        { ...preferences, userId: 123 }, { ...preferences, model: 'gpt-6-astra' }, { ...preferences, quality: null }]) assert.throws(() => parsePreferences(invalid));
});

test('an unavailable provider is not selected from ambient process credentials', () => {
    const context = resources(); context.vars = {} as typeof context.vars;
    assert.throws(() => buildModelPlan(preferences, context), /Нет доступного подключения/);
});

test('explicit app presets bypass the general account policy while ordinary turns use it', async t => {
    const plan = buildModelPlan({ ...preferences, cost: 'low' }, resources());
    const descriptor = Object.getOwnPropertyDescriptor(AppDataSource, 'isInitialized')!;
    Object.defineProperty(AppDataSource, 'isInitialized', { configurable: true, value: true });
    t.after(() => Object.defineProperty(AppDataSource, 'isInitialized', descriptor));
    t.mock.method(AppDataSource, 'getRepository', () => ({ findOneBy: async ({ key }: {key: string}) => key === 'AI_MODEL_POLICY' ? { value: JSON.stringify(plan) } : null }) as any);
    assert.deepEqual(await getModelPolicy(true), plan);
    assert.equal(await runWithChannelPreset('gpt-max', () => getModelPolicy(true)), null);
    assert.deepEqual(await getModelPolicy(true), plan);
});

test('the actual SDK request receives the compiled reasoning and ceiling; API preset overrides stay separate', async t => {
    t.mock.method(usage, 'logAiUsage', async () => {});
    const calls: any[] = [];
    t.mock.method(openaiProviderAdapter.client.chat.completions, 'create', async (body: any) => { calls.push(body); return { choices: [{ message: { content: '{}' } }] } as any; });
    const plan = buildModelPlan({ ...preferences, cost: 'low' }, resources());
    await runWithChannelPreset('gpt-max', () => runWithModelPolicy(plan, () => createChatCompletionForTask('complexReasoning', { messages, max_tokens: 20000, temperature: 0.5 })));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].model, 'gpt-6-luna');
    assert.equal(calls[0].reasoning_effort, 'medium');
    assert.equal(calls[0].max_completion_tokens, 4096);
    assert.equal(calls[0].temperature, undefined);
});

test('legacy pinned policies still prohibit cross-provider and JSON fallbacks', async t => {
    t.mock.method(usage, 'logAiUsage', async () => {});
    const network = t.mock.method(openaiProviderAdapter.client.chat.completions, 'create', async () => { throw new Error('Unexpected cloud request'); });
    const local = parseModelPolicy(legacyPlan())!;
    t.mock.method(lmstudioProviderAdapter.client.chat.completions, 'create', async () => { throw Object.assign(new Error('Synthetic unavailable'), { status: 503 }); });
    await assert.rejects(runWithModelPolicy(local, () => createChatCompletionForTask('conversation', { messages })));
    assert.equal(network.mock.callCount(), 0);
    const cloud = parseModelPolicy(legacyPlan(false))!;
    network.mock.restore();
    const malformed = t.mock.method(openaiProviderAdapter.client.chat.completions, 'create', async () => ({ choices: [{ message: { content: 'not JSON' } }] }) as any);
    assert.equal(await runWithModelPolicy(cloud, () => createJsonChatCompletionForTask('intentClassification', { messages })), null);
    assert.equal(malformed.mock.callCount(), 1);
});

test('Responses keeps its search route and respects policy settings', async t => {
    t.mock.method(usage, 'logAiUsage', async () => {});
    const calls: any[] = [];
    t.mock.method(openaiProviderAdapter.client.responses, 'create', async (body: any) => { calls.push(body); return { output: [] } as any; });
    const plan = buildModelPlan(preferences, resources());
    await runWithModelPolicy(plan, () => createResponseForTask('webSearchReasoning', { input: 'Synthetic', tools: [{ type: 'web_search_preview' }] }));
    assert.equal(calls[0].model, 'gpt-6-luna'); assert.equal(calls[0].reasoning.effort, 'none');
    assert.equal(calls[0].tools[0].type, 'web_search_preview');
});

test('the shared settings controller writes the plan and preset atomically and validates before writing', async () => {
    const { saveModelPreferences } = require('../admin-panel/modelPreferences');
    const writes: any[] = [];
    const pool = { query: async (sql: string, params: unknown[]) => { if (sql.startsWith('INSERT')) writes.push({ sql, params }); return { rows: [] }; } };
    await saveModelPreferences(pool, resources().vars, 'stable-1536', preferences);
    assert.equal(writes.length, 1); assert.match(writes[0].sql, /VALUES \(\$1,\$2,now\(\)\),\(\$3,\$4,now\(\)\)/);
    assert.equal(writes[0].params[0], 'AI_MODEL_PRESET'); assert.equal(writes[0].params[2], 'AI_MODEL_POLICY');
    await assert.rejects(saveModelPreferences(pool, resources().vars, 'stable-1536', { ...preferences, userId: 1 }));
    await assert.rejects(saveModelPreferences(pool, resources().vars, 'stable-1536', { ...preferences, censorship: 'off' }));
    assert.equal(writes.length, 1);
});

test('preferences list six choices and canonicalize old stored settings without rewriting them', async () => {
    const { readModelPreferences } = require('../admin-panel/modelPreferences');
    const legacy = legacyPlan(false);
    const queries: string[] = [];
    const pool = { query: async (sql: string) => {
        queries.push(sql);
        return { rows: sql.includes('key IN') ? [{ key: 'AI_MODEL_POLICY', value: JSON.stringify(legacy) }] : [] };
    } };
    const result = await readModelPreferences(pool, resources().vars, 'stable-1536');
    assert.equal(result.plans.length, 6);
    assert.deepEqual(result.preferences, preferences);
    assert.deepEqual(result.activePlan.models, legacy.models);
    assert.ok(queries.every(sql => sql.startsWith('SELECT')));
});
