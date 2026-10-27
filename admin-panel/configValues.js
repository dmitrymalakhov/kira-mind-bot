'use strict';

function mergeEditableDefaults(fileValues, inherited, editableKeys) {
  const values = { ...fileValues };
  for (const key of editableKeys) {
    if (!Object.hasOwn(values, key) && inherited[key] !== undefined) values[key] = inherited[key];
  }
  return values;
}

function maskConfigValues(values, sensitiveKeys = new Set()) {
  const secretSuffix = /(?:^|_)(?:API_KEY|TOKEN|PASSWORD|PASSWD|SECRET|API_HASH|SESSION_STRING|PRIVATE_KEY|SECRET_ACCESS_KEY)$/;
  return Object.fromEntries(Object.entries(values).map(([key, value]) => {
    if (value && (sensitiveKeys.has(key) || secretSuffix.test(key))) {
      return [key, { value: value.length > 8 ? value.slice(0, 4) + '••••' : '••••', masked: true }];
    }
    return [key, { value, masked: false }];
  }));
}

function isValidProxyUrl(value) {
  if (typeof value !== 'string') return false;
  if (!value.trim()) return true;
  if (/[\r\n\0]/.test(value)) return false;
  try {
    const url = new URL(value.trim());
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}
module.exports = { mergeEditableDefaults, maskConfigValues, isValidProxyUrl };
