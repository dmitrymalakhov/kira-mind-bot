'use strict';

const VALID_TYPES = new Set(['interval', 'daily', 'weekly', 'monthly']);

function clampInteger(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function getZonedParts(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (type) => Number(parts.find((item) => item.type === type)?.value || 0);
  const weekdayShort = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
  }).format(date);
  const weekdays = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
    weekday: weekdays[weekdayShort] || 1,
  };
}

function timezoneOffsetMs(date, timezone) {
  const parts = getZonedParts(date, timezone);
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - date.getTime();
}

function zonedDateTimeToDate(year, month, day, hour, minute, timezone) {
  let utcMs = Date.UTC(year, month - 1, day, hour, minute);
  for (let index = 0; index < 3; index += 1) {
    utcMs = Date.UTC(year, month - 1, day, hour, minute) - timezoneOffsetMs(new Date(utcMs), timezone);
  }
  return new Date(utcMs);
}

function dateKey(year, month, day) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function dayDiff(anchor, candidate) {
  const parse = (value) => {
    const [year, month, day] = value.split('-').map(Number);
    return Date.UTC(year, month - 1, day);
  };
  return Math.round((parse(candidate) - parse(anchor)) / 86400000);
}

function monthDiff(anchor, year, month) {
  const [anchorYear, anchorMonth] = anchor.split('-').map(Number);
  return (year - anchorYear) * 12 + month - anchorMonth;
}

function isValidDateKey(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() + 1 === month
    && date.getUTCDate() === day;
}

function normalizeRecurringSchedule(value, timezone, now = new Date()) {
  if (!value || typeof value !== 'object' || !VALID_TYPES.has(value.type)) {
    throw new Error('Некорректный тип расписания');
  }
  const parts = getZonedParts(now, timezone);
  const anchorDate = isValidDateKey(String(value.anchorDate || ''))
    ? String(value.anchorDate)
    : dateKey(parts.year, parts.month, parts.day);
  if (value.type === 'interval') {
    return {
      type: 'interval',
      intervalMinutes: clampInteger(value.intervalMinutes, 1, 525600, 60),
      anchorDate,
    };
  }

  const schedule = {
    type: value.type,
    interval: clampInteger(value.interval, 1, 365, 1),
    hour: clampInteger(value.hour, 0, 23, 9),
    minute: clampInteger(value.minute, 0, 59, 0),
    anchorDate,
  };
  if (value.type === 'weekly') {
    const days = Array.isArray(value.daysOfWeek)
      ? [...new Set(value.daysOfWeek.map((day) => clampInteger(day, 1, 7, 1)))].sort()
      : [];
    schedule.daysOfWeek = days.length ? days : [parts.weekday];
  }
  if (value.type === 'monthly') {
    schedule.dayOfMonth = clampInteger(value.dayOfMonth, 1, 31, parts.day);
  }
  return schedule;
}

function computeNextRecurringRun(schedule, timezone, after = new Date()) {
  if (schedule.type === 'interval') {
    return new Date(after.getTime() + schedule.intervalMinutes * 60000);
  }
  const parts = getZonedParts(after, timezone);
  const searchHorizonDays = schedule.type === 'monthly'
    ? Math.max(3660, schedule.interval * 32 + 400)
    : 3660;
  for (let offset = 0; offset <= searchHorizonDays; offset += 1) {
    const day = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + offset));
    const year = day.getUTCFullYear();
    const month = day.getUTCMonth() + 1;
    const dayOfMonth = day.getUTCDate();
    const candidate = zonedDateTimeToDate(year, month, dayOfMonth, schedule.hour, schedule.minute, timezone);
    if (candidate <= after) continue;
    const diff = dayDiff(schedule.anchorDate, dateKey(year, month, dayOfMonth));
    if (schedule.type === 'daily' && diff >= 0 && diff % schedule.interval === 0) return candidate;
    if (schedule.type === 'weekly') {
      const weekday = ((day.getUTCDay() + 6) % 7) + 1;
      if (diff >= 0 && schedule.daysOfWeek.includes(weekday) && Math.floor(diff / 7) % schedule.interval === 0) {
        return candidate;
      }
    }
    if (
      schedule.type === 'monthly' &&
      monthDiff(schedule.anchorDate, year, month) >= 0 &&
      monthDiff(schedule.anchorDate, year, month) % schedule.interval === 0 &&
      dayOfMonth === schedule.dayOfMonth
    ) {
      return candidate;
    }
  }
  throw new Error('Не удалось вычислить следующий запуск');
}

module.exports = {
  normalizeRecurringSchedule,
  computeNextRecurringRun,
};
