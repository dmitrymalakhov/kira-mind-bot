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
const preferences: ModelPreferences = { censorship: 'on', cost: 'medium', quality: 'high' };
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

test('free dialogue is unavailable without a suitable resource and never pretends a normal cloud model is unrestricted', () => {
    assert.throws(() => buildModelPlan({ ...preferences, censorship: 'off' }, resources()), /Для свободного диалога/);
    const context = resources(); context.localModels = [{ id: 'synthetic/local-standard', uncensored: false }];
    assert.throws(() => buildModelPlan({ ...preferences, censorship: 'off' }, context), /Для свободного диалога/);
});

test('a connected model can be explicitly selected for free dialogue without inferring behaviour from its filename', () => {
    const context = resources(); context.localModels = [{ id: 'synthetic/local-standard', uncensored: false }];
    context.localRoutes.fast.freeDialogue = true;
    const plan = buildModelPlan({ ...preferences, censorship: 'off' }, context);
    assert.equal(plan.source, 'local'); assert.equal(plan.models.fastDialogue.model, 'synthetic/local-standard');
    assert.equal(plan.models.fastDialogue.allowFallback, false);
});

test('free local dialogue pins all text routes including classification; local role controls survive', () => {
    const context = resources();
    context.localModels = [{ id: 'synthetic/local-free', uncensored: true }];
    context.localRoutes.fast.maxTokens = 768;
    const plan = buildModelPlan({ ...preferences, censorship: 'off' }, context);
    assert.equal(plan.source, 'local');
    for (const task of TEXT_TASKS) {
        assert.equal(plan.models[task].provider, 'lmstudio');
        assert.equal(plan.models[task].model, 'synthetic/local-free');
        assert.equal(plan.models[task].allowFallback, false);
        assert.ok(plan.models[task].localRole); // Role parameters stay live while the free model remains pinned.
    }
    assert.equal(plan.models.fastDialogue.generation?.maxTokens, 768);
    assert.equal(plan.models.webSearchReasoning.provider, 'openai');
    assert.equal(plan.models.embedding.model, 'text-embedding-3-small');
    const altered = structuredClone(plan); altered.models.fastDialogue.allowFallback = true;
    assert.throws(() => parseModelPolicy(altered), /подмену/);
});

test('a declared service free model works without a local connection and with no standard-model fallback', () => {
    const context = resources(); (context.vars as NodeJS.ProcessEnv).KIRA_FREE_DIALOGUE_MODEL = 'synthetic/service-free';
    const plan = buildModelPlan({ ...preferences, censorship: 'off', cost: 'low' }, context);
    assert.equal(plan.source, 'service-free');
    for (const task of TEXT_TASKS) assert.deepEqual(plan.models[task], { provider: 'openai', model: 'synthetic/service-free', allowFallback: false });
    (context.vars as NodeJS.ProcessEnv).KIRA_FREE_DIALOGUE_MODEL = 'invalid\nmodel';
    assert.throws(() => buildModelPlan({ ...preferences, censorship: 'off' }, context), /Некорректный маршрут/);
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

test('free-model HTTP failure and malformed JSON never dispatch a standard fallback', async t => {
    t.mock.method(usage, 'logAiUsage', async () => {});
    const network = t.mock.method(openaiProviderAdapter.client.chat.completions, 'create', async () => { throw new Error('Unexpected cloud request'); });
    const context = resources(); context.localModels = [{ id: 'synthetic/local-free', uncensored: true }];
    const local = buildModelPlan({ ...preferences, censorship: 'off' }, context);
    t.mock.method(lmstudioProviderAdapter.client.chat.completions, 'create', async () => { throw Object.assign(new Error('Synthetic unavailable'), { status: 503 }); });
    await assert.rejects(runWithModelPolicy(local, () => createChatCompletionForTask('conversation', { messages })));
    assert.equal(network.mock.callCount(), 0);
    (context.vars as NodeJS.ProcessEnv).KIRA_FREE_DIALOGUE_MODEL = 'synthetic/service-free'; context.localModels = [];
    const cloud = buildModelPlan({ ...preferences, censorship: 'off' }, context);
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
