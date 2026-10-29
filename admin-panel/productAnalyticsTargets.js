'use strict';

// Pilot hypotheses, not industry benchmarks. Only an explicit save applies them.
const STARTER_TARGETS = Object.freeze({ weeklyValueUsers: 10, activation: 60, retentionW4: 30, success: 70 });
const TARGET_KEYS = Object.freeze(Object.keys(STARTER_TARGETS));
const MIN_RATE_SAMPLE = 20;
const MIN_SUCCESS_COVERAGE = 80;
const DAY = 86400000;

function buildTargetComparisons(summary, targets) {
  return Object.fromEntries(TARGET_KEYS.map(key => {
    const target = targets[key] ?? null;
    const count = key === 'weeklyValueUsers';
    const actual = count ? summary.weeklyValueUsers : summary[key]?.value;
    const value = typeof actual === 'number' && Number.isFinite(actual) ? actual : null;
    const sample = count ? null : summary[key]?.denominator || 0;
    const result = { value, target, unit: count ? 'users' : 'percentage_points', delta: null, attainment: null,
      status: 'unset', reason: 'Цель не задана', sample, minimumSample: count ? null : MIN_RATE_SAMPLE };
    if (target === null) return [key, result];
    if (!summary.complete) return [key, { ...result, status: 'incomplete', reason: 'Неполные данные: сравнение недоступно' }];
    if (summary.filters?.channel || summary.filters?.scenario) return [key, { ...result, status: 'filtered',
      reason: 'Общая цель продукта: выберите все каналы и сценарии для сравнения' }];
    if (value === null) return [key, { ...result, status: 'no_data', reason: 'Нет данных для сравнения' }];
    const difference = value - target;
    result.delta = Math.abs(difference) < 1e-9 ? 0 : difference;
    // Zero is a valid saved goal, but a percentage of zero is undefined.
    result.attainment = target > 0 ? 100 * value / target : null;
    if (count) {
      const elapsed = summary.startedAt ? +new Date(summary.generatedAt) - +new Date(summary.startedAt) : 0;
      if (value < target && elapsed < 7 * DAY) return [key, { ...result, status: 'collecting', reason: 'Предварительно: ещё нет полной недели наблюдений' }];
      if (value < target && summary.weeklyAssessment?.delivered > 0 && !summary.weeklyAssessment.assessed)
        return [key, { ...result, status: 'collecting', reason: 'Предварительно: нет оценок результатов за неделю' }];
    } else {
      if (sample < MIN_RATE_SAMPLE) return [key, { ...result, status: 'collecting', reason: `Предварительно: выборка ${sample} из ${MIN_RATE_SAMPLE}` }];
      if (key === 'success') {
        const assessed = summary.totals?.assessed || 0;
        const coverage = sample ? 100 * assessed / sample : 0;
        if (assessed < MIN_RATE_SAMPLE || coverage < MIN_SUCCESS_COVERAGE) return [key, { ...result, status: 'collecting',
          reason: `Предварительно: нужно ${MIN_RATE_SAMPLE} оценок и покрытие ≥ ${MIN_SUCCESS_COVERAGE}% всех обращений` }];
      }
    }
    return [key, { ...result, status: result.delta >= 0 ? 'met' : 'below', reason: result.delta >= 0 ? 'Цель достигнута' : 'Ниже цели' }];
  }));
}

module.exports = { STARTER_TARGETS, TARGET_KEYS, MIN_RATE_SAMPLE, MIN_SUCCESS_COVERAGE, buildTargetComparisons };
