'use strict';

/** BotFather credentials never grant access to a person's Telegram account. */
function readTelegramUserCredentials(env = process.env) {
  const rawApiId = env.TELEGRAM_API_ID?.trim();
  const apiHash = env.TELEGRAM_API_HASH?.trim();
  const sessionString = env.TELEGRAM_SESSION_STRING?.trim();
  const apiId = Number(rawApiId);
  if (!rawApiId || !apiHash || !sessionString || !Number.isSafeInteger(apiId) || apiId <= 0) return null;
  return { apiId, apiHash, sessionString };
}

module.exports = { readTelegramUserCredentials };
