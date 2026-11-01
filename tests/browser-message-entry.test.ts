import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { Bot } from 'grammy';
import { config } from '../config';
import { BotApiBackend } from '../api/backend';
import { createExternalApiServer } from '../api/server';
import { createPlatformServer } from '../platform/server';
import { digest, PlatformSecrets } from '../platform/crypto';
import { TypeORMSessionStorage } from '../services/SessionStorage';
import { ChatGroupRepository } from '../services/ChatGroupRepository';
import { DialogueJobRepository } from '../services/DialogueJobRepository';
import { RecurringTaskRepository } from '../services/RecurringTaskRepository';
import { factAnalysisManager } from '../utils/factAnalysisTimer';
import { liveBrowserSessions } from '../services/liveBrowserSession';
import * as completion from '../ai/chatCompletion';
import * as browser from '../agents/browserAgent';
import * as conversation from '../agents/conversationAgent';
import * as web from '../agents/webSearchAgent';
import * as memory from '../utils/agentMemoryContext';
import * as history from '../utils/history';
import * as communication from '../services/communicationProfileService';
import * as behavior from '../services/behaviorMemoryService';
import * as reconsolidation from '../services/MemoryReconsolidationService';
import type { BotContext, SessionData } from '../types';

const owner = 94101;
const botToken = '1234567890:abcdefghijklmnopqrstuvwxyzABCDE';
const actualBrowserAgent = browser.browserAgent;

for (const deferred of [false, true]) test(`accounts /messages keeps browser viewing constraints and operation discovery (async=${deferred})`, async t => {
    const previousOwner = config.allowedUserId; config.allowedUserId = owner;
    const previousMode = process.env.KIRA_ORCHESTRATION_MODE; process.env.KIRA_ORCHESTRATION_MODE = 'skills';
    t.after(() => { config.allowedUserId = previousOwner;
        if (previousMode === undefined) delete process.env.KIRA_ORCHESTRATION_MODE; else process.env.KIRA_ORCHESTRATION_MODE = previousMode;
    });
    let stored: SessionData | undefined;
    t.mock.method(TypeORMSessionStorage.prototype, 'read', async () => stored && structuredClone(stored));
    t.mock.method(TypeORMSessionStorage.prototype, 'write', async (_key: string, value: SessionData) => { stored = structuredClone(value); });
    t.mock.method(ChatGroupRepository, 'findAll', async () => []);
    t.mock.method(DialogueJobRepository, 'beginTurn', async () => {});
    t.mock.method(RecurringTaskRepository, 'listByChatId', async () => []);
    const stage = t.mock.method(DialogueJobRepository, 'stage', async () => { throw Error('Browser work must stay in its foreground turn'); });
    t.mock.method(factAnalysisManager, 'scheduleAnalysis', () => {});
    t.mock.method(reconsolidation, 'reconsolidateAfterResponse', async () => {});
    t.mock.method(history, 'addToHistory', async (ctx: BotContext, role: string, content: string) => {
        ctx.session.messageHistory.unshift({ role: role as any, content, timestamp: new Date() });
    });
    t.mock.method(communication, 'communicationProfileContext', async () => '');
    t.mock.method(behavior, 'getBehaviorMemoryContext', async () => '');
    t.mock.method(memory, 'fetchAgentMemoryContext', async () => ({ domain: 'personal', context: '', recalledMemories: [] }));
    let control: 'continue' | 'cancel' = 'continue';
    let mode: 'browser' | 'greeting' | 'research' = 'browser';
    const classify = t.mock.method(completion, 'createJsonChatCompletionForTask', async (task: string) => {
        assert.ok(['intentClassification','fastDialogue'].includes(task));
        if (mode !== 'browser') return { intent:mode === 'greeting' ? 'РАЗГОВОР' : 'ВЕБ_ПОИСК', confidenceLevel:'ВЫСОКИЙ',
            details:{memoryNeed:'none',responseComplexity:'routine',...(mode === 'research' ? {knowledgeSource:'external_current'} : {})},
            fastReply:mode === 'greeting' ? {mode:'answer',answer:'Привет!'} : {mode:'route'} } as any;
        return { intent: 'БРАУЗЕР_ЗАДАЧА', confidenceLevel: 'ВЫСОКИЙ', details: { memoryNeed: 'none', responseComplexity: 'routine', browserTaskControl: control } } as any;
    });
    const answer = t.mock.method(conversation, 'conversationAgent', async () => ({ responseText: 'A conversation cannot open the requested page.' }));
    const search = t.mock.method(web, 'performWebSearch', async () => ({success:true,results:'Synthetic astronomy news from a public source.'}));
    const operationId = randomUUID();
    const task = 'Открой https://fixture.example/. Ничего не бронируй и не отправляй. Оставь страницу открытой для ручного управления.' + (deferred ? ' Дальше жди моего ответа.' : '');
    let expectedText = task, expectedOperation = operationId;
    let session: ReturnType<typeof liveBrowserSessions.create>;
    const leaf = t.mock.method(browser, 'browserAgent', async (ctx: BotContext, text: string, ...args: any[]) => {
        assert.equal(text, expectedText); assert.equal(ctx.from?.id, owner); assert.equal(ctx.sessionStorageKey, `api:${owner}`);
        assert.equal(ctx.liveBrowserRequest?.operationId, expectedOperation);
        if (control === 'cancel' || session) return actualBrowserAgent(ctx, text, ...args);
        if (!session) { session = liveBrowserSessions.create(owner, `api:${owner}`, operationId); t.after(() => session.dispose()); }
        ctx.session.pendingBrowserTask = { sessionId: session.id, originalTask: task, question: 'Продолжить просмотр?', createdAt: Date.now(), expiresAt: Date.now() + 60_000 };
        return { responseText: 'Синтетический браузер ожидает пользователя.', operationStatus: 'needs_input' as const };
    });
    const bot = new Bot<BotContext>(botToken, { botInfo: { id: 1234567890, is_bot: true, first_name: 'Test', username: 'synthetic_bot' } as any });
    bot.api.config.use(async () => { throw Error('No Telegram traffic'); });
    const workerToken = 'synthetic-worker-token';
    const backend = new BotApiBackend(bot, { ownerId: owner, token: workerToken, host: '127.0.0.1', port: 0 },
        { read: async () => ({ preset: null, revision: 'none' }), write: async () => { throw Error('No settings writes'); } });
    const worker = createExternalApiServer({ ownerId: owner, token: workerToken, host: '127.0.0.1', port: 0 }, backend,
        { run: async (_key, _fingerprint, work) => work() });
    await new Promise<void>(resolve => worker.listen(0, '127.0.0.1', resolve));
    const token = 'synthetic-public-token-at-least-thirty-two-characters', account = { id: randomUUID(), owner_id: String(owner) };
    const platform = createPlatformServer({
        store: { authenticate: async (hash: string) => hash === digest(token) ? account : undefined } as any,
        secrets: new PlatformSecrets('12'.repeat(32)),
        runtimes: { endpoint: () => ({ port: (worker.address() as AddressInfo).port, token: workerToken }) } as any,
        telegram: {} as any,
    });
    await new Promise<void>(resolve => platform.listen(0, '127.0.0.1', resolve));
    t.after(async () => { for (const server of [platform, worker]) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
    const base = `http://127.0.0.1:${(platform.address() as AddressInfo).port}/api/v1`;
    const response = await fetch(base + '/messages', { method: 'POST', headers: { Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json', 'Idempotency-Key': operationId, 'X-Kira-Browser-Session': 'v1', ...(deferred ? { Prefer: 'respond-async' } : {}) }, body: JSON.stringify({ text: task }) });
    assert.equal(response.status, 200, await response.text());
    const discovery = await fetch(base + `/browser/sessions/active?operationId=${operationId}`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(discovery.status, 200);
    assert.ok((await discovery.json() as any).session, 'The message must start the requested browser, not merely answer in chat');
    assert.equal(leaf.mock.callCount(), 1); assert.equal(answer.mock.callCount(), 0); assert.equal(stage.mock.callCount(), 0);
    assert.equal(classify.mock.callCount(), 1);
    const originalSessionId = session!.id;
    expectedText = 'Не бронируй ничего, продолжи осмотр этой страницы.' + (deferred ? ' Я пока смотрю.' : ''); expectedOperation = randomUUID();
    const send = () => fetch(base + '/messages', { method:'POST', headers:{ Authorization:`Bearer ${token}`, 'Content-Type':'application/json',
        'Idempotency-Key':expectedOperation, 'X-Kira-Browser-Session':'v1', ...(deferred ? { Prefer:'respond-async' } : {}) }, body:JSON.stringify({ text:expectedText }) });
    const continuation = await send(); assert.equal(continuation.status, 200, await continuation.text());
    assert.equal(leaf.mock.callCount(), 2, 'A scoped prohibition must reach the existing workflow');
    assert.equal(session!.id, originalSessionId); assert.notEqual(session!.state, 'cancelled');
    assert.equal(stored!.pendingBrowserTask?.sessionId, originalSessionId);
    control = 'cancel'; expectedText = 'Я передумал, останови всю браузерную задачу.' + (deferred ? ' Просмотр больше не нужен.' : ''); expectedOperation = randomUUID();
    const cancellation = await send(); assert.equal(cancellation.status, 200, await cancellation.text());
    assert.equal(session!.state, 'cancelled'); assert.equal(stored!.pendingBrowserTask, undefined);
    assert.equal(answer.mock.callCount(), 0); assert.equal(stage.mock.callCount(), 0);
    mode = 'greeting'; expectedText = deferred ? 'Привет!' : 'Привет'; expectedOperation = randomUUID();
    const greeting = await send(); assert.equal(greeting.status,200); assert.match(JSON.stringify(await greeting.json()), /Привет/);
    assert.equal(leaf.mock.callCount(),3); assert.equal(answer.mock.callCount(),0);
    mode = 'research'; expectedText = 'Поищи актуальные новости об астрономии.' + (deferred ? ' За сегодня.' : ''); expectedOperation = randomUUID();
    const research = await send(); assert.equal(research.status,200,await research.text());
    assert.equal(search.mock.callCount(),1); assert.equal(leaf.mock.callCount(),3);
    assert.equal(liveBrowserSessions.active(owner,`api:${owner}`,expectedOperation),null);
});
