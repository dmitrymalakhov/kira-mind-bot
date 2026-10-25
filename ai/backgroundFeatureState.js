'use strict';
const registry = require('./background-features.json');

function requiresTelegramSession(feature) {
  return feature === 'telegramReading' || registry[feature].requires.some(requiresTelegramSession);
}

/** Saved choices remain intact while dependencies, credentials or budget suspend execution. */
function buildFeatureStates(preferences, mode, telegramConfigured = true) {
  function blocker(key) {
    if (!preferences[key]) return key;
    if (registry[key].budgetPaused && mode === 'maximum') return 'budget';
    if (requiresTelegramSession(key) && !telegramConfigured) return 'telegram';
    for (const parent of registry[key].requires) {
      const reason = blocker(parent);
      if (reason) return reason;
    }
    return null;
  }
  return Object.entries(registry).map(([key, definition]) => ({
    key, ...definition, enabled: preferences[key], effective: !blocker(key), blockedBy: blocker(key),
  }));
}

module.exports = { requiresTelegramSession, buildFeatureStates };
