import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { buildModelPlan, parseModelPolicy, parsePreferences, selectAutomaticProviders, TEXT_TASKS, type ModelResources } from '../ai/modelPreferences';
import { defaultLocalRoutes } from '../ai/localModelRouting';
import { runWithModelPolicy } from '../services/modelPreferenceService';
import { runWithChannelPreset } from '../services/aiRuntimeConfigService';
import { resolveModelForTaskAsync } from '../ai/modelResolver';
import { createChatCompletionForTask, createJsonChatCompletionForTask, createFallbackChatCompletion } from '../ai/chatCompletion';
import { createResponseForTask } from '../ai/responseCompletion';
import { openaiProviderAdapter } from '../ai/providers/openai';
import { openrouterProviderAdapter } from '../ai/providers/openrouter';
import { zaiProviderAdapter } from '../ai/providers/zai';
import { lmstudioProviderAdapter } from '../ai/providers/lmstudio';
import { runAutomaticModels, supportsAutomaticResponse } from '../ai/automaticRouting';
import { AiContentSafetyError, assertAiResponseAllowed, isAiContentSafetyError } from '../ai/contentSafety';
import { photoVisionRoute } from '../api/photos';
import { publicModelPreferences } from '../api/modelPreferenceView';
import { selectConversationTask } from '../ai/taskRouting';
import * as usage from '../services/aiUsageLogService';
import type { ChatCompletionParamsWithoutModel } from '../ai/providers/types';
import * as resolver from '../ai/modelResolver';

const messages = [{ role: 'user' as const, content: 'Синтетическая задача' }];
const completion = (content = '{}') => ({ choices: [{ message: { content } }] } as any);
const resources = (): ModelResources => ({ vars: { OPENAI_API_KEY: 'synthetic', ZAI_API_KEY: 'synthetic', OPENROUTER_API_KEY: 'synthetic', GEMINI_API_KEY: 'synthetic' },
    memoryProfileName: 'stable-1536', localRoutes: defaultLocalRoutes('synthetic/local'), localModels: [{ id: 'synthetic/local' }] });
let clock = Date.now();
function isolated(t: TestContext) {
    const before = { ...process.env };
    Object.assign(process.env, resources().vars);
    clock += 120_000; t.mock.method(Date, 'now', () => clock);
    const log = t.mock.method(usage, 'logAiUsage', async () => {});
    t.after(() => { for (const key of Object.keys(resources().vars)) { if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key]; } });
    return log;
}

test('automatic compilation mixes task roles, respects quality and snapshots a bounded validated pool', () => {
    for (const quality of ['standard', 'high', 'maximum'] as const) {
        const plan = buildModelPlan({ quality }, resources());
        assert.equal(plan.version, 4); assert.equal(plan.source, 'service');
        assert.deepEqual(parseModelPolicy(JSON.stringify(plan)), plan);
        for (const task of TEXT_TASKS) {
            assert.deepEqual(plan.models[task], plan.routing![task]![0]);
            assert.deepEqual(new Set(plan.routing![task]!.map(ref => ref.provider)), new Set(['openai', 'gemini', 'zai', 'openrouter']));
            assert.ok(plan.routing![task]!.every(ref => ref.allowFallback === false && !ref.localRole && !ref.modelEnvKey));
            assert.ok(plan.routing![task]!.filter(ref => ref.provider === 'openrouter').length >= 2);
            assert.ok(plan.routing![task]!.every(ref => ref.provider !== 'openrouter' || !ref.model.endsWith('/auto')));
        }
        assert.equal(plan.models.webSearchReasoning.provider, 'openai');
        assert.equal(plan.models.embedding.provider, 'openai');
        if (quality === 'standard') assert.equal(plan.models.conversation.provider, 'zai');
        if (quality === 'high') {
            assert.equal(plan.models.fastDialogue.provider, 'openai');
            assert.equal(plan.models.runtimePlanning.provider, 'zai');
            assert.equal(plan.models.conversation.provider, 'openrouter');
            assert.equal(plan.models.complexReasoning.model, 'gpt-6.1-sol');
        }
    }
});

test('provider selection is strict, local is opt-in and preview uses the same pool restriction as saving', () => {
    const context = resources();
    const all = buildModelPlan({ quality: 'standard', providers: ['openai', 'gemini', 'zai', 'openrouter', 'lmstudio'] }, context);
    const chosen = buildModelPlan({ quality: 'standard', providers: ['lmstudio', 'openai'] }, context);
    assert.deepEqual(selectAutomaticProviders(all, ['lmstudio', 'openai']), chosen);
    assert.equal(chosen.models.conversation.provider, 'lmstudio');
    context.localRoutes.fast.model = 'synthetic/changed-after-save';
    assert.equal(chosen.models.conversation.model, 'synthetic/local');
    assert.throws(() => buildModelPlan({ quality: 'high', providers: ['lmstudio'] }, { ...context, localModels: [] }), /Нет доступного/);
    for (const providers of [[], ['unknown'], ['openai', 'openai'], '__proto__', [null]]) assert.throws(() => parsePreferences({ quality: 'high', providers }));
    assert.throws(() => parsePreferences({ quality: 'high', provider: 'zai', providers: ['openai'] }));
    for (const change of [
        (plan: any) => { plan.routing.conversation[1].provider = 'lmstudio'; },
        (plan: any) => { plan.routing.conversation[1].modelEnvKey = 'SECRET'; },
        (plan: any) => { plan.routing.conversation[1].allowFallback = true; },
        (plan: any) => { plan.routing.conversation[1].generation.maxTokens = 20000; },
        (plan: any) => { plan.routing.conversation = []; },
        (plan: any) => { plan.routing.conversation.push(plan.routing.conversation[0]); },
        (plan: any) => { plan.models.conversation.model = 'synthetic/tampered'; },
    ]) {
        const plan = structuredClone(buildModelPlan({ quality: 'high' }, context)); change(plan);
        assert.throws(() => parseModelPolicy(plan));
    }
});

test('a full semantic task sequence uses separate providers with one call per successful stage and preserves input', async t => {
    isolated(t);
    const plan = buildModelPlan({ quality: 'high', providers: ['openai', 'zai', 'openrouter'] }, resources());
    const calls: Array<{ provider: string; model: string; text: unknown }> = [];
    for (const adapter of [openaiProviderAdapter, zaiProviderAdapter, openrouterProviderAdapter]) {
        t.mock.method(adapter, 'createChatCompletion', async (model: string, params: ChatCompletionParamsWithoutModel) => {
            calls.push({ provider: adapter.provider, model, text: params.messages[0].content }); return completion();
        });
    }
    await runWithModelPolicy(plan, async () => {
        await createJsonChatCompletionForTask('intentClassification', { messages });
        await createJsonChatCompletionForTask('runtimePlanning', { messages });
        for (const details of [{ responseComplexity: 'routine' as const }, { responseComplexity: 'complex' as const }]) {
            await createChatCompletionForTask(selectConversationTask({ details }), { messages });
        }
        const restored = JSON.parse(JSON.stringify(plan));
        await runWithModelPolicy(parseModelPolicy(restored), () => createChatCompletionForTask('conversation', { messages }));
    });
    assert.deepEqual(calls.map(call => call.provider), ['openai', 'zai', 'openrouter', 'openai', 'openrouter']);
    assert.ok(calls.every(call => call.text === messages[0].content));
});

test('technical failures and invalid JSON switch only inside the pool, retain caps and record actual models', async t => {
    const log = isolated(t);
    const plan = buildModelPlan({ quality: 'high', providers: ['openai', 'zai'] }, resources());
    const events: any[] = [], calls: string[] = [];
    log.mock.mockImplementation(async (event: Parameters<typeof usage.logAiUsage>[0]) => { events.push(event); });
    const first = t.mock.method(openaiProviderAdapter, 'createChatCompletion', async () => { calls.push('openai'); throw Object.assign(new Error('Synthetic outage'), { status: 503 }); });
    t.mock.method(zaiProviderAdapter, 'createChatCompletion', async (_model: string, params: ChatCompletionParamsWithoutModel) => {
        calls.push('zai'); assert.equal(params.max_completion_tokens ?? params.max_tokens, 100); return completion('{"ok":true}');
    });
    const result = await runWithModelPolicy(plan, () => createJsonChatCompletionForTask('conversation', { messages, max_tokens: 100 }));
    assert.deepEqual(result, { ok: true }); assert.deepEqual(calls, ['openai', 'zai']);
    assert.deepEqual(events.map(event => [event.provider, event.success, event.stage]), [['openai', false, 'primary'], ['zai', true, 'fallback']]);
    calls.length = 0;
    await runWithModelPolicy(plan, () => createChatCompletionForTask('conversation', { messages, max_tokens: 100 }));
    assert.deepEqual(calls, ['zai']); // Account-worker cooldown avoids repeating an outage on the next turn.
    clock += 60_000;
    first.mock.mockImplementation(async () => completion('invalid synthetic JSON'));
    assert.deepEqual(await runWithModelPolicy(plan, () => createJsonChatCompletionForTask('intentClassification', { messages, max_tokens: 100 })), { ok: true });
});

test('concurrent requests prefer a free candidate and release reservations after completion', async t => {
    isolated(t);
    const plan = buildModelPlan({ quality: 'high', providers: ['openai', 'zai'] }, resources());
    let release!: () => void, started!: () => void;
    const gate = new Promise<void>(r => { release = r; }), entered = new Promise<void>(r => { started = r; });
    const calls: string[] = [];
    t.mock.method(openaiProviderAdapter, 'createChatCompletion', async () => { calls.push('openai'); started(); await gate; return completion(); });
    t.mock.method(zaiProviderAdapter, 'createChatCompletion', async () => { calls.push('zai'); return completion(); });
    await runWithModelPolicy(plan, async () => {
        const first = createChatCompletionForTask('conversation', { messages }); await entered;
        try { await createChatCompletionForTask('conversation', { messages }); } finally { release(); }
        await first;
        await createChatCompletionForTask('conversation', { messages });
    });
    assert.deepEqual(calls, ['openai', 'zai', 'openai']);
});

test('refusals and moderation errors never reach a second provider, a local model or JSON repair', async t => {
    isolated(t);
    const plan = buildModelPlan({ quality: 'high', providers: ['openai', 'lmstudio'] }, resources());
    const local = t.mock.method(lmstudioProviderAdapter, 'createChatCompletion', async () => { throw new Error('Unexpected local call'); });
    const primary = t.mock.method(openaiProviderAdapter, 'createChatCompletion', async () => completion());
    for (const rejection of [
        () => { throw Object.assign(new Error('Synthetic moderation'), { status: 503, code: 'content_policy_violation' }); },
        () => ({ choices: [{ finish_reason: 'content_filter', message: { content: '' } }] } as any),
        () => ({ choices: [{ message: { content: '', refusal: 'Synthetic refusal' } }] } as any),
    ]) {
        primary.mock.mockImplementation(async () => rejection());
        await assert.rejects(runWithModelPolicy(plan, () => createJsonChatCompletionForTask('intentClassification', { messages })), isAiContentSafetyError);
    }
    assert.equal(local.mock.callCount(), 0);
    await assert.rejects(createFallbackChatCompletion('conversation', { messages }, new AiContentSafetyError()), isAiContentSafetyError);
    assert.throws(() => assertAiResponseAllowed({ output: [{ content: [{ type: 'refusal', refusal: 'Synthetic' }] }] }), AiContentSafetyError);
    assert.equal(isAiContentSafetyError({ response: { data: { error: { code: 'content_filter' } } } }), true);
});

test('local is an ordinary explicitly selected participant; exhausted and unsupported pools fail closed', async t => {
    isolated(t);
    const plan = buildModelPlan({ quality: 'high', providers: ['openai', 'lmstudio'] }, resources());
    t.mock.method(openaiProviderAdapter, 'createChatCompletion', async () => { throw Object.assign(new Error('Synthetic outage'), { status: 503 }); });
    const local = t.mock.method(lmstudioProviderAdapter, 'createChatCompletion', async () => completion('Synthetic local answer'));
    const result = await runWithModelPolicy(plan, () => createChatCompletionForTask('conversation', { messages }));
    assert.equal(result.choices[0].message.content, 'Synthetic local answer'); assert.equal(local.mock.callCount(), 1);
    const outside = t.mock.method(zaiProviderAdapter, 'createChatCompletion', async () => { throw new Error('Outside pool'); });
    local.mock.mockImplementation(async () => { throw Object.assign(new Error('Synthetic outage'), { status: 503 }); });
    await assert.rejects(runWithModelPolicy(plan, () => createChatCompletionForTask('conversation', { messages })));
    assert.equal(outside.mock.callCount(), 0);
    const route = await runWithModelPolicy(plan, () => resolveModelForTaskAsync('conversation'));
    await assert.rejects(runAutomaticModels(route, () => false, async () => 'unused'), /Нет доступной модели/);
});

test('vision uses the prepared recipient, Responses filters unsupported transports, and app overrides have no pool', async t => {
    isolated(t);
    const plan = buildModelPlan({ quality: 'high', providers: ['openrouter', 'openai', 'zai'] }, resources());
    const other = t.mock.method(openaiProviderAdapter, 'createChatCompletion', async () => { throw new Error('Unexpected vision recipient'); });
    t.mock.method(openrouterProviderAdapter, 'createChatCompletion', async () => completion('Synthetic pixels'));
    await runWithModelPolicy(plan, async () => {
        assert.equal((await photoVisionRoute()).provider, 'openrouter');
        const vision = [{ role: 'user' as const, content: [{ type: 'image_url' as const, image_url: { url: 'data:image/jpeg;base64,c3ludGhldGlj' } }] }];
        assert.equal((await createChatCompletionForTask('conversation', { messages: vision })).choices[0].message.content, 'Synthetic pixels');
    });
    assert.equal(other.mock.callCount(), 0);
    const response = t.mock.method(openaiProviderAdapter, 'createResponse', async () => ({ output: [], output_text: 'Synthetic response' }) as any);
    assert.equal((await runWithModelPolicy(plan, () => createResponseForTask('conversation', { input: 'Synthetic' }))).output_text, 'Synthetic response');
    assert.equal(response.mock.callCount(), 1);
    assert.equal(supportsAutomaticResponse(plan.routing!.conversation!.find(ref => ref.provider === 'zai')!, { tools: [{ type: 'function' }] }), false);
    // The explicit app selection bypasses the database policy; it must not inherit automatic candidates.
    const overridden = await runWithChannelPreset('gpt-lean', () => resolveModelForTaskAsync('conversation'));
    assert.equal(overridden.candidates, undefined);
});

test('mobile recipient metadata describes the complete selected text pool and scoped overrides', t => {
    isolated(t);
    const plan = buildModelPlan({ quality: 'high', providers: ['openai', 'zai', 'lmstudio'] }, resources());
    const state = { activePlan: plan, localRoutes: resources().localRoutes, plans: [], providerPlans: [], manualPreset: 'gpt-balanced' };
    const inherited = publicModelPreferences(state, { preset: null, revision: 'synthetic' }, 'stable-1536');
    const route = inherited.effectivePlan.account.routes.conversation as any;
    assert.equal(route.selection, 'automatic-pool'); assert.equal(route.crossProviderFallback, true);
    assert.deepEqual(route.candidates.map((ref: any) => ref.provider), plan.routing!.conversation!.map(ref => ref.provider));
    assert.equal(route.fallbacks.at(-1).location, 'server-local');
    const overridden = publicModelPreferences(state, { preset: 'gpt-lean', revision: 'synthetic' }, 'stable-1536');
    assert.equal((overridden.effectivePlan.app.routes.conversation as any).selection, undefined);
});

test('a policy change after failure abandons the former pool before sending to another recipient', async t => {
    isolated(t);
    const initial = buildModelPlan({ quality: 'high', providers: ['openai', 'zai'] }, resources());
    const next = buildModelPlan({ quality: 'high', providers: ['lmstudio'] }, resources());
    let current = { presetName: initial.presetName, modelRef: initial.models.conversation, candidates: initial.routing!.conversation };
    t.mock.method(resolver, 'resolveModelForTaskAsync', async () => current);
    t.mock.method(resolver, 'resolveModelForTaskFreshAsync', async () => current);
    t.mock.method(openaiProviderAdapter, 'createChatCompletion', async () => {
        current = { presetName: next.presetName, modelRef: next.models.conversation, candidates: next.routing!.conversation };
        throw Object.assign(new Error('Synthetic temporary failure'), { status: 503 });
    });
    const former = t.mock.method(zaiProviderAdapter, 'createChatCompletion', async () => { throw Error('Former recipient'); });
    t.mock.method(lmstudioProviderAdapter, 'createChatCompletion', async () => completion('New scoped response'));
    assert.equal((await createChatCompletionForTask('conversation', { messages })).choices[0].message.content, 'New scoped response');
    assert.equal(former.mock.callCount(), 0);
});

test('Responses fails over on technical errors, stops on refusal, and malformed JSON exhaustion stays inside its pool', async t => {
    isolated(t);
    const plan = buildModelPlan({ quality: 'high', providers: ['openai', 'zai'] }, resources());
    const primary = t.mock.method(openaiProviderAdapter, 'createResponse', async () => { throw Object.assign(new Error('Synthetic outage'), { status: 503 }); });
    const second = t.mock.method(zaiProviderAdapter, 'createResponse', async () => ({ output_text: 'Recovered response', output: [] }) as any);
    assert.equal((await runWithModelPolicy(plan, () => createResponseForTask('conversation', { input: 'Synthetic' }))).output_text, 'Recovered response');
    assert.equal(second.mock.callCount(), 1);
    clock += 60_000;
    primary.mock.mockImplementation(async () => ({ output: [{ content: [{ type: 'refusal', refusal: 'Synthetic refusal' }] }] }) as any);
    await assert.rejects(runWithModelPolicy(plan, () => createResponseForTask('conversation', { input: 'Synthetic' })), isAiContentSafetyError);
    assert.equal(second.mock.callCount(), 1);
    const firstJson = t.mock.method(openaiProviderAdapter, 'createChatCompletion', async () => completion('Invalid synthetic JSON'));
    const secondJson = t.mock.method(zaiProviderAdapter, 'createChatCompletion', async () => completion('Also invalid synthetic JSON'));
    assert.equal(await runWithModelPolicy(plan, () => createJsonChatCompletionForTask('conversation', { messages })), null);
    assert.equal(firstJson.mock.callCount(), 1); assert.equal(secondJson.mock.callCount(), 1);
});

test('switching a pinned route to an automatic pool with the same primary activates its replacement policy', async t => {
    isolated(t);
    const plan = buildModelPlan({ quality: 'high', providers: ['openai', 'zai'] }, resources());
    const automatic = { presetName: plan.presetName, modelRef: plan.models.conversation, candidates: plan.routing!.conversation };
    let current: resolver.AiResolvedTaskRoute = { presetName: plan.presetName, modelRef: plan.models.conversation };
    t.mock.method(resolver, 'resolveModelForTaskAsync', async () => current);
    t.mock.method(resolver, 'resolveModelForTaskFreshAsync', async () => current);
    t.mock.method(openaiProviderAdapter, 'createChatCompletion', async () => {
        current = automatic; throw Object.assign(new Error('Synthetic outage while changing strategy'), { status: 503 });
    });
    const second = t.mock.method(zaiProviderAdapter, 'createChatCompletion', async () => completion('New automatic result'));
    assert.equal((await createChatCompletionForTask('conversation', { messages })).choices[0].message.content, 'New automatic result');
    assert.equal(second.mock.callCount(), 1);
    clock += 60_000; current = { presetName: plan.presetName, modelRef: plan.models.conversation };
    t.mock.method(openaiProviderAdapter, 'createResponse', async () => {
        current = automatic; throw Object.assign(new Error('Synthetic outage while changing strategy'), { status: 503 });
    });
    const recovered = t.mock.method(zaiProviderAdapter, 'createResponse', async () => ({ output_text: 'New automatic response' }) as any);
    assert.equal((await createResponseForTask('conversation', { input: 'Synthetic' })).output_text, 'New automatic response');
    assert.equal(recovered.mock.callCount(), 1);
});

test('a refused response records consumed provider tokens once and marks content policy as terminal', async t => {
    const log = isolated(t);
    const plan = buildModelPlan({ quality: 'high', providers: ['openai', 'lmstudio'] }, resources());
    const events: Array<Parameters<typeof usage.logAiUsage>[0]> = [];
    log.mock.mockImplementation(async (event: Parameters<typeof usage.logAiUsage>[0]) => { events.push(event); });
    t.mock.method(openaiProviderAdapter, 'createChatCompletion', async () => ({ choices: [{ message: { refusal: 'Synthetic refusal', content: '' } }],
        usage: { prompt_tokens: 2, completion_tokens: 5, total_tokens: 7 } }) as any);
    await assert.rejects(runWithModelPolicy(plan, () => createChatCompletionForTask('conversation', { messages })), isAiContentSafetyError);
    assert.equal(events.length, 1); assert.equal(events[0].totalTokens, 7); assert.equal(events[0].errorCategory, 'content_policy');
    assert.equal(events[0].success, false); assert.equal(events[0].retryable, false);
    t.mock.method(openaiProviderAdapter, 'createResponse', async () => ({ output: [{ content: [{ type: 'refusal' }] }],
        usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 } }) as any);
    await assert.rejects(runWithModelPolicy(plan, () => createResponseForTask('conversation', { input: 'Synthetic' })), isAiContentSafetyError);
    assert.equal(events.length, 2); assert.equal(events[1].totalTokens, 7); assert.equal(events[1].success, false);
    const zaiPlan = buildModelPlan({ quality: 'high', providers: ['zai'] }, resources());
    t.mock.method(zaiProviderAdapter.client.chat.completions, 'create', async () => ({ choices: [{ message: { refusal: 'Synthetic refusal' } }],
        usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } }) as any);
    await assert.rejects(runWithModelPolicy(zaiPlan, () => createResponseForTask('conversation', { input: 'Synthetic' })), isAiContentSafetyError);
    assert.equal(events.length, 3); assert.equal(events[2].totalTokens, 7); assert.equal(events[2].success, false);
});

test('an automatic account with one cloud provider can degrade a heavy model without increasing standard quality cost', async t => {
    isolated(t);
    const context = resources();
    for (const provider of ['openai', 'gemini', 'zai'] as const) {
        const standard = buildModelPlan({ quality: 'standard', providers: [provider] }, context);
        const maximum = buildModelPlan({ quality: 'maximum', providers: [provider] }, context);
        assert.equal(standard.routing!.complexReasoning!.length, 1);
        assert.equal(maximum.routing!.complexReasoning!.length, 2);
        assert.equal(maximum.routing!.complexReasoning![1].model, standard.models.complexReasoning.model);
    }
    const plan = buildModelPlan({ quality: 'high', providers: ['openai'] }, context);
    const calls: string[] = [];
    t.mock.method(openaiProviderAdapter.client.chat.completions, 'create', async (body: any) => {
        calls.push(body.model);
        if (body.model === 'gpt-6.1-sol') throw Object.assign(new Error('Synthetic model outage'), { status: 503 });
        assert.equal(body.reasoning_effort, 'low'); assert.equal(body.max_completion_tokens, 4096);
        return completion('Recovered with a lighter model');
    });
    const result = await runWithModelPolicy(plan, () => createChatCompletionForTask('complexReasoning', { messages }));
    assert.equal(result.choices[0].message.content, 'Recovered with a lighter model');
    assert.deepEqual(calls, ['gpt-6.1-sol', 'gpt-6-luna']);
});
