'use strict';

// Per-account preferences. Identity, storage addresses and shared provider credentials remain server-owned.
const ACCOUNT_SETTING_KEYS = [
  'LM_STUDIO_MODEL', 'ELEVENLABS_VOICE_ID', 'ELEVENLABS_VOICE_NAME', 'ELEVENLABS_MODEL_ID', 'ELEVENLABS_OUTPUT_FORMAT',
  'ELEVENLABS_VOICE_STABILITY', 'ELEVENLABS_VOICE_SIMILARITY_BOOST', 'ELEVENLABS_VOICE_STYLE', 'ELEVENLABS_VOICE_SPEED',
  'ELEVENLABS_VOICE_USE_SPEAKER_BOOST', 'ELEVENLABS_MAX_TEXT_CHARS', 'VECTOR_SEARCH_THRESHOLD', 'MEMORY_GRAPH_MAX_POINTS',
  'USER_TIMEZONE', 'REMINDER_EXPIRY_TIME_MS', 'PROACTIVE_ONLY_PRIVATE_CHAT', 'GROUP_PUBLIC_MODE',
  'KIRA_PROACTIVE_ENABLED', 'KIRA_PROACTIVE_INTERVAL_MS', 'KIRA_LIFE_WEB_GROUNDING_ENABLED',
  'KIRA_PROACTIVE_QUIET_HOURS_ENABLED', 'KIRA_PROACTIVE_QUIET_HOUR_START', 'KIRA_PROACTIVE_QUIET_HOUR_END',
  'DM_REPORT_ENABLED', 'DM_REPORT_INTERVAL_MS', 'DM_REPORT_DIALOG_LIMIT', 'DM_REPORT_QUIET_HOURS_ENABLED',
  'DAYTIME_REFLECTION_ENABLED', 'INBOX_GUARDIAN_ENABLED', 'INBOX_GUARDIAN_HOUR', 'INBOX_GUARDIAN_LOOKBACK_HOURS', 'INBOX_GUARDIAN_MIN_AGE_MINUTES',
  'MEMORY_INSIGHT_ENABLED', 'MEMORY_INSIGHT_INTERVAL_MS', 'MEMORY_CONSOLIDATION_ENABLED', 'MEMORY_CONSOLIDATION_INTERVAL_MS', 'MEMORY_CONSOLIDATION_MIN_FACTS',
  'PERSONAL_CHAT_MEMORY_ENABLED', 'PERSONAL_CHAT_MEMORY_INTERVAL_MS', 'PERSONAL_CHAT_MEMORY_INITIAL_LOOKBACK_DAYS',
  'PERSONAL_CHAT_MEMORY_MAX_CHATS_PER_RUN', 'PERSONAL_CHAT_MEMORY_MAX_MESSAGES_PER_CHAT', 'PERSONAL_CHAT_MEMORY_MIN_NEW_MESSAGES', 'PERSONAL_CHAT_MEMORY_DIALOG_LIMIT',
];
const allowed = new Set(ACCOUNT_SETTING_KEYS);
const INSTANCE_SETTING_KEYS = ['OPENAI_API_KEY','OPENAI_IMAGE_API_KEY','OPENAI_BASE_URL','OPENAI_IMAGE_BASE_URL','OPENROUTER_API_KEY','GEMINI_API_KEY','ZAI_API_KEY','KIMI_API_KEY',
  'LM_STUDIO_BASE_URL','LM_STUDIO_API_KEY','ELEVENLABS_API_KEY','GOOGLE_MAPS_API_KEY','IDEOGRAM_API_KEY','DB_HOST','DB_PORT','DB_USER','DB_PASSWORD','DB_NAME','VECTOR_PROVIDER','QDRANT_URL','QDRANT_API_KEY'];
function parseAccountSettings(raw, patch = false) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length > ACCOUNT_SETTING_KEYS.length) throw Error('Некорректные настройки аккаунта.');
  const result = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!allowed.has(key) || (value !== null || !patch) && (typeof value !== 'string' || value.length > 4096 || /[\r\n\0]/.test(value))) throw Error('Этот параметр задаётся для инстанса или подключения аккаунта.');
    if (value !== null && value !== '') {
      if ((/_ENABLED$|_USE_SPEAKER_BOOST$/.test(key) || ['PROACTIVE_ONLY_PRIVATE_CHAT','GROUP_PUBLIC_MODE'].includes(key)) && !['true','false'].includes(value)) throw Error('Ожидается переключатель true/false.');
      if (key === 'USER_TIMEZONE') { try { new Intl.DateTimeFormat('en', { timeZone: value }); } catch { throw Error('Некорректный часовой пояс.'); } }
      if (/_MS$|_CHARS$|_LIMIT$|_POINTS$|_HOURS$|_MINUTES$|_DAYS$|_FACTS$|_PER_RUN$|_PER_CHAT$|_MESSAGES$|_HOUR$|_HOUR_START$|_HOUR_END$/.test(key)) {
        if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw Error('Ожидается неотрицательное целое число.');
        if (/_HOUR$|_HOUR_START$|_HOUR_END$/.test(key) && Number(value) > 23) throw Error('Час должен быть от 0 до 23.');
      }
    }
    result[key] = value;
  }
  return result;
}
module.exports = { ACCOUNT_SETTING_KEYS, INSTANCE_SETTING_KEYS, parseAccountSettings };
