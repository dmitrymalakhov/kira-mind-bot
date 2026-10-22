import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveConfiguredModelRef } from '../ai/modelResolver';
import { allowsCrossProviderFallback } from '../ai/runtimeSupport';
import { lmstudioProviderAdapter } from '../ai/providers/lmstudio';
import { aiPresets } from '../ai/modelPresets';
const { getPresetAvailability } = require('../admin-panel/presetAvailability');

test('local model IDs are resolved explicitly and never guessed', () => {
    const previous = process.env.LM_STUDIO_MODEL;
    try {
        delete process.env.LM_STUDIO_MODEL;
        assert.throws(() => resolveConfiguredModelRef(aiPresets['lmstudio-local'].models.conversation), /LM_STUDIO_MODEL/);
        process.env.LM_STUDIO_MODEL = 'synthetic/local-model';
        assert.equal(resolveConfiguredModelRef(aiPresets['lmstudio-local'].models.conversation).model, 'synthetic/local-model');
        assert.equal(resolveConfiguredModelRef(aiPresets['gpt-balanced'].models.conversation).provider, 'openai');
    } finally {
        if (previous === undefined) delete process.env.LM_STUDIO_MODEL;
        else process.env.LM_STUDIO_MODEL = previous;
    }
});

test('local mode keeps failed text local while hybrid allows cloud fallback', () => {
    assert.equal(allowsCrossProviderFallback('lmstudio-local'), false);
    assert.equal(allowsCrossProviderFallback('hybrid-lmstudio-gpt'), true);
    assert.equal(aiPresets['lmstudio-local'].models.memoryExtraction.provider, 'lmstudio');
    assert.equal(aiPresets['hybrid-lmstudio-gpt'].models.complexReasoning.provider, 'openai');
    assert.equal(aiPresets['lmstudio-local'].models.webSearchReasoning.provider, 'openai');
});

test('LM Studio accepts JSON schema instead of unsupported json_object', () => {
    const params = lmstudioProviderAdapter.normalizeChatParams('synthetic-model', {
        messages: [{ role: 'user', content: 'Return JSON' }],
        response_format: { type: 'json_object' }, max_completion_tokens: 100,
        reasoning_effort: 'high', prompt_cache_key: 'synthetic-cache',
    });
    assert.equal(params.response_format?.type, 'json_schema');
    assert.equal(params.max_tokens, 100);
    assert.equal(params.max_completion_tokens, undefined);
    assert.equal(params.reasoning_effort, 'high');
    assert.equal(params.prompt_cache_key, undefined);
});

test('LM Studio availability requires a model and allows an unauthenticated local server', () => {
    const preset = { models: { conversation: aiPresets['lmstudio-local'].models.conversation } };
    assert.equal(getPresetAvailability(preset, { LM_STUDIO_MODEL: 'synthetic-model' }).enabled, true);
    assert.equal(getPresetAvailability(preset, {}).enabled, false);
});
