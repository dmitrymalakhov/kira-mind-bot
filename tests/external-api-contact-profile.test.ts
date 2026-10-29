import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { Bot } from 'grammy';
import { config } from '../config';
import { BotApiBackend } from '../api/backend';
import type { BotContext, SessionData } from '../types';
import { TypeORMSessionStorage } from '../services/SessionStorage';
import * as storage from '../services/SessionStorage';
import * as history from '../utils/history';
import * as completion from '../ai/chatCompletion';
import * as memory from '../utils/agentMemoryContext';
import * as conversation from '../agents/conversationAgent';
import * as profiles from '../services/telegramProfileService';
import * as reconsolidation from '../services/MemoryReconsolidationService';
import { ChatGroupRepository } from '../services/ChatGroupRepository';
import { DialogueJobRepository } from '../services/DialogueJobRepository';
import { registerDialogueLifecycle } from '../services/dialogueJobs';
import { registerTextMessageHandler } from '../handlers/textMessages';
import * as shared from '../handlers/shared';
import { llmCache } from '../utils/llmCache';
import { ReminderRegistry } from '../stores/ReminderRegistry';

const owner = 730051;
function fixture(t: TestContext, channel: 'app' | 'telegram' = 'app') {
    const previous = { owner: config.allowedUserId, mode: process.env.KIRA_ORCHESTRATION_MODE, decisions: process.env.KIRA_DECISIONS_ENABLED };
    config.allowedUserId = owner; process.env.KIRA_ORCHESTRATION_MODE = 'skills'; delete process.env.KIRA_DECISIONS_ENABLED;
    t.after(() => { config.allowedUserId = previous.owner;
        if (previous.mode === undefined) delete process.env.KIRA_ORCHESTRATION_MODE; else process.env.KIRA_ORCHESTRATION_MODE = previous.mode;
        if (previous.decisions === undefined) delete process.env.KIRA_DECISIONS_ENABLED; else process.env.KIRA_DECISIONS_ENABLED = previous.decisions;
    });
    const sessions = new Map<string, SessionData>(), keys: string[] = [];
    t.mock.method(llmCache, 'get', () => undefined);
    t.mock.method(TypeORMSessionStorage.prototype, 'read', async (key: string) => { keys.push(key); return structuredClone(sessions.get(key)); });
    t.mock.method(TypeORMSessionStorage.prototype, 'write', async (key: string, value: SessionData) => { keys.push(key); sessions.set(key, structuredClone(value)); });
    t.mock.method(storage, 'persistAgentRuntime', async () => {});
    t.mock.method(history, 'addToHistory', async (ctx: BotContext, role: string, content: string) => { ctx.session.messageHistory.unshift({ role, content, timestamp: new Date() }); });
    t.mock.method(reconsolidation, 'reconsolidateAfterResponse', async () => {});
    t.mock.method(DialogueJobRepository, 'beginTurn', async () => {});
    t.mock.method(ChatGroupRepository, 'findAll', async () => []);
    t.mock.method(memory, 'fetchAgentMemoryContext', async () => ({ domain: 'personal', context: '', recalledMemories: [] }));
    let classification: any = { intent: 'РАЗГОВОР', confidenceLevel: 'ВЫСОКИЙ', details: { telegramProfile: true, contactQuery: 'Мирон Тестово', memoryNeed: 'none', memoryTask: 'none' }, fastReply: { mode: 'route' } };
    let planning = (_request: any): any => ({ finish: true });
    const classifier = t.mock.method(completion, 'createJsonChatCompletionForTask', async (task: string, request: any) => {
        if (task === 'runtimePlanning') return planning(request);
        assert.ok(['intentClassification', 'fastDialogue'].includes(task));
        return typeof classification === 'function' ? classification(request) : classification;
    });
    const bot = new Bot<BotContext>('1234567890:abcdefghijklmnopqrstuvwxyzABCDE', { botInfo: { id: 1234567890, is_bot: true, first_name: 'Test', username: 'synthetic_bot' } as any });
    const delivered: string[] = [];
    let updateId = 8000;
    bot.api.config.use(async (_prev, method, payload: any) => {
        assert.equal(channel, 'telegram', 'Mobile profile lookup must not send Telegram messages');
        if (method === 'sendMessage') {
            delivered.push(payload.text);
            return { ok: true, result: { message_id: ++updateId, date: 0, chat: { id: owner, type: 'private' }, text: payload.text } } as any;
        }
        assert.equal(method, 'sendChatAction'); return { ok: true, result: true } as any;
    });
    if (channel === 'telegram') {
        t.mock.method(shared, 'shouldRunProactiveHint', () => false);
        bot.use(async (ctx, next) => {
            const key = String(ctx.chat!.id); keys.push(key); ctx.sessionStorageKey = key;
            ctx.session = structuredClone(sessions.get(key)) || { messageHistory: [], reminders: [], domains: {}, dialogueSummary: '', lastSummarizedIndex: -1 } as SessionData;
            await next(); sessions.set(key, structuredClone(ctx.session));
        });
        registerDialogueLifecycle(bot); registerTextMessageHandler(bot, { immediate: true });
    }
    const backend = () => new BotApiBackend(bot, { token: 'synthetic-mobile-profile-token-32-characters', ownerId: owner, host: '127.0.0.1', port: 0 },
        { read: async () => ({ preset: 'gpt-lean', revision: 'synthetic' }) } as any);
    const send = async (text: string) => {
        if (channel === 'app') return (await backend().message(text)).messages.map(item => item.text || '').join('\n');
        const start = delivered.length;
        await bot.handleUpdate({ update_id: ++updateId, message: { message_id: updateId, date: Math.floor(Date.now() / 1000), from: { id: owner, is_bot: false, first_name: 'Synthetic' }, chat: { id: owner, type: 'private', first_name: 'Synthetic' }, text } });
        return delivered.slice(start).join('\n');
    };
    return { backend, sessions, keys, classifier, send, key: channel === 'app' ? `api:${owner}` : String(owner), setClassification: (value: any) => { classification = value; }, setPlanning: (value: typeof planning) => { planning = value; } };
}

test('mobile API persists the offered candidate and reads its profile after “да это он” on the next request', async t => {
    const f = fixture(t), requests: string[] = [];
    t.mock.method(profiles, 'lookupTelegramProfile', async (query: string, _fields: unknown, expectedId?: number) => {
        requests.push(query);
        if (requests.length === 1) return { state: 'ambiguous', source: 'telegram_profile', summary: 'Найден похожий контакт: Мирон Тестовый (@synthetic_miron). Это нужный человек?',
            candidates: [{ id: 81001, firstName: 'Мирон', lastName: 'Тестовый', username: 'synthetic_miron' }] };
        assert.equal(query, '@synthetic_miron'); assert.equal(expectedId, 81001);
        return { state: 'found', source: 'telegram_profile', summary: 'Номер получен из профиля.', profile: { id: 81001, firstName: 'Мирон', phone: '+12025550123', phoneStatus: 'available' } };
    });
    const synthesis = t.mock.method(conversation, 'conversationAgent', async (...args: any[]) => {
        assert.match(args[6].context, /12025550123/); return { responseText: 'Телефон Мирона: +12025550123.' };
    });
    const first = await f.backend().message('Какой телефон у Мирона Тестово?');
    assert.ok(first.messages.some(item => item.text?.includes('synthetic_miron')));
    const saved = f.sessions.get(`api:${owner}`)!;
    assert.equal(saved.agentRuntime?.status, 'waiting');
    // Emulate a new HTTP request and a restarted backend with a serialized ledger.
    saved.agentRuntime = JSON.parse(JSON.stringify(saved.agentRuntime));
    const second = await f.backend().message('Да это он');
    assert.ok(second.messages.some(item => item.text?.includes('+12025550123')));
    assert.equal(f.sessions.get(`api:${owner}`)!.agentRuntime?.status, 'completed');
    assert.deepEqual(requests, ['Мирон Тестово', '@synthetic_miron']);
    assert.equal(synthesis.mock.callCount(), 1);
    assert.equal(f.classifier.mock.calls.filter(call => call.arguments[0] !== 'runtimePlanning').length, 1);
    assert.ok(f.keys.every(key => key === `api:${owner}`));
});

test('the mobile API keeps a choice pending when “да” refers to several candidates', async t => {
    const f = fixture(t);
    const lookup = t.mock.method(profiles, 'lookupTelegramProfile', async () => ({ state: 'ambiguous', source: 'telegram_profile', summary: 'Укажи нужный аккаунт: @synthetic_one или @synthetic_two.',
        candidates: [{ id: 81001, firstName: 'Мирон', username: 'synthetic_one' }, { id: 81002, firstName: 'Мирон', username: 'synthetic_two' }] }));
    await f.backend().message('Какой телефон у Мирона Тестово?');
    const reply = await f.backend().message('да');
    assert.equal(lookup.mock.callCount(), 1);
    assert.ok(reply.messages.some(item => item.text?.includes('несколько людей')));
    assert.equal(f.sessions.get(`api:${owner}`)!.agentRuntime?.status, 'waiting');
});

test('a repeated full phone question starts a fresh lookup instead of becoming an answer to a stale clarification', async t => {
    const f = fixture(t), requests: string[] = [];
    t.mock.method(profiles, 'lookupTelegramProfile', async (query: string) => {
        requests.push(query);
        if (requests.length === 1) return { state: 'incomplete', source: 'telegram_profile', summary: 'Укажи username для точной проверки.', candidates: [] };
        return { state: 'found', source: 'telegram_profile', summary: 'Телефон: +12025550123.', profile: { id: 81001, firstName: 'Мирон', phone: '+12025550123', phoneStatus: 'available' } };
    });
    t.mock.method(conversation, 'conversationAgent', async () => ({ responseText: 'Телефон: +12025550123.' }));
    await f.backend().message('Какой телефон у Мирона Тестово?');
    f.setClassification({ intent: 'РАЗГОВОР', confidenceLevel: 'ВЫСОКИЙ', details: { telegramProfile: true, memoryNeed: 'none', memoryTask: 'none',
        telegramProfileSelection: { action: 'new_target', query: 'Мирон Тестово' } } });
    const reply = await f.backend().message('Какой телефон у Мирона Тестово?');
    assert.ok(reply.messages.some(item => item.text?.includes('+12025550123')));
    assert.deepEqual(requests, ['Мирон Тестово', 'Мирон Тестово']);
    assert.equal(f.classifier.mock.calls.filter(call => call.arguments[0] !== 'runtimePlanning').length, 2);
});

for (const channel of ['app', 'telegram'] as const) {
    test(`${channel}: a normalized target remains a profile request without a pending ledger or redundant flag`, async t => {
        const f = fixture(t, channel);
        f.setClassification({ intent: 'РАЗГОВОР', confidenceLevel: 'ВЫСОКИЙ', details: { telegramProfile: false, memoryNeed: 'none', memoryTask: 'none',
            telegramProfileSelection: { action: 'new_target', query: 'Мирон Тестовый' } } });
        const lookup = t.mock.method(profiles, 'lookupTelegramProfile', async (query: string) => {
            assert.equal(query, 'Мирон Тестовый'); return { state: 'found', source: 'telegram_profile', summary: 'Телефон: +12025550123.' };
        });
        t.mock.method(conversation, 'conversationAgent', async () => ({ responseText: 'Телефон: +12025550123.', skipOptionalFollowups: true }));
        assert.match(await f.send('Мирон Тестовый'), /12025550123/); assert.equal(lookup.mock.callCount(), 1);
    });

    for (const scenario of [
        { answer: 'Да, всё верно, это нужный человек', count: 1, id: 81001 },
        { answer: 'Второй из предложенных', count: 2, id: 81002 },
        { answer: 'Тот, у которого ник synthetic_two', count: 2, id: 81002 },
    ]) test(`${channel}: semantic clarification binds ${scenario.answer} to the persisted candidate`, async t => {
        const f = fixture(t, channel), requests: string[] = [];
        const candidates = [{ id: 81001, firstName: 'Мирон', username: 'synthetic_one' }, { id: 81002, firstName: 'Мирон', username: 'synthetic_two' }].slice(0, scenario.count);
        t.mock.method(profiles, 'lookupTelegramProfile', async (query: string, _fields: unknown, expectedId?: number) => {
            requests.push(query);
            if (requests.length === 1) return { state: 'ambiguous', source: 'telegram_profile', summary: 'Выбери человека: ' + candidates.map(item => '@' + item.username).join(', '), candidates };
            assert.equal(expectedId, scenario.id); assert.equal(query, '@' + candidates.find(item => item.id === scenario.id)!.username);
            return { state: 'found', source: 'telegram_profile', summary: 'Номер: +12025550123.', profile: { id: scenario.id, firstName: 'Мирон', phone: '+12025550123' } };
        });
        t.mock.method(conversation, 'conversationAgent', async (...args: any[]) => {
            assert.match(args[6].context, /12025550123/); return { responseText: 'Телефон: +12025550123.', skipOptionalFollowups: true };
        });
        assert.match(await f.send('Какой телефон у Мирона Тестово?'), /synthetic_one/);
        const saved = f.sessions.get(f.key)!; saved.agentRuntime = JSON.parse(JSON.stringify(saved.agentRuntime));
        f.setClassification({ intent: 'РАЗГОВОР', confidenceLevel: 'ВЫСОКИЙ', details: { telegramProfile: scenario.id === 81001 ? true : undefined,
            telegramProfileSelection: { action: 'select', candidateId: scenario.id }, memoryNeed: 'none', memoryTask: 'none' }, fastReply: { mode: 'route' } });
        assert.match(await f.send(scenario.answer), /12025550123/);
        const intake = f.classifier.mock.calls.filter(call => call.arguments[0] !== 'runtimePlanning');
        assert.equal(intake.length, 2);
        assert.match(JSON.stringify(intake[1].arguments[1]), /Ожидающее уточнение профиля/);
        assert.equal(requests.length, 2); assert.equal(f.sessions.get(f.key)!.agentRuntime!.status, 'completed');
        assert.ok(f.keys.every(key => key === f.key));
    });

    test(`${channel}: a new topic while a profile question is waiting never becomes a contact name`, async t => {
        const f = fixture(t, channel);
        const lookup = t.mock.method(profiles, 'lookupTelegramProfile', async () => ({ state: 'incomplete', source: 'telegram_profile', summary: 'Уточни аккаунт.', candidates: [] }));
        await f.send('Какой телефон у Мирона Тестово?');
        f.setClassification({ intent: 'РАЗГОВОР', confidenceLevel: 'ВЫСОКИЙ', details: { memoryNeed: 'none', memoryTask: 'none', responseComplexity: 'routine', telegramProfileSelection: { action: 'new_request' } }, fastReply: { mode: 'answer', answer: 'LTE — стандарт мобильной связи.' } });
        t.mock.method(conversation, 'conversationAgent', async () => ({ responseText: 'LTE — стандарт мобильной связи.', skipOptionalFollowups: true }));
        assert.match(await f.send('А теперь объясни LTE'), /стандарт мобильной связи/);
        assert.equal(lookup.mock.callCount(), 1);
    });

    test(`${channel}: an invented selection cannot read a profile outside the pending candidates`, async t => {
        const f = fixture(t, channel);
        const lookup = t.mock.method(profiles, 'lookupTelegramProfile', async () => ({ state: 'ambiguous', source: 'telegram_profile', summary: 'Выбери @synthetic_one.', candidates: [{ id: 81001, firstName: 'Мирон', username: 'synthetic_one' }] }));
        await f.send('Какой телефон у Мирона Тестово?');
        f.setClassification({ intent: 'РАЗГОВОР', confidenceLevel: 'ВЫСОКИЙ', details: { telegramProfile: true, telegramProfileSelection: { action: 'select', candidateId: 81999 } } });
        assert.match(await f.send('Да, всё верно'), /Выбери @synthetic_one/);
        assert.equal(lookup.mock.callCount(), 1); assert.equal(f.sessions.get(f.key)!.agentRuntime!.status, 'waiting');
    });

    for (const repaired of [true, false]) test(`${channel}: incomplete model output is repaired once and cannot discard a pending profile goal (${repaired})`, async t => {
        const f = fixture(t, channel);
        const lookup = t.mock.method(profiles, 'lookupTelegramProfile', async (_query: string, _fields: unknown, id?: number) => id
            ? { state: 'found', source: 'telegram_profile', summary: 'Телефон: +12025550123.' }
            : { state: 'ambiguous', source: 'telegram_profile', summary: 'Это @synthetic_one?', candidates: [{ id: 81001, firstName: 'Мирон', username: 'synthetic_one' }] });
        t.mock.method(conversation, 'conversationAgent', async () => ({ responseText: 'Телефон: +12025550123.', skipOptionalFollowups: true }));
        await f.send('Какой телефон у Мирона Тестово?');
        let attempts = 0;
        f.setClassification((request: any) => {
            attempts++;
            const selection = repaired && request.messages[0].content.includes('Предыдущий ответ пропустил') ? { telegramProfileSelection: { action: 'select', candidateId: 81001 } } : {};
            return { intent: 'РАЗГОВОР', confidenceLevel: 'ВЫСОКИЙ', details: { memoryNeed: 'none', memoryTask: 'none', ...selection } };
        });
        const reply = await f.send('Именно этого человека я имел в виду');
        assert.equal(attempts, 2); assert.equal(lookup.mock.callCount(), repaired ? 2 : 1);
        assert.match(reply, repaired ? /12025550123/ : /synthetic_one/);
        assert.equal(f.sessions.get(f.key)!.agentRuntime!.status, repaired ? 'completed' : 'waiting');
    });

    test(`${channel}: confirmation with an additional request preserves and executes both tasks`, async t => {
        const f = fixture(t, channel);
        const lookup = t.mock.method(profiles, 'lookupTelegramProfile', async (_query: string, _fields: unknown, id?: number) => id
            ? { state: 'found', source: 'telegram_profile', summary: 'Телефон: +12025550123.' }
            : { state: 'ambiguous', source: 'telegram_profile', summary: 'Это @synthetic_one?', candidates: [{ id: 81001, firstName: 'Мирон', username: 'synthetic_one' }] });
        const reminders = t.mock.method(ReminderRegistry.getInstance(), 'getActiveByChatId', () => []);
        t.mock.method(conversation, 'conversationAgent', async (...args: any[]) => {
            assert.match(args[6].context, /12025550123/); assert.match(args[6].context, /Активных напоминаний: 0/);
            return { responseText: 'Телефон: +12025550123. Активных напоминаний нет.', skipOptionalFollowups: true };
        });
        await f.send('Какой телефон у Мирона Тестово?');
        const extra = [{ intent: 'НАПОМИНАНИЕ', details: { reminderAction: 'list' } }];
        f.setClassification({ intent: 'РАЗГОВОР', confidenceLevel: 'ВЫСОКИЙ', details: { telegramProfile: true, telegramProfileSelection: { action: 'select', candidateId: 81001 },
            ...(channel === 'app' ? { subIntents: extra } : {}) }, subIntents: channel === 'app' ? [] : extra, fastReply: { mode: 'route' } });
        f.setPlanning(request => {
            const text = request.messages[1].content;
            assert.match(text, /покажи мои напоминания/);
            return text.includes('Активных напоминаний: 0') ? { finish: true } : { calls: [{ id: 'additional-reminders', tool: 'reminders.list', args: {} }] };
        });
        assert.match(await f.send('Да, это нужный человек, и покажи мои напоминания'), /Активных напоминаний нет/);
        assert.equal(lookup.mock.callCount(), 2);
        // API response snapshots also read the registry; count actual runtime
        // executions separately from rendering the app's reminder list.
        assert.ok(reminders.mock.callCount() >= 1);
        assert.equal(f.sessions.get(f.key)!.agentRuntime!.toolNames.filter(name => name === 'reminders.list').length, 1);
    });
}
