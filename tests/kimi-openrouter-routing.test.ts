import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { execFileSync } from 'node:child_process';
import { buildCustomPlan, buildModelPlan, getStrategyCatalog, parseModelPolicy, TEXT_TASKS, type ModelResources } from '../ai/modelPreferences';
import { defaultLocalRoutes } from '../ai/localModelRouting';
import { aiPresets } from '../ai/modelPresets';
import { kimiProviderAdapter } from '../ai/providers/kimi';
import { openrouterProviderAdapter } from '../ai/providers/openrouter';
import { openaiProviderAdapter } from '../ai/providers/openai';
import { createChatCompletionForTask, createJsonChatCompletionForTask } from '../ai/chatCompletion';
import { runWithModelPolicy } from '../services/modelPreferenceService';
import { photoVisionRoute } from '../api/photos';
import { publicModelPreferences } from '../api/modelPreferenceView';
import { formatGenerativeProviderChain } from '../ai/presetSummary';
import { isAiContentSafetyError } from '../ai/contentSafety';
import * as usage from '../services/aiUsageLogService';

const completion = (content = '{}') => ({ choices: [{ message: { content } }] }) as any;
const messages = [{ role: 'user' as const, content: 'Синтетическая задача' }];
function resources(provider: 'kimi' | 'openrouter'): ModelResources {
    return { vars: { [provider === 'kimi' ? 'KIMI_API_KEY' : 'OPENROUTER_API_KEY']: 'synthetic-api-key' },
        memoryProfileName: 'stable-1536', localRoutes: defaultLocalRoutes() };
}
let now = Date.now();
function isolated(t: TestContext, provider: 'kimi' | 'openrouter') {
    const before = { ...process.env };
    for (const name of ['OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'KIMI_API_KEY', 'ZAI_API_KEY', 'GEMINI_API_KEY']) delete process.env[name];
    Object.assign(process.env, resources(provider).vars);
    now += 120_000; t.mock.method(Date, 'now', () => now);
    const log = t.mock.method(usage, 'logAiUsage', async () => {});
    t.after(() => { for (const name of Object.keys(process.env)) if (!(name in before)) delete process.env[name]; Object.assign(process.env, before); });
    return log;
}

test('each provider alone compiles every text role at each quality without changing specialized services or memory', () => {
    for (const provider of ['kimi', 'openrouter'] as const) for (const quality of ['standard', 'high', 'maximum'] as const) {
        const plan = buildModelPlan({ quality, providers: [provider] }, resources(provider));
        assert.deepEqual(parseModelPolicy(JSON.stringify(plan)), plan);
        for (const task of TEXT_TASKS) {
            assert.equal(plan.models[task].provider, provider);
            assert.ok(plan.routing![task]!.length >= 2);
            assert.ok(plan.routing![task]!.every(ref => ref.provider === provider));
        }
        assert.equal(plan.models.embedding.provider, 'openai'); assert.equal(plan.models.transcription.provider, 'openai');
        assert.equal(plan.models.webSearchReasoning.provider, 'openai');
        assert.equal(plan.models.browserVision.provider, provider);
        assert.doesNotMatch(JSON.stringify(plan), /synthetic-api-key/);
        if (provider === 'openrouter' && quality !== 'standard') {
            assert.equal(plan.models.fastDialogue.model, 'google/gemini-2.5-flash-lite');
            assert.equal(plan.models.complexReasoning.model, 'openai/gpt-5.4');
            assert.ok(new Set(TEXT_TASKS.map(task => plan.models[task].model)).size >= (quality === 'high' ? 3 : 2));
            assert.ok(new Set(Object.values(plan.routing!).flat().map(ref => ref.model)).size >= 5);
        }
        const fixed = buildModelPlan({ quality, provider }, resources(provider));
        assert.equal(fixed.version, 3); assert.ok(TEXT_TASKS.every(task => fixed.models[task].allowFallback === false));
    }
    assert.equal(aiPresets['hybrid-openrouter-gpt'].models.intentClassification.provider, 'openai');
    assert.match(formatGenerativeProviderChain(aiPresets['openrouter-balanced'].models), /^OpenRouter/);
    assert.doesNotMatch(formatGenerativeProviderChain(aiPresets['openrouter-balanced'].models), /Auto/);
});

test('Kimi SDK receives supported sampling, reasoning, token limits and unchanged structured history', async t => {
    isolated(t, 'kimi');
    const calls: any[] = [];
    t.mock.method(kimiProviderAdapter.client.chat.completions, 'create', async (body: any) => { calls.push(body); return completion(); });
    const plan = buildModelPlan({ quality: 'high', providers: ['kimi'] }, resources('kimi'));
    const history = [{ role: 'assistant', content: 'Синтетический промежуточный ответ', reasoning_content: 'Synthetic preserved reasoning' }, ...messages] as any;
    await runWithModelPolicy(plan, async () => {
        await createJsonChatCompletionForTask('intentClassification', { messages: history, max_tokens: 256, temperature: .3, top_p: .5, n: 2, frequency_penalty: .4 });
        await createChatCompletionForTask('complexReasoning', { messages, max_tokens: 500 });
    });
    assert.equal(calls[0].model, 'kimi-k3.1-pro-highspeed'); assert.equal(calls[0].reasoning_effort, 'low');
    assert.equal(calls[1].model, 'kimi-k3.1-pro'); assert.equal(calls[1].reasoning_effort, 'high');
    assert.equal(calls[0].max_tokens, 256); assert.equal(calls[1].max_tokens, 500);
    assert.equal(calls[0].messages[0].reasoning_content, 'Synthetic preserved reasoning');
    for (const key of ['temperature', 'top_p', 'n', 'frequency_penalty', 'thinking', 'max_completion_tokens']) assert.equal(calls[0][key], undefined);
});

test('OpenRouter routes distinct models through one SDK and keeps strict JSON/provider preferences', async t => {
    isolated(t, 'openrouter');
    const calls: any[] = [];
    const outside = t.mock.method(openaiProviderAdapter.client.chat.completions, 'create', async () => { throw Error('Unexpected direct OpenAI request'); });
    t.mock.method(openrouterProviderAdapter.client.chat.completions, 'create', async (body: any) => { calls.push(body); return completion(); });
    const plan = buildModelPlan({ quality: 'high', providers: ['openrouter'] }, resources('openrouter'));
    await runWithModelPolicy(plan, async () => {
        for (const task of ['intentClassification', 'runtimePlanning', 'conversation', 'complexReasoning'] as const) {
            await createJsonChatCompletionForTask(task, { messages, response_format: { type: 'json_object' }, max_tokens: 320,
                provider: { data_collection: 'deny' } });
        }
    });
    assert.deepEqual(calls.map(call => call.model), ['google/gemini-2.5-flash-lite', 'z-ai/glm-5.2', 'moonshotai/kimi-k3.1-pro', 'openai/gpt-5.4']);
    assert.ok(calls.every(call => call.provider.require_parameters === true && call.provider.data_collection === 'deny' && call.max_tokens === 320));
    assert.deepEqual(calls.map(call => call.provider.sort), ['price', 'latency', 'throughput', 'throughput']);
    assert.equal(calls[3].reasoning.effort, 'medium'); assert.equal(outside.mock.callCount(), 0);
});

for (const provider of ['openrouter', 'kimi'] as const) test(`${provider} changes models on technical errors and keeps moderation terminal`, async t => {
    isolated(t, provider);
    const adapter = provider === 'kimi' ? kimiProviderAdapter : openrouterProviderAdapter;
    const plan = buildModelPlan({ quality: 'high', providers: [provider] }, resources(provider));
    const calls: string[] = [];
    const sdk = t.mock.method(adapter.client.chat.completions, 'create', async (body: any) => {
        calls.push(body.model);
        if (calls.length === 1) throw Object.assign(new Error('Synthetic outage'), { status: 503 });
        return completion('Синтетический ответ резерва');
    });
    assert.equal((await runWithModelPolicy(plan, () => createChatCompletionForTask('conversation', { messages }))).choices[0].message.content, 'Синтетический ответ резерва');
    assert.equal(calls.length, 2); assert.notEqual(calls[0], calls[1]);
    now += 60_000;
    const count = calls.length;
    sdk.mock.mockImplementation(async () => { calls.push('refused'); return { choices: [{ message: { refusal: 'Synthetic refusal', content: '' } }] } as any; });
    await assert.rejects(runWithModelPolicy(plan, () => createJsonChatCompletionForTask('conversation', { messages })), isAiContentSafetyError);
    assert.equal(calls.length, count + 1);
});

test('Kimi Custom pins catalog models and media preparation discloses the same selected recipient', async t => {
    isolated(t, 'kimi');
    const context = resources('kimi');
    assert.equal(getStrategyCatalog(context).filter(ref => ref.provider === 'kimi').length, 2);
    const plan = buildCustomPlan({ mode: 'custom', provider: 'kimi', quality: 'high', routes: Object.fromEntries(TEXT_TASKS.map(task => [task,
        { model: 'kimi-k3.1-pro', reasoningEffort: 'low', maxTokens: 700 }])) }, context);
    assert.equal(plan.customProvider, 'kimi'); assert.equal(plan.models.embedding.provider, 'openai');
    assert.deepEqual(parseModelPolicy(JSON.stringify(plan)), plan);
    const route = await runWithModelPolicy(plan, () => photoVisionRoute());
    assert.equal(route.available, true); assert.equal(route.provider, 'kimi'); assert.equal(route.model, 'kimi-k3.1-pro');
    const view = publicModelPreferences({ activePlan: plan, localRoutes: context.localRoutes, plans: [], providerPlans: [] }, { preset: null, revision: 'synthetic' }, 'stable-1536');
    assert.equal(view.effectivePlan.memoryEmbedding.available, false);
});

test('OpenRouter numeric moderation errors are terminal while model-access errors can use another permitted model', async t => {
    isolated(t, 'openrouter');
    const plan = buildModelPlan({ quality: 'high', providers: ['openrouter'] }, resources('openrouter'));
    let calls = 0;
    const sdk = t.mock.method(openrouterProviderAdapter.client.chat.completions, 'create', async () => {
        calls++; throw Object.assign(new Error('Synthetic upstream content policy rejection'), { status: 403 });
    });
    await assert.rejects(runWithModelPolicy(plan, () => createChatCompletionForTask('conversation', { messages })), isAiContentSafetyError);
    assert.equal(calls, 1);
    sdk.mock.mockImplementation((async () => {
        calls++; if (calls === 2) throw Object.assign(new Error('This API key cannot access the selected model'), { status: 403 });
        return completion('Permitted model result');
    }) as any);
    assert.equal((await runWithModelPolicy(plan, () => createChatCompletionForTask('conversation', { messages }))).choices[0].message.content, 'Permitted model result');
    assert.equal(calls, 3);
});

test('both standalone providers bootstrap the real API runtime without an OpenAI key or saved preset', () => {
    for (const provider of ['kimi', 'openrouter'] as const) {
        const env = { ...process.env, NODE_ENV: 'test', AI_MODEL_PRESET: '', OPENAI_API_KEY: '', GEMINI_API_KEY: '', ZAI_API_KEY: '', KIMI_API_KEY: '', OPENROUTER_API_KEY: '',
            ...resources(provider).vars };
        const result = execFileSync(process.execPath, ['-e', `
            const assert = require('node:assert/strict');
            require('./dist/api/backend'); require('./dist/openai');
            assert.equal(require('./dist/services/aiRuntimeConfigService').getEnvAiPresetName(), '${provider === 'kimi' ? 'kimi-full' : 'openrouter-balanced'}');
            const cloud = require('./dist/ai/providers/openai').openaiProviderAdapter;
            let calls = 0;
            cloud.client.embeddings.create = async () => { calls++; throw Error('Unexpected unavailable-service network request'); };
            assert.rejects(cloud.createEmbedding('text-embedding-3-small', {input:'Synthetic unavailable service'}), error => error.code === 'provider_not_configured')
                .then(() => { assert.equal(calls, 0); console.log('standalone runtime loaded'); })
                .catch(error => { console.error(error); process.exitCode = 1; });
        `], { cwd: process.cwd(), env, encoding: 'utf8', timeout: 30_000 });
        assert.match(result, /standalone runtime loaded/);
    }
});

test('all connected providers fit the validated pool and preserve each selected provider', () => {
    const vars = { OPENAI_API_KEY: 'synthetic', GEMINI_API_KEY: 'synthetic', ZAI_API_KEY: 'synthetic', KIMI_API_KEY: 'synthetic', OPENROUTER_API_KEY: 'synthetic' };
    const plan = buildModelPlan({ quality: 'maximum' }, { ...resources('kimi'), vars });
    assert.deepEqual(parseModelPolicy(plan), plan);
    for (const task of TEXT_TASKS) {
        assert.ok(plan.routing![task]!.length <= 16);
        assert.deepEqual(new Set(plan.routing![task]!.map(ref => ref.provider)), new Set(['openai', 'gemini', 'zai', 'openrouter', 'kimi']));
    }
});
