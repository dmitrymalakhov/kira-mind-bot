import assert from 'node:assert/strict';
import { test } from 'node:test';
import { needsPriorityReflection, REFLECTION_TRIAGE_INSTRUCTIONS } from '../ai/reflectionTriage';
import { openaiProviderAdapter } from '../ai/providers/openai';
import * as resolver from '../ai/modelResolver';
import * as completion from '../ai/chatCompletion';
import * as usage from '../services/aiUsageLogService';
import * as features from '../services/backgroundFeatureService';
import * as reflectionTriage from '../ai/reflectionTriage';
import { queueMessage, getBufferStats } from '../services/reflectionModeService';
const decisionAdapter = openaiProviderAdapter as typeof openaiProviderAdapter & { createDecision: NonNullable<typeof openaiProviderAdapter.createDecision> };

function route(t: any, provider = 'openai', model = 'gpt-6-luna', reasoningEffort?: 'none' | 'low') {
    t.mock.method(resolver, 'resolveModelForTaskAsync', async (task: string) => {
        assert.equal(task,'lightweightText');
        return { presetName: 'gpt-balanced',modelRef: { provider,model,allowFallback: false,...(reasoningEffort ? { generation: { reasoningEffort } } : {}) } } as any;
    });
    t.mock.method(usage, 'logAiUsage', async () => {});
}

test('a configured reasoning level remains on the generative route even for Luna', async t => {
    route(t,'openai','gpt-6-luna','low');
    const decisions = t.mock.method(decisionAdapter,'createDecision',async () => { throw new Error('Cannot discard explicit reasoning'); });
    t.mock.method(completion,'createChatCompletionForTask',async () => ({ choices: [{ message: { content: '{"urgent":false}' } }] }) as any);
    assert.equal(await needsPriorityReflection('Контакт','Обычный разговор'),false);
    assert.equal(decisions.mock.callCount(),0);
});

test('reflection uses one predicate on the same pinned model, with full life-event criteria and no JSON on a valid answer', async t => {
    route(t);
    const json = t.mock.method(completion,'createChatCompletionForTask',async () => { throw new Error('No second call'); });
    let probability = 0.99;
    t.mock.method(decisionAdapter,'createDecision',async (params: any) => {
        assert.equal(params.model,'gpt-6-luna'); assert.equal(params.questions.length,1);
        assert.equal(params.questions[0].name,'urgent'); assert.equal(params.questions[0].instructions,REFLECTION_TRIAGE_INSTRUCTIONS);
        assert.match(params.questions[0].instructions,/свадьба|свадьбе/); assert.match(params.questions[0].instructions,/отношени/);
        assert.deepEqual(params.input[0].content[1], { type: 'input_json',data: { senderName: 'Тестовый контакт',text: 'Мы подали заявление на свадьбу.' } });
        return { model: 'gpt-6-luna',answers: [{ type: 'predicate',name: 'urgent',probability }] };
    });
    assert.equal(await needsPriorityReflection('Тестовый контакт','Мы подали заявление на свадьбу.'),true);
    probability = 0.90;
    assert.equal(await needsPriorityReflection('Тестовый контакт','Мы подали заявление на свадьбу.'),true);
    probability = 0.89;
    assert.equal(await needsPriorityReflection('Тестовый контакт','Мы подали заявление на свадьбу.'),false);
    assert.equal(json.mock.callCount(),0);
});

for (const [provider,model] of [['gemini','synthetic-gemini'],['lmstudio','synthetic-local'],['openai','gpt-6.1-sol']]) {
    test(`reflection preserves ${provider}/${model} without substituting Luna`,async t => {
        route(t,provider,model);
        const decisions = t.mock.method(decisionAdapter,'createDecision',async () => { throw new Error('No cross-model call'); });
        t.mock.method(completion,'createChatCompletionForTask',async () => ({ choices: [{ message: { content: '{"urgent":true}' } }] }) as any);
        assert.equal(await needsPriorityReflection('Контакт','Синтетическое важное сообщение'),true);
        assert.equal(decisions.mock.callCount(),0);
    });
}

test('endpoint failure, refusal, malformed probability or unexpected model uses the configured JSON route once', async t => {
    route(t);
    const responses = [null,{ type: 'refusal',name: 'urgent' },{ type: 'predicate',name: 'urgent',probability: 3 },{ type: 'predicate',name: 'wrong',probability: 1 },
        { type: 'predicate',name: 'urgent',probability: 1,unexpectedModel: true }];
    const json = t.mock.method(completion,'createChatCompletionForTask',async (task: string,params: any) => {
        assert.equal(task,'lightweightText'); assert.match(params.messages[0].content,/свадьба|свадьбе/);
        assert.equal(params.max_completion_tokens,32);
        return { choices: [{ message: { content: '{"urgent":true}' } }] } as any;
    });
    let response: any;
    const decisions = t.mock.method(decisionAdapter,'createDecision',async () => {
        if (!response) throw new Error('synthetic provider failure');
        return { model: response.unexpectedModel ? 'unexpected-model' : 'gpt-6-luna',answers: [response] };
    });
    for (response of responses) assert.equal(await needsPriorityReflection('Контакт','Новое событие'),true);
    assert.equal(json.mock.callCount(),responses.length); assert.equal(decisions.mock.callCount(),responses.length);
});

test('reflection Decisions can be disabled without resolving or changing the model policy', async t => {
    const previous = process.env.KIRA_REFLECTION_TRIAGE_DECISIONS_ENABLED;
    process.env.KIRA_REFLECTION_TRIAGE_DECISIONS_ENABLED = 'false';
    t.after(() => { if (previous === undefined) delete process.env.KIRA_REFLECTION_TRIAGE_DECISIONS_ENABLED; else process.env.KIRA_REFLECTION_TRIAGE_DECISIONS_ENABLED = previous; });
    const resolve = t.mock.method(resolver,'resolveModelForTaskAsync',async () => { throw new Error('No routing lookup'); });
    t.mock.method(completion,'createChatCompletionForTask',async () => ({ choices: [{ message: { content: '{"urgent":"true"}' } }] }) as any);
    assert.equal(await needsPriorityReflection('Контакт','Обычный текст'),false);
    assert.equal(resolve.mock.callCount(),0);
});

test('outgoing, forwarded and old messages remain context without scheduling priority reflection or consuming the chat cooldown', async t => {
    t.mock.method(features,'isBackgroundFeatureEnabled',async () => true);
    const called: string[] = [];
    t.mock.method(reflectionTriage,'needsPriorityReflection',async (_sender: string,text: string) => { called.push(text); return false; });
    const chat = 'synthetic-triage-directions';
    const before = getBufferStats().totalMessages;
    const incoming = 'Синтетическое новое сообщение о принятом решении переехать';
    await queueMessage(chat,'Контакт','Синтетическое исходящее сообщение о важном событии',new Date(),true);
    await queueMessage(chat,'Контакт','Синтетическая пересылка о важном событии',new Date(),false,undefined,{ isForwarded: true });
    await queueMessage(chat,'Контакт','Синтетическое старое сообщение о важном событии',new Date(Date.now()-60*60*1000));
    await queueMessage(chat,'Контакт',incoming,new Date());
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(called,[incoming]); assert.equal(getBufferStats().totalMessages,before+4);
});
