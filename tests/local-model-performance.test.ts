import assert from 'node:assert/strict';
import test from 'node:test';
import { isSimpleSocialMessage, simplePresenceReply } from '../utils/simpleDialogue';
import { defaultLocalRoutes, parseLocalRoutes } from '../ai/localModelRouting';
import { resolveConfiguredModelRef } from '../ai/modelResolver';
import { resolveModelForTaskAsync } from '../ai/modelResolver';
import { getLocalModelRoutes } from '../services/localModelConfigService';
import { AppDataSource } from '../data-source';
import { aiPresets } from '../ai/modelPresets';
import { lmstudioProviderAdapter } from '../ai/providers/lmstudio';
import * as completions from '../ai/chatCompletion';
import * as selfMemory from '../utils/kiraSelfMemory';
import * as evolution from '../services/kiraSelfEvolutionService';
import * as residence from '../services/kiraResidenceService';
import * as domainMemory from '../utils/domainMemory';
import { processMessage } from '../orchestrator';
import { createPlan } from '../orchestration/planner';
import { buildAssistantLifeContext } from '../utils/conversationSelfMemoryFallback';
const { listLocalModels, registerLocalModelRoutes } = require('../admin-panel/localModels');

test('social fast path never consumes an action or context-dependent answer', () => {
  for (const text of ['Привет!', 'Привет, как дела?', 'Спасибо большое', 'Добрый вечер, Лира', 'Лира, как настроение?']) assert.equal(isSimpleSocialMessage(text, 'Лира'), true, text);
  for (const text of ['Привет, напомни через час', 'Спасибо, отправь это маме', 'Да', 'Нет', 'А что с ней?', 'Привет, какие сегодня новости?', 'Ок, бронируй']) assert.equal(isSimpleSocialMessage(text, 'Лира'), false, text);
});

test('presence recognition is exact and cannot swallow a longer request, quotation or third-person question', () => {
  for (const text of ['Ты тут?', 'Лира, ты на связи?', 'Привет, ты здесь?', 'Ау!']) assert.ok(simplePresenceReply(text, 'Лира'), text);
  for (const text of ['Ты тут? Напомни через час', 'Напиши ему «ты тут?»', 'Он тут?', 'Ты тут была вчера?', 'Ты на связи с моей коллегой?']) assert.equal(simplePresenceReply(text, 'Лира'), undefined, text);
});

test('self-contained turns keep mood and a recent event without loading the personality archive into the prompt', () => {
  const state = { mood: 'спокойное', recentThoughts: ['Синтетическая мысль'], recentTopics: [], personality: { identity: 'Синтетический длинный архив'.repeat(200) } } as any;
  const context = buildAssistantLifeContext(state, [{ description: 'Синтетическая прогулка' }] as any, [], new Date(), { compact: true });
  assert.match(context, /спокойное/); assert.match(context, /Синтетическая прогулка/);
  assert.doesNotMatch(context, /длинный архив/); assert.ok(context.length < 650);
});

test('local role choices resolve independently and preserve cloud routes', () => {
  const routes = defaultLocalRoutes('synthetic/fast');
  routes.analysis.model = 'synthetic/json'; routes.deep.model = 'synthetic/deep';
  assert.equal(resolveConfiguredModelRef(aiPresets['lmstudio-local'].models.conversation, routes).model, 'synthetic/fast');
  assert.equal(resolveConfiguredModelRef(aiPresets['lmstudio-local'].models.intentClassification, routes).model, 'synthetic/json');
  assert.equal(resolveConfiguredModelRef(aiPresets['lmstudio-local'].models.complexReasoning, routes).model, 'synthetic/deep');
  assert.equal(resolveConfiguredModelRef(aiPresets['hybrid-lmstudio-gpt'].models.complexReasoning, routes).provider, 'openai');
  assert.deepEqual(parseLocalRoutes(JSON.stringify(routes)), routes);
  for (const invalid of [{}, { ...routes, fast: { ...routes.fast, maxTokens: 0 } }, { ...routes, fast: { ...routes.fast, reasoningEffort: 'unbounded' } }]) assert.throws(() => parseLocalRoutes(invalid));
});

test('LM Studio sends role-specific reasoning and output limits without extra requests', async t => {
  const sent: any[] = [];
  t.mock.method(lmstudioProviderAdapter.client.chat.completions, 'create', async (body: any) => {
    sent.push(body); return { choices: [{ message: { content: 'synthetic reply' }, finish_reason: 'stop' }] } as any;
  });
  const params = { messages: [{ role: 'user', content: 'synthetic' }], max_completion_tokens: 1200 } as any;
  await lmstudioProviderAdapter.createChatCompletion('synthetic/local', params, { maxTokens: 768, reasoningEffort: 'none' });
  await lmstudioProviderAdapter.createChatCompletion('synthetic/deep', params, { maxTokens: 4096, reasoningEffort: 'low' });
  assert.equal(sent.length, 2);
  assert.equal(sent[0].reasoning_effort, 'none'); assert.equal(sent[0].max_tokens, 768);
  assert.equal(sent[1].reasoning_effort, 'low'); assert.equal(sent[1].max_tokens, 1200);
  assert.equal(sent[0].max_completion_tokens, undefined);
});

test('ordinary conversation skips the planner at medium confidence but retains current web sources', async t => {
  const call = t.mock.method(completions, 'createChatCompletionForTask', async () => { throw new Error('unnecessary planner'); });
  assert.deepEqual(await createPlan({ message: 'Расскажи короткую шутку', classification: { intent: 'РАЗГОВОР', confidenceLevel: 'СРЕДНИЙ', details: {} } }), { steps: [{ agentId: 'conversation' }] });
  assert.equal(call.mock.callCount(), 0);
  // The source policy must survive the conversation optimization.
  const { postProcessPlan } = await import('../orchestration/planner');
  assert.deepEqual(postProcessPlan({ steps: [{ agentId: 'conversation' }] }, { intent: 'РАЗГОВОР', confidenceLevel: 'ВЫСОКИЙ', details: { knowledgeSource: 'external_current' } }), { steps: [{ agentId: 'webSearch' }, { agentId: 'conversation' }] });
});

test('a greeting uses one answer call and never repeats empty memory retrieval', async t => {
  const calls: string[] = [];
  t.mock.method(completions, 'createChatCompletionForTask', async (task: string) => {
    calls.push(task); return { choices: [{ message: { content: 'Привет! Рада тебя видеть.' } }] } as any;
  });
  const classify = t.mock.method(completions, 'createJsonChatCompletionForTask', async () => { throw new Error('unnecessary classification'); });
  const detect = t.mock.method(domainMemory, 'detectDomain', async () => { throw new Error('empty memory is already resolved'); });
  t.mock.method(selfMemory, 'getRecentKiraSelfEvents', async () => []);
  t.mock.method(selfMemory, 'getKiraSelfMemoryState', async () => null as any);
  const search = t.mock.method(selfMemory, 'searchKiraSelfEventsByQuery', async () => { throw new Error('unnecessary semantic search'); });
  t.mock.method(evolution, 'maybeEvolveKiraSelfFromConversation', async () => undefined);
  t.mock.method(residence, 'getKiraResidence', async () => ({ city: 'Синтетический город', source: 'default' }) as any);
  const result = await processMessage({ from: { id: 900001 }, chat: { id: 900001, type: 'private' }, session: { messageHistory: [] }, api: {} }, 'Привет!');
  assert.equal(result.responseText, 'Привет! Рада тебя видеть.');
  assert.equal(result.skipOptionalFollowups, true);
  assert.deepEqual(calls, ['conversation']);
  assert.equal(classify.mock.callCount(), 0); assert.equal(detect.mock.callCount(), 0); assert.equal(search.mock.callCount(), 0);
});

test('admin catalog lists text models alphabetically and loaded aliases without content labels', async () => {
  const models = await listLocalModels({ LM_STUDIO_BASE_URL: 'http://synthetic:1234/v1' }, async (url: string) => {
    assert.equal(url, 'http://synthetic:1234/api/v1/models');
    return { ok: true, json: async () => ({ models: [
      { type: 'embedding', key: 'synthetic/embed' },
      { type: 'llm', key: 'synthetic/regular', loaded_instances: [] },
      { type: 'llm', key: 'synthetic/uncensored', loaded_instances: [{ id: 'synthetic/alias', config: { context_length: 8192 } }] },
    ] }) };
  });
  assert.equal(models.length, 2); assert.equal(models[0].id, 'synthetic/regular'); assert.equal(Object.prototype.hasOwnProperty.call(models[1], 'uncensored'), false);
  assert.deepEqual(models[1].loadedIds, ['synthetic/alias']); assert.equal(models[1].contextLength, 8192);
});

test('admin never confirms model settings after a failed database write', async t => {
  const handlers: Record<string, any> = {};
  const app = { get: () => undefined, post: (path: string, _auth: unknown, handler: unknown) => { handlers[path] = handler; } };
  const routes = defaultLocalRoutes('synthetic/local');
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ models: [{ type: 'llm', key: 'synthetic/local' }] }) }) as any);
  registerLocalModelRoutes(app, { requireAuth: () => undefined, readEnvFile: () => ({}), ensureBotSettingsTable: async () => undefined, createDbPool: () => ({ query: async () => { throw new Error('synthetic DB failure'); }, end: async () => undefined }) });
  let status = 200, body: any;
  const response = { status(value: number) { status = value; return response; }, json(value: unknown) { body = value; return response; } };
  await handlers['/api/local-models']({ body: { settings: routes } }, response);
  assert.equal(status, 500); assert.equal(body.success, undefined);
});

test('saved local roles propagate into live task routing after cache expiry', async t => {
  const descriptor = Object.getOwnPropertyDescriptor(AppDataSource, 'isInitialized')!;
  Object.defineProperty(AppDataSource, 'isInitialized', { configurable: true, value: true });
  t.after(() => Object.defineProperty(AppDataSource, 'isInitialized', descriptor));
  let now = Date.now(), fail = false;
  const routes = defaultLocalRoutes('synthetic/first');
  t.mock.method(Date, 'now', () => now);
  t.mock.method(AppDataSource, 'getRepository', () => ({ async findOneBy({ key }: { key: string }) {
    if (fail) throw new Error('synthetic unavailable database');
    return key === 'AI_MODEL_PRESET' ? { value: 'lmstudio-local' } : key === 'LM_STUDIO_ROUTES' ? { value: JSON.stringify(routes) } : null;
  } }) as any);
  await getLocalModelRoutes(true);
  assert.equal((await resolveModelForTaskAsync('intentClassification')).modelRef.generation?.temperature, 0);
  routes.fast.model = 'synthetic/changed';
  assert.equal((await resolveModelForTaskAsync('conversation')).modelRef.model, 'synthetic/first');
  now += 5001;
  assert.equal((await resolveModelForTaskAsync('conversation')).modelRef.model, 'synthetic/changed');
  fail = true;
  await assert.rejects(getLocalModelRoutes(true), /unavailable database/);
});
