'use strict';

function mergeEditableDefaults(fileValues, inherited, editableKeys) {
  const values = { ...fileValues };
  for (const key of editableKeys) {
    if (!Object.hasOwn(values, key) && inherited[key] !== undefined) values[key] = inherited[key];
  }
  return values;
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
module.exports = { mergeEditableDefaults, isValidProxyUrl };
