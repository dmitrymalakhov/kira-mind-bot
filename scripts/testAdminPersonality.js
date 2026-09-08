'use strict';

const assert = require('node:assert/strict');
const {
  DEFAULT_PERSONALITY,
  getDefaultPersonalityProfile,
  normalizeGenderDefaults,
} = require('../admin-panel/personalityDefaults');

const femaleDefaults = DEFAULT_PERSONALITY.KiraMindBot;
const maleDefaults = getDefaultPersonalityProfile('мужской');

const switchedToMale = normalizeGenderDefaults({
  ...femaleDefaults,
  characterGender: 'мужской',
});
assert.equal(switchedToMale.characterName, maleDefaults.characterName);
assert.equal(switchedToMale.persona, maleDefaults.persona);
assert.equal(switchedToMale.biography, maleDefaults.biography);
assert.equal(switchedToMale.proactiveMessageHint, maleDefaults.proactiveMessageHint);

const customPersona = normalizeGenderDefaults({
  ...femaleDefaults,
  characterGender: 'мужской',
  characterName: 'Макс',
  persona: 'Пользовательский мужской промпт',
  biography: 'Пользовательская биография',
});
assert.equal(customPersona.characterName, 'Макс');
assert.equal(customPersona.persona, 'Пользовательский мужской промпт');
assert.equal(customPersona.biography, 'Пользовательская биография');
assert.equal(customPersona.proactiveMessageHint, maleDefaults.proactiveMessageHint);

const {
  normalizeKiraResidenceCity,
  parseKiraResidence,
  buildKiraResidenceUpdate,
} = require('../admin-panel/kiraResidence');

assert.equal(normalizeKiraResidenceCity('  город Казань  '), 'Казань');
assert.equal(normalizeKiraResidenceCity('https://example.com'), null);
const moved = buildKiraResidenceUpdate(
  parseKiraResidence(null, 'Санкт-Петербург'),
  'Москва',
  '2026-09-01T10:00:00.000Z'
);
assert.deepEqual(moved, {
  city: 'Москва',
  previousCity: 'Санкт-Петербург',
  movedAt: '2026-09-01T10:00:00.000Z',
  source: 'admin',
});

console.log('admin personality gender defaults checks passed');
