import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createKiraToolRegistry, runKiraRuntime, continueConfirmedRuntime, continueQuestionRuntime, hasRuntimeQuestionAnswer, cancelRuntimeContinuation } from '../orchestration/runtime/kernel';
import { ToolRegistry, objectSchema } from '../orchestration/runtime/registry';
import { canExecuteRuntimeCall } from '../orchestration/runtime/authorization';
import type { KiraRuntimeInput, ToolContext, ToolDefinition, RuntimeSessionState } from '../orchestration/runtime/types';
import { config } from '../config';
import * as image from '../agents/imageAgent';
import * as memory from '../utils/multiQueryMemory';
import * as sessionStorage from '../services/SessionStorage';
import * as health from '../agents/healthAgent';
import { saveMessageDraft, getMessageDraft, deleteMessageDraft } from '../agents/sendMessagesAgent';
import { InlineKeyboard } from 'grammy';
import { AppDataSource } from '../data-source';

function input(): KiraRuntimeInput {
    return { ctx: { from: { id: 101 }, chat: { id: 101, type: 'private' }, session: { messageHistory: [], reminders: [], domains: {}, dialogueSummary: '', lastSummarizedIndex: -1 } } as any,
        message: 'Найди данные и напомни проверить', isForwarded: false, forwardFrom: '', messageHistory: [], enrichedContextFromMemory: '',
        classification: { intent: 'ВЕБ_ПОИСК', confidenceLevel: 'ВЫСОКИЙ', details: {} } };
}
function context(value = input()): ToolContext { return { ...value, runId: 'synthetic-run', signal: new AbortController().signal, memoryContext: '', observations: [] }; }
function pending(goal = 'Найди данные и напомни проверить'): RuntimeSessionState {
    return { version: 1, runId: 'waiting-run', status: 'waiting', startedAt: Date.now(), updatedAt: Date.now(), goal, receipts: [], agents: [], skills: [], toolNames: [], observations: [], classification: input().classification };
}

test('private tools stay unavailable in groups even to the owner', async () => {
    const owner = config.allowedUserId; config.allowedUserId = 101;
    try {
        const value = context(); value.ctx = { ...value.ctx, chat: { id: -101, type: 'group' } } as any;
        const registry = createKiraToolRegistry();
        for (const name of ['memory.search', 'contacts.list', 'health.listEntries', 'settings.get', 'agents.start']) {
            assert.equal(registry.available(value).some(tool => tool.name === name), false, name);
            assert.equal((await registry.execute(name, {}, value)).status, 'failed', name);
        }
        assert.equal(registry.available(value).some(tool => tool.name === 'web.search'), true);
    } finally { config.allowedUserId = owner; }
});

test('an explicitly prepared empty memory context is not retrieved a second time', async t => {
    const owner = config.allowedUserId; config.allowedUserId = 101;
    const recall = t.mock.method(memory, 'getMultiQueryMemoryContextDetailed', async () => { throw new Error('Duplicate retrieval'); });
    try {
        const value = context();
        const result = await createKiraToolRegistry().execute('memory.search', { query: value.message }, value);
        assert.equal(result.status, 'ok'); assert.equal(recall.mock.callCount(), 0);
    } finally { config.allowedUserId = owner; }
});

test('image inspection is read-only and strips a legacy implicit reminder', async t => {
    const inspect = t.mock.method(image, 'imageAgent', async (...args: any[]) => {
        assert.deepEqual(args[5], { readOnly: true });
        return { responseText: 'На картинке синтетическая афиша.', description: 'Афиша', detectedText: '2099', reminderCreated: true, reminderDetails: { id: 'injected' } } as any;
    });
    const value = context(); value.images = [Buffer.from('synthetic image')];
    const result = await createKiraToolRegistry().execute('images.inspect', {}, value);
    assert.equal(inspect.mock.callCount(), 1); assert.equal(result.status, 'ok'); assert.equal(result.result?.reminderCreated, undefined); assert.equal(result.result?.reminderDetails, undefined);
});

test('caption actions run only after attached images have been inspected', async () => {
    const value = input(); value.images = [Buffer.from('synthetic')]; value.classification.intent = 'НАПОМИНАНИЕ';
    let inspected = false; let written = false;
    const definitions: ToolDefinition[] = [
        { name: 'images.inspect', skill: 'image-creation', effect: 'read', ownerOnly: false, description: '', inputSchema: objectSchema({ caption: { type: 'string' } }), execute: async () => { inspected = true; return { status: 'ok', summary: 'Афиша', context: 'Событие из афиши: 2099' }; } },
        { name: 'test.write', skill: 'reminders', effect: 'state', ownerOnly: false, description: '', inputSchema: objectSchema({}), execute: async (_, ctx) => { assert.equal(inspected, true); assert.match(ctx.memoryContext, /2099/); written = true; return { status: 'ok', summary: 'Сохранено' }; } },
    ];
    let round = 0;
    await runKiraRuntime(value, { registry: new ToolRegistry(definitions, () => true), decide: async () => round++ === 0 ? { calls: [{ id: 'write', tool: 'test.write', args: {} }] } : { finish: true }, persist: async () => {}, respond: async () => ({ responseText: 'Готово' }) });
    assert.equal(written, true);
});

test('a short answer continues the original goal and does not repeat completed work', async () => {
    const value = input(); const state = pending(); state.question = 'В каком городе?';
    state.observations = [{ id: 'done', tool: 'web.search', status: 'ok', summary: 'Источник' }, { id: 'question', tool: 'kernel.question', status: 'needs_input', summary: state.question }];
    value.ctx.session.agentRuntime = state;
    assert.equal(hasRuntimeQuestionAnswer(value.ctx, 'В Казани'), true);
    assert.equal(hasRuntimeQuestionAnswer(value.ctx, 'Что умеешь?'), false);
    assert.equal(hasRuntimeQuestionAnswer(value.ctx, 'Найди новый концерт'), false);
    let decisions = 0;
    const result = await continueQuestionRuntime(value.ctx, 'В Казани', { forceLoop: true, registry: new ToolRegistry([], () => true), persist: async () => {},
        decide: async ({ context: ctx }) => { decisions++; assert.equal(ctx.message, state.goal); assert.equal(ctx.continuationAnswer, 'В Казани'); assert.equal(ctx.observations[0].id, 'done'); return { finish: true }; }, respond: async () => ({ responseText: 'Ответ с городом' }) });
    assert.equal(decisions, 1); assert.equal(result?.operationStatus, 'ok');
});

test('verified confirmation can resume an archived compound goal after another request', async () => {
    const mode = process.env.KIRA_ORCHESTRATION_MODE; process.env.KIRA_ORCHESTRATION_MODE = 'skills';
    try {
        const value = input(); const archived = pending('Напиши контакту и напомни проверить');
        archived.observations = [{ id: 'draft', tool: 'messages.prepareDraft', status: 'needs_input', summary: 'Черновик' }];
        archived.pendingCalls = [{ id: 'next', tool: 'test.write', args: {}, dependsOn: ['draft'] }];
        value.ctx.session.agentRuntime = { ...pending('Другая задача'), status: 'completed', runId: 'another-run' };
        value.ctx.session.agentRuntimePending = [archived];
        let writes = 0;
        const definition: ToolDefinition = { name: 'test.write', skill: 'reminders', effect: 'state', ownerOnly: false, description: '', inputSchema: objectSchema({}), execute: async () => { writes++; return { status: 'ok', summary: 'Сохранено' }; } };
        const result = await continueConfirmedRuntime(value.ctx, ['messages.prepareDraft'], 'Отправлено после подтверждения', { registry: new ToolRegistry([definition], () => true), persist: async () => {}, decide: async () => ({ finish: true }), respond: async () => ({ responseText: 'Готово' }) });
        assert.equal(writes, 1); assert.equal(result?.operationStatus, 'ok'); assert.equal(value.ctx.session.agentRuntimePending?.length, 0);
    } finally { if (mode === undefined) delete process.env.KIRA_ORCHESTRATION_MODE; else process.env.KIRA_ORCHESTRATION_MODE = mode; }
});

test('cancelling a confirmation cancels its queued continuation', async t => {
    const mode = process.env.KIRA_ORCHESTRATION_MODE; process.env.KIRA_ORCHESTRATION_MODE = 'skills';
    const persist = t.mock.method(sessionStorage, 'persistAgentRuntime', async () => {});
    try {
        const value = input(); const state = pending(); state.observations = [{ id: 'draft', tool: 'messages.prepareDraft', status: 'needs_input', summary: 'Черновик' }]; state.pendingCalls = [{ id: 'next', tool: 'test.write', args: {} }]; value.ctx.session.agentRuntime = state;
        await cancelRuntimeContinuation(value.ctx, ['messages.prepareDraft']);
        assert.equal(state.status, 'failed'); assert.deepEqual(state.pendingCalls, []); assert.equal(persist.mock.callCount(), 1);
    } finally { if (mode === undefined) delete process.env.KIRA_ORCHESTRATION_MODE; else process.env.KIRA_ORCHESTRATION_MODE = mode; }
});

test('journal and pending goals survive storage roundtrip without crossing API and Telegram', async t => {
    const rows = new Map<string, unknown>();
    const repo = { findOne: async ({ where }: any) => rows.get(where.key) ?? null, upsert: async (row: any) => { rows.set(row.key, JSON.parse(JSON.stringify(row))); } };
    t.mock.method(AppDataSource, 'getRepository', (() => repo) as any);
    const storage = new sessionStorage.TypeORMSessionStorage(true);
    const value = input(); value.ctx.session.agentRuntime = pending(); value.ctx.session.agentRuntimePending = [pending('Отложенный запрос')];
    await storage.write('api:101', value.ctx.session);
    assert.equal((await storage.read('api:101'))?.agentRuntime?.goal, value.message);
    assert.equal((await storage.read('api:101'))?.agentRuntimePending?.[0].goal, 'Отложенный запрос');
    assert.equal(await storage.read('101'), undefined);
});

test('self study authority cannot be used to change settings or cancel unrelated reminders', () => {
    const value = context(); value.classification.intent = 'САМОИЗУЧЕНИЕ'; value.message = 'Изучи себя';
    const registry = createKiraToolRegistry();
    assert.equal(canExecuteRuntimeCall(registry.get('settings.update')!, { id: 'a', tool: 'settings.update', args: { budgetMode: 'maximum' } }, value), false);
    value.classification.intent = 'НАПОМИНАНИЕ'; value.classification.details.reminderAction = 'cancel'; value.message = 'Отмени напоминание';
    assert.equal(canExecuteRuntimeCall(registry.get('reminders.create')!, { id: 'b', tool: 'reminders.create', args: {} }, value), false);
});

test('a saved health observation with optional menu buttons does not pause the compound goal', async t => {
    const owner = config.allowedUserId; config.allowedUserId = 101;
    t.mock.method(health, 'healthAgent', async () => ({ responseText: 'Наблюдение сохранено.', operationStatus: 'ok', keyboard: new InlineKeyboard().text('Меню', 'health:menu') }));
    try {
        const value = context(); value.message = 'Запиши в дневник здоровья: синтетическое наблюдение';
        const result = await createKiraToolRegistry().execute('health.request', { request: value.message }, value);
        assert.equal(result.status, 'ok'); assert.equal(result.result?.keyboard, undefined);
        assert.equal((await createKiraToolRegistry().execute('health.request', { request: 'Выдуманный моделью симптом' }, value)).status, 'failed');
    } finally { config.allowedUserId = owner; }
});

test('a new draft cannot overwrite a pending message belonging to another goal', async () => {
    const owner = config.allowedUserId; config.allowedUserId = 101;
    saveMessageDraft(101, 202, 'Существующий синтетический черновик', undefined, false);
    try {
        const result = await createKiraToolRegistry().execute('messages.prepareDraft', { request: 'Напиши другое сообщение' }, context());
        assert.equal(result.status, 'failed'); assert.equal(result.result?.keyboard, undefined);
        assert.equal(getMessageDraft(101)?.text, 'Существующий синтетический черновик');
    } finally { deleteMessageDraft(101); config.allowedUserId = owner; }
});

test('an independent literal reminder can succeed even when the separate current-world lookup failed', async () => {
    const value = input(); value.message = 'Найди свежую афишу и напомни завтра купить хлеб'; value.classification.details.knowledgeSource = 'external_current';
    value.classification.subIntents = [{ intent: 'НАПОМИНАНИЕ' }]; let writes = 0; let round = 0;
    const definitions: ToolDefinition[] = [
        { name: 'web.search', skill: 'web-research', ownerOnly: false, effect: 'read', description: '', inputSchema: objectSchema({}), execute: async () => ({ status: 'failed', summary: 'Нет связи' }) },
        { name: 'reminders.create', skill: 'reminders', ownerOnly: false, effect: 'state', description: '', inputSchema: objectSchema({ text: { type: 'string' } }), execute: async () => { writes++; return { status: 'ok', summary: 'Напоминание сохранено.', result: { responseText: 'Напоминание сохранено.' } }; } },
    ];
    const result = await runKiraRuntime(value, { forceLoop: true, registry: new ToolRegistry(definitions, () => true), persist: async () => {},
        decide: async () => round++ === 0 ? { calls: [{ id: 'search', tool: 'web.search', args: {} }, { id: 'remind', tool: 'reminders.create', args: { text: 'купить хлеб' } }] } : { finish: true }, respond: async () => { throw new Error('Cannot claim current-world answer'); } });
    assert.equal(writes, 1); assert.match(result.responseText, /Напоминание сохранено/); assert.match(result.responseText, /Не удалось проверить/); assert.equal(result.operationStatus, 'failed');
});
