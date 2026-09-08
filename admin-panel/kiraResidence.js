'use strict';

const DEFAULT_KIRA_CURRENT_CITY = 'Санкт-Петербург';
const KIRA_RESIDENCE_DB_KEY = 'global:KIRA_RESIDENCE';

function normalizeKiraResidenceCity(value) {
  if (typeof value !== 'string') return null;
  const normalized = value
    .trim()
    .replace(/^[«"'`]+|[»"'`]+$/gu, '')
    .replace(/^(?:город(?:е|ом|а|у)?\s+|г\.\s*)/iu, '')
    .replace(/\s+/gu, ' ');
  if (!normalized || normalized.length > 80 || !/\p{L}/u.test(normalized)) return null;
  if (!/^[\p{L}\p{M}][\p{L}\p{M}\s.'’()\-]{0,79}$/u.test(normalized)) return null;
  return normalized;
}

function parseKiraResidence(raw, fallbackCity = DEFAULT_KIRA_CURRENT_CITY) {
  const fallback = normalizeKiraResidenceCity(fallbackCity) || DEFAULT_KIRA_CURRENT_CITY;
  if (!raw) return { city: fallback, source: 'default' };
  try {
    const parsed = JSON.parse(raw);
    const city = normalizeKiraResidenceCity(parsed?.city);
    if (!city) return { city: fallback, source: 'default' };
    return {
      city,
      previousCity: normalizeKiraResidenceCity(parsed.previousCity) || undefined,
      movedAt: typeof parsed.movedAt === 'string' ? parsed.movedAt : undefined,
      source: parsed.source === 'conversation' || parsed.source === 'admin' ? parsed.source : 'default',
    };
  } catch {
    const legacyCity = normalizeKiraResidenceCity(raw);
    return legacyCity ? { city: legacyCity, source: 'default' } : { city: fallback, source: 'default' };
  }
}

function buildKiraResidenceUpdate(current, nextCityInput, movedAt = new Date().toISOString()) {
  const nextCity = normalizeKiraResidenceCity(nextCityInput);
  if (!nextCity) return null;
  if (nextCity.toLocaleLowerCase('ru-RU') === current.city.toLocaleLowerCase('ru-RU')) {
    return current;
  }
  return {
    city: nextCity,
    previousCity: current.city,
    movedAt,
    source: 'admin',
  };
}

module.exports = {
  DEFAULT_KIRA_CURRENT_CITY,
  KIRA_RESIDENCE_DB_KEY,
  normalizeKiraResidenceCity,
  parseKiraResidence,
  buildKiraResidenceUpdate,
};
