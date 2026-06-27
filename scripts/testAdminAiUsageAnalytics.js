const assert = require('assert');
const { buildAiUsageSummary } = require('../admin-panel/aiUsageAnalytics');

function createPoolStub(handler) {
  return {
    async query(sql, values) {
      return handler(sql, values);
    },
  };
}

async function testSummaryAndFilters() {
  const pool = createPoolStub((sql, values) => {
    if (sql.includes('COUNT(*)::int AS calls') && !sql.includes('GROUP BY 1')) {
      assert.strictEqual(values[0], 'openai');
      assert.strictEqual(values[1], 'chat');
      assert.strictEqual(values[2], true);
      assert.strictEqual(values[3], true);
      return {
        rows: [{
          calls: 10,
          successfulCalls: 9,
          failedCalls: 1,
          fallbackCalls: 2,
          callsWithUsage: 8,
          inputTokens: 100,
          outputTokens: 40,
          totalTokens: 140,
          avgLatencyMs: 250,
        }],
      };
    }

    if (sql.includes('date_trunc(\'hour\'')) {
      return {
        rows: [
          {
            bucketStart: '2026-06-27T08:00:00.000Z',
            calls: 4,
            successfulCalls: 4,
            failedCalls: 0,
            fallbackCalls: 1,
            inputTokens: 40,
            outputTokens: 10,
            totalTokens: 50,
          },
          {
            bucketStart: '2026-06-27T09:00:00.000Z',
            calls: 6,
            successfulCalls: 5,
            failedCalls: 1,
            fallbackCalls: 1,
            inputTokens: 60,
            outputTokens: 30,
            totalTokens: 90,
          },
        ],
      };
    }

    if (sql.includes('SELECT\n      provider AS key')) {
      return { rows: Array.from({ length: 11 }, (_, index) => ({
        key: `provider-${index + 1}`,
        calls: 11 - index,
        successfulCalls: 11 - index,
        failedCalls: 0,
        fallbackCalls: index === 0 ? 1 : 0,
        inputTokens: 10 * (11 - index),
        outputTokens: 5 * (11 - index),
        totalTokens: 15 * (11 - index),
        avgLatencyMs: 100 + index,
      })) };
    }

    if (sql.includes('LIMIT 5') && sql.includes('SELECT\n      model AS key')) {
      if (sql.includes('ORDER BY COUNT(*) DESC')) {
        return { rows: [
          { key: 'gpt-5.4-lite', calls: 9, successfulCalls: 9, failedCalls: 0, fallbackCalls: 0, inputTokens: 18, outputTokens: 9, totalTokens: 27, avgLatencyMs: 110 },
          { key: 'gpt-5.4-mini', calls: 5, successfulCalls: 4, failedCalls: 1, fallbackCalls: 1, inputTokens: 70, outputTokens: 20, totalTokens: 90, avgLatencyMs: 210 },
        ] };
      }
      return { rows: [
        { key: 'gpt-5.4-mini', calls: 5, successfulCalls: 4, failedCalls: 1, fallbackCalls: 1, inputTokens: 70, outputTokens: 20, totalTokens: 90, avgLatencyMs: 210 },
        { key: 'gpt-5.4-nano', calls: 3, successfulCalls: 3, failedCalls: 0, fallbackCalls: 0, inputTokens: 20, outputTokens: 10, totalTokens: 30, avgLatencyMs: 140 },
      ] };
    }

    if (sql.includes('LIMIT 5') && sql.includes('SELECT\n      "taskKey" AS key')) {
      if (sql.includes('ORDER BY COUNT(*) DESC')) {
        return { rows: [
          { key: 'conversation', calls: 6, successfulCalls: 5, failedCalls: 1, fallbackCalls: 1, inputTokens: 80, outputTokens: 25, totalTokens: 105, avgLatencyMs: 220 },
          { key: 'heartbeat', calls: 5, successfulCalls: 5, failedCalls: 0, fallbackCalls: 0, inputTokens: 5, outputTokens: 5, totalTokens: 10, avgLatencyMs: 80 },
        ] };
      }
      return { rows: [
        { key: 'conversation', calls: 6, successfulCalls: 5, failedCalls: 1, fallbackCalls: 1, inputTokens: 80, outputTokens: 25, totalTokens: 105, avgLatencyMs: 220 },
        { key: 'intentClassification', calls: 4, successfulCalls: 4, failedCalls: 0, fallbackCalls: 1, inputTokens: 20, outputTokens: 15, totalTokens: 35, avgLatencyMs: 170 },
      ] };
    }

    if (sql.includes('SELECT\n      model AS key')) {
      return { rows: [
        { key: 'gpt-5.4-mini', calls: 5, successfulCalls: 4, failedCalls: 1, fallbackCalls: 1, inputTokens: 70, outputTokens: 20, totalTokens: 90, avgLatencyMs: 210 },
        { key: 'gpt-5.4-nano', calls: 3, successfulCalls: 3, failedCalls: 0, fallbackCalls: 0, inputTokens: 20, outputTokens: 10, totalTokens: 30, avgLatencyMs: 140 },
      ] };
    }

    if (sql.includes('SELECT\n      "taskKey" AS key')) {
      return { rows: [
        { key: 'conversation', calls: 6, successfulCalls: 5, failedCalls: 1, fallbackCalls: 1, inputTokens: 80, outputTokens: 25, totalTokens: 105, avgLatencyMs: 220 },
        { key: 'intentClassification', calls: 4, successfulCalls: 4, failedCalls: 0, fallbackCalls: 1, inputTokens: 20, outputTokens: 15, totalTokens: 35, avgLatencyMs: 170 },
      ] };
    }

    if (sql.includes('SELECT\n      preset AS key')) {
      return { rows: [{ key: 'gpt-balanced', calls: 10, successfulCalls: 9, failedCalls: 1, fallbackCalls: 2, inputTokens: 100, outputTokens: 40, totalTokens: 140, avgLatencyMs: 250 }] };
    }

    if (sql.includes('SELECT\n      COALESCE(operation, \'unknown\') AS key')) {
      return { rows: [{ key: 'chat', calls: 10, successfulCalls: 9, failedCalls: 1, fallbackCalls: 2, inputTokens: 100, outputTokens: 40, totalTokens: 140, avgLatencyMs: 250 }] };
    }

    if (sql.includes('success = false')) {
      return { rows: [{ createdAt: '2026-06-27T09:10:00.000Z', provider: 'openai', model: 'gpt-5.4-mini', taskKey: 'conversation', preset: 'gpt-balanced', operation: 'chat', fallbackUsed: true, errorMessage: 'Rate limit' }] };
    }

    throw new Error(`Unexpected SQL: ${sql}`);
  });

  const summary = await buildAiUsageSummary({
    pool,
    query: {
      days: '1',
      provider: 'openai',
      operation: 'chat',
      success: true,
      fallbackUsed: true,
    },
    now: new Date('2026-06-27T10:00:00.000Z'),
  });

  assert.strictEqual(summary.timeseries.bucket, 'hour');
  assert.strictEqual(summary.totals.calls, 10);
  assert.strictEqual(summary.coverage.callsWithUsage, 8);
  assert.strictEqual(summary.coverage.callsWithoutUsage, 2);
  assert.strictEqual(summary.totals.errorRate, 0.1);
  assert.strictEqual(summary.totals.fallbackRate, 0.2);
  assert.strictEqual(summary.breakdowns.providers.length, 11);
  assert.strictEqual(summary.breakdowns.providers.at(-1).key, 'other');
  assert.strictEqual(summary.recentFailures.length, 1);
  assert.strictEqual(summary.leaders.modelsByTokens[0].key, 'gpt-5.4-mini');
  assert.strictEqual(summary.leaders.modelsByCalls[0].key, 'gpt-5.4-lite');
  assert.strictEqual(summary.leaders.tasksByCalls[1].key, 'heartbeat');
}

async function testDailyBucketsAndEmptyResults() {
  const pool = createPoolStub((sql) => {
    if (sql.includes('success = false')) {
      return { rows: [] };
    }
    if (sql.includes('date_trunc(\'day\'')) {
      return { rows: [] };
    }
    if (sql.includes('COUNT(*)::int AS calls') && !sql.includes('GROUP BY 1')) {
      return { rows: [{}] };
    }
    return { rows: [] };
  });

  const summary = await buildAiUsageSummary({
    pool,
    query: { days: '30' },
    now: new Date('2026-06-27T10:00:00.000Z'),
  });

  assert.strictEqual(summary.timeseries.bucket, 'day');
  assert.strictEqual(summary.totals.calls, 0);
  assert.strictEqual(summary.coverage.usageCoverageRate, 0);
  assert.deepStrictEqual(summary.recentFailures, []);
}

async function main() {
  await testSummaryAndFilters();
  await testDailyBucketsAndEmptyResults();
  console.log('testAdminAiUsageAnalytics: ok');
}

main().catch((error) => {
  console.error('testAdminAiUsageAnalytics: failed');
  console.error(error);
  process.exit(1);
});
