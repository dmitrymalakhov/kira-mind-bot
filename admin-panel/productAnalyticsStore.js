'use strict';

// Shared by the runtime and the operator's admin backend. No prompts, names or answers.
const SCENARIOS = ['conversation', 'memory', 'reminder', 'search', 'action', 'other'];
const KINDS = ['interactive', 'continuation', 'proactive', 'reminder_delivery', 'recurring'];
const STATUSES = ['running', 'waiting', 'delivered', 'failed', 'unknown', 'cancelled'];
const FEEDBACK = ['helpful', 'unhelpful', 'corrected', 'memory_correct', 'memory_wrong', 'trust'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function ensureProductAnalyticsSchema(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS product_analytics_tasks (
    id uuid PRIMARY KEY, actor text NOT NULL, channel text NOT NULL,
    kind text NOT NULL, scenario text NOT NULL DEFAULT 'other',
    started_at timestamptz NOT NULL DEFAULT now(), delivered_at timestamptz,
    status text NOT NULL DEFAULT 'running', parent_id uuid,
    technical_ok boolean, feedback_offered boolean NOT NULL DEFAULT false
  )`);
  await db.query('CREATE INDEX IF NOT EXISTS product_tasks_started ON product_analytics_tasks (started_at)');
  await db.query('CREATE INDEX IF NOT EXISTS product_tasks_actor ON product_analytics_tasks (actor, started_at)');
  await db.query(`CREATE TABLE IF NOT EXISTS product_analytics_assessments (
    id uuid PRIMARY KEY, task_id uuid NOT NULL REFERENCES product_analytics_tasks(id),
    source text NOT NULL, rating text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
  )`);
  await db.query('CREATE INDEX IF NOT EXISTS product_assessments_task ON product_analytics_assessments (task_id, source, created_at DESC)');
  await db.query(`CREATE TABLE IF NOT EXISTS product_analytics_meta (
    id int PRIMARY KEY CHECK (id=1), started_at timestamptz NOT NULL DEFAULT now()
  )`);
  await db.query('INSERT INTO product_analytics_meta(id) VALUES(1) ON CONFLICT DO NOTHING');
  await db.query(`CREATE TABLE IF NOT EXISTS product_analytics_preferences (
    id uuid PRIMARY KEY, actor text NOT NULL, feature text NOT NULL, enabled boolean NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
  await db.query('CREATE INDEX IF NOT EXISTS product_preferences_created ON product_analytics_preferences(created_at)');
}

async function recordPreference(db, actor, feature, enabled) {
  if (!/^[a-f0-9]{64}$/.test(actor) || !['kiraLife', 'memoryInsight', 'daytimeReflection', 'inboxGuardian', 'dmReport', 'morningDigest'].includes(feature) || typeof enabled !== 'boolean') return;
  await db.query('INSERT INTO product_analytics_preferences(id,actor,feature,enabled) VALUES($1,$2,$3,$4)',
    [require('crypto').randomUUID(), actor, feature, enabled]);
}

async function startTask(db, task) {
  if (!UUID.test(task.id) || !/^[a-f0-9]{64}$/.test(task.actor) || !KINDS.includes(task.kind) ||
      !SCENARIOS.includes(task.scenario) || !['telegram', 'api'].includes(task.channel)) throw new Error('Invalid analytics task');
  await db.query(`INSERT INTO product_analytics_tasks(id,actor,channel,kind,scenario,started_at)
    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
  [task.id, task.actor, task.channel, task.kind, task.scenario, new Date(task.startedAt)]);
}

async function assessTask(db, id, actor, rating, source, assessmentId) {
  if (!UUID.test(id) || !UUID.test(assessmentId) || !FEEDBACK.includes(rating) || !['user', 'review'].includes(source)) throw new Error('Invalid analytics assessment');
  // Scope is supplied by the authenticated server, never by Telegram callback data.
  const result = await db.query(`INSERT INTO product_analytics_assessments(id,task_id,source,rating)
    SELECT $1,id,$2,$3 FROM product_analytics_tasks WHERE id=$4 AND actor=$5
      AND delivered_at IS NOT NULL AND kind <> 'continuation'
    ON CONFLICT DO NOTHING RETURNING id`, [assessmentId, source, rating, id, actor]);
  return (result.rows || result).length > 0;
}

module.exports = { SCENARIOS, KINDS, STATUSES, FEEDBACK, UUID, ensureProductAnalyticsSchema, startTask, assessTask, recordPreference };
