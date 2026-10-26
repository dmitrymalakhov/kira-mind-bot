import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aiPresets, type AiPresetName } from '../ai/modelPresets';
import { limitChatGeneration, limitResponseGeneration } from '../ai/generationLimits';
import { createChatCompletionForTask, createJsonChatCompletionForTask } from '../ai/chatCompletion';
import { createResponseForTask } from '../ai/responseCompletion';
import { openaiProviderAdapter } from '../ai/providers/openai';
import { geminiProviderAdapter } from '../ai/providers/gemini';
import { runWithChannelPreset } from '../services/aiRuntimeConfigService';
import type { ChatCompletionParamsWithoutModel, RetryPolicy } from '../ai/providers/types';
import * as usage from '../services/aiUsageLogService';

const messages = [{ role: 'user' as const, content: 'Синтетическая задача' }];
const completion = (content = '{}') => ({ choices: [{ message: { content } }] } as any);

test('economy has no full GPT route; balance reserves it for complex synthesis', () => {
    assert.ok(Object.values(aiPresets['gpt-lean'].models).every(ref => ref.model !== 'gpt-5.4'));
    for (const name of ['gpt-balanced', 'gpt-lean', 'hybrid-openrouter-gpt', 'hybrid-lmstudio-gpt', 'glm-balanced'] as const) {
        assert.equal(aiPresets[name].models.runtimePlanning.model, 'gpt-5.4-mini', name);
    }
    assert.equal(aiPresets['gpt-balanced'].models.complexReasoning.model, 'gpt-5.4');
    assert.equal(aiPresets['gpt-max'].models.conversation.model, 'gpt-5.4');
    for (const name of ['gpt-max', 'gpt-balanced', 'gpt-lean'] as const) {
        assert.equal(aiPresets[name].models.memoryExtraction.model, 'gpt-5.4-mini');
    }
    for (const [name, provider] of [['gemini-full', 'gemini'], ['glm-full', 'zai'], ['lmstudio-local', 'lmstudio']] as const) {
        for (const task of ['runtimePlanning', 'intentClassification', 'conversation', 'messageAnalysis', 'complexReasoning'] as const) {
            assert.equal(aiPresets[name].models[task].provider, provider);
        }
    }
});

test('registry output ceilings are valid and explicitly distinguish cost modes', () => {
    for (const preset of Object.values(aiPresets)) {
        for (const [task, cap] of Object.entries(preset.outputTokenLimits ?? {})) {
            assert.ok(task in preset.models);
            assert.ok(Number.isSafeInteger(cap) && cap > 0 && cap <= 16384);
        }
    }
    for (const task of ['runtimePlanning', 'conversation', 'complexReasoning'] as const) {
        const limit = (name: AiPresetName) => aiPresets[name].outputTokenLimits![task]!;
        assert.ok(limit('gpt-lean') < limit('gpt-balanced'));
        assert.ok(limit('gpt-balanced') < limit('gpt-max'));
    }
});

test('caps preserve tighter caller limits, do not mutate requests or override local role controls', () => {
    const params = { messages, max_tokens: 64, max_completion_tokens: 128 };
    const capped = limitChatGeneration('gpt-balanced', 'runtimePlanning', 'openai', params);
    assert.equal(capped.max_completion_tokens, 64);
    assert.equal(capped.max_tokens, undefined);
    assert.equal(params.max_tokens, 64);
    assert.equal(params.max_completion_tokens, 128);
    assert.equal(limitResponseGeneration('gpt-lean', 'complexReasoning', 'openai', { input: 'Synthetic', max_output_tokens: 100 }).max_output_tokens, 100);
    assert.equal(limitChatGeneration('hybrid-lmstudio-gpt', 'conversation', 'lmstudio', params), params);
    // Evidence extraction and long structured memory operations retain their own limits.
    assert.equal(limitChatGeneration('gpt-lean', 'memoryExtraction', 'openai', params), params);
});

test('planning reaches the actual OpenAI request with the selected model and cap', async t => {
    t.mock.method(usage, 'logAiUsage', async () => {});
    const calls: any[] = [];
    t.mock.method(openaiProviderAdapter.client.chat.completions, 'create', async (body: any) => { calls.push(body); return completion(); });
    await runWithChannelPreset('gpt-balanced', () => createChatCompletionForTask('runtimePlanning', { messages, max_tokens: 12000 }));
    await runWithChannelPreset('gpt-lean', () => createChatCompletionForTask('conversation', { messages }));
    assert.deepEqual(calls.map(body => [body.model, body.max_completion_tokens]), [['gpt-5.4-mini', 4096], ['gpt-5.4-nano', 1536]]);
    assert.ok(calls.every(body => body.max_tokens === undefined));
});

test('JSON parse fallback retains the originating preset cap and never upgrades economy to full GPT', async t => {
    t.mock.method(usage, 'logAiUsage', async () => {});
    t.mock.method(console, 'warn', () => {});
    const calls: any[] = [];
    t.mock.method(openaiProviderAdapter.client.chat.completions, 'create', async (body: any) => {
        calls.push(body); return completion(calls.length === 1 ? 'invalid synthetic JSON' : '{"finish":true}');
    });
    const result = await runWithChannelPreset('gpt-lean', () => createJsonChatCompletionForTask('runtimePlanning', {
        messages, response_format: { type: 'json_object' }, max_completion_tokens: 20000,
    }));
    assert.deepEqual(result, { finish: true });
    assert.deepEqual(calls.map(body => [body.model, body.max_completion_tokens]), [['gpt-5.4-mini', 3072], ['gpt-5.4-mini', 3072]]);
});

test('Responses fallback keeps the economy output ceiling', async t => {
    t.mock.method(usage, 'logAiUsage', async () => {});
    t.mock.method(console, 'warn', () => {});
    const calls: any[] = [];
    t.mock.method(openaiProviderAdapter.client.responses, 'create', async (body: any) => {
        calls.push(body);
        if (calls.length === 1) throw Object.assign(new Error('Synthetic rejection'), { status: 400 });
        return { output: [] } as any;
    });
    await runWithChannelPreset('gpt-lean', () => createResponseForTask('complexReasoning', { input: 'Synthetic', max_output_tokens: 20000 }));
    assert.deepEqual(calls.map(body => [body.model, body.max_output_tokens]), [['gpt-5.4-mini', 4096], ['gpt-5.4-mini', 4096]]);
});

test('true-full retry and provider degradation keep the same ceiling without crossing providers', async t => {
    t.mock.method(usage, 'logAiUsage', async () => {});
    t.mock.method(console, 'warn', () => {});
    t.mock.method(geminiProviderAdapter as { getRetryPolicy(): RetryPolicy }, 'getRetryPolicy', () => ({ enabled: true, maxAttempts: 1, getDelayMs: () => 0 }));
    const calls: Array<[string, number | null | undefined]> = [];
    t.mock.method(geminiProviderAdapter, 'createChatCompletion', async (model: string, params: ChatCompletionParamsWithoutModel) => {
        calls.push([model, params.max_completion_tokens]);
        if (calls.length < 3) throw Object.assign(new Error('Synthetic outage'), { status: 503 });
        return completion();
    });
    const cloud = t.mock.method(openaiProviderAdapter, 'createChatCompletion', async () => { throw new Error('Unexpected cross-provider request'); });
    await runWithChannelPreset('gemini-full', () => createChatCompletionForTask('runtimePlanning', { messages, max_tokens: 12000 }));
    assert.deepEqual(calls, [['gemini-3.6-flash', 4096], ['gemini-3.6-flash', 4096], ['gemini-3.5-flash-lite', 4096]]);
    assert.equal(cloud.mock.callCount(), 0);
});
