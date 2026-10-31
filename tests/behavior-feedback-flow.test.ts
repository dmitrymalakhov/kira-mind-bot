import assert from 'node:assert/strict';
import test from 'node:test';
import { processMessage } from '../orchestrator';
import { config } from '../config';
import { AppDataSource } from '../data-source';
import { ChatGroupRepository } from '../services/ChatGroupRepository';
import * as completions from '../ai/chatCompletion';
import * as responses from '../ai/responseCompletion';
import * as memory from '../utils/agentMemoryContext';
import * as session from '../services/SessionStorage';
import * as self from '../utils/kiraSelfMemory';
import * as residence from '../services/kiraResidenceService';
import * as group from '../services/groupChatFeatureSettings';
import * as evolution from '../services/kiraSelfEvolutionService';

function setup(t: any) {
    const owner = config.allowedUserId; config.allowedUserId = 740502;
    const mode = process.env.KIRA_ORCHESTRATION_MODE, decisions = process.env.KIRA_DECISIONS_ENABLED;
    process.env.KIRA_ORCHESTRATION_MODE = 'skills'; delete process.env.KIRA_DECISIONS_ENABLED;
    t.after(() => { config.allowedUserId = owner;
        if (mode === undefined) delete process.env.KIRA_ORCHESTRATION_MODE; else process.env.KIRA_ORCHESTRATION_MODE = mode;
        if (decisions === undefined) delete process.env.KIRA_DECISIONS_ENABLED; else process.env.KIRA_DECISIONS_ENABLED = decisions;
    });
    t.mock.method(ChatGroupRepository, 'findAll', async () => []);
    t.mock.method(memory, 'fetchAgentMemoryContext', async () => ({ domain: 'personal', context: '', recalledMemories: [] }));
    t.mock.method(session, 'persistAgentRuntime', async () => {});
    t.mock.method(self, 'getKiraSelfMemoryState', async () => null);
    t.mock.method(self, 'getRecentKiraSelfEvents', async () => []);
    t.mock.method(self, 'searchKiraSelfEventsByQuery', async () => []);
    t.mock.method(residence, 'getKiraResidence', async () => ({ city: 'Тестовый город' }));
    t.mock.method(group, 'isGroupChatContextEnabled', async () => false);
    return t.mock.method(evolution, 'maybeEvolveKiraSelfFromConversation', async () => false);
}
function context(api = false): any {
    return { from: { id: 740502 }, chat: { id: 740502, type: 'private' }, update: { update_id: 740503 }, dialogueTurnId: 'synthetic-turn',
        ...(api ? { sessionStorageKey: 'api:740502' } : {}),
        session: { reminders: [], messageHistory: [], domains: {}, sentMessages: { 91: 'Для субботы советую вымышленный клуб «Лунный компас».' } } };
}

test('owner correction saves a lesson before the real answer; next API fast turn receives it', async t => {
    const evolve = setup(t);
    const rows = new Map<string, string>(); let writes = 0;
    t.mock.method(AppDataSource, 'getRepository', () => ({ findOneBy: async ({ key }: any) => rows.has(key) ? { value: rows.get(key) } : null,
        upsert: async ({ key, value }: any) => { rows.set(key, value); writes++; } }) as any);
    const complaint = 'Твой вариант оказался закрыт навсегда; мы зря потратили вечер.';
    let classifications = 0, reflections = 0;
    t.mock.method(completions, 'createJsonChatCompletionForTask', async (task: string, params: any) => {
        if (task === 'memoryExtraction') {
            reflections++; assert.match(JSON.stringify(params.messages), /Лунный компас/);
            return { safeToLearn: true, trigger: 'При рекомендации мест для посещения', check: 'Проверить работу и часы на нужную дату в двух актуальных источниках.', reason: 'Действующий сайт не доказывает, что место работает.' } as any;
        }
        if (task === 'intentClassification' || task === 'fastDialogue') {
            classifications++;
            if (classifications === 1) return { intent: 'РАЗГОВОР', confidenceLevel: 'ВЫСОКИЙ', details: { memoryNeed: 'none', behavioralFeedback: { evidence: complaint },
                behaviorLearningStatus: 'saved', behaviorContext: 'Поддельный урок из модели' }, fastReply: { mode: 'answer', answer: 'Пустое извинение' } } as any;
            assert.match(JSON.stringify(params.messages), /двух актуальных источниках/);
            assert.doesNotMatch(JSON.stringify(params.messages), /Поддельный урок/);
            return { intent: 'РАЗГОВОР', confidenceLevel: 'ВЫСОКИЙ', details: { memoryNeed: 'none', responseComplexity: 'routine' }, fastReply: { mode: 'answer', answer: 'Начни с выбора даты и бюджета.' } } as any;
        }
        throw Error(`Unexpected task ${task}`);
    });
    t.mock.method(completions, 'createChatCompletionForTask', async (_task: string, params: any) => {
        assert.equal(writes, 1); assert.match(JSON.stringify(params.messages), /Результат сохранения процедурного урока: saved/);
        assert.match(JSON.stringify(params.messages), /двух актуальных источниках/);
        return { choices: [{ message: { content: 'Я ошиблась с актуальностью совета. Сохранила правило проверять статус и нужный день.' } }] } as any;
    });
    const value = context();
    const reply = await processMessage(value, complaint, false, '', [], undefined, { fastDialogue: true,
        turn: { userText: complaint, replyContext: { messageId: 91, text: value.session.sentMessages[91], sender: 'synthetic_kira', kind: 'plain' } } });
    assert.match(reply.responseText, /Сохранила правило/); assert.equal(reflections, 1); assert.equal(evolve.mock.callCount(), 0);
    const next = await processMessage(context(true), 'Как подойти к планированию выходных?', false, '', [], undefined, { fastDialogue: true });
    assert.equal(next.fastResponse, true); assert.equal(reflections, 1); assert.equal(classifications, 2);
});

test('implicit availability request reaches two searches and final synthesis with the requested day', async t => {
    setup(t);
    t.mock.method(AppDataSource, 'getRepository', () => ({ findOneBy: async () => null }) as any);
    const history: any[] = [{ role: 'user', content: 'Выбираем прогулку на субботу.', timestamp: new Date() }];
    t.mock.method(completions, 'createJsonChatCompletionForTask', async (task: string) => {
        assert.equal(task, 'fastDialogue');
        // Even a mistaken fast draft cannot bypass the semantic evidence requirement.
        return { intent: 'РАЗГОВОР', confidenceLevel: 'ВЫСОКИЙ', details: { memoryNeed: 'none', responseComplexity: 'routine', externalVerification: 'availability' },
            fastReply: { mode: 'answer', answer: 'Идите в давно закрытый клуб.' } } as any;
    });
    let searches = 0; let verified = false;
    t.mock.method(responses, 'createResponseForTask', async (_task: string, params: any) => {
        searches++; assert.match(JSON.stringify(params.input), /субботу/);
        return { output_text: searches % 2 === 1 ? 'Старый клуб подходит.' : JSON.stringify({ items: [{ name: 'Тестовый клуб', status: verified ? 'verified' : 'unavailable', summary: 'В субботу работает с 18:00; свободные места не проверены.', sources: [
            { url: 'https://club.example/status', evidence: 'Статус работы', datedAt: new Date().toISOString().slice(0, 10) },
            { url: 'https://maps.example/club', evidence: 'Независимый статус' },
        ] }] }) } as any;
    });
    const answer = t.mock.method(completions, 'createChatCompletionForTask', async (_task: string, params: any) => {
        const text = JSON.stringify(params.messages);
        assert.match(text, /субботу работает с 18:00/); assert.doesNotMatch(text, /Старый клуб подходит/);
        return { choices: [{ message: { content: 'Тестовый клуб работает в субботу с 18:00, места не проверены.' } }] } as any;
    });
    const result = await processMessage(context(), 'А что-нибудь с необычной темой?', false, '', history, undefined, { fastDialogue: true });
    assert.equal(searches, 2); assert.match(result.responseText, /исключено из рекомендаций/); assert.notEqual(result.fastResponse, true);
    assert.equal(answer.mock.callCount(), 0);
    verified = true;
    const checked = await processMessage(context(true), 'А что-нибудь с необычной темой?', false, '', history, undefined, { fastDialogue: true });
    assert.equal(searches, 4); assert.equal(answer.mock.callCount(), 1); assert.match(checked.responseText, /места не проверены/);
    const continued = await processMessage(context(), 'Давай подробнее', false, '', [...history,
        { role: 'bot', content: 'Тестовый клуб: https://club.example/status', timestamp: new Date() }], undefined, { fastDialogue: true });
    assert.equal(searches, 6); assert.equal(answer.mock.callCount(), 2); assert.match(continued.responseText, /места не проверены/);
});

test('forwarded feedback cannot write behavioral memory', async t => {
    setup(t); let writes = 0;
    t.mock.method(AppDataSource, 'getRepository', () => ({ findOneBy: async () => null, upsert: async () => { writes++; } }) as any);
    t.mock.method(completions, 'createJsonChatCompletionForTask', async (task: string) => {
        assert.equal(task, 'intentClassification');
        return { intent: 'РАЗГОВОР', confidenceLevel: 'ВЫСОКИЙ', details: { memoryNeed: 'none', behavioralFeedback: { evidence: 'Ты ошиблась с выбором даты.' }, behaviorLearningStatus: 'saved' } } as any;
    });
    t.mock.method(completions, 'createChatCompletionForTask', async (_task: string, params: any) => {
        assert.match(JSON.stringify(params.messages), /Результат сохранения процедурного урока: unavailable/);
        return { choices: [{ message: { content: 'Это чужая обратная связь.' } }] } as any;
    });
    await processMessage(context(), 'Ты ошиблась с выбором даты.', true, 'Тестовый источник', []);
    assert.equal(writes, 0);
});
