'use strict';
const { randomUUID } = require('crypto');
const { SCENARIOS, UUID, FEEDBACK, assessTask } = require('./productAnalyticsStore');
const { STARTER_TARGETS, TARGET_KEYS, buildTargetComparisons } = require('./productAnalyticsTargets');
const DAY = 86400000;
const TARGETS_KEY = 'PRODUCT_ANALYTICS_TARGETS';

function inputError(message) { return Object.assign(new Error(message), { statusCode: 400 }); }
function parseFilters(query, now = new Date()) {
  const days = query.days === undefined ? 30 : Number(query.days);
  if (![7, 30, 90].includes(days)) throw inputError('Период: 7, 30 или 90 дней');
  const channel = query.channel || '';
  const scenario = query.scenario || '';
  if (!['', 'telegram', 'api'].includes(channel) || !['', ...SCENARIOS].includes(scenario)) throw inputError('Неизвестный канал или сценарий');
  return { days, channel, scenario, from: new Date(+now - days * DAY).toISOString(), to: now.toISOString() };
}
function validateTargets(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !TARGET_KEYS.includes(key))) throw inputError('Неизвестная цель');
  return Object.fromEntries(TARGET_KEYS.map(key => {
    const n = value[key] ?? null;
    if (n !== null && (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || (key !== 'weeklyValueUsers' && n > 100) || (key === 'weeklyValueUsers' && (!Number.isInteger(n) || n > 1e9)))) throw inputError('Цель должна быть неотрицательным числом, процент — от 0 до 100');
    return [key, n];
  }));
}
const rate = (n, d) => ({ value: d ? 100 * n / d : null, numerator: n, denominator: d });
function percentile(values, p) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
}
function positive(task) { return task.ratings?.length && task.ratings.every(r => ['helpful', 'memory_correct'].includes(r.rating)); }

// Rows contain only outcome metadata. An unassessed answer is never inferred to be helpful.
function summarizeProductAnalytics(sources, filters, now = new Date()) {
  const end = +now, from = +new Date(filters.from);
  const match = task => (!filters.channel || task.channel === filters.channel) && (!filters.scenario || task.scenario === filters.scenario);
  const all = sources.flatMap(source => source.tasks.map(task => ({ ...task, source: source.id,
    actor: `${source.id}:${task.actor}`, started: +new Date(task.started_at), delivered: task.delivered_at ? +new Date(task.delivered_at) : null })));
  const selected = all.filter(task => task.kind !== 'continuation' && match(task));
  const tasks = selected.filter(task => task.kind === 'interactive' && task.started >= from && task.started <= end);
  const useful = selected.filter(task => task.delivered !== null && task.delivered <= end && positive(task));
  const weekly = new Set(useful.filter(task => task.delivered >= end - 7 * DAY).map(task => task.actor));
  const weeklyDelivered = selected.filter(task => task.delivered !== null && task.delivered >= end - 7 * DAY && task.delivered <= end);
  const delivered = tasks.filter(task => task.delivered !== null && task.delivered <= end);
  const assessed = delivered.filter(task => task.ratings?.length);
  const successful = assessed.filter(positive);
  const users = sources.flatMap(source => source.users.map(user => ({ ...user, actor: `${source.id}:${user.actor}`,
    first: +new Date(user.registered_at || user.first_seen), firstValue: filters.channel || filters.scenario
      ? useful.filter(task => task.actor === `${source.id}:${user.actor}`).reduce((min, task) => min === null ? task.delivered : Math.min(min, task.delivered), null)
      : user.first_value ? +new Date(user.first_value) : null,
    eligible: Boolean(user.registered_at && source.startedAt && +new Date(user.registered_at) >= +new Date(source.startedAt)) })));
  const cohort = users.filter(user => user.eligible && user.first >= from && user.first <= end);
  const activation = users.filter(user => user.eligible && user.first >= from - DAY && user.first <= end - DAY);
  const retained = users.filter(user => user.eligible && user.first >= from - 28 * DAY && user.first <= end - 28 * DAY);
  const firstTimes = activation.filter(user => user.firstValue !== null && user.firstValue >= user.first && user.firstValue <= end).map(user => user.firstValue - user.first);
  const csat = assessed.filter(task => task.ratings.some(r => r.source === 'user'));
  const userHelpful = csat.filter(task => task.ratings.find(r => r.source === 'user')?.rating === 'helpful');
  const memory = selected.filter(task => task.started >= from && task.started <= end && task.ratings?.some(r => ['memory_correct', 'memory_wrong'].includes(r.rating)));
  const proactive = selected.filter(task => task.kind === 'proactive' && task.started >= from && task.started <= end);
  const proactiveAssessed = proactive.filter(task => task.ratings?.length);
  const optOuts = sources.flatMap(source => (source.preferences || []).filter(event => !event.enabled && +new Date(event.created_at) >= from && +new Date(event.created_at) <= end)
    .map(event => `${source.id}:${event.actor}`));
  const timings = delivered.map(task => task.delivered - task.started).filter(ms => ms >= 0);
  const daily = [];
  for (let date = Math.floor(from / DAY) * DAY; date <= end; date += DAY) {
    const rows = tasks.filter(task => task.started >= date && task.started < date + DAY);
    const benefits = useful.filter(task => task.delivered >= Math.max(from, date) && task.delivered < date + DAY);
    daily.push({ date: new Date(date).toISOString().slice(0, 10), tasks: rows.length,
      valueUsers: new Set(benefits.map(task => task.actor)).size, successful: rows.filter(positive).length });
  }
  const coverage = rate(assessed.length, delivered.length);
  return {
    generatedAt: now.toISOString(), filters, sources: sources.length, complete: sources.every(source => !source.truncated && !source.unavailable),
    startedAt: sources.map(s => s.startedAt).filter(Boolean).sort()[0] || null,
    weeklyValueUsers: weekly.size,
    weeklyAssessment: { delivered: weeklyDelivered.length, assessed: weeklyDelivered.filter(task => task.ratings?.length).length },
    activation: rate(activation.filter(user => user.firstValue !== null && user.firstValue >= user.first && user.firstValue < user.first + DAY).length, activation.length),
    retentionW4: rate(retained.filter(user => useful.some(task => task.actor === user.actor && task.delivered >= user.first + 21 * DAY && task.delivered < user.first + 28 * DAY)).length, retained.length),
    pendingActivation: cohort.filter(user => user.first > end - DAY).length, pendingRetention: cohort.filter(user => user.first > end - 28 * DAY).length,
    observedUsers: users.length, cohortUsers: cohort.length,
    success: rate(successful.length, tasks.length), assessedSuccess: rate(successful.length, assessed.length), coverage,
    csat: rate(userHelpful.length, csat.length),
    correction: rate(assessed.filter(task => task.correction_reported || task.ratings.some(r => r.rating === 'corrected')).length, assessed.length),
    memory: rate(memory.filter(task => task.ratings.every(r => r.rating !== 'memory_wrong') && task.ratings.some(r => r.rating === 'memory_correct')).length, memory.length),
    proactive: rate(proactiveAssessed.filter(positive).length, proactiveAssessed.length), proactiveCoverage: rate(proactiveAssessed.length, proactive.length),
    optOutUsers: new Set(optOuts).size,
    trustIncidents: selected.filter(task => task.trust_reported_at
      ? +new Date(task.trust_reported_at) >= from && +new Date(task.trust_reported_at) <= end
      : task.started >= from && task.started <= end && task.ratings?.some(r => r.rating === 'trust')).length,
    timing: { p50: percentile(timings, .5), p90: percentile(timings, .9), samples: timings.length,
      firstValueP50: percentile(firstTimes, .5), firstValueP90: percentile(firstTimes, .9), firstValueSamples: firstTimes.length,
      withoutFirstValue: activation.filter(user => user.firstValue === null).length },
    totals: { tasks: tasks.length, delivered: delivered.length, assessed: assessed.length,
      technicalOk: tasks.filter(task => task.technical_ok === true).length,
      failed: tasks.filter(task => task.status === 'failed').length,
      unresolved: tasks.filter(task => ['running', 'waiting', 'unknown'].includes(task.status)).length,
      feedbackOffered: delivered.filter(task => task.feedback_offered).length },
    scenarios: SCENARIOS.map(scenario => { const rows = tasks.filter(task => task.scenario === scenario); return { scenario, tasks: rows.length,
      success: rate(rows.filter(positive).length, rows.length), assessed: rows.filter(task => task.ratings?.length).length }; }),
    daily,
    recent: selected.filter(task => task.started >= from && task.started <= end).sort((a, b) => b.started - a.started).slice(0, 50)
      .map(task => ({ id: task.id, source: task.source, channel: task.channel, kind: task.kind, scenario: task.scenario,
        startedAt: task.started_at, deliveredAt: task.delivered_at, status: task.status, technicalOk: task.technical_ok,
        ratings: task.ratings || [] })),
  };
}

async function readSource(pool, id, registeredAt, filters) {
  const meta = await pool.query('SELECT started_at FROM product_analytics_meta WHERE id=1');
  // Latest assessment per reviewer/user, rather than counting repeated clicks as new successes.
  const outcomes = `WITH latest AS (
    SELECT DISTINCT ON (task_id,source) task_id,source,rating,created_at
    FROM product_analytics_assessments WHERE created_at <= $1 ORDER BY task_id,source,created_at DESC,id DESC
  ), ratings AS (SELECT task_id, json_agg(json_build_object('source',source,'rating',rating)) AS ratings,
    bool_and(rating IN ('helpful','memory_correct')) AS helpful FROM latest GROUP BY task_id),
  signals AS (SELECT task_id, bool_or(rating='corrected') AS correction_reported,
    min(created_at) FILTER (WHERE rating='trust') AS trust_reported_at
    FROM product_analytics_assessments WHERE created_at <= $1 GROUP BY task_id)`;
  const users = await pool.query(`${outcomes} SELECT t.actor,min(t.started_at) AS first_seen,
    min(t.delivered_at) FILTER (WHERE r.helpful AND t.delivered_at <= $1) AS first_value
    FROM product_analytics_tasks t LEFT JOIN ratings r ON r.task_id=t.id
    WHERE t.kind <> 'continuation' AND t.started_at <= $1 GROUP BY t.actor`, [filters.to]);
  const result = await pool.query(`${outcomes} SELECT t.*,COALESCE(r.ratings,'[]'::json) AS ratings,s.correction_reported,s.trust_reported_at
    FROM product_analytics_tasks t LEFT JOIN ratings r ON r.task_id=t.id LEFT JOIN signals s ON s.task_id=t.id
    WHERE t.started_at <= $1 AND (t.started_at >= $2 OR t.delivered_at >= $2 OR s.trust_reported_at >= $2)
    ORDER BY t.started_at DESC LIMIT 50001`, [filters.to, new Date(+new Date(filters.from) - 28 * DAY)]);
  const preferences = await pool.query('SELECT actor,feature,enabled,created_at FROM product_analytics_preferences WHERE created_at >= $1 AND created_at <= $2', [filters.from, filters.to]);
  return { id, preferences: preferences.rows, startedAt: meta.rows[0]?.started_at?.toISOString?.() || meta.rows[0]?.started_at || null,
    truncated: result.rows.length > 50000, tasks: result.rows.slice(0, 50000), users: users.rows.map(user => ({ ...user, registered_at: registeredAt || null })) };
}

function registerProductAnalyticsRoutes(app, { requireAuth, createDbPool, ensureBotSettingsTable, analyticsSources }) {
  app.get('/api/product-analytics', requireAuth, async (req, res) => {
    let bindings;
    const settings = createDbPool();
    try {
      const snapshot = await settings.query('SELECT clock_timestamp() AS now');
      const now = new Date(snapshot.rows[0]?.now || Date.now());
      const filters = parseFilters(req.query, now);
      bindings = await analyticsSources();
      const sources = [];
      for (const binding of bindings) {
        try {
          const source = binding.pool ? await readSource(binding.pool, binding.id, binding.registeredAt, filters)
            : { id: binding.id, tasks: [], users: [] };
          if (binding.cohortStartedAt) source.startedAt = binding.cohortStartedAt;
          if (!source.users.length && binding.registeredAt) source.users.push({ actor: 'registered', registered_at: binding.registeredAt });
          sources.push(source);
        }
        catch (error) {
          if (error.code !== '42P01') throw error;
          sources.push({ id: binding.id, users: [], tasks: [], unavailable: true });
        }
      }
      await ensureBotSettingsTable(settings);
      const saved = await settings.query('SELECT value FROM bot_settings WHERE key=$1', [TARGETS_KEY]);
      let targets = validateTargets({});
      try { if (saved.rows[0]) targets = validateTargets(JSON.parse(saved.rows[0].value)); } catch { /* Show unset targets if a legacy value is invalid. */ }
      const summary = summarizeProductAnalytics(sources, filters, now);
      res.json({ ...summary, targets, starterTargets: STARTER_TARGETS, targetComparisons: buildTargetComparisons(summary, targets) });
    } catch (error) { res.status(error.statusCode || 503).json({ error: error.statusCode ? error.message : 'Аналитика временно недоступна' }); }
    finally { await settings.end(); if (bindings) await Promise.all(bindings.map(binding => binding.pool?.end())); }
  });
  app.put('/api/product-analytics/targets', requireAuth, async (req, res) => {
    const pool = createDbPool();
    try {
      const targets = validateTargets(req.body);
      await ensureBotSettingsTable(pool);
      await pool.query(`INSERT INTO bot_settings(key,value,"updatedAt") VALUES($1,$2,now())
        ON CONFLICT(key) DO UPDATE SET value=excluded.value,"updatedAt"=now()`, [TARGETS_KEY, JSON.stringify(targets)]);
      res.json({ targets });
    } catch (error) { res.status(error.statusCode || 503).json({ error: error.statusCode ? error.message : 'Не удалось сохранить цели' }); }
    finally { await pool.end(); }
  });
  app.post('/api/product-analytics/review', requireAuth, async (req, res) => {
    let bindings;
    try {
      const { id, source, rating } = req.body || {};
      if (!UUID.test(id || '') || typeof source !== 'string' || !FEEDBACK.includes(rating)) throw inputError('Укажите результат и оценку');
      bindings = await analyticsSources();
      const binding = bindings.find(item => item.id === source);
      if (!binding?.pool) throw inputError('Источник недоступен');
      const task = await binding.pool.query('SELECT actor FROM product_analytics_tasks WHERE id=$1', [id]);
      if (!task.rows[0] || !await assessTask(binding.pool, id, task.rows[0].actor, rating, 'review', randomUUID())) return res.status(404).json({ error: 'Доставленный результат не найден' });
      res.json({ success: true });
    } catch (error) { res.status(error.statusCode || 503).json({ error: error.statusCode ? error.message : 'Не удалось сохранить оценку' }); }
    finally { if (bindings) await Promise.all(bindings.map(binding => binding.pool?.end())); }
  });
}

module.exports = { parseFilters, validateTargets, percentile, summarizeProductAnalytics, readSource, registerProductAnalyticsRoutes };
