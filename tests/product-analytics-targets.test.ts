import assert from 'node:assert/strict';
import { test } from 'node:test';
const { STARTER_TARGETS, buildTargetComparisons } = require('../admin-panel/productAnalyticsTargets');
const { registerProductAnalyticsRoutes } = require('../admin-panel/productAnalytics');

function snapshot(overrides: any = {}) {
    return { complete: true, startedAt: '2026-08-01T00:00:00.000Z', generatedAt: '2026-08-30T12:00:00.000Z',
        filters: { channel: '', scenario: '' }, weeklyValueUsers: 8, weeklyAssessment: { delivered: 100, assessed: 80 },
        activation: { value: 55, numerator: 11, denominator: 20 },
        retentionW4: { value: 40, numerator: 8, denominator: 20 },
        success: { value: 70, numerator: 70, denominator: 100 }, totals: { tasks: 100, assessed: 80 }, ...overrides };
}

test('pilot goals have explicit values and deviations use users or percentage points', () => {
    assert.deepEqual(STARTER_TARGETS, { weeklyValueUsers: 10, activation: 60, retentionW4: 30, success: 70 });
    const result = buildTargetComparisons(snapshot(), STARTER_TARGETS);
    assert.equal(result.weeklyValueUsers.delta, -2); assert.equal(result.weeklyValueUsers.attainment, 80);
    assert.equal(result.weeklyValueUsers.unit, 'users'); assert.equal(result.weeklyValueUsers.status, 'below');
    assert.equal(result.activation.delta, -5); assert.equal(result.activation.unit, 'percentage_points');
    assert.ok(Math.abs(result.activation.attainment - 100 * 55 / 60) < 1e-9);
    assert.equal(result.retentionW4.delta, 10); assert.equal(result.retentionW4.status, 'met');
    assert.equal(result.success.delta, 0); assert.equal(result.success.attainment, 100); assert.equal(result.success.status, 'met');
});

test('custom goals, exceeding goals and zero targets never produce infinity or NaN', () => {
    const result = buildTargetComparisons(snapshot({ weeklyValueUsers: 15 }), { weeklyValueUsers: 10, activation: 0, retentionW4: null, success: 85 });
    assert.equal(result.weeklyValueUsers.delta, 5); assert.equal(result.weeklyValueUsers.attainment, 150);
    assert.equal(result.weeklyValueUsers.status, 'met');
    assert.equal(result.activation.delta, 55); assert.equal(result.activation.attainment, null);
    assert.equal(result.retentionW4.status, 'unset'); assert.equal(result.retentionW4.delta, null);
    assert.equal(result.success.delta, -15); assert.equal(result.success.status, 'below');
    const zero = buildTargetComparisons(snapshot({ success: { value: 0, numerator: 0, denominator: 100 } }), { success: 0 });
    assert.equal(zero.success.delta, 0); assert.equal(zero.success.attainment, null); assert.equal(zero.success.status, 'met');
});

test('missing, incomplete and filtered metrics are not presented as failure against global goals', () => {
    const empty = buildTargetComparisons(snapshot({ activation: { value: null, numerator: 0, denominator: 0 } }), STARTER_TARGETS);
    assert.equal(empty.activation.status, 'no_data'); assert.equal(empty.activation.delta, null); assert.equal(empty.activation.attainment, null);
    for (const overrides of [{ complete: false }, { filters: { channel: 'api', scenario: '' } }, { filters: { channel: '', scenario: 'memory' } }]) {
        const comparisons = buildTargetComparisons(snapshot(overrides), STARTER_TARGETS);
        for (const value of Object.values(comparisons) as any[]) {
            assert.ok(['incomplete', 'filtered'].includes(value.status));
            assert.equal(value.delta, null); assert.equal(value.attainment, null);
        }
    }
});

test('small samples show provisional deltas and success requires sufficient explicit feedback', () => {
    const tiny = buildTargetComparisons(snapshot({ activation: { value: 100, numerator: 1, denominator: 1 } }), STARTER_TARGETS);
    assert.equal(tiny.activation.status, 'collecting'); assert.equal(tiny.activation.delta, 40);
    assert.equal(tiny.activation.sample, 1); assert.equal(tiny.activation.minimumSample, 20);
    for (const totals of [{ tasks: 100, assessed: 0 }, { tasks: 100, assessed: 79 }]) {
        const result = buildTargetComparisons(snapshot({ totals }), STARTER_TARGETS);
        assert.equal(result.success.status, 'collecting'); assert.equal(result.success.delta, 0);
    }
    const under20 = buildTargetComparisons(snapshot({ success: { value: 80, denominator: 23 }, totals: { assessed: 19 } }), STARTER_TARGETS);
    assert.equal(under20.success.status, 'collecting');
});

test('weekly goals distinguish an incomplete week, absent feedback and reaching the target early', () => {
    const early = snapshot({ startedAt: '2026-08-29T00:00:00.000Z' });
    assert.equal(buildTargetComparisons(early, STARTER_TARGETS).weeklyValueUsers.status, 'collecting');
    assert.equal(buildTargetComparisons({ ...early, weeklyValueUsers: 10 }, STARTER_TARGETS).weeklyValueUsers.status, 'met');
    const unrated = snapshot({ weeklyValueUsers: 0, weeklyAssessment: { delivered: 50, assessed: 0 } });
    assert.equal(buildTargetComparisons(unrated, STARTER_TARGETS).weeklyValueUsers.status, 'collecting');
    const inactive = snapshot({ weeklyValueUsers: 0, weeklyAssessment: { delivered: 0, assessed: 0 } });
    assert.equal(buildTargetComparisons(inactive, STARTER_TARGETS).weeklyValueUsers.status, 'below');
});

test('saved targets survive reload, cleared targets stay unset, and reading never silently applies starter goals', async () => {
    const routes = new Map<string, Function>(); const auth = () => {}; let saved: string | undefined; let writes = 0; let body: any;
    const app = Object.fromEntries(['get', 'put', 'post'].map(method => [method, (path: string, guard: Function, handler: Function) => {
        assert.equal(guard, auth); routes.set(`${method}:${path}`, handler);
    }]));
    registerProductAnalyticsRoutes(app, { requireAuth: auth, ensureBotSettingsTable: async () => {}, analyticsSources: async () => [],
        createDbPool: () => ({ end: async () => {}, query: async (sql: string, args: any[]) => {
            if (sql.includes('clock_timestamp')) return { rows: [{ now: new Date('2026-08-30T12:00:00.000Z') }] };
            if (sql.startsWith('SELECT value')) return { rows: saved ? [{ value: saved }] : [] };
            assert.ok(sql.includes('INSERT INTO bot_settings')); saved = args[1]; writes++; return { rows: [] };
        } }) });
    const response: any = { status: (status: number) => { throw new Error(`Unexpected status ${status}`); }, json: (value: any) => { body = value; } };
    const get = () => routes.get('get:/api/product-analytics')!({ query: {} }, response);
    await get();
    assert.deepEqual(body.starterTargets, STARTER_TARGETS); assert.equal(body.targets.activation, null);
    assert.equal(body.targetComparisons.activation.status, 'unset'); assert.equal(writes, 0);
    await routes.get('put:/api/product-analytics/targets')!({ body: STARTER_TARGETS }, response);
    await get(); assert.deepEqual(body.targets, STARTER_TARGETS); assert.equal(writes, 1);
    await routes.get('put:/api/product-analytics/targets')!({ body: { ...STARTER_TARGETS, success: null, activation: 65 } }, response);
    await get(); assert.equal(body.targets.activation, 65); assert.equal(body.targets.success, null);
    assert.equal(body.targetComparisons.success.status, 'unset'); assert.equal(writes, 2);
});
