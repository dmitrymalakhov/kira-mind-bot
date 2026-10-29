'use strict';
// Integration smoke: isolated temporary PostgreSQL database, synthetic metadata only.
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { Pool } = require('../admin-panel/node_modules/pg');
const { ensureProductAnalyticsSchema, startTask, assessTask, recordPreference } = require('../admin-panel/productAnalyticsStore');
const { readSource, summarizeProductAnalytics, parseFilters } = require('../admin-panel/productAnalytics');

async function main() {
  const name = `kira_analytics_test_${randomUUID().replace(/-/g, '')}`;
  const options = { host: process.env.DB_HOST || 'postgres', port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USER || 'postgres', password: process.env.DB_PASSWORD, connectionTimeoutMillis: 5000 };
  const admin = new Pool({ ...options, database: 'postgres' });
  let db;
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    db = new Pool({ ...options, database: name });
    await ensureProductAnalyticsSchema(db);
    await ensureProductAnalyticsSchema(db);
    // pg timestamps have microseconds; a JS Date truncates them. Round the test's as-of
    // boundary up one millisecond so events committed in that millisecond are included.
    const databaseNow = async () => new Date(+(await db.query('SELECT clock_timestamp() AS now')).rows[0].now + 1);
    const now = await databaseNow(), started = +now - 60000;
    const actor = createHash('sha256').update('synthetic analytics owner').digest('hex');
    const id = randomUUID(), second = randomUUID();
    const first = { id, actor, channel: 'telegram', kind: 'interactive', scenario: 'memory', startedAt: started };
    await startTask(db, first); await startTask(db, first);
    await startTask(db, { ...first, id: second, channel: 'api' });
    const [{ count }] = (await db.query('SELECT count(*)::int AS count FROM product_analytics_tasks')).rows;
    assert.equal(count, 2);
    assert.equal(await assessTask(db, id, actor, 'helpful', 'user', randomUUID()), false);
    await db.query("UPDATE product_analytics_tasks SET status='delivered',delivered_at=$1,feedback_offered=true", [new Date(started + 2000)]);
    assert.equal(await assessTask(db, id, '0'.repeat(64), 'trust', 'user', randomUUID()), false);
    const assessment = randomUUID();
    assert.equal(await assessTask(db, id, actor, 'helpful', 'user', assessment), true);
    assert.equal(await assessTask(db, id, actor, 'helpful', 'user', assessment), false);
    await recordPreference(db, actor, 'memoryInsight', false);
    let snapshot = await databaseNow();
    let filters = parseFilters({ days: 30 }, snapshot);
    let source = await readSource(db, 'synthetic', null, filters);
    let metrics = summarizeProductAnalytics([source], filters, snapshot);
    assert.equal(metrics.weeklyValueUsers, 1);
    assert.equal(metrics.success.value, 50);
    assert.equal(metrics.optOutUsers, 1);
    assert.equal(metrics.timing.p90, 2000);
    assert.equal(metrics.activation.value, null);
    await assessTask(db, id, actor, 'trust', 'user', randomUUID());
    await db.query("UPDATE product_analytics_assessments SET created_at=created_at-interval '1 second' WHERE rating='helpful'");
    snapshot = await databaseNow();
    filters = parseFilters({ days: 30 }, snapshot);
    source = await readSource(db, 'synthetic', null, filters);
    metrics = summarizeProductAnalytics([source], filters, snapshot);
    assert.equal(metrics.weeklyValueUsers, 0);
    assert.equal(metrics.trustIncidents, 1);
    // A later positive review must not erase an already reported incident.
    await assessTask(db, id, actor, 'helpful', 'review', randomUUID());
    source = await readSource(db, 'synthetic', null, parseFilters({ days: 30 }, await databaseNow()));
    assert.ok(source.tasks.find(row => row.id === id).trust_reported_at);
    console.log('Product analytics PostgreSQL integration: passed (schema, deduplication, owner scope, current assessments, incidents, aggregation).');
  } finally {
    if (db) await db.end();
    await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
    await admin.end();
  }
}
main().catch(error => { console.error('Product analytics PostgreSQL integration failed:', error.code === 'ERR_ASSERTION' ? error.stack : error.code || error.name); process.exitCode = 1; });
