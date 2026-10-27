import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { classifyWithDecisions } from '../ai/decisionRouting';
import * as resolver from '../ai/modelResolver';
import { openaiProviderAdapter } from '../ai/providers/openai';
const decisionAdapter = openaiProviderAdapter as typeof openaiProviderAdapter & { createDecision: NonNullable<typeof openaiProviderAdapter.createDecision> };

function enabled(work: () => Promise<void>) {
    const previous = process.env.KIRA_DECISIONS_ENABLED;
    process.env.KIRA_DECISIONS_ENABLED = 'true';
    return work().finally(() => { if (previous === undefined) delete process.env.KIRA_DECISIONS_ENABLED; else process.env.KIRA_DECISIONS_ENABLED = previous; });
}

describe('optional Decisions routing adapter', () => {
    test('does no work unless explicitly enabled', async t => {
        const previous = process.env.KIRA_DECISIONS_ENABLED; delete process.env.KIRA_DECISIONS_ENABLED;
        const resolve = t.mock.method(resolver, 'resolveModelForTaskAsync', async () => { throw new Error('Unexpected routing lookup'); });
        try { assert.equal(await classifyWithDecisions('Привет'), null); assert.equal(resolve.mock.callCount(), 0); }
        finally { if (previous !== undefined) process.env.KIRA_DECISIONS_ENABLED = previous; }
    });

    test('preserves provider-pure Gemini and local routes', async t => {
        let provider: 'gemini' | 'lmstudio' = 'gemini';
        t.mock.method(resolver, 'resolveModelForTaskAsync', async () => ({ presetName: 'gemini-full', modelRef: { provider, model: 'synthetic-model' } }) as any);
        const call = t.mock.method(decisionAdapter, 'createDecision', async () => { throw new Error('OpenAI must not be called'); });
        await enabled(async () => {
            assert.equal(await classifyWithDecisions('Синтетический запрос'), null);
            provider = 'lmstudio'; assert.equal(await classifyWithDecisions('Синтетический запрос'), null);
            assert.equal(call.mock.callCount(), 0);
        });
    });

    test('does not replace a pinned free-dialogue classifier with Luna Decisions', async t => {
        t.mock.method(resolver, 'resolveModelForTaskAsync', async () => ({ presetName: 'gpt-balanced',
            modelRef: { provider: 'openai', model: 'synthetic/service-free', allowFallback: false } }) as any);
        const call = t.mock.method(decisionAdapter, 'createDecision', async () => { throw new Error('No alternate classifier'); });
        await enabled(async () => { assert.equal(await classifyWithDecisions('Синтетический запрос'), null); assert.equal(call.mock.callCount(), 0); });
    });

    test('returns routing, independent actions and context signals in one request', async t => {
        t.mock.method(resolver, 'resolveModelForTaskAsync', async () => ({ presetName: 'gpt-balanced', modelRef: { provider: 'openai', model: 'synthetic-classifier' } }) as any);
        let body: any;
        t.mock.method(decisionAdapter, 'createDecision', async (request: Record<string, unknown>) => {
            body = request;
            return { model: 'gpt-6-luna', answers: [
                { type: 'choice', name: 'intent', choice: 'ВЕБ_ПОИСК', confidence: 0.95, probabilities: [{ value: 'ВЕБ_ПОИСК', probability: 0.95 }, { value: 'РАЗГОВОР', probability: 0.05 }] },
                { type: 'choice', name: 'memory', choice: 'light' }, { type: 'choice', name: 'complexity', choice: 'complex' }, { type: 'choice', name: 'role', choice: 'мама' },
                { type: 'choice', name: 'reminder_action', choice: 'create', confidence: 0.98 },
                { type: 'predicate', name: 'action_0', probability: 0.99 },
            ], usage: { input_tokens: 100, output_tokens: 0, total_tokens: 100 } };
        });
        await enabled(async () => {
            const result = await classifyWithDecisions('Найди синтетическую афишу и напомни выбрать');
            assert.equal(body.model, 'gpt-6-luna'); assert.ok(body.questions.length > 4);
            assert.equal(result?.intent, 'ВЕБ_ПОИСК'); assert.equal(result?.details.memoryNeed, 'light');
            assert.equal(result?.details.responseComplexity, 'complex'); assert.equal(result?.details.relationshipRole, 'мама');
            assert.ok(result?.subIntents?.some(item => item.intent === 'НАПОМИНАНИЕ'));
        });
    });

    test('falls back to the configured classifier on gateway failure or refusal', async t => {
        t.mock.method(resolver, 'resolveModelForTaskAsync', async () => ({ presetName: 'gpt-balanced', modelRef: { provider: 'openai', model: 'synthetic-classifier' } }) as any);
        const call = t.mock.method(decisionAdapter, 'createDecision', async () => { throw new Error('Unsupported gateway endpoint'); });
        await enabled(async () => { assert.equal(await classifyWithDecisions('Синтетический запрос'), null); });
        call.mock.restore();
        t.mock.method(decisionAdapter, 'createDecision', async () => ({ model: 'gpt-6-luna', answers: [{ type: 'refusal', name: 'intent' }] }));
        await enabled(async () => { assert.equal(await classifyWithDecisions('Синтетический запрос'), null); });
    });

    test('uses documented choice confidence and preserves reminder cancellation', async t => {
        t.mock.method(resolver, 'resolveModelForTaskAsync', async () => ({ presetName: 'gpt-balanced', modelRef: { provider: 'openai', model: 'synthetic-classifier' } }) as any);
        t.mock.method(decisionAdapter, 'createDecision', async () => ({ model: 'gpt-6-luna', answers: [
            { type: 'choice', name: 'intent', choice: 'НАПОМИНАНИЕ', confidence: 0.95 },
            { type: 'choice', name: 'memory', choice: 'none' }, { type: 'choice', name: 'complexity', choice: 'routine' }, { type: 'choice', name: 'role', choice: 'none' },
            { type: 'choice', name: 'reminder_action', choice: 'cancel' },
        ] }));
        await enabled(async () => {
            const result = await classifyWithDecisions('Отмени синтетическое напоминание');
            assert.equal(result?.confidenceLevel, 'ВЫСОКИЙ'); assert.equal(result?.details.reminderAction, 'cancel');
        });
    });

    test('uses the existing OpenAI client transport for the new endpoint', async t => {
        const request = t.mock.method(openaiProviderAdapter.client, 'post', async () => ({ model: 'gpt-6-luna', answers: [] }) as any);
        await openaiProviderAdapter.createDecision!({ model: 'gpt-6-luna', input: 'synthetic', questions: [] });
        assert.equal(request.mock.calls[0].arguments[0], '/decisions');
        const options = request.mock.calls[0].arguments[1] as any;
        assert.equal(options.timeout, 5000); assert.equal(options.maxRetries, 0);
    });
});
