import assert from 'node:assert/strict';
import test from 'node:test';
import { Bot } from 'grammy';
import { BotApiBackend } from '../api/backend';
import { processMessage } from '../orchestrator';
import { config } from '../config';
import { buildModelPlan, parseModelPolicy } from '../ai/modelPreferences';
import { defaultLocalRoutes } from '../ai/localModelRouting';
import { AI_CONTENT_SAFETY_REPLY } from '../ai/contentSafety';
import { runWithModelPolicy } from '../services/modelPreferenceService';
import { openaiProviderAdapter } from '../ai/providers/openai';
import { zaiProviderAdapter } from '../ai/providers/zai';
import { kimiProviderAdapter } from '../ai/providers/kimi';
import { openrouterProviderAdapter } from '../ai/providers/openrouter';
import * as usage from '../services/aiUsageLogService';
import * as memory from '../utils/agentMemoryContext';
import * as session from '../services/SessionStorage';
import * as search from '../agents/webSearchAgent';
import * as selfMemory from '../utils/kiraSelfMemory';
import * as residence from '../services/kiraResidenceService';
import * as profile from '../services/communicationProfileService';
import * as history from '../utils/history';
import * as reconsolidation from '../services/MemoryReconsolidationService';
import { ChatGroupRepository } from '../services/ChatGroupRepository';
import type { BotContext, SessionData } from '../types';

test('Telegram orchestration and API text delivery retain evidence through GPT classification, GLM planning and GPT synthesis', async t => {
    const env = { ...process.env }, owner = config.allowedUserId;
    Object.assign(process.env, { KIRA_ORCHESTRATION_MODE: 'skills', KIRA_FAST_DIALOGUE_ENABLED: 'false', KIRA_DECISIONS_ENABLED: 'false',
        OPENAI_API_KEY: 'synthetic', ZAI_API_KEY: 'synthetic' });
    config.allowedUserId = 741903;
    t.after(() => { config.allowedUserId = owner; for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key]; Object.assign(process.env, env); });
    t.mock.method(usage, 'logAiUsage', async () => {});
    t.mock.method(ChatGroupRepository, 'findAll', async () => []);
    t.mock.method(memory, 'fetchAgentMemoryContext', async () => ({ domain: 'personal', context: '', recalledMemories: [] }));
    t.mock.method(session, 'persistAgentRuntime', async () => {});
    t.mock.method(selfMemory, 'getRecentKiraSelfEvents', async () => []);
    t.mock.method(selfMemory, 'searchKiraSelfEventsByQuery', async () => []);
    t.mock.method(selfMemory, 'getKiraSelfMemoryState', async () => null as any);
    t.mock.method(residence, 'getKiraResidence', async () => ({ city: '' }) as any);
    t.mock.method(profile, 'communicationProfileContext', async () => '');
    t.mock.method(search, 'performWebSearch', async () => ({ success: true, results: 'Синтетический отчёт: показатель 42. https://example.test/report' }));
    t.mock.method(reconsolidation, 'reconsolidateAfterResponse', async () => {});
    t.mock.method(history, 'addToHistory', async (ctx: BotContext, role: string, content: string) => {
        ctx.session.messageHistory.push({ role, content, timestamp: new Date() });
    });
    let stored: SessionData | undefined;
    t.mock.method(session.TypeORMSessionStorage.prototype, 'read', async () => stored);
    t.mock.method(session.TypeORMSessionStorage.prototype, 'write', async (_key: string, value: SessionData) => { stored = structuredClone(value); });
    const calls: Array<[string, string]> = [];
    const classification = { intent: 'ВЕБ_ПОИСК', confidenceLevel: 'ВЫСОКИЙ',
        details: { memoryNeed: 'none', relationshipRole: null, responseComplexity: 'complex', knowledgeSource: 'external' }, subIntents: [{ intent: 'РАЗГОВОР' }] };
    const primary = t.mock.method(openaiProviderAdapter.client.chat.completions, 'create', async (body: any) => {
        calls.push(['openai', body.model]);
        if (body.model === 'gpt-6-luna') return { choices: [{ message: { content: JSON.stringify(classification) } }] } as any;
        assert.match(JSON.stringify(body.messages), /показатель 42/);
        return { choices: [{ message: { content: 'В синтетическом отчёте показатель 42: https://example.test/report' } }] } as any;
    });
    let round = 0;
    t.mock.method(zaiProviderAdapter.client.chat.completions, 'create', async (body: any) => {
        calls.push(['zai', body.model]);
        const decision = round++ % 2 === 0 ? { calls: [{ id: 'read_report', tool: 'web.search', args: { query: 'Синтетический отчёт' } }] } : { finish: true };
        return { choices: [{ message: { content: JSON.stringify(decision) } }] } as any;
    });
    const plan = parseModelPolicy(JSON.stringify(buildModelPlan({ quality: 'high', providers: ['openai', 'zai'] }, {
        vars: process.env, memoryProfileName: 'stable-1536', localRoutes: defaultLocalRoutes(),
    })))!;
    const text = 'Найди свежий синтетический отчёт и сравни его показатели';
    const ctx = { from: { id: config.allowedUserId }, chat: { id: config.allowedUserId, type: 'private' }, update: { update_id: 100 },
        session: { reminders: [], messageHistory: [], domains: {}, dialogueSummary: '', lastSummarizedIndex: -1 } } as any;
    const telegram = await runWithModelPolicy(plan, () => processMessage(ctx, text));
    assert.match(telegram.responseText, /показатель 42/);
    assert.equal(ctx.session.agentRuntime.status, 'completed');
    const bot = new Bot<BotContext>('1234567890:abcdefghijklmnopqrstuvwxyzABCDE', { botInfo: { id: 1234567890, is_bot: true, first_name: 'Synthetic', username: 'synthetic_bot' } as any });
    bot.api.config.use(async () => { throw new Error('Unexpected Telegram transport'); });
    const backend = new BotApiBackend(bot, { token: 'synthetic-token-with-at-least-32-characters', ownerId: config.allowedUserId, host: '127.0.0.1', port: 0 });
    const delivered = await runWithModelPolicy(plan, () => backend.message(text));
    assert.ok(delivered.messages.some(item => /показатель 42/.test(item.text || '')));
    assert.ok(stored!.messageHistory.some(item => item.role === 'bot' && /показатель 42/.test(item.content)));
    assert.deepEqual(calls.map(([provider]) => provider), ['openai', 'zai', 'zai', 'openai', 'openai', 'zai', 'zai', 'openai']);
    const earlierCalls = calls.length;
    primary.mock.mockImplementation(async () => ({ choices: [{ message: { content: '', refusal: 'Synthetic policy refusal' } }] }) as any);
    const stopped = await runWithModelPolicy(plan, () => processMessage({ ...ctx, session: { messageHistory: [], reminders: [], domains: {} } }, 'Проанализируй другой синтетический запрос'));
    assert.equal(stopped.responseText, AI_CONTENT_SAFETY_REPLY); assert.equal(stopped.operationStatus, 'failed');
    assert.equal(calls.length, earlierCalls); // No planning or final model after a refused classifier request.
    primary.mock.mockImplementation(async (body: any) => ({ choices: [{ message: body.model === 'gpt-6-luna'
        ? { content: JSON.stringify(classification) } : { content: '', refusal: 'Synthetic synthesis refusal' } }] }) as any);
    const refusedSynthesis = await runWithModelPolicy(plan, () => processMessage({ ...ctx, session: { messageHistory: [], reminders: [], domains: {} } }, 'Найди свежую синтетическую документацию и сравни показатели'));
    assert.equal(refusedSynthesis.responseText, AI_CONTENT_SAFETY_REPLY); assert.equal(refusedSynthesis.operationStatus, 'failed');
});

for (const provider of ['kimi', 'openrouter'] as const) test(`${provider} alone executes the real API text handler, tool loop and final response`, async t => {
    const env = { ...process.env }, previousOwner = config.allowedUserId;
    for (const key of ['OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'KIMI_API_KEY', 'GEMINI_API_KEY', 'ZAI_API_KEY']) delete process.env[key];
    Object.assign(process.env, { KIRA_ORCHESTRATION_MODE: 'skills', KIRA_FAST_DIALOGUE_ENABLED: 'false', KIRA_DECISIONS_ENABLED: 'false',
        [provider === 'kimi' ? 'KIMI_API_KEY' : 'OPENROUTER_API_KEY']: 'synthetic-only-provider-key' });
    config.allowedUserId = 741911;
    t.after(() => { config.allowedUserId = previousOwner; for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key]; Object.assign(process.env, env); });
    t.mock.method(usage, 'logAiUsage', async () => {});
    t.mock.method(ChatGroupRepository, 'findAll', async () => []);
    t.mock.method(memory, 'fetchAgentMemoryContext', async () => ({ domain: 'personal', context: '', recalledMemories: [] }));
    t.mock.method(session, 'persistAgentRuntime', async () => {});
    t.mock.method(selfMemory, 'getRecentKiraSelfEvents', async () => []);
    t.mock.method(selfMemory, 'searchKiraSelfEventsByQuery', async () => []);
    t.mock.method(selfMemory, 'getKiraSelfMemoryState', async () => null as any);
    t.mock.method(residence, 'getKiraResidence', async () => ({ city: '' }) as any);
    t.mock.method(profile, 'communicationProfileContext', async () => '');
    t.mock.method(search, 'performWebSearch', async () => ({ success: true, results: 'Синтетический источник: показатель 84. https://example.test/standalone' }));
    t.mock.method(reconsolidation, 'reconsolidateAfterResponse', async () => {});
    t.mock.method(history, 'addToHistory', async (ctx: BotContext, role: string, content: string) => { ctx.session.messageHistory.push({ role, content, timestamp: new Date() }); });
    let stored: SessionData | undefined;
    t.mock.method(session.TypeORMSessionStorage.prototype, 'read', async () => stored);
    t.mock.method(session.TypeORMSessionStorage.prototype, 'write', async (_key: string, value: SessionData) => { stored = structuredClone(value); });
    const outside = t.mock.method(openaiProviderAdapter.client.chat.completions, 'create', async () => { throw Error('Unexpected direct OpenAI request'); });
    const plan = buildModelPlan({ quality: 'high', providers: [provider] }, { vars: process.env, memoryProfileName: 'stable-1536', localRoutes: defaultLocalRoutes() });
    const adapter = provider === 'kimi' ? kimiProviderAdapter : openrouterProviderAdapter;
    const calls: string[] = []; let round = 0;
    t.mock.method(adapter.client.chat.completions, 'create', async (body: any) => {
        calls.push(body.model);
        if (body.model === plan.models.intentClassification.model) return { choices: [{ message: { content: JSON.stringify({
            intent: 'ВЕБ_ПОИСК', confidenceLevel: 'ВЫСОКИЙ', details: { memoryNeed: 'none', knowledgeSource: 'external', responseComplexity: 'complex' }, subIntents: [{ intent: 'РАЗГОВОР' }],
        }) } }] } as any;
        if (body.response_format) return { choices: [{ message: { content: JSON.stringify(round++ ? { finish: true }
            : { calls: [{ id: 'read_source', tool: 'web.search', args: { query: 'Синтетический источник' } }] }) } }] } as any;
        assert.match(JSON.stringify(body.messages), /показатель 84/);
        return { choices: [{ message: { content: 'В синтетическом источнике показатель 84: https://example.test/standalone' } }] } as any;
    });
    const bot = new Bot<BotContext>('1234567890:abcdefghijklmnopqrstuvwxyzABCDE', { botInfo: { id: 1234567890, is_bot: true, first_name: 'Synthetic', username: 'synthetic_bot' } as any });
    bot.api.config.use(async () => { throw new Error('Unexpected Telegram delivery'); });
    const backend = new BotApiBackend(bot, { token: 'synthetic-token-with-at-least-32-characters', ownerId: config.allowedUserId, host: '127.0.0.1', port: 0 });
    const reply = await runWithModelPolicy(plan, () => backend.message(`Найди свежий синтетический отчёт ${provider} и сравни его показатели`));
    assert.ok(reply.messages.some(item => /показатель 84/.test(item.text || '')));
    assert.ok(stored!.messageHistory.some(item => item.role === 'bot' && /показатель 84/.test(item.content)));
    assert.deepEqual(calls, [plan.models.intentClassification.model, plan.models.runtimePlanning.model, plan.models.runtimePlanning.model, plan.models.complexReasoning.model]);
    assert.equal(outside.mock.callCount(), 0);
});
