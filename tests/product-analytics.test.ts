import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { Api, Bot, Context } from 'grammy';
import { AppDataSource } from '../data-source';
import { config } from '../config';
import type { BotContext } from '../types';
import { analyticsActor, continueAnalyticsTask, observeClassification, productAnalyticsMiddleware,
    recordDeferredOutcome, recordResultDelivery } from '../services/productAnalytics';
import { sendResultToUser, canSendResultAsVoice } from '../handlers/shared';
import { provisionTenantAnalytics } from '../platform/analytics';
const { summarizeProductAnalytics, parseFilters, validateTargets, registerProductAnalyticsRoutes } = require('../admin-panel/productAnalytics');
const { startTask, assessTask } = require('../admin-panel/productAnalyticsStore');
const DAY = 86400000;
const now = new Date('2026-08-30T12:00:00Z');
const iso = (days: number) => new Date(+now + days * DAY).toISOString();
function task(actor: string, days: number, rating?: string, extra: any = {}) {
    return { id: randomUUID(), actor, channel: 'telegram', kind: 'interactive', scenario: 'conversation',
        started_at: iso(days), delivered_at: iso(days + .001), status: 'delivered',
        ratings: rating ? [{ source: 'user', rating }] : [], ...extra };
}
function source(tasks: any[], users: any[] = []) { return { id: 'synthetic', startedAt: iso(-100), tasks, users }; }
const summary = (sources: any[], query: any = {}) => summarizeProductAnalytics(sources, parseFilters(query, now), now);

test('value users are deduplicated across channels; delivery, technical success and continuations do not imply value', () => {
    const result = summary([source([
        task('a', -1, 'helpful'), task('a', -2, 'helpful', { channel: 'api' }),
        task('b', -1, undefined, { technical_ok: true }), task('c', -1, 'helpful', { kind: 'continuation' }),
        task('d', -1, 'helpful', { kind: 'proactive' }), task('e', -1, undefined, { status: 'failed', delivered_at: null }),
    ])]);
    assert.equal(result.weeklyValueUsers, 2);
    assert.deepEqual(result.success, { value: 50, numerator: 2, denominator: 4 });
    assert.equal(result.totals.failed, 1);
    assert.equal(result.proactive.value, 100);
    assert.equal(result.coverage.denominator, 3);
    assert.equal(result.activation.value, null, 'unknown signup time is not presented as new-user activation');
});

test('an explicit negative assessment overrides a positive one and memory quality requires a specific assessment', () => {
    const rows = [task('a', -1, 'helpful', { ratings: [{ source: 'user', rating: 'unhelpful' }, { source: 'review', rating: 'helpful' }] }),
        task('b', -1, 'memory_wrong', { scenario: 'memory' }), task('c', -1, 'memory_correct', { scenario: 'memory' }),
        task('d', -1, 'corrected'), task('e', -1, 'trust'), task('f', -1, undefined, { scenario: 'memory' })];
    const result = summary([source(rows)]);
    assert.equal(result.weeklyValueUsers, 1);
    assert.deepEqual(result.memory, { value: 50, numerator: 1, denominator: 2 });
    assert.equal(result.trustIncidents, 1);
    assert.equal(result.correction.numerator, 1);
    assert.equal(result.csat.denominator, 5);
});

test('activation and W4 use mature registration cohorts including people who never started a task', () => {
    const users = [
        { actor: 'active', registered_at: iso(-40), first_value: iso(-39.5) },
        { actor: 'dormant', registered_at: iso(-40), first_value: null },
        { actor: 'late', registered_at: iso(-29), first_value: iso(-27) },
        { actor: 'new', registered_at: iso(-.5), first_value: null },
        { actor: 'pretracking', registered_at: iso(-101), first_value: iso(-100.5) },
    ];
    const rows = [task('active', -19, 'helpful'), task('active', -12, 'helpful'), task('late', -1, 'helpful')];
    const result = summary([source(rows, users)]);
    assert.deepEqual(result.retentionW4, { value: 100 / 3, numerator: 1, denominator: 3 });
    assert.equal(result.pendingRetention, 1);
    assert.equal(result.activation.denominator, 1);
    assert.equal(result.activation.numerator, 0);
    assert.equal(result.pendingActivation, 1);
    const local = summary([source(rows, [{ actor: 'active', first_seen: iso(-40), first_value: iso(-39) }])]);
    assert.equal(local.retentionW4.value, null);
});

test('W4 counts the 22nd day inclusively and excludes the 29th day; filters keep registration denominators stable', () => {
    const users = ['a', 'b'].map(actor => ({ actor, registered_at: iso(-40), first_value: iso(-39.5) }));
    const rows = [task('a', -19, 'helpful', { delivered_at: iso(-19), scenario: 'memory' }),
        task('b', -12, 'helpful', { delivered_at: iso(-12), channel: 'api' })];
    assert.equal(summary([source(rows, users)]).retentionW4.numerator, 1);
    const filtered = summary([source(rows, users)], { channel: 'api' });
    assert.equal(filtered.retentionW4.denominator, 2);
    assert.equal(filtered.retentionW4.numerator, 0);
});

test('time to result uses the completed delivery, while first-value latency keeps non-activated users visible', () => {
    const rows = [task('a', -1, 'helpful', { delivered_at: new Date(+new Date(iso(-1)) + 1000).toISOString() }),
        task('b', -1, undefined, { delivered_at: new Date(+new Date(iso(-1)) + 10000).toISOString() })];
    const result = summary([source(rows, [{ actor: 'a', registered_at: iso(-2), first_value: iso(-1) },
        { actor: 'b', registered_at: iso(-2), first_value: null }])]);
    assert.equal(result.timing.p50, 1000); assert.equal(result.timing.p90, 10000);
    assert.equal(result.timing.withoutFirstValue, 1); assert.equal(result.timing.firstValueP50, DAY);
    assert.equal(summary([{ ...source(rows), truncated: true }]).complete, false);
});

test('filters and targets reject invalid values instead of silently changing the metric contract', () => {
    assert.throws(() => parseFilters({ days: 'all' }), /Период/);
    assert.throws(() => parseFilters({ channel: 'external' }), /канал/);
    assert.throws(() => parseFilters({ scenario: ['memory'] }), /сценарий/);
    for (const value of [{ activation: 101 }, { weeklyValueUsers: 1.5 }, { success: '90' }, { arbitrary: 1 }, []]) assert.throws(() => validateTargets(value));
    assert.equal(validateTargets({ activation: 75 }).activation, 75);
    assert.equal(validateTargets({}).success, null);
});

function fakeDatabase(t: any) {
    const tasks = new Map<string, any>(); const assessments = new Map<string, any>(); const queries: string[] = [];
    const initial = AppDataSource.isInitialized;
    (AppDataSource as any).isInitialized = true;
    t.after(() => { (AppDataSource as any).isInitialized = initial; });
    t.mock.method(AppDataSource, 'query', async (sql: string, values: any[] = []) => {
        queries.push(sql);
        if (sql.startsWith('INSERT INTO product_analytics_tasks')) {
            if (!tasks.has(values[0])) tasks.set(values[0], { id: values[0], actor: values[1], channel: values[2], kind: values[3], scenario: values[4], started_at: values[5], status: 'running', delivered_at: null });
            return [];
        }
        if (sql.startsWith('SELECT * FROM product_analytics_tasks')) return [...tasks.values()].filter(row => row.id === values[0] && row.actor === values[1]);
        if (sql.includes("SET kind='continuation'")) { Object.assign(tasks.get(values[0]), { kind: 'continuation', parent_id: values[1] }); return []; }
        if (sql.includes('UPDATE product_analytics_tasks SET\n        status=')) {
            const row = tasks.get(values[0]); if (row?.actor !== values[6]) return [];
            if (values[1]) row.status = values[1];
            if (values[2] !== null) row.technical_ok = values[2];
            if (values[3]) row.delivered_at ||= new Date();
            row.feedback_offered ||= values[4]; if (values[5]) row.scenario = values[5]; return [];
        }
        if (sql.startsWith('UPDATE product_analytics_tasks SET status=$3')) {
            const row = tasks.get(values[0]); if (row?.actor === values[1] && !row.delivered_at) { row.status = values[2]; if (values[2] === 'delivered') row.delivered_at = new Date(); } return [];
        }
        if (sql.startsWith('INSERT INTO product_analytics_assessments')) {
            const row = tasks.get(values[3]);
            if (!row || row.actor !== values[4] || !row.delivered_at || assessments.has(values[0])) return [];
            assessments.set(values[0], { task: row.id, source: values[1], rating: values[2] }); return [{ id: values[0] }];
        }
        throw new Error(`Unexpected synthetic SQL: ${sql.slice(0, 60)}`);
    });
    return { tasks, assessments, queries };
}
function harness(t: any) {
    const db = fakeDatabase(t);
    const previousOwner = config.allowedUserId; (config as any).allowedUserId = 990001;
    t.after(() => { (config as any).allowedUserId = previousOwner; });
    const botInfo = { id: 990002, is_bot: true as const, first_name: 'Synthetic', username: 'synthetic_bot', can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false,
        has_topics_enabled: false, allows_users_to_create_topics: false, can_manage_bots: false, supports_join_request_queries: false };
    const bot = new Bot<BotContext>('1234567890:abcdefghijklmnopqrstuvwxyzABCDE', { botInfo });
    const sent: any[] = [];
    bot.api.config.use(async (_prev, method, payload) => {
        sent.push({ method, payload });
        return { ok: true, result: method === 'answerCallbackQuery' ? true : { message_id: 10 + sent.length, chat: { id: 990001, type: 'private' }, date: 1, text: 'synthetic' } } as any;
    });
    bot.use(productAnalyticsMiddleware());
    function context(updateId: number, callback?: string, owner = 990001) {
        const from = { id: owner, is_bot: false, first_name: 'Synthetic' };
        const chat = { id: owner, type: 'private' as const, first_name: 'Synthetic' };
        const update: any = callback ? { update_id: updateId, callback_query: { id: `synthetic-${updateId}`, from, chat_instance: 'synthetic', data: callback,
            message: { message_id: 10, date: 1, chat, from: botInfo, text: 'synthetic' } } } : { update_id: updateId, message: { message_id: updateId, date: 1, from, chat, text: 'Синтетический запрос' } };
        const ctx = new Context(update, bot.api, botInfo) as BotContext;
        ctx.session = { isAllowedUser: owner === 990001, reminders: [], messageHistory: [], dialogueSummary: '', lastSummarizedIndex: -1, domains: {}, sentMessages: {} };
        return ctx;
    }
    return { ...db, bot, sent, context, dispatch: (ctx: BotContext) => bot.middleware()(ctx, async () => {}) };
}

test('Telegram result -> persisted delivery -> authenticated feedback; duplicate updates and feedback clicks stay idempotent', async t => {
    const h = harness(t);
    h.bot.on('message:text', async ctx => {
        await observeClassification(ctx, { intent: 'РАЗГОВОР', confidenceLevel: 'ВЫСОКИЙ', details: { memoryTask: 'lookup' } });
        await sendResultToUser(ctx, { responseText: 'Синтетический ответ' });
    });
    await h.dispatch(h.context(1)); await h.dispatch(h.context(1));
    assert.equal(h.tasks.size, 1);
    const row = [...h.tasks.values()][0];
    assert.equal(row.scenario, 'memory'); assert.equal(row.status, 'delivered'); assert.ok(row.delivered_at);
    assert.match(h.sent[0].payload.reply_markup.inline_keyboard[0][0].callback_data, /^pa:helpful:/);
    await h.dispatch(h.context(2, `pa:helpful:${row.id}`)); await h.dispatch(h.context(2, `pa:helpful:${row.id}`));
    assert.equal(h.assessments.size, 1); assert.equal(h.tasks.size, 1);
    await h.dispatch(h.context(3, `pa:trust:${row.id}`, 990003));
    assert.equal(h.assessments.size, 1, 'another person cannot rate the owner result');
    const assessment = [...h.assessments.values()][0]; assert.equal(assessment.rating, 'helpful');
    assert.ok(h.queries.every(sql => !sql.includes('Синтетический')), 'analytics never receives conversation contents');
});

test('clarifications do not count as delivered results and their continuation keeps the original task and clock', async t => {
    const h = harness(t); let parentId = '';
    h.bot.on('message:text', async ctx => {
        if (!parentId) {
            parentId = ctx.productAnalytics!.id;
            await sendResultToUser(ctx, { responseText: 'Уточнение', operationStatus: 'needs_input' });
        } else {
            await continueAnalyticsTask(ctx, parentId);
            await sendResultToUser(ctx, { responseText: 'Готовый результат', operationStatus: 'ok' });
        }
    });
    await h.dispatch(h.context(10));
    assert.equal(h.tasks.get(parentId).delivered_at, null);
    assert.equal(h.sent[0].payload.reply_markup, undefined);
    await h.dispatch(h.context(11));
    assert.equal([...h.tasks.values()].filter(row => row.kind === 'interactive').length, 1);
    assert.equal(h.tasks.get(parentId).status, 'delivered');
    assert.equal([...h.tasks.values()].filter(row => row.kind === 'continuation').length, 1);
});

test('deferred acknowledgement is not a final result; completed delivery and failed transport are recorded separately', async t => {
    const h = harness(t);
    h.bot.on('message:text', async ctx => { await sendResultToUser(ctx, { responseText: 'Проверю источники', dialogueJobId: 'synthetic-job', awaitingDeferredResult: true }); });
    await h.dispatch(h.context(20));
    const row = [...h.tasks.values()][0]; assert.equal(row.delivered_at, null); assert.equal(row.status, 'waiting');
    await recordDeferredOutcome(row.id, 990001, 'delivered'); assert.ok(row.delivered_at);
    const context = h.context(21); context.productAnalytics = { id: randomUUID(), actor: analyticsActor(), channel: 'telegram', kind: 'interactive', scenario: 'other', startedAt: Date.now(), persisted: true };
    await startTask(AppDataSource, context.productAnalytics);
    await assert.rejects(recordResultDelivery(context, { responseText: 'synthetic' }, async () => { throw new Error('synthetic delivery failed'); }));
    assert.equal(h.tasks.get(context.productAnalytics.id).status, 'failed');
    assert.equal(h.tasks.get(context.productAnalytics.id).delivered_at, null);
});

test('storage outages leave user delivery working without unusable feedback buttons', async t => {
    const h = harness(t);
    t.mock.method(AppDataSource, 'query', async () => { throw new Error('synthetic unavailable storage'); });
    h.bot.on('message:text', async ctx => { await sendResultToUser(ctx, { responseText: 'synthetic' }); });
    await h.dispatch(h.context(30));
    assert.equal(h.sent.filter(row => row.method === 'sendMessage').length, 1);
    assert.equal(h.sent[0].payload.reply_markup, undefined);
});

test('analytics does not replace a requested voice response with text by adding a keyboard', async t => {
    const h = harness(t); const ctx = h.context(31);
    const id = randomUUID();
    ctx.productAnalytics = { id, actor: analyticsActor(), channel: 'telegram', kind: 'interactive', scenario: 'conversation', startedAt: Date.now(), persisted: true };
    await startTask(AppDataSource, ctx.productAnalytics);
    const result = { responseText: 'Синтетический голосовой ответ' };
    await recordResultDelivery(ctx, result, async () => {
        assert.equal(canSendResultAsVoice(result), true);
        return { message_id: 31 };
    }, { feedback: false });
    assert.equal(h.tasks.get(id).feedback_offered, false);
});

test('assessment writes require a delivered task owned by the authenticated user', async t => {
    const h = harness(t); const id = randomUUID();
    await startTask(AppDataSource, { id, actor: analyticsActor(), channel: 'api', kind: 'interactive', scenario: 'action', startedAt: Date.now() });
    assert.equal(await assessTask(AppDataSource, id, analyticsActor(), 'helpful', 'user', randomUUID()), false);
    h.tasks.get(id).delivered_at = new Date();
    assert.equal(await assessTask(AppDataSource, id, analyticsActor(990003), 'helpful', 'user', randomUUID()), false);
    assert.equal(await assessTask(AppDataSource, id, analyticsActor(), 'helpful', 'user', randomUUID()), true);
});

test('operator migration grants access only to the generated tenant role and never enables full schema synchronization', async () => {
    const sql: string[] = []; let closed = false;
    const id = '00000000-0000-4000-8000-000000000001';
    const admin = { options: { type: 'postgres', database: 'SyntheticPlatform' }, query: async (query: string) => { sql.push(query); } } as any;
    await provisionTenantAnalytics(admin, id, 'SyntheticImported', true, async options => {
        assert.equal(options.synchronize, false); assert.equal(options.database, 'SyntheticImported');
        return { query: async (query: string) => { sql.push(query); }, destroy: async () => { closed = true; } } as any;
    });
    assert.equal(closed, true); assert.ok(sql.some(query => query.includes('GRANT SELECT,INSERT,UPDATE') && query.includes('kira_u_00000000000040008000000000000001')));
    assert.ok(sql.every(query => !/GRANT.*PUBLIC|DROP TABLE/.test(query)));
    await assert.rejects(provisionTenantAnalytics(admin, id, 'invalid;DROP', false));
});

test('all analytics routes require admin authentication; target and review validation cannot select arbitrary sources', async () => {
    const handlers = new Map<string, Function>(); const auth = () => {}; let writes = 0;
    const app = Object.fromEntries(['get', 'put', 'post'].map(method => [method, (path: string, guard: Function, handler: Function) => {
        assert.equal(guard, auth); handlers.set(`${method}:${path}`, handler);
    }]));
    registerProductAnalyticsRoutes(app, { requireAuth: auth, createDbPool: () => ({ query: async () => { writes++; return { rows: [] }; }, end: async () => {} }),
        ensureBotSettingsTable: async () => {}, analyticsSources: async () => [] });
    let status = 200; const response: any = { status: (code: number) => { status = code; return response; }, json: () => {} };
    await handlers.get('put:/api/product-analytics/targets')!({ body: { retentionW4: 101 } }, response);
    assert.equal(status, 400); assert.equal(writes, 0);
    await handlers.get('post:/api/product-analytics/review')!({ body: { id: randomUUID(), source: 'arbitrary_database', rating: 'helpful' } }, response);
    assert.equal(status, 400); assert.equal(writes, 0);
});
