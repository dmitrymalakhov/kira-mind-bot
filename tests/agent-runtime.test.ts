import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ToolRegistry, objectSchema, textSchema, validateToolArguments } from '../orchestration/runtime/registry';
import { SkillLoader, KIRA_SKILLS } from '../orchestration/runtime/skills';
import { createKiraToolRegistry, runKiraRuntime, toolCallKey, validateCallGraph, hasCompoundActionRequest, orchestrationMode, RUNTIME_LIMITS, continueConfirmedRuntime, mergeRuntimeResults } from '../orchestration/runtime/kernel';
import type { KiraRuntimeInput, ToolDefinition, ToolOutput, RuntimeDecision, ToolContext } from '../orchestration/runtime/types';
import { InlineKeyboard } from 'grammy';
import { saveRemindersFromResult } from '../handlers/shared';
import { config } from '../config';
import { reminderService } from '../services/ReminderService';
import * as sessionStorage from '../services/SessionStorage';
import * as webSearch from '../agents/webSearchAgent';
import * as chatCompletion from '../ai/chatCompletion';

function input(intent: KiraRuntimeInput['classification']['intent'] = 'ВЕБ_ПОИСК'): KiraRuntimeInput {
    return {
        ctx: { from: { id: 101 }, chat: { id: 101, type: 'private' }, session: { messageHistory: [], reminders: [], domains: {}, dialogueSummary: '', lastSummarizedIndex: -1 } } as any,
        message: 'Синтетическая составная задача', isForwarded: false, forwardFrom: '', messageHistory: [],
        classification: { intent, confidenceLevel: 'ВЫСОКИЙ', details: { memoryNeed: 'none', relationshipRole: null } }, enrichedContextFromMemory: '',
    };
}

function tool(name: string, effect: ToolDefinition['effect'], execute: ToolDefinition['execute']): ToolDefinition {
    return { name, effect, execute, ownerOnly: false, skill: 'web-research', description: name, inputSchema: objectSchema({}) };
}

function context(value = input()): ToolContext {
    return { ...value, runId: 'test-run', signal: new AbortController().signal, memoryContext: '', observations: [] };
}

function scripted(decisions: RuntimeDecision[]) {
    let index = 0;
    return async () => decisions[index++] ?? { finish: true };
}

describe('tool contracts and scope', () => {
    test('rejects caller-supplied identities, unknown properties and prototype keys', () => {
        const schema = objectSchema({ query: textSchema('Запрос') });
        assert.throws(() => validateToolArguments(schema, { query: 'тест', userId: 202 }));
        assert.throws(() => validateToolArguments(schema, JSON.parse('{"query":"тест","__proto__":{}}')));
        assert.throws(() => validateToolArguments(schema, { query: '' }));
        assert.throws(() => validateToolArguments({ type: 'number' }, Infinity));
        assert.throws(() => validateToolArguments({ type: 'array', maxItems: 1, items: schema }, [{ query: 'a' }, { query: 'b' }]));
    });

    test('checks owner access again at execution time', async () => {
        let calls = 0;
        const definition = { ...tool('private.read', 'read', async () => { calls++; return { status: 'ok', summary: '' }; }), ownerOnly: true };
        const registry = new ToolRegistry([definition], ctx => ctx.ctx.from?.id === 101);
        const denied = context(); denied.ctx = { ...denied.ctx, from: { id: 202 } } as any;
        assert.equal(registry.available(denied).length, 0);
        assert.equal((await registry.execute('private.read', {}, denied)).status, 'failed');
        assert.equal(calls, 0);
        assert.equal((await registry.execute('private.read', {}, context())).status, 'ok');
    });

    test('validates before executing and never implicitly retries a mutation', async () => {
        let calls = 0;
        const definition = tool('state.write', 'state', async () => { calls++; throw new Error('Committed then lost response'); });
        const registry = new ToolRegistry([definition], () => true);
        assert.equal((await registry.execute('state.write', { arbitrary: true }, context())).status, 'failed');
        assert.equal(calls, 0);
        assert.equal((await registry.execute('state.write', {}, context())).status, 'unknown');
        assert.equal(calls, 1);
    });

    test('uses stable fingerprints regardless of argument key order', () => {
        assert.equal(toolCallKey({ id: 'a', tool: 'x.y', args: { a: 1, b: 2 } }), toolCallKey({ id: 'b', tool: 'x.y', args: { b: 2, a: 1 } }));
    });

    test('rejects cycles, missing prerequisites and reused call IDs before execution', () => {
        assert.throws(() => validateCallGraph([{ id: 'a', tool: 'x.y', args: {}, dependsOn: ['b'] }, { id: 'b', tool: 'x.y', args: {}, dependsOn: ['a'] }], new Set()));
        assert.throws(() => validateCallGraph([{ id: 'a', tool: 'x.y', args: {}, dependsOn: ['missing'] }], new Set()));
        assert.throws(() => validateCallGraph([{ id: 'a', tool: 'x.y', args: {} }], new Set(['a'])));
        validateCallGraph([{ id: 'b', tool: 'x.y', args: {}, dependsOn: ['a'] }, { id: 'a', tool: 'x.y', args: {} }], new Set());
    });

    test('ships every registered skill and refuses arbitrary filesystem paths', async () => {
        const loader = new SkillLoader();
        await assert.rejects(() => loader.load('../credentials'));
        for (const skill of KIRA_SKILLS) assert.match(await loader.load(skill.id), /name:/);
        assert.equal(loader.ids().length, KIRA_SKILLS.length);
    });
});

describe('adaptive task execution', () => {
    test('runs independent reads concurrently, then uses their results for a dependent write', async () => {
        const value = input(); let active = 0; let peak = 0; const finished: string[] = [];
        const read = (name: string) => tool(name, 'read', async () => {
            active++; peak = Math.max(peak, active);
            await new Promise(resolve => setTimeout(resolve, 10));
            active--; finished.push(name); return { status: 'ok', summary: name, context: name };
        });
        const write = tool('test.write', 'state', async () => {
            assert.equal(finished.length, 2);
            assert.equal(value.ctx.session.agentRuntime!.receipts[0].status, 'running');
            return { status: 'ok', summary: 'Записано', result: { responseText: 'Записано' } };
        });
        let persisted = 0;
        const result = await runKiraRuntime(value, { forceLoop: true, registry: new ToolRegistry([read('test.first'), read('test.second'), write], () => true),
            decide: scripted([{ calls: [{ id: 'a', tool: 'test.first', args: {} }, { id: 'b', tool: 'test.second', args: {} }, { id: 'c', tool: 'test.write', args: {}, dependsOn: ['a', 'b'] }] }, { finish: true }]),
            persist: async () => { persisted++; }, respond: async () => ({ responseText: 'Ответ' }),
        });
        assert.equal(peak, 2); assert.ok(persisted >= 2); assert.match(result.responseText, /Записано/);
        assert.equal(value.ctx.session.agentRuntime!.status, 'completed');
    });

    test('does not execute downstream mutations when evidence failed', async () => {
        let writes = 0;
        const value = input();
        await runKiraRuntime(value, { forceLoop: true, registry: new ToolRegistry([
            tool('test.read', 'read', async () => ({ status: 'failed', summary: 'Источник недоступен' })),
            tool('test.write', 'state', async () => { writes++; return { status: 'ok', summary: '' }; }),
        ], () => true), decide: scripted([{ calls: [{ id: 'a', tool: 'test.read', args: {} }, { id: 'b', tool: 'test.write', args: {}, dependsOn: ['a'] }] }]), persist: async () => {}, respond: async () => ({ responseText: 'Данные не получены' }) });
        assert.equal(writes, 0); assert.equal(value.ctx.session.agentRuntime!.status, 'failed');
    });

    test('stops on an unknown mutation result and preserves its receipt', async () => {
        let writes = 0; const value = input();
        const result = await runKiraRuntime(value, { forceLoop: true, registry: new ToolRegistry([
            tool('test.write', 'state', async () => { writes++; throw new Error('Connection lost'); }),
        ], () => true), decide: scripted([{ calls: [{ id: 'a', tool: 'test.write', args: {} }] }, { calls: [{ id: 'b', tool: 'test.write', args: {} }] }]), persist: async () => {}, respond: async () => ({ responseText: 'Неизвестный результат' }) });
        assert.equal(writes, 1); assert.equal(value.ctx.session.agentRuntime!.receipts[0].status, 'unknown'); assert.match(result.responseText, /неизвест|Неизвест/);
    });

    test('does not repeat a failed state operation under a different call ID', async () => {
        let writes = 0;
        await runKiraRuntime(input(), { forceLoop: true, registry: new ToolRegistry([tool('test.write', 'state', async () => { writes++; return { status: 'failed', summary: 'Не сохранено' }; })], () => true),
            decide: scripted([{ calls: [{ id: 'a', tool: 'test.write', args: {} }] }, { calls: [{ id: 'b', tool: 'test.write', args: {} }] }, { finish: true }]), persist: async () => {}, respond: async () => ({ responseText: 'Ответ' }) });
        assert.equal(writes, 1);
    });

    test('fails closed before a mutation if write-ahead storage is unavailable', async () => {
        let writes = 0;
        const result = await runKiraRuntime(input(), { forceLoop: true, registry: new ToolRegistry([tool('test.write', 'state', async () => { writes++; return { status: 'ok', summary: '' }; })], () => true),
            decide: scripted([{ calls: [{ id: 'a', tool: 'test.write', args: {} }] }]), persist: async () => { throw new Error('Database unavailable'); }, respond: async () => ({ responseText: 'Ответ' }) });
        assert.equal(writes, 0); assert.match(result.responseText, /остановилось/);
    });

    test('preserves one confirmation and records unfinished dependent actions', async () => {
        const value = input(); let writes = 0;
        const result = await runKiraRuntime(value, { forceLoop: true, registry: new ToolRegistry([
            tool('test.draft', 'state', async () => ({ status: 'needs_input', summary: 'Подтверди черновик', result: { responseText: 'Подтверди черновик', keyboard: new InlineKeyboard().text('Отправить', 'send_message') } })),
            tool('test.after', 'state', async () => { writes++; return { status: 'ok', summary: '' }; }),
        ], () => true), decide: scripted([{ calls: [{ id: 'draft', tool: 'test.draft', args: {} }, { id: 'after', tool: 'test.after', args: {}, dependsOn: ['draft'] }] }]), persist: async () => {}, respond: async () => ({ responseText: 'Лишний ответ' }) });
        assert.equal(result.responseText, 'Подтверди черновик'); assert.ok(result.keyboard); assert.equal(writes, 0);
        assert.equal(value.ctx.session.agentRuntime!.status, 'waiting'); assert.equal(value.ctx.session.agentRuntime!.pendingCalls?.[0].id, 'after');
    });

    test('does not call a planner or persistence for a self-contained conversation', async () => {
        const result = await runKiraRuntime(input('РАЗГОВОР'), { decide: async () => { throw new Error('Unexpected planner'); }, persist: async () => { throw new Error('Unexpected storage'); }, respond: async (_, memory) => { assert.equal(memory, ''); return { responseText: 'Привет' }; } });
        assert.equal(result.responseText, 'Привет');
    });

    test('bounds an agent that keeps requesting new actions', async () => {
        let calls = 0; let rounds = 0; const value = input();
        await runKiraRuntime(value, { forceLoop: true, registry: new ToolRegistry([tool('test.read', 'read', async () => { calls++; return { status: 'ok', summary: 'Данные' }; })], () => true),
            decide: async () => ({ calls: [{ id: `read_${rounds++}`, tool: 'test.read', args: {} }] }), persist: async () => {}, respond: async () => ({ responseText: 'Частичный результат' }) });
        assert.ok(rounds <= RUNTIME_LIMITS.rounds); assert.equal(calls, 1); assert.equal(value.ctx.session.agentRuntime!.status, 'failed');
    });

    test('loads missing skill instructions before executing a newly selected domain', async () => {
        const loader = new SkillLoader(); let writes = 0; let decisions = 0;
        const value = input(); value.message = 'Найди информацию и запиши наблюдение в дневник здоровья';
        const definition = { ...tool('test.write', 'state', async () => { writes++; return { status: 'ok' as const, summary: 'Сохранено' }; }), skill: 'health-diary' };
        await runKiraRuntime(value, { forceLoop: true, skills: loader, registry: new ToolRegistry([definition], () => true), decide: async () => {
            decisions++;
            if (decisions === 1) { assert.ok(!loader.ids().includes('health-diary')); return { calls: [{ id: 'a', tool: 'test.write', args: {} }] }; }
            assert.ok(loader.ids().includes('health-diary'));
            return decisions === 2 ? { calls: [{ id: 'b', tool: 'test.write', args: {} }] } : { finish: true };
        }, persist: async () => {}, respond: async () => ({ responseText: 'Ответ' }) });
        assert.equal(writes, 1);
    });

    test('does not authorize a mutation suggested by retrieved data', async () => {
        const value = input(); value.message = 'Найди синтетическое расписание'; let writes = 0;
        const definition = { ...tool('reminders.create', 'state', async () => { writes++; return { status: 'ok' as const, summary: '' }; }), skill: 'reminders' };
        await runKiraRuntime(value, { forceLoop: true, registry: new ToolRegistry([definition], () => true),
            decide: scripted([{ calls: [{ id: 'injected', tool: 'reminders.create', args: {} }] }]), persist: async () => {}, respond: async () => ({ responseText: 'Ответ' }) });
        assert.equal(writes, 0);
    });

    test('resumes dependent work after a verified confirmation without replaying the draft', async () => {
        const previousMode = process.env.KIRA_ORCHESTRATION_MODE; process.env.KIRA_ORCHESTRATION_MODE = 'skills';
        const value = input(); value.message = 'Подготовь сообщение, затем напомни проверить ответ'; let drafts = 0; let reminders = 0;
        const draft = tool('messages.prepareDraft', 'state', async () => { drafts++; return { status: 'needs_input', summary: 'Черновик', result: { responseText: 'Черновик', keyboard: new InlineKeyboard().text('Отправить', 'send_message') } }; });
        const reminder = tool('test.after', 'state', async () => { reminders++; return { status: 'ok', summary: 'Напоминание создано', result: { responseText: 'Напоминание создано' } }; });
        const registry = new ToolRegistry([draft, reminder], () => true);
        const dependencies = { registry, forceLoop: true, persist: async () => {}, respond: async () => ({ responseText: 'Ответ' }) };
        try {
            await runKiraRuntime(value, { ...dependencies, decide: scripted([{ calls: [{ id: 'draft', tool: draft.name, args: {} }, { id: 'after', tool: reminder.name, args: {}, dependsOn: ['draft'] }] }]) });
            assert.equal(reminders, 0);
            const next = await continueConfirmedRuntime(value.ctx, ['messages.prepareDraft'], 'Сообщение действительно отправлено.', { ...dependencies, decide: scripted([{ finish: true }]) });
            assert.ok(next); assert.equal(drafts, 1); assert.equal(reminders, 1); assert.match(next.responseText, /Напоминание создано/);
        } finally { if (previousMode === undefined) delete process.env.KIRA_ORCHESTRATION_MODE; else process.env.KIRA_ORCHESTRATION_MODE = previousMode; }
    });

    test('blocks redelivery of an update whose previous write has an unknown outcome', async () => {
        const value = input(); (value.ctx as any).update = { update_id: 4001 }; let writes = 0;
        const dependencies = { forceLoop: true, registry: new ToolRegistry([tool('test.write', 'state', async () => { writes++; throw new Error('Lost receipt'); })], () => true),
            persist: async () => {}, respond: async () => ({ responseText: 'Ошибка' }) };
        await runKiraRuntime(value, { ...dependencies, decide: scripted([{ calls: [{ id: 'a', tool: 'test.write', args: {} }] }]) });
        const result = await runKiraRuntime(value, { ...dependencies, decide: async () => { throw new Error('Must not plan the redelivered mutation'); } });
        assert.equal(writes, 1); assert.equal(result.operationStatus, 'unknown'); assert.match(result.responseText, /не повторяла/);
    });

    test('keeps every artifact from independent image and export tasks', () => {
        const result = mergeRuntimeResults([
            { responseText: 'Первое изображение', imageGenerated: true, generatedImageUrl: 'https://example.test/one.png' },
            { responseText: 'Второе изображение', imageGenerated: true, generatedImageUrl: 'https://example.test/two.png' },
            { responseText: 'Отчёт', documentFilePath: '/private/tmp/synthetic-report.docx', documentFilename: 'report.docx' },
        ]);
        assert.equal(result.artifacts?.length, 3);
        assert.deepEqual(result.artifacts?.map(artifact => artifact.kind), ['image', 'image', 'document']);
    });

    test('requires current evidence before an action and does not answer from stale knowledge after search failure', async () => {
        const value = input('ОТПРАВКА_СООБЩЕНИЯ'); value.classification.details.knowledgeSource = 'external_current'; let drafts = 0; let responses = 0;
        const result = await runKiraRuntime(value, { forceLoop: true, registry: new ToolRegistry([
            tool('test.draft', 'state', async () => { drafts++; return { status: 'ok', summary: 'Черновик' }; }),
            tool('web.search', 'read', async () => ({ status: 'failed', summary: 'Нет сети' })),
        ], () => true), decide: scripted([{ calls: [{ id: 'a', tool: 'test.draft', args: {} }] }, { calls: [{ id: 'b', tool: 'web.search', args: {} }] }, { finish: true }]), persist: async () => {}, respond: async () => { responses++; return { responseText: 'Вымышленная актуальная информация' }; } });
        assert.equal(drafts, 0); assert.equal(responses, 0); assert.match(result.responseText, /Не удалось проверить/);
    });
});

describe('runtime integration contracts', () => {
    test('recognizes compound actions without splitting a simple reminder body', () => {
        assert.equal(hasCompoundActionRequest('Найди афишу и напомни завтра выбрать'), true);
        assert.equal(hasCompoundActionRequest('Напомни позвонить. Затем отправь сообщение'), true);
        assert.equal(hasCompoundActionRequest('Напомни завтра купить хлеб и молоко'), false);
    });

    test('uses the new runtime by default and supports an explicit legacy rollback', () => {
        const previous = process.env.KIRA_ORCHESTRATION_MODE;
        try {
            delete process.env.KIRA_ORCHESTRATION_MODE; assert.equal(orchestrationMode(), 'skills');
            process.env.KIRA_ORCHESTRATION_MODE = 'legacy'; assert.equal(orchestrationMode(), 'legacy');
        } finally { if (previous === undefined) delete process.env.KIRA_ORCHESTRATION_MODE; else process.env.KIRA_ORCHESTRATION_MODE = previous; }
    });

    test('publishes the supported capabilities with unique typed contracts', () => {
        const registry = createKiraToolRegistry();
        for (const name of ['web.search', 'maps.geocode', 'reminders.create', 'tasks.create', 'watchers.create', 'health.export', 'images.generate', 'agents.start', 'settings.update']) assert.ok(registry.get(name), name);
    });

    test('commits reminders exactly once and transports do not save them again', async t => {
        const previousOwner = config.allowedUserId; config.allowedUserId = 101;
        const create = t.mock.method(reminderService, 'createReminder', async (_ctx: unknown, details: any) => ({ ...details, chatId: 101 }));
        try {
            const value = context();
            const registry = createKiraToolRegistry();
            const output = await registry.execute('reminders.create', { text: 'Проверить синтетический отчёт', dueAt: '2099-01-01T10:00:00+03:00' }, value);
            assert.equal(output.status, 'ok'); assert.equal(output.result?.remindersPersisted, true); assert.equal(create.mock.callCount(), 1);
            await saveRemindersFromResult(value.ctx, output.result!);
            assert.equal(create.mock.callCount(), 1);
            assert.equal((await registry.execute('reminders.create', { text: 'Старая задача', dueAt: '2000-01-01T10:00:00Z' }, value)).status, 'failed');
        } finally { config.allowedUserId = previousOwner; }
    });

    test('delegates isolated research and returns its lifecycle without sending messages', async t => {
        const previousOwner = config.allowedUserId; config.allowedUserId = 101;
        t.mock.method(sessionStorage, 'persistAgentRuntime', async () => {});
        const searches = t.mock.method(webSearch, 'performWebSearch', async () => ({ success: true, results: 'Проверенный синтетический источник https://example.test/event' }));
        t.mock.method(chatCompletion, 'createJsonChatCompletionForTask', async () => ({ finish: true }) as any);
        try {
            const value = context(); value.ctx.session.agentRuntime = { version: 1, runId: value.runId, startedAt: Date.now(), updatedAt: Date.now(), status: 'running', receipts: [], agents: [], skills: [], toolNames: [] };
            const result = await createKiraToolRegistry().execute('agents.start', { kind: 'research', task: 'Изучи синтетическое событие' }, value);
            assert.equal(result.status, 'ok'); assert.equal(searches.mock.callCount(), 1);
            assert.equal(value.ctx.session.agentRuntime.agents[0].status, 'completed');
        } finally { config.allowedUserId = previousOwner; }
    });
});
