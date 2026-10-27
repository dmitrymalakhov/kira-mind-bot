import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeGpt6Chat, normalizeGpt6Response } from '../ai/providers/openaiCompatibility';
import { openaiProviderAdapter } from '../ai/providers/openai';
import { createChatCompletionForTask } from '../ai/chatCompletion';
import { createResponseForTask } from '../ai/responseCompletion';
import { runWithChannelPreset } from '../services/aiRuntimeConfigService';
import * as usage from '../services/aiUsageLogService';

const messages = [{ role: 'user' as const, content: 'Synthetic compatibility check' }];
const tools = [{ type: 'function' as const, function: { name: 'synthetic_read', parameters: { type: 'object', properties: {} } } }];

test('Luna defaults to none; normal sampling and non-reasoning chat function calling survive', () => {
    const params = { messages, tools, temperature: 0.4, top_p: 0.8, logprobs: true };
    const result = normalizeGpt6Chat('gpt-6-luna', params);
    assert.equal(result.reasoning_effort, 'none');
    assert.equal(result.temperature, 0.4);
    assert.equal(result.top_p, 0.8);
    assert.equal(result.logprobs, true);
    assert.equal(result.tools, tools);
    assert.ok(!('reasoning_effort' in params));
});

test('Sol uses low instead of unsupported none and removes incompatible sampling without mutating input', () => {
    const params = { messages, temperature: 0.4, top_p: 0.8, logprobs: true, top_logprobs: 2 };
    for (const explicit of [undefined, 'none', 'minimal']) {
        const result = normalizeGpt6Chat('gpt-6.1-sol', { ...params, reasoning_effort: explicit } as any);
        assert.equal(result.reasoning_effort, 'low');
        for (const key of ['temperature', 'top_p', 'top_logprobs', 'logprobs']) assert.equal(result[key], undefined);
    }
    assert.equal(params.temperature, 0.4);
    assert.equal(normalizeGpt6Chat('gpt-6-luna', { messages }, 'low').reasoning_effort, 'low');
    assert.equal(normalizeGpt6Chat('gpt-6.1-sol', { messages, reasoning_effort: 'high' }, 'low').reasoning_effort, 'high');
});

test('reasoning Chat Completions rejects native tools before dispatch while the JSON planner remains compatible', async t => {
    const network = t.mock.method(openaiProviderAdapter.client.chat.completions, 'create', async () => { throw new Error('Must not send an unsupported request'); });
    for (const model of ['gpt-6.1-sol', 'gpt-6-luna']) {
        await assert.rejects(openaiProviderAdapter.createChatCompletion(model, { messages, tools, reasoning_effort: 'low' }), /Responses API/);
    }
    assert.equal(network.mock.callCount(), 0);
    const planned = normalizeGpt6Chat('gpt-6.1-sol', { messages, response_format: { type: 'json_object' } });
    assert.equal(planned.reasoning_effort, 'low');
    assert.deepEqual(planned.response_format, { type: 'json_object' });
});

test('Responses preserves tools and reasoning options while removing unsupported sampling and old cache settings', () => {
    const params = { input: 'Synthetic', tools: [{ type: 'web_search_preview' }], reasoning: { summary: 'auto' },
        temperature: 0.4, top_p: 0.8, top_logprobs: 2, include: ['message.output_text.logprobs', 'file_search_call.results'], prompt_cache_retention: '24h' } as any;
    const result = normalizeGpt6Response('gpt-6.1-sol', params);
    assert.deepEqual(result.reasoning, { summary: 'auto', effort: 'low' });
    assert.equal(result.tools, params.tools);
    assert.deepEqual(result.include, ['file_search_call.results']);
    for (const key of ['temperature', 'top_p', 'top_logprobs', 'prompt_cache_retention']) assert.equal(result[key], undefined);
    assert.deepEqual(result.prompt_cache_options, { ttl: '30m' });
    assert.equal(params.prompt_cache_retention, '24h');
    assert.equal(params.include.length, 2);
    const configured = normalizeGpt6Response('gpt-6-luna', { input: 'Synthetic', prompt_cache_retention: '24h', prompt_cache_options: { ttl: '12h' } }, 'low');
    assert.deepEqual(configured.prompt_cache_options, { ttl: '12h' });
    assert.equal(configured.reasoning?.effort, 'low');
});

test('legacy model requests and local role controls are not rewritten by GPT-6 compatibility', () => {
    const chat = { messages, temperature: 1, max_tokens: 100 };
    assert.equal(normalizeGpt6Chat('gpt-5.4-mini', chat), chat);
    const response = { input: 'Synthetic', temperature: 1 };
    assert.equal(normalizeGpt6Response('gpt-4o', response), response);
    assert.equal(openaiProviderAdapter.getModelCapabilities('gpt-6-luna').supportsReasoningEffort, true);
    assert.equal(openaiProviderAdapter.getModelCapabilities('gpt-6.1-sol').supportsEmbedding, false);
    assert.equal(openaiProviderAdapter.getModelCapabilities('gpt-6-luna').supportsTranscription, false);
    assert.equal(openaiProviderAdapter.normalizeChatParams('gpt-6-luna-2026-01-01', { messages, max_tokens: 100 }).max_completion_tokens, 100);
});

test('selected Sol and fallback Luna each receive their own reasoning settings and bounded output', async t => {
    t.mock.method(usage, 'logAiUsage', async () => {});
    t.mock.method(console, 'warn', () => {});
    const calls: any[] = [];
    t.mock.method(openaiProviderAdapter.client.chat.completions, 'create', async (body: any) => {
        calls.push(body);
        if (calls.length === 1) throw Object.assign(new Error('Synthetic route unavailable'), { status: 400 });
        return { choices: [{ message: { content: 'Synthetic answer' } }] } as any;
    });
    await runWithChannelPreset('gpt-balanced', () => createChatCompletionForTask('complexReasoning', { messages, temperature: 0.7 }));
    assert.deepEqual(calls.map(body => [body.model, body.reasoning_effort, body.max_completion_tokens, body.temperature]),
        [['gpt-6.1-sol', 'low', 8192, undefined], ['gpt-6-luna', 'low', 8192, undefined]]);
});

test('Responses receives task-specific reasoning for both cloud models', async t => {
    t.mock.method(usage, 'logAiUsage', async () => {});
    const calls: any[] = [];
    t.mock.method(openaiProviderAdapter.client.responses, 'create', async (body: any) => { calls.push(body); return { output: [] } as any; });
    await runWithChannelPreset('gpt-balanced', () => createResponseForTask('webSearchReasoning', { input: 'Synthetic', tools: [{ type: 'web_search_preview' }], max_output_tokens: 2048 }));
    await runWithChannelPreset('gpt-max', () => createResponseForTask('webSearchReasoning', { input: 'Synthetic', tools: [{ type: 'web_search_preview' }], max_output_tokens: 2048, temperature: 0.7 }));
    assert.deepEqual(calls.map(body => [body.model, body.reasoning?.effort, body.max_output_tokens]), [['gpt-6-luna', 'none', 2048], ['gpt-6.1-sol', 'low', 2048]]);
    assert.ok(calls.every(body => body.tools[0].type === 'web_search_preview'));
    assert.equal(calls[1].temperature, undefined);
});
