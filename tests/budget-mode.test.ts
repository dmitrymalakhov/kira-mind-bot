import assert from 'node:assert/strict';
import test from 'node:test';
import { AppDataSource } from '../data-source';
import { getBudgetMode, isMaximumSavingsEnabled, setBudgetMode } from '../services/budgetModeService';
import { BUDGET_MODE_SETTING_KEY, parseBudgetMode, resolveBudgetMode } from '../ai/budgetMode';
import { registerBudgetCommands } from '../handlers/budgetCommands';
import { config } from '../config';
import * as chat from '../ai/chatCompletion';
import { buildDigestGreeting } from '../services/morningDigestScheduler';
import { maybeEvolveKiraSelfFromConversation } from '../services/kiraSelfEvolutionService';
import { processBuffers, queueMessage, setReflectionModeEnabled } from '../services/reflectionModeService';
import { factAnalysisManager } from '../utils/factAnalysisTimer';
import { startRecurringTaskScheduler } from '../services/recurringTaskScheduler';
import { RecurringTaskRepository } from '../services/RecurringTaskRepository';
const telegramAccess = require('../utils/telegramAccess');

test('budget mode is shared, persistent, fail-closed and gates automatic AI', async (t) => {
    t.mock.method(telegramAccess, 'readTelegramUserCredentials', () => ({ apiId: 12345, apiHash: 'synthetic-hash', sessionString: 'synthetic-session' }));
    let stored: string | undefined;
    let reads = 0;
    let writes = 0;
    let failRead = false;
    let failWrite = false;
    let now = Date.now();
    let delayedRead: Promise<{ value: string } | null> | undefined;
    const settings = {
        async findOneBy({ key }: { key: string }) {
            if (key !== BUDGET_MODE_SETTING_KEY) return null;
            reads++;
            if (failRead) throw new Error('synthetic database outage');
            if (delayedRead) return delayedRead;
            return stored == null ? null : { value: stored };
        },
        async upsert(row: { key: string; value: string }) {
            if (row.key !== BUDGET_MODE_SETTING_KEY) return;
            if (failWrite) throw new Error('synthetic write failure');
            stored = row.value;
            writes++;
        },
    };
    const initialized = Object.getOwnPropertyDescriptor(AppDataSource, 'isInitialized')!;
    Object.defineProperty(AppDataSource, 'isInitialized', { configurable: true, value: true });
    t.after(() => Object.defineProperty(AppDataSource, 'isInitialized', initialized));
    t.mock.method(AppDataSource, 'getRepository', () => settings as any);
    t.mock.method(Date, 'now', () => now);
    t.mock.method(console, 'warn', () => undefined);

    await t.test('legacy installs default to normal; invalid values fail closed', async () => {
        assert.equal(await getBudgetMode(true), 'normal');
        assert.equal(parseBudgetMode('__proto__'), null);
        assert.equal(parseBudgetMode({}), null);
        assert.equal(resolveBudgetMode('invalid'), 'maximum');
        assert.equal(resolveBudgetMode(''), 'maximum');
    });

    await t.test('bot writes persist, admin changes appear after 5 seconds', async () => {
        await setBudgetMode('maximum');
        assert.equal(stored, 'maximum');
        assert.equal(await isMaximumSavingsEnabled(), true);
        stored = 'normal'; // запись через админку, без изменения process-cache
        assert.equal(await getBudgetMode(), 'maximum');
        now += 5001;
        assert.equal(await getBudgetMode(), 'normal');
        stored = 'maximum';
        now += 5001;
        const before = reads;
        assert.deepEqual(await Promise.all([getBudgetMode(), getBudgetMode(), getBudgetMode()]), ['maximum', 'maximum', 'maximum']);
        assert.equal(reads - before, 1);
    });

    await t.test('failed writes never report success or change the cache', async () => {
        failWrite = true;
        await assert.rejects(setBudgetMode('normal'), /synthetic write failure/);
        assert.equal(await getBudgetMode(), 'maximum');
        assert.equal(stored, 'maximum');
        failWrite = false;
    });

    await t.test('unavailable database pauses paid background and recovers', async () => {
        await setBudgetMode('normal');
        failRead = true;
        assert.equal(await getBudgetMode(true), 'maximum');
        failRead = false;
        now += 5001;
        assert.equal(await getBudgetMode(), 'normal');
    });

    await t.test('a stale read cannot undo a successful owner change', async () => {
        let finish!: (entry: { value: string }) => void;
        delayedRead = new Promise(resolve => { finish = resolve; });
        const pending = getBudgetMode(true);
        await setBudgetMode('maximum');
        finish({ value: 'normal' });
        assert.equal(await pending, 'maximum');
        assert.equal(await getBudgetMode(), 'maximum');
        delayedRead = undefined;
    });

    await t.test('owner-only bot controls write the same setting; failures stay visible', async () => {
        const commands = new Map<string, Function>();
        let callback!: Function;
        registerBudgetCommands({
            command(names: string[], handler: Function) { for (const name of names) commands.set(name, handler); },
            callbackQuery(_pattern: RegExp, handler: Function) { callback = handler; },
        } as any);
        let reply = '';
        let alert = '';
        const ctx: any = {
            from: { id: config.allowedUserId + 1 }, chat: { id: 111 }, match: 'on',
            reply: async (text: string) => { reply = text; },
            answerCallbackQuery: async ({ text }: { text: string }) => { alert = text; },
            api: { sendRichMessage: async () => ({}), sendMessage: async () => ({}) },
            editMessageText: async () => ({}),
        };
        const before = writes;
        await commands.get('budget')!(ctx);
        assert.match(reply, /только владельцу/);
        ctx.match = ['budget:normal', 'normal'];
        await callback(ctx);
        assert.equal(writes, before);

        ctx.from.id = config.allowedUserId;
        ctx.match = 'off';
        await commands.get('budget')!(ctx);
        assert.equal(stored, 'normal');
        ctx.match = ['budget:maximum', 'maximum'];
        failWrite = true;
        await callback(ctx);
        assert.match(alert, /Не удалось сохранить/);
        assert.equal(stored, 'normal');
        failWrite = false;
        await callback(ctx);
        assert.equal(stored, 'maximum');
    });

    await t.test('maximum mode uses free greeting and skips reflection, self-evolution, facts and scheduled claims', async () => {
        await setBudgetMode('maximum');
        let paidCalls = 0;
        t.mock.method(chat, 'createChatCompletionForTask', async () => {
            paidCalls++;
            throw new Error('paid AI must not run');
        });
        assert.equal(await buildDigestGreeting(0), 'Привет! Сегодня напоминаний нет.');
        assert.equal(await buildDigestGreeting(2), 'Привет! Вот что у тебя сегодня:');
        assert.equal(await maybeEvolveKiraSelfFromConversation({} as any), false);
        await setReflectionModeEnabled(true);
        queueMessage('synthetic-chat', 'Контакт Альфа', 'Важное синтетическое сообщение о переезде в тестовый город', new Date(), false, 1);
        await processBuffers({} as any);

        const timers: Function[] = [];
        t.mock.method(global, 'setInterval', (fn: Function) => { timers.push(fn); return { unref() {} } as any; });
        t.mock.method(global, 'setTimeout', (fn: Function) => { timers.push(fn); return { unref() {} } as any; });
        t.mock.method(global, 'clearTimeout', () => undefined);
        const claims = t.mock.method(RecurringTaskRepository, 'claimDue', async () => []);
        startRecurringTaskScheduler({} as any);
        const ctx: any = { from: { id: 99001 }, session: { messageHistory: [] } };
        factAnalysisManager.scheduleAnalysis(ctx);
        for (const timer of timers) await timer();
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(factAnalysisManager.getPendingAnalysis(99001), undefined);
        assert.equal(claims.mock.callCount(), 0);
        assert.equal(paidCalls, 0);

        await setBudgetMode('normal');
        await timers[0]();
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(claims.mock.callCount(), 1, 'scheduled tasks resume when savings is disabled');
        await buildDigestGreeting(2);
        assert.equal(paidCalls, 1, 'normal mode restores the configured AI greeting route');
    });
});

test('admin budget endpoints validate input, use bot setting key and preserve write errors', async () => {
    const { registerBudgetModeRoutes } = require('../admin-panel/budgetMode');
    const routes = new Map<string, Function>();
    const queries: unknown[][] = [];
    let value: string | undefined;
    let failWrite = false;
    const auth = () => undefined;
    let ended = 0;
    registerBudgetModeRoutes({
        get(path: string, middleware: Function, handler: Function) { assert.equal(middleware, auth); routes.set(`GET ${path}`, handler); },
        post(path: string, middleware: Function, handler: Function) { assert.equal(middleware, auth); routes.set(`POST ${path}`, handler); },
    }, {
        requireAuth: auth,
        ensureBotSettingsTable: async () => undefined,
        createDbPool: () => ({
            query: async (sql: string, args: unknown[]) => {
                queries.push(args);
                if (sql.startsWith('SELECT')) return { rows: value == null ? [] : [{ value }] };
                if (failWrite) throw new Error('synthetic outage');
                value = String(args[1]);
                return { rows: [] };
            },
            end: async () => { ended++; },
        }),
    });
    let status = 200;
    let response: any;
    const res = { status(code: number) { status = code; return res; }, json(body: any) { response = body; } };
    const get = routes.get('GET /api/budget-mode')!;
    const post = routes.get('POST /api/budget-mode')!;
    await get({}, res);
    assert.equal(response.mode, 'normal');
    await post({ body: { mode: '__proto__' } }, res);
    assert.equal(status, 400);
    assert.equal(queries.length, 1);
    await post({ body: { mode: 'maximum' } }, res);
    assert.equal(response.success, true);
    await get({}, res);
    assert.equal(response.mode, 'maximum');
    assert(queries.every(args => args[0] === BUDGET_MODE_SETTING_KEY));
    failWrite = true;
    await post({ body: { mode: 'normal' } }, res);
    assert.equal(status, 500);
    assert.equal(value, 'maximum');
    assert.equal(ended, 4);
});
