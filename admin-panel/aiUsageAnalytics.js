'use strict';

const AI_USAGE_OPERATIONS = new Set(['chat', 'response', 'embedding', 'transcription', 'unknown']);
const TOP_BREAKDOWN_LIMIT = 10;
const RECENT_FAILURE_LIMIT = 50;
const DEFAULT_DAYS = 7;
const MAX_DAYS = 90;

function firstQueryValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

function httpInputError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function parseDateQuery(value, endOfDay = false) {
  const raw = firstQueryValue(value);
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const trimmed = raw.trim();
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(trimmed)
    ? `${trimmed}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`
    : trimmed;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeIntegerQuery(value, fallback, max) {
  const raw = firstQueryValue(value);
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.round(parsed), max);
}

function parseBooleanFilter(value) {
  const raw = firstQueryValue(value);
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw === 'boolean') return raw;
  const normalized = String(raw).trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  throw httpInputError('Boolean filter должен быть true или false');
}

function parseStringFilter(value, label) {
  const raw = firstQueryValue(value);
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const trimmed = raw.trim();
  if (trimmed.length > 200) throw httpInputError(`${label} слишком длинный`);
  return trimmed;
}

function parseOperationFilter(value) {
  const operation = parseStringFilter(value, 'operation');
  if (!operation) return null;
  if (!AI_USAGE_OPERATIONS.has(operation)) {
    throw httpInputError('Недопустимое operation');
  }
  return operation;
}

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function buildWhereClause(filters) {
  return filters.length ? filters.join(' AND ') : 'TRUE';
}

function buildAiUsageFilters(query, now = new Date()) {
  const values = [];
  const filters = [];
  const meta = {};

  const provider = parseStringFilter(query.provider, 'provider');
  if (provider) {
    values.push(provider);
    filters.push(`provider = $${values.length}`);
    meta.provider = provider;
  }

  const model = parseStringFilter(query.model, 'model');
  if (model) {
    values.push(model);
    filters.push(`model = $${values.length}`);
    meta.model = model;
  }

  const taskKey = parseStringFilter(query.taskKey, 'taskKey');
  if (taskKey) {
    values.push(taskKey);
    filters.push(`"taskKey" = $${values.length}`);
    meta.taskKey = taskKey;
  }

  const preset = parseStringFilter(query.preset, 'preset');
  if (preset) {
    values.push(preset);
    filters.push(`preset = $${values.length}`);
    meta.preset = preset;
  }

  const operation = parseOperationFilter(query.operation);
  if (operation) {
    values.push(operation);
    filters.push(`COALESCE(operation, 'unknown') = $${values.length}`);
    meta.operation = operation;
  }

  const success = parseBooleanFilter(query.success);
  if (success !== null) {
    values.push(success);
    filters.push(`success = $${values.length}`);
    meta.success = success;
  }

  const fallbackUsed = parseBooleanFilter(query.fallbackUsed);
  if (fallbackUsed !== null) {
    values.push(fallbackUsed);
    filters.push(`COALESCE("fallbackUsed", false) = $${values.length}`);
    meta.fallbackUsed = fallbackUsed;
  }

  const fromRaw = firstQueryValue(query.from);
  const toRaw = firstQueryValue(query.to);
  let from = parseDateQuery(fromRaw, false);
  let to = parseDateQuery(toRaw, true);
  if (fromRaw && !from) throw httpInputError('Некорректная дата from');
  if (toRaw && !to) throw httpInputError('Некорректная дата to');

  const daysRaw = firstQueryValue(query.days);
  if (!from && !to && daysRaw !== 'all') {
    const days = normalizeIntegerQuery(daysRaw, DEFAULT_DAYS, MAX_DAYS);
    to = new Date(now);
    from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
    meta.days = days;
  }

  if (from && to && from.getTime() > to.getTime()) {
    throw httpInputError('Дата from должна быть раньше to');
  }

  if (from) {
    values.push(from);
    filters.push(`"createdAt" >= $${values.length}`);
    meta.from = from.toISOString();
  }

  if (to) {
    values.push(to);
    filters.push(`"createdAt" <= $${values.length}`);
    meta.to = to.toISOString();
  }

  const effectiveFrom = from || new Date(now.getTime() - DEFAULT_DAYS * 24 * 60 * 60 * 1000);
  const effectiveTo = to || new Date(now);
  const rangeMs = Math.max(1, effectiveTo.getTime() - effectiveFrom.getTime());
  const bucket = rangeMs <= 48 * 60 * 60 * 1000 ? 'hour' : 'day';

  return {
    whereSql: buildWhereClause(filters),
    values,
    filters: meta,
    bucket,
    rangeMs,
  };
}

function buildBreakdownWithOther(rows, limit = TOP_BREAKDOWN_LIMIT) {
  const normalized = rows.map((row) => ({
    key: row.key || 'unknown',
    calls: toNumber(row.calls),
    successfulCalls: toNumber(row.successfulCalls),
    failedCalls: toNumber(row.failedCalls),
    fallbackCalls: toNumber(row.fallbackCalls),
    inputTokens: toNumber(row.inputTokens),
    outputTokens: toNumber(row.outputTokens),
    totalTokens: toNumber(row.totalTokens),
    avgLatencyMs: toNumber(row.avgLatencyMs),
  }));

  if (normalized.length <= limit) {
    return normalized;
  }

  const visible = normalized.slice(0, limit);
  const hidden = normalized.slice(limit);
  visible.push(hidden.reduce((acc, row) => ({
    key: 'other',
    calls: acc.calls + row.calls,
    successfulCalls: acc.successfulCalls + row.successfulCalls,
    failedCalls: acc.failedCalls + row.failedCalls,
    fallbackCalls: acc.fallbackCalls + row.fallbackCalls,
    inputTokens: acc.inputTokens + row.inputTokens,
    outputTokens: acc.outputTokens + row.outputTokens,
    totalTokens: acc.totalTokens + row.totalTokens,
    avgLatencyMs: acc.avgLatencyMs,
  }), {
    key: 'other',
    calls: 0,
    successfulCalls: 0,
    failedCalls: 0,
    fallbackCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    avgLatencyMs: 0,
  }));
  return visible;
}

async function queryBreakdown(pool, whereSql, values, sqlExpr) {
  const result = await pool.query(
    `SELECT
      ${sqlExpr} AS key,
      COUNT(*)::int AS calls,
      COUNT(*) FILTER (WHERE success = true)::int AS "successfulCalls",
      COUNT(*) FILTER (WHERE success = false)::int AS "failedCalls",
      COUNT(*) FILTER (WHERE COALESCE("fallbackUsed", false) = true)::int AS "fallbackCalls",
      COALESCE(SUM("inputTokens"), 0) AS "inputTokens",
      COALESCE(SUM("outputTokens"), 0) AS "outputTokens",
      COALESCE(SUM("totalTokens"), 0) AS "totalTokens",
      COALESCE(AVG("latencyMs"), 0) AS "avgLatencyMs"
    FROM ai_usage_logs
    WHERE ${whereSql}
    GROUP BY 1
    ORDER BY COALESCE(SUM("totalTokens"), 0) DESC, COUNT(*) DESC, 1 ASC`,
    values,
  );
  return buildBreakdownWithOther(result.rows);
}

function normalizeTimeseriesRows(rows) {
  return rows.map((row) => ({
    bucketStart: row.bucketStart instanceof Date ? row.bucketStart.toISOString() : new Date(row.bucketStart).toISOString(),
    calls: toNumber(row.calls),
    successfulCalls: toNumber(row.successfulCalls),
    failedCalls: toNumber(row.failedCalls),
    fallbackCalls: toNumber(row.fallbackCalls),
    inputTokens: toNumber(row.inputTokens),
    outputTokens: toNumber(row.outputTokens),
    totalTokens: toNumber(row.totalTokens),
  }));
}

async function buildAiUsageSummary({ pool, query = {}, now = new Date() }) {
  const { whereSql, values, filters, bucket } = buildAiUsageFilters(query, now);
  const bucketExpr = bucket === 'hour'
    ? `date_trunc('hour', "createdAt")`
    : `date_trunc('day', "createdAt")`;

  const [
    totalsResult,
    timeseriesResult,
    providerRows,
    modelRows,
    taskRows,
    presetRows,
    operationRows,
    recentFailuresResult,
  ] = await Promise.all([
    pool.query(
      `SELECT
        COUNT(*)::int AS calls,
        COUNT(*) FILTER (WHERE success = true)::int AS "successfulCalls",
        COUNT(*) FILTER (WHERE success = false)::int AS "failedCalls",
        COUNT(*) FILTER (WHERE COALESCE("fallbackUsed", false) = true)::int AS "fallbackCalls",
        COUNT(*) FILTER (
          WHERE "inputTokens" IS NOT NULL OR "outputTokens" IS NOT NULL OR "totalTokens" IS NOT NULL
        )::int AS "callsWithUsage",
        COALESCE(SUM("inputTokens"), 0) AS "inputTokens",
        COALESCE(SUM("outputTokens"), 0) AS "outputTokens",
        COALESCE(SUM("totalTokens"), 0) AS "totalTokens",
        COALESCE(AVG("latencyMs"), 0) AS "avgLatencyMs"
      FROM ai_usage_logs
      WHERE ${whereSql}`,
      values,
    ),
    pool.query(
      `SELECT
        ${bucketExpr} AS "bucketStart",
        COUNT(*)::int AS calls,
        COUNT(*) FILTER (WHERE success = true)::int AS "successfulCalls",
        COUNT(*) FILTER (WHERE success = false)::int AS "failedCalls",
        COUNT(*) FILTER (WHERE COALESCE("fallbackUsed", false) = true)::int AS "fallbackCalls",
        COALESCE(SUM("inputTokens"), 0) AS "inputTokens",
        COALESCE(SUM("outputTokens"), 0) AS "outputTokens",
        COALESCE(SUM("totalTokens"), 0) AS "totalTokens"
      FROM ai_usage_logs
      WHERE ${whereSql}
      GROUP BY 1
      ORDER BY 1 ASC`,
      values,
    ),
    queryBreakdown(pool, whereSql, values, 'provider'),
    queryBreakdown(pool, whereSql, values, 'model'),
    queryBreakdown(pool, whereSql, values, '"taskKey"'),
    queryBreakdown(pool, whereSql, values, 'preset'),
    queryBreakdown(pool, whereSql, values, `COALESCE(operation, 'unknown')`),
    pool.query(
      `SELECT
        "createdAt",
        provider,
        model,
        "taskKey",
        preset,
        COALESCE(operation, 'unknown') AS operation,
        COALESCE("fallbackUsed", false) AS "fallbackUsed",
        errorMessage
      FROM ai_usage_logs
      WHERE ${whereSql} AND success = false
      ORDER BY "createdAt" DESC
      LIMIT ${RECENT_FAILURE_LIMIT}`,
      values,
    ),
  ]);

  const totalsRow = totalsResult.rows[0] || {};
  const calls = toNumber(totalsRow.calls);
  const successfulCalls = toNumber(totalsRow.successfulCalls);
  const failedCalls = toNumber(totalsRow.failedCalls);
  const fallbackCalls = toNumber(totalsRow.fallbackCalls);
  const callsWithUsage = toNumber(totalsRow.callsWithUsage);
  const callsWithoutUsage = Math.max(0, calls - callsWithUsage);

  const totals = {
    calls,
    successfulCalls,
    failedCalls,
    fallbackCalls,
    inputTokens: toNumber(totalsRow.inputTokens),
    outputTokens: toNumber(totalsRow.outputTokens),
    totalTokens: toNumber(totalsRow.totalTokens),
    avgLatencyMs: toNumber(totalsRow.avgLatencyMs),
    errorRate: calls ? failedCalls / calls : 0,
    fallbackRate: calls ? fallbackCalls / calls : 0,
  };

  const breakdowns = {
    providers: providerRows,
    models: modelRows,
    tasks: taskRows,
    presets: presetRows,
    operations: operationRows,
  };

  return {
    generatedAt: new Date(now).toISOString(),
    filters,
    timeseries: {
      bucket,
      points: normalizeTimeseriesRows(timeseriesResult.rows),
    },
    totals,
    coverage: {
      callsWithUsage,
      callsWithoutUsage,
      usageCoverageRate: calls ? callsWithUsage / calls : 0,
    },
    breakdowns,
    leaders: {
      modelsByTokens: [...breakdowns.models].sort((a, b) => b.totalTokens - a.totalTokens || b.calls - a.calls).slice(0, 5),
      modelsByCalls: [...breakdowns.models].sort((a, b) => b.calls - a.calls || b.totalTokens - a.totalTokens).slice(0, 5),
      tasksByTokens: [...breakdowns.tasks].sort((a, b) => b.totalTokens - a.totalTokens || b.calls - a.calls).slice(0, 5),
      tasksByCalls: [...breakdowns.tasks].sort((a, b) => b.calls - a.calls || b.totalTokens - a.totalTokens).slice(0, 5),
    },
    recentFailures: recentFailuresResult.rows.map((row) => ({
      createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : new Date(row.createdAt).toISOString(),
      provider: row.provider,
      model: row.model,
      taskKey: row.taskKey,
      preset: row.preset,
      operation: row.operation || 'unknown',
      fallbackUsed: Boolean(row.fallbackUsed),
      errorMessage: row.errorMessage || '',
    })),
  };
}

module.exports = {
  AI_USAGE_OPERATIONS,
  buildAiUsageSummary,
};
