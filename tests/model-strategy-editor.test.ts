import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aiPresets } from '../ai/modelPresets';
import { defaultLocalRoutes } from '../ai/localModelRouting';
import { buildModelPlan, TEXT_TASKS, type ModelResources } from '../ai/modelPreferences';
import { customDraftFromModels, customDraftForProvider, inferCustomProvider } from '../admin-panel/src/modelStrategyEditor';

const localRoutes = defaultLocalRoutes('synthetic/local');
const context: ModelResources = { vars: { OPENAI_API_KEY: 'synthetic' }, localRoutes, memoryProfileName: 'stable-1536' };
const catalog = [{ provider: 'openai' as const, model: 'gpt-6-luna' }, { provider: 'openai' as const, model: 'gpt-6.1-sol' },
  { provider: 'gemini' as const, model: 'gemini-3.6-flash' }, { provider: 'lmstudio' as const, model: 'synthetic/local' }];

test('editor preserves exact saved model parameters, caps and provider when opening Custom', () => {
  const plan = buildModelPlan({ quality: 'high' }, context);
  const draft = customDraftFromModels(plan.models, 'high', localRoutes, plan.outputTokenLimits)!;
  assert.equal(draft.provider, 'openai');
  assert.equal(draft.routes.complexReasoning.maxTokens, plan.models.complexReasoning.generation?.maxTokens);
  assert.equal(draft.routes.complexReasoning.reasoningEffort, 'medium');
  const local = customDraftFromModels(aiPresets['lmstudio-local'].models, 'high', localRoutes)!;
  assert.equal(local.provider, 'lmstudio'); assert.equal(local.routes.conversation.model, 'synthetic/local');
  assert.equal(local.routes.conversation.maxTokens, localRoutes.fast.maxTokens);
});

test('provider change selects only its own catalog and resets foreign models', () => {
  for (const provider of ['openai', 'gemini', 'lmstudio'] as const) {
    const draft = customDraftForProvider(provider, 'high', catalog, localRoutes);
    assert.equal(draft.provider, provider);
    assert.ok(TEXT_TASKS.every(task => catalog.some(ref => ref.provider === provider && ref.model === draft.routes[task].model)));
  }
  assert.ok(Object.values(customDraftForProvider('gemini', 'high', [], localRoutes).routes).every(route => route.model === ''));
});

test('mixed legacy strategies require explicit provider choice and never silently migrate', () => {
  const before = structuredClone(aiPresets['hybrid-lmstudio-gpt'].models);
  assert.equal(inferCustomProvider(before), null);
  assert.equal(customDraftFromModels(before, 'high', localRoutes), null);
  assert.deepEqual(before, aiPresets['hybrid-lmstudio-gpt'].models);
});
