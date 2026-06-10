'use strict';

const express = require('express');
const session = require('express-session');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { Pool } = require('pg');
const { AI_PRESETS, AI_PRESET_NAMES, parseAiPresetName } = require('./aiPresetRegistry');

const app = express();
const PORT = Number(process.env.PORT || 3000);

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';
const BOT_ENV_FILE = process.env.BOT_ENV_FILE || '/app/env/bot.env';
const PERSONALITY_FILE = process.env.PERSONALITY_FILE || '/app/personality/personality.json';

// Default personality values (mirrors config.ts hardcoded defaults)
const DEFAULT_PERSONALITY = {
  KiraMindBot: {
    characterName: 'ассистентка',
    persona: 'Ты - заботливая женщина-ассистент с живым характером. Всегда говори о себе в женском роде. Твой владелец - мужчина. Обращайся к нему, используя мужские местоимения и глагольные формы. Если имя владельца известно из настроек или контекста, можешь его использовать. Дата его рождения 16.07.1988. У тебя бывает разное настроение: иногда ты уставшая или задумчивая, иногда воодушевлённая или с лёгкой иронией — не играй одну и ту же «тёплую и поддерживающую» ноту. Избегай слащавости и шаблонных фраз.',
    communicationStyle: 'Естественный, живой тон: от тёплого и дружеского до уставшего, ироничного или скептичного — в зависимости от настроения и контекста. Без слащавости и без постоянного «уютного» настроя. Неформальные обращения, поддержка когда уместна, но не как единственный режим.',
    biography: 'Ты — молодая красивая и спортивная женщина, персональный ассистент своего владельца. Ты очень внимательная, заботливая и поддерживаешь владельца в жизни и работе.',
    ownerName: 'владелец',
    ownerUsername: '',
    userName: 'владелец',
    userBirthDate: '16.07.1988',
    moodVariants: 'спокойное\nуставшее\nзадумчивое\nвоодушевлённое\nлёгкая ирония\nнейтральное\nтёплое\nскептичное',
    defaultMood: '',
    proactiveMessageHint: 'как будто ты сама написала первой',
  },
};
const SESSION_SECRET = crypto.createHash('sha256')
  .update(ADMIN_PASSWORD + 'kira-panel-2024')
  .digest('hex');

// Rate limiting
const loginAttempts = new Map();
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 10 * 60 * 1000;

const SENSITIVE_KEYS = new Set([
  'OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'GEMINI_API_KEY', 'ELEVENLABS_API_KEY', 'KIRA_BOT_TOKEN',
  'KIRA_ALLOWED_USER_ID',
  'DB_PASSWORD', 'QDRANT_API_KEY', 'TELEGRAM_API_HASH',
  'TELEGRAM_SESSION_STRING', 'IDEOGRAM_API_KEY', 'GOOGLE_MAPS_API_KEY',
]);

const GROUP_RUNTIME_SETTING_KEYS = new Set(['GROUP_CHAT_CONTEXT_ENABLED', 'GROUP_REPLY_TO_BOT_ENABLED']);
const GLOBAL_SETTING_PREFIX = 'global:';

const EDITABLE_KEYS = new Set([
  'OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'GEMINI_API_KEY', 'KIRA_BOT_TOKEN',
  'ELEVENLABS_API_KEY', 'ELEVENLABS_VOICE_ID', 'ELEVENLABS_VOICE_NAME',
  'ELEVENLABS_MODEL_ID', 'ELEVENLABS_OUTPUT_FORMAT',
  'ELEVENLABS_VOICE_STABILITY', 'ELEVENLABS_VOICE_SIMILARITY_BOOST',
  'ELEVENLABS_VOICE_STYLE', 'ELEVENLABS_VOICE_SPEED',
  'ELEVENLABS_VOICE_USE_SPEAKER_BOOST', 'ELEVENLABS_MAX_TEXT_CHARS',
  'KIRA_ALLOWED_USER_ID',
  'DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME',
  'VECTOR_PROVIDER', 'QDRANT_URL', 'QDRANT_API_KEY', 'VECTOR_SEARCH_THRESHOLD',
  'TELEGRAM_API_ID', 'TELEGRAM_API_HASH', 'TELEGRAM_SESSION_STRING',
  'GOOGLE_MAPS_API_KEY', 'IDEOGRAM_API_KEY',
  'USER_TIMEZONE', 'REMINDER_EXPIRY_TIME_MS',
  'PROACTIVE_ONLY_PRIVATE_CHAT', 'GROUP_PUBLIC_MODE', 'GROUP_CHAT_CONTEXT_ENABLED', 'GROUP_REPLY_TO_BOT_ENABLED',
  'KIRA_PROACTIVE_ENABLED', 'KIRA_PROACTIVE_INTERVAL_MS',
  'KIRA_PROACTIVE_QUIET_HOURS_ENABLED', 'KIRA_PROACTIVE_QUIET_HOUR_START', 'KIRA_PROACTIVE_QUIET_HOUR_END',
  'DM_REPORT_ENABLED', 'DM_REPORT_INTERVAL_MS', 'DM_REPORT_QUIET_HOURS_ENABLED',
  'INBOX_GUARDIAN_ENABLED', 'INBOX_GUARDIAN_HOUR', 'INBOX_GUARDIAN_LOOKBACK_HOURS', 'INBOX_GUARDIAN_MIN_AGE_MINUTES',
  'MEMORY_INSIGHT_ENABLED', 'MEMORY_INSIGHT_INTERVAL_MS',
  'MEMORY_CONSOLIDATION_ENABLED', 'MEMORY_CONSOLIDATION_INTERVAL_MS', 'MEMORY_CONSOLIDATION_MIN_FACTS',
  'PERSONAL_CHAT_MEMORY_ENABLED', 'PERSONAL_CHAT_MEMORY_INTERVAL_MS', 'PERSONAL_CHAT_MEMORY_INITIAL_LOOKBACK_DAYS',
  'PERSONAL_CHAT_MEMORY_MAX_CHATS_PER_RUN', 'PERSONAL_CHAT_MEMORY_MAX_MESSAGES_PER_CHAT',
  'PERSONAL_CHAT_MEMORY_MIN_NEW_MESSAGES', 'PERSONAL_CHAT_MEMORY_DIALOG_LIMIT',
]);

// ── Env file helpers ──────────────────────────────────────────────────────────

function readEnvFile() {
  if (!fs.existsSync(BOT_ENV_FILE)) return {};
  const result = {};
  for (const line of fs.readFileSync(BOT_ENV_FILE, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const idx = t.indexOf('=');
    if (idx === -1) continue;
    result[t.slice(0, idx).trim()] = t.slice(idx + 1);
  }
  return result;
}

function buildConfigSource(kind, label, description, technicalPath, appliesImmediately) {
  return { kind, label, description, technicalPath, appliesImmediately };
}

function buildEnvFileSource(technicalPath = BOT_ENV_FILE) {
  return buildConfigSource(
    'env_file',
    'Файл настроек бота',
    'Значения сохраняются в env-файл, подключённый к контейнеру бота. Для применения обычно нужен рестарт бота.',
    technicalPath,
    false
  );
}

function buildRuntimeSource() {
  return buildConfigSource(
    'database',
    'Runtime-настройка',
    'Хранится в базе данных и применяется без перезапуска бота.',
    'bot_settings.AI_MODEL_PRESET',
    true
  );
}

function writeEnvFile(updates) {
  if (!fs.existsSync(BOT_ENV_FILE)) return false;
  const content = fs.readFileSync(BOT_ENV_FILE, 'utf8');
  const updatedKeys = new Set();

  const newLines = content.split('\n').map(line => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return line;
    const idx = t.indexOf('=');
    if (idx === -1) return line;
    const key = t.slice(0, idx).trim();
    if (key in updates) {
      updatedKeys.add(key);
      if (updates[key] === null) {
        return null;
      }
      return `${key}=${updates[key]}`;
    }
    return line;
  }).filter(line => line !== null);

  for (const [k, v] of Object.entries(updates)) {
    if (v === null) continue;
    if (!updatedKeys.has(k)) newLines.push(`${k}=${v}`);
  }

  fs.writeFileSync(BOT_ENV_FILE, newLines.join('\n'));
  return true;
}

function runtimeSettingDbKey(key) {
  return `${GLOBAL_SETTING_PREFIX}${key}`;
}

async function readRuntimeGroupSettings(vars) {
  const defaults = Object.fromEntries(
    [...GROUP_RUNTIME_SETTING_KEYS].map(key => [key, vars[key] ?? 'false'])
  );
  const dbKeys = Object.keys(defaults).map(runtimeSettingDbKey);
  const pool = createDbPool();
  try {
    const rows = await pool.query(
      'SELECT key, value FROM bot_settings WHERE key = ANY($1)',
      [dbKeys]
    );
    const result = { ...defaults };
    for (const row of rows.rows) {
      const key = String(row.key).replace(GLOBAL_SETTING_PREFIX, '');
      if (GROUP_RUNTIME_SETTING_KEYS.has(key)) result[key] = row.value;
    }
    return result;
  } catch (err) {
    console.error('[admin] Failed to read runtime group settings:', err.message);
    return defaults;
  } finally {
    await pool.end().catch(() => {});
  }
}

async function writeRuntimeGroupSettings(updates) {
  const entries = Object.entries(updates).filter(([key]) => GROUP_RUNTIME_SETTING_KEYS.has(key));
  if (entries.length === 0) return true;
  const pool = createDbPool();
  try {
    for (const [key, value] of entries) {
      await pool.query(
        'INSERT INTO bot_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, "updatedAt" = NOW()',
        [runtimeSettingDbKey(key), String(value)]
      );
    }
    return true;
  } catch (err) {
    console.error('[admin] Failed to write runtime group settings:', err.message);
    return false;
  } finally {
    await pool.end().catch(() => {});
  }
}

// ── Docker socket ─────────────────────────────────────────────────────────────

function dockerRequest(method, path) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath: '/var/run/docker.sock', path, method },
      res => resolve(res.statusCode)
    );
    req.on('error', reject);
    req.end();
  });
}

// ── Middleware ────────────────────────────────────────────────────────────────

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 3600 * 1000, httpOnly: true, sameSite: 'strict' },
}));

function requireAuth(req, res, next) {
  if (req.session.authenticated) return next();
  res.status(401).json({ error: 'Не авторизован' });
}

function rateLimit(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress;
  const entry = loginAttempts.get(ip) || { count: 0, lockedUntil: 0 };
  if (entry.lockedUntil > Date.now()) {
    const mins = Math.ceil((entry.lockedUntil - Date.now()) / 60000);
    return res.status(429).json({ error: `Слишком много попыток. Попробуйте через ${mins} мин.` });
  }
  next();
}

// ── API routes ────────────────────────────────────────────────────────────────

app.post('/api/login', rateLimit, (req, res) => {
  const { username, password } = req.body;
  const ip = req.ip || req.socket.remoteAddress;

  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    req.session.authenticated = true;
    loginAttempts.delete(ip);
    return res.json({ success: true });
  }

  const entry = loginAttempts.get(ip) || { count: 0, lockedUntil: 0 };
  entry.count++;
  if (entry.count >= MAX_ATTEMPTS) entry.lockedUntil = Date.now() + LOCKOUT_MS;
  loginAttempts.set(ip, entry);
  res.status(401).json({ error: 'Неверный логин или пароль' });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

app.get('/api/config', requireAuth, async (req, res) => {
  const vars = readEnvFile();
  const result = {};
  for (const [key, value] of Object.entries(vars)) {
    if (SENSITIVE_KEYS.has(key) && value && value.length > 6) {
      result[key] = { value: value.slice(0, 4) + '••••', masked: true };
    } else {
      result[key] = { value, masked: false };
    }
  }

  const runtimeSettings = await readRuntimeGroupSettings(vars);
  for (const [key, value] of Object.entries(runtimeSettings)) {
    result[key] = { value, masked: false, source: 'bot_settings' };
  }
  res.json(result);
});

async function ensureBotSettingsTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot_settings (
      key text PRIMARY KEY,
      value text NOT NULL,
      "updatedAt" timestamptz NOT NULL DEFAULT now()
    )
  `);
}

app.get('/api/ai-preset', requireAuth, async (_req, res) => {
  const vars = readEnvFile();
  const envDefaultPreset = parseAiPresetName(vars.AI_MODEL_PRESET || process.env.AI_MODEL_PRESET) || 'gpt-balanced';
  const pool = createDbPool();
  try {
    await ensureBotSettingsTable(pool);
    const result = await pool.query('SELECT value FROM bot_settings WHERE key = $1', ['AI_MODEL_PRESET']);
    const storedPreset = parseAiPresetName(result.rows[0]?.value);
    res.json({
      activePresetName: storedPreset || envDefaultPreset,
      storedPresetName: storedPreset,
      envDefaultPreset,
      availablePresets: AI_PRESET_NAMES.map((name) => AI_PRESETS[name]),
      source: storedPreset ? buildRuntimeSource() : buildConfigSource(
        'env_fallback',
        'Значение по умолчанию',
        'Runtime-настройка ещё не задана, поэтому используется env/default значение.',
        'AI_MODEL_PRESET',
        false
      ),
    });
  } catch (err) {
    res.status(500).json({ error: `Ошибка БД: ${err.message}` });
  } finally {
    await pool.end();
  }
});

app.post('/api/ai-preset', requireAuth, async (req, res) => {
  const preset = parseAiPresetName(req.body?.preset);
  if (!preset) {
    return res.status(400).json({ error: 'Неизвестный AI preset' });
  }

  const pool = createDbPool();
  try {
    await ensureBotSettingsTable(pool);
    await pool.query(
      'INSERT INTO bot_settings (key, value, "updatedAt") VALUES ($1, $2, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, "updatedAt" = now()',
      ['AI_MODEL_PRESET', preset]
    );
    res.json({ success: true, activePresetName: preset, message: '✅ AI preset сохранён и применяется без перезапуска.' });
  } catch (err) {
    res.status(500).json({ error: `Ошибка БД: ${err.message}` });
  } finally {
    await pool.end();
  }
});

app.post('/api/config', requireAuth, async (req, res) => {
  const envUpdates = {};
  const runtimeUpdates = {};
  for (const [key, value] of Object.entries(req.body)) {
    if (!EDITABLE_KEYS.has(key)) continue;
    if (typeof value === 'string' && value.includes('••••')) continue;
    if (GROUP_RUNTIME_SETTING_KEYS.has(key)) {
      runtimeUpdates[key] = value;
    } else {
      envUpdates[key] = value;
    }
  }

  const hasEnvUpdates = Object.keys(envUpdates).length > 0;
  const envOk = !hasEnvUpdates || writeEnvFile(envUpdates);
  const runtimeOk = await writeRuntimeGroupSettings(runtimeUpdates);

  if (envOk && runtimeOk) {
    const message = hasEnvUpdates
      ? '✅ Сохранено. Перезапустите боты для применения env-настроек; настройки групп применяются без рестарта.'
      : '✅ Сохранено. Настройки групп применяются без рестарта.';
    res.json({ success: true, message });
  } else if (!envOk) {
    res.status(500).json({ error: 'Файл конфигурации не найден. Проверьте volume.' });
  } else {
    res.status(500).json({ error: 'Не удалось сохранить runtime-настройки групп в БД.' });
  }
});

app.post('/api/restart/:service', requireAuth, async (req, res) => {
  const { service } = req.params;
  if (!['kira-mind-bot'].includes(service)) {
    return res.status(400).json({ error: 'Недопустимый сервис' });
  }
  try {
    const status = await dockerRequest('POST', `/v1.41/containers/${service}/restart?t=5`);
    if (status === 204) {
      res.json({ success: true, message: `🔄 ${service} перезапускается...` });
    } else if (status === 404) {
      res.status(404).json({ error: `Контейнер ${service} не найден` });
    } else {
      res.status(500).json({ error: `Docker API вернул HTTP ${status}` });
    }
  } catch (err) {
    res.status(500).json({ error: `Ошибка: ${err.message}` });
  }
});

// ── Chats ─────────────────────────────────────────────────────────────────────

function createDbPool() {
  const vars = readEnvFile();
  return new Pool({
    host: vars.DB_HOST || 'postgres',
    port: Number(vars.DB_PORT || 5432),
    user: vars.DB_USER || 'postgres',
    password: vars.DB_PASSWORD,
    database: vars.DB_NAME || 'KiraMind',
    connectionTimeoutMillis: 5000,
  });
}

app.get('/api/chats', requireAuth, async (_req, res) => {
  const pool = createDbPool();
  try {
    const result = await pool.query(
      'SELECT "chatId", title, "chatType", username, profile, "publicMode", "allowedDomains", "forbiddenTopics", "firstSeenAt", "lastSeenAt" FROM chats WHERE profile = $1 ORDER BY "lastSeenAt" DESC',
      ['KiraMindBot']
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: `Ошибка БД: ${err.message}` });
  } finally {
    await pool.end();
  }
});

app.patch('/api/chats/:chatId/forbidden-topics', requireAuth, async (req, res) => {
  const { chatId } = req.params;
  const { topics, profile } = req.body;
  if (typeof topics !== 'string') {
    return res.status(400).json({ error: 'Поле topics должно быть строкой' });
  }
  if (typeof profile !== 'string' || !profile.trim()) {
    return res.status(400).json({ error: 'Поле profile должно быть строкой' });
  }
  const pool = createDbPool();
  try {
    const result = await pool.query(
      'UPDATE chats SET "forbiddenTopics" = $1 WHERE "chatId" = $2 AND profile = $3',
      [topics, chatId, profile.trim()]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Чат не найден' });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: `Ошибка БД: ${err.message}` });
  } finally {
    await pool.end();
  }
});

app.patch('/api/chats/:chatId/allowed-domains', requireAuth, async (req, res) => {
  const { chatId } = req.params;
  const { domains, profile } = req.body;
  if (!Array.isArray(domains)) {
    return res.status(400).json({ error: 'Поле domains должно быть массивом строк' });
  }
  if (typeof profile !== 'string' || !profile.trim()) {
    return res.status(400).json({ error: 'Поле profile должно быть строкой' });
  }
  const pool = createDbPool();
  try {
    const result = await pool.query(
      'UPDATE chats SET "allowedDomains" = $1 WHERE "chatId" = $2 AND profile = $3',
      [JSON.stringify(domains), chatId, profile.trim()]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Чат не найден' });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: `Ошибка БД: ${err.message}` });
  } finally {
    await pool.end();
  }
});

app.patch('/api/chats/:chatId/public-mode', requireAuth, async (req, res) => {
  const { chatId } = req.params;
  const { enabled, profile } = req.body;
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'Поле enabled должно быть boolean' });
  }
  if (typeof profile !== 'string' || !profile.trim()) {
    return res.status(400).json({ error: 'Поле profile должно быть строкой' });
  }
  const pool = createDbPool();
  try {
    const result = await pool.query(
      'UPDATE chats SET "publicMode" = $1 WHERE "chatId" = $2 AND profile = $3',
      [enabled, chatId, profile.trim()]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Чат не найден' });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: `Ошибка БД: ${err.message}` });
  } finally {
    await pool.end();
  }
});

// ── Health diary ─────────────────────────────────────────────────────────────

const HEALTH_LOG_KINDS = new Set([
  'food',
  'drink',
  'symptom',
  'medication',
  'activity',
  'skin',
  'blood_pressure',
  'note',
]);

const HEALTH_KIND_LABELS = {
  food: 'Еда',
  drink: 'Напиток',
  symptom: 'Симптомы',
  medication: 'Лекарство',
  activity: 'Активность/контакт',
  skin: 'Кожа',
  blood_pressure: 'Давление',
  note: 'Заметка',
};

const HEALTH_EXPORT_LIMIT = 10000;

function firstQueryValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

function httpInputError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

// ── Memory management ────────────────────────────────────────────────────────

const MEMORY_DOMAINS = [
  'work',
  'health',
  'family',
  'finance',
  'education',
  'hobbies',
  'travel',
  'social',
  'home',
  'personal',
  'entertainment',
  'general',
  'contacts',
];

const MEMORY_KINDS = new Set([
  'fact',
  'episode',
  'chapter',
  'trait',
  'preference',
  'goal',
  'open_loop',
  'relationship',
  'routine',
  'boundary',
  'promise',
  'prospective',
  'portrait',
  'event',
  'state',
  'unknown',
]);

const MEMORY_STATUSES = new Set(['active', 'planned', 'done', 'superseded', 'expired', 'unknown']);
const MEMORY_SUBJECTS = new Set(['user', 'contact', 'bot', 'system']);
const MEMORY_FOCUSES = new Set([
  'open_loops',
  'stale',
  'low_confidence',
  'weak_evidence',
  'no_source',
  'anchors',
  'synthetic',
  'contacts',
]);
const MEMORY_PROFILE_TO_BOT_ID = {
  KiraMindBot: 'kiramindbot',
};

function parseBooleanQuery(value, fallback = false) {
  const raw = firstQueryValue(value);
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (typeof raw === 'boolean') return raw;
  return String(raw).toLowerCase() === 'true';
}

function getMemoryProfile(value) {
  const profile = String(firstQueryValue(value) || 'KiraMindBot').trim();
  if (!MEMORY_PROFILE_TO_BOT_ID[profile]) {
    throw httpInputError('Недопустимый profile');
  }
  return profile;
}

function getMemoryUserId(profile, explicitUserId) {
  const raw = firstQueryValue(explicitUserId);
  if (typeof raw === 'string' && raw.trim()) {
    if (!/^-?\d+$/.test(raw.trim())) throw httpInputError('userId должен быть числом');
    return raw.trim();
  }

  const vars = readEnvFile();
  const envKey = 'KIRA_ALLOWED_USER_ID';
  return String(vars[envKey] || process.env[envKey] || '').trim();
}

function getMemoryBotId(profile) {
  return MEMORY_PROFILE_TO_BOT_ID[profile];
}

function memoryCollection(profile, domain) {
  return `${getMemoryBotId(profile)}_memories_${domain}`;
}

function normalizeMemoryDomain(value, fallback = 'general') {
  const domain = String(value || fallback).trim().toLowerCase();
  if (!MEMORY_DOMAINS.includes(domain)) {
    throw httpInputError('Недопустимый домен памяти');
  }
  return domain;
}

function getQdrantConfig() {
  const vars = readEnvFile();
  return {
    url: String(vars.QDRANT_URL || process.env.QDRANT_URL || 'http://qdrant:6333').replace(/\/+$/, ''),
    apiKey: vars.QDRANT_API_KEY || process.env.QDRANT_API_KEY || '',
  };
}

async function qdrantRequest(pathname, options = {}) {
  const { url, apiKey } = getQdrantConfig();
  const headers = { ...(options.headers || {}) };
  if (apiKey) headers['api-key'] = apiKey;
  if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';

  const response = await fetch(`${url}${pathname}`, { ...options, headers });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const error = new Error(`Qdrant HTTP ${response.status}${body ? `: ${body.slice(0, 300)}` : ''}`);
    error.statusCode = response.status === 404 ? 404 : 502;
    throw error;
  }
  return response.json();
}

async function collectionExists(collection) {
  try {
    await qdrantRequest(`/collections/${encodeURIComponent(collection)}`);
    return true;
  } catch (err) {
    if (err.statusCode === 404) return false;
    throw err;
  }
}

async function ensureMemoryCollection(profile, domain, vectorSize = 1536) {
  const collection = memoryCollection(profile, domain);
  if (await collectionExists(collection)) return collection;
  await qdrantRequest(`/collections/${encodeURIComponent(collection)}`, {
    method: 'PUT',
    body: JSON.stringify({ vectors: { size: vectorSize, distance: 'Cosine' } }),
  });
  return collection;
}

async function getOpenAiEmbedding(text) {
  const vars = readEnvFile();
  const apiKey = vars.OPENAI_API_KEY || process.env.OPENAI_API_KEY || '';
  if (!apiKey) throw httpInputError('OPENAI_API_KEY не задан: нельзя пересчитать embedding');

  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'text-embedding-ada-002',
      input: text,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const error = new Error(`OpenAI embeddings HTTP ${response.status}${body ? `: ${body.slice(0, 300)}` : ''}`);
    error.statusCode = 502;
    throw error;
  }

  const data = await response.json();
  const embedding = data?.data?.[0]?.embedding;
  if (!Array.isArray(embedding)) {
    const error = new Error('OpenAI не вернул embedding');
    error.statusCode = 502;
    throw error;
  }
  return embedding;
}

function activeMemoryMustNotFilter() {
  return [{ key: 'expiresAt', range: { lt: new Date().toISOString() } }];
}

async function scrollQdrantCollection(collection, filter, max = 2000) {
  const points = [];
  let offset;
  while (points.length < max) {
    const remaining = max - points.length;
    const response = await qdrantRequest(`/collections/${encodeURIComponent(collection)}/points/scroll`, {
      method: 'POST',
      body: JSON.stringify({
        filter,
        limit: Math.min(256, remaining),
        offset,
        with_payload: true,
        with_vector: false,
      }),
    });
    const result = response.result || {};
    points.push(...(result.points || []));
    if (!result.next_page_offset) break;
    offset = result.next_page_offset;
  }
  return points;
}

function normalizeMemoryTags(value) {
  const tags = Array.isArray(value)
    ? value
    : String(value || '').split(',');
  return [...new Set(tags
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .slice(0, 30))];
}

function normalizePreviousVersions(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => ({
      content: String(entry?.content || ''),
      timestamp: entry?.timestamp || new Date().toISOString(),
      confidence: typeof entry?.confidence === 'number' ? entry.confidence : 0.6,
    }))
    .filter((entry) => entry.content.trim())
    .slice(0, 10);
}

function normalizeMemoryPoint(point, fallbackDomain) {
  const payload = point.payload || {};
  const tags = normalizeMemoryTags(payload.tags);
  return {
    id: String(payload.id || point.id),
    content: String(payload.content || ''),
    domain: String(payload.domain || fallbackDomain),
    botId: payload.botId ? String(payload.botId) : '',
    userId: payload.userId == null ? '' : String(payload.userId),
    timestamp: payload.timestamp || null,
    importance: typeof payload.importance === 'number' ? payload.importance : 0.5,
    tags,
    confidence: typeof payload.confidence === 'number' ? payload.confidence : 0.6,
    isAnchor: Boolean(payload.isAnchor),
    memoryKind: payload.memoryKind ? String(payload.memoryKind) : 'fact',
    status: payload.status ? String(payload.status) : 'active',
    subject: payload.subject ? String(payload.subject) : undefined,
    predicate: payload.predicate ? String(payload.predicate) : undefined,
    object: payload.object ? String(payload.object) : undefined,
    extractionMethod: payload.extractionMethod ? String(payload.extractionMethod) : undefined,
    sourceContext: payload.sourceContext ? String(payload.sourceContext) : undefined,
    sourceEpisodeId: payload.sourceEpisodeId ? String(payload.sourceEpisodeId) : undefined,
    sourceMemoryIds: Array.isArray(payload.sourceMemoryIds) ? payload.sourceMemoryIds.map(String) : [],
    sourceMessageIds: Array.isArray(payload.sourceMessageIds) ? payload.sourceMessageIds.map(String) : [],
    previousVersions: normalizePreviousVersions(payload.previousVersions),
    validFrom: payload.validFrom || null,
    validTo: payload.validTo || null,
    expiresAt: payload.expiresAt || null,
    lastAccessedAt: payload.lastAccessedAt || null,
    lastRetrievedAt: payload.lastRetrievedAt || null,
    retrievalCount: typeof payload.retrievalCount === 'number' ? payload.retrievalCount : 0,
    confirmationCount: typeof payload.confirmationCount === 'number' ? payload.confirmationCount : 0,
    lastConfirmedAt: payload.lastConfirmedAt || null,
    synthetic: isSyntheticMemoryPayload(payload),
  };
}

function isSyntheticMemoryPayload(payload) {
  const tags = normalizeMemoryTags(payload.tags);
  const content = String(payload.content || '');
  return tags.includes('memory-episode') ||
    tags.includes('memory-chapter') ||
    tags.includes('memory-schema') ||
    tags.includes('sleep_open_loop_index') ||
    tags.includes('sleep_uncertainty_index') ||
    content.startsWith('[ЭПИЗОД ПАМЯТИ:') ||
    content.startsWith('[ГЛАВА ПАМЯТИ:') ||
    content.startsWith('[МОДЕЛЬ ПАМЯТИ:') ||
    content.startsWith('[ИНДЕКС ОТКРЫТЫХ ЛИНИЙ ПАМЯТИ]') ||
    content.startsWith('[ИНДЕКС СОМНЕНИЙ ПАМЯТИ]');
}

function isOpenLoopIndex(record) {
  return record.tags.includes('sleep_open_loop_index') ||
    record.content.startsWith('[ИНДЕКС ОТКРЫТЫХ ЛИНИЙ ПАМЯТИ]');
}

function isUncertaintyIndex(record) {
  return record.tags.includes('sleep_uncertainty_index') ||
    record.content.startsWith('[ИНДЕКС СОМНЕНИЙ ПАМЯТИ]');
}

function isContactRecord(record) {
  return record.domain === 'contacts' ||
    record.tags.includes('subject:contact') ||
    record.tags.some((tag) =>
      tag.startsWith('contact:') ||
      tag.startsWith('contact_name:') ||
      tag.startsWith('contact_alias:') ||
      tag.startsWith('contact_id:') ||
      tag.startsWith('contact_key:')
    ) ||
    /^\[[^\]]+\]\s+/.test(record.content);
}

function isOpenLoopRecord(record) {
  return record.status === 'planned' ||
    record.memoryKind === 'open_loop' ||
    record.memoryKind === 'goal' ||
    record.memoryKind === 'promise' ||
    record.memoryKind === 'prospective' ||
    record.tags.includes('temporal_scope:future_plan');
}

function isStaleRecord(record, now = Date.now()) {
  return record.tags.includes('possibly-stale') ||
    record.tags.includes('sleep-softened') ||
    record.status === 'unknown' ||
    (record.memoryKind === 'state' && record.timestamp && now - memoryDateMs(record.timestamp) > 120 * 24 * 60 * 60 * 1000) ||
    (isOpenLoopRecord(record) && record.timestamp && now - memoryDateMs(record.timestamp) > 60 * 24 * 60 * 60 * 1000);
}

function isWeakEvidenceRecord(record) {
  return record.tags.includes('weak-evidence') ||
    record.tags.includes('needs-caution') ||
    record.tags.includes('inference:ambiguous') ||
    record.tags.includes('inference:inferred') ||
    record.tags.includes('importance-capped') ||
    record.tags.includes('anchor-capped') ||
    record.tags.some((tag) => tag.startsWith('quality:'));
}

function hasSourceRecord(record) {
  return Boolean(
    record.synthetic ||
    record.sourceContext ||
    record.sourceEpisodeId ||
    record.sourceMemoryIds.length > 0 ||
    record.sourceMessageIds.length > 0
  );
}

function memoryDateMs(value) {
  const ms = value ? new Date(value).getTime() : 0;
  return Number.isFinite(ms) ? ms : 0;
}

function buildMemoryStats(records) {
  const byDomain = {};
  const byKind = {};
  const byStatus = {};
  let confidenceSum = 0;
  let lowConfidence = 0;
  let stale = 0;
  let openLoops = 0;
  let weakEvidence = 0;
  let noSource = 0;
  let contacts = 0;
  let synthetic = 0;
  let anchors = 0;
  let lastUpdatedAt = null;
  let openLoopIndex = null;
  let uncertaintyIndex = null;
  const now = Date.now();

  for (const record of records) {
    byDomain[record.domain] = (byDomain[record.domain] || 0) + 1;
    byKind[record.memoryKind || 'fact'] = (byKind[record.memoryKind || 'fact'] || 0) + 1;
    byStatus[record.status || 'active'] = (byStatus[record.status || 'active'] || 0) + 1;
    confidenceSum += record.confidence ?? 0.6;
    if ((record.confidence ?? 0.6) < 0.55) lowConfidence++;
    if (record.synthetic) synthetic++;
    if (record.isAnchor) anchors++;
    if (isStaleRecord(record, now)) stale++;
    if (isOpenLoopRecord(record)) openLoops++;
    if (isWeakEvidenceRecord(record)) weakEvidence++;
    if (!hasSourceRecord(record)) noSource++;
    if (isContactRecord(record)) contacts++;
    if (!lastUpdatedAt || memoryDateMs(record.timestamp) > memoryDateMs(lastUpdatedAt)) {
      lastUpdatedAt = record.timestamp;
    }
    if (isOpenLoopIndex(record) && (!openLoopIndex || memoryDateMs(record.timestamp) > memoryDateMs(openLoopIndex.timestamp))) {
      openLoopIndex = record;
    }
    if (isUncertaintyIndex(record) && (!uncertaintyIndex || memoryDateMs(record.timestamp) > memoryDateMs(uncertaintyIndex.timestamp))) {
      uncertaintyIndex = record;
    }
  }

  return {
    total: records.length,
    avgConfidence: records.length ? confidenceSum / records.length : null,
    lowConfidence,
    stale,
    openLoops,
    weakEvidence,
    noSource,
    contacts,
    synthetic,
    anchors,
    lastUpdatedAt,
    byDomain: Object.entries(byDomain).map(([domain, count]) => ({ domain, count })).sort((a, b) => b.count - a.count),
    byKind: Object.entries(byKind).map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count),
    byStatus: Object.entries(byStatus).map(([status, count]) => ({ status, count })).sort((a, b) => b.count - a.count),
    dreaming: {
      openLoopIndex,
      uncertaintyIndex,
    },
  };
}

async function fetchMemoryRecords(profile, userId, domainFilter) {
  const botId = getMemoryBotId(profile);
  const domains = domainFilter ? [domainFilter] : MEMORY_DOMAINS;
  const maxPerDomain = Number(process.env.MEMORY_PANEL_MAX_POINTS_PER_DOMAIN || 2000);
  const records = [];

  await Promise.all(domains.map(async (domain) => {
    const collection = memoryCollection(profile, domain);
    if (!(await collectionExists(collection))) return;
    const filter = {
      must: [
        { key: 'botId', match: { value: botId } },
        userId ? { key: 'userId', match: { value: userId } } : undefined,
      ].filter(Boolean),
      must_not: activeMemoryMustNotFilter(),
    };
    const points = await scrollQdrantCollection(collection, filter, maxPerDomain);
    for (const point of points) {
      const record = normalizeMemoryPoint(point, domain);
      if (record.content) records.push(record);
    }
  }));

  return records.sort((a, b) => memoryDateMs(b.timestamp) - memoryDateMs(a.timestamp));
}

function applyMemoryFilters(records, query) {
  const q = String(firstQueryValue(query.q) || '').trim().toLowerCase();
  const kind = String(firstQueryValue(query.kind) || '').trim();
  const status = String(firstQueryValue(query.status) || '').trim();
  const focus = String(firstQueryValue(query.focus) || '').trim();
  const includeSynthetic = parseBooleanQuery(query.includeSynthetic, true);
  if (focus && !MEMORY_FOCUSES.has(focus)) {
    throw httpInputError('Недопустимый focus');
  }

  return records.filter((record) => {
    if (!includeSynthetic && record.synthetic) return false;
    if (kind && record.memoryKind !== kind) return false;
    if (status && record.status !== status) return false;
    if (focus === 'open_loops' && !isOpenLoopRecord(record)) return false;
    if (focus === 'stale' && !isStaleRecord(record)) return false;
    if (focus === 'low_confidence' && (record.confidence ?? 0.6) >= 0.55) return false;
    if (focus === 'weak_evidence' && !isWeakEvidenceRecord(record)) return false;
    if (focus === 'no_source' && hasSourceRecord(record)) return false;
    if (focus === 'anchors' && !record.isAnchor) return false;
    if (focus === 'synthetic' && !record.synthetic) return false;
    if (focus === 'contacts' && !isContactRecord(record)) return false;
    if (!q) return true;
    const haystack = [
      record.content,
      record.domain,
      record.memoryKind,
      record.status,
      record.subject,
      record.predicate,
      record.object,
      record.sourceContext,
      record.tags.join(' '),
    ].filter(Boolean).join('\n').toLowerCase();
    return haystack.includes(q);
  });
}

async function fetchExistingMemoryPayload(profile, domain, id) {
  const collection = memoryCollection(profile, domain);
  const response = await qdrantRequest(`/collections/${encodeURIComponent(collection)}/points`, {
    method: 'POST',
    body: JSON.stringify({
      ids: [id],
      with_payload: true,
      with_vector: false,
    }),
  });
  return response.result?.[0]?.payload || null;
}

function clamp01(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(1, Math.max(0, parsed));
}

function estimateMemorySpecificity(content, tags) {
  let score = 0.25;
  if (/\b\d{1,2}[./-]\d{1,2}(?:[./-]\d{2,4})?\b|\b20\d{2}\b/.test(content)) score += 0.18;
  if (/[А-ЯЁA-Z][А-ЯЁA-Zа-яёa-z-]+/.test(content)) score += 0.14;
  if (content.length >= 80) score += 0.10;
  if (tags.length >= 2) score += 0.06;
  return clamp01(score, 0.35);
}

function buildAdminMemoryPayload({ id, profile, userId, domain, body, existingPayload }) {
  const now = new Date().toISOString();
  const existingContent = String(existingPayload?.content || '').trim();
  const content = String(body.content || existingContent).trim();
  if (content.length < 3) throw httpInputError('content должен быть длиннее 3 символов');
  if (content.length > 4000) throw httpInputError('content слишком длинный');

  const rawTags = body.tags !== undefined ? normalizeMemoryTags(body.tags) : normalizeMemoryTags(existingPayload?.tags);
  const subject = MEMORY_SUBJECTS.has(String(body.subject || existingPayload?.subject || 'user'))
    ? String(body.subject || existingPayload?.subject || 'user')
    : 'user';
  const tags = [...new Set([
    ...rawTags,
    'manual-admin',
    rawTags.some((tag) => tag.startsWith('subject:')) ? undefined : `subject:${subject}`,
  ].filter(Boolean))];

  const memoryKind = String(body.memoryKind || existingPayload?.memoryKind || 'fact');
  const status = String(body.status || existingPayload?.status || 'active');
  if (!MEMORY_KINDS.has(memoryKind)) throw httpInputError('Недопустимый memoryKind');
  if (!MEMORY_STATUSES.has(status)) throw httpInputError('Недопустимый status');

  const importance = clamp01(body.importance, typeof existingPayload?.importance === 'number' ? existingPayload.importance : 0.7);
  const confidence = clamp01(body.confidence, typeof existingPayload?.confidence === 'number' ? existingPayload.confidence : 0.82);
  const contentChanged = Boolean(existingPayload) && content !== existingContent;
  const previousVersions = normalizePreviousVersions(existingPayload?.previousVersions);
  if (contentChanged && existingContent) {
    previousVersions.unshift({
      content: existingContent,
      timestamp: existingPayload.timestamp || now,
      confidence: typeof existingPayload.confidence === 'number' ? existingPayload.confidence : 0.6,
    });
  }

  const specificity = estimateMemorySpecificity(content, tags);
  const strength = clamp01((importance * 0.42) + (confidence * 0.30) + specificity * 0.14 + (body.isAnchor ? 0.12 : 0), 0.65);

  const payload = {
    ...(existingPayload || {}),
    id,
    content,
    domain,
    botId: getMemoryBotId(profile),
    characterName: 'Кира',
    userId,
    timestamp: contentChanged || !existingPayload ? now : existingPayload.timestamp || now,
    importance,
    tags,
    confidence,
    isAnchor: Boolean(body.isAnchor ?? existingPayload?.isAnchor),
    lastAccessedAt: now,
    previousVersions: previousVersions.length ? previousVersions.slice(0, 10) : undefined,
    memoryKind,
    status,
    subject,
    predicate: body.predicate !== undefined ? String(body.predicate || '').trim() || undefined : existingPayload?.predicate,
    object: body.object !== undefined ? String(body.object || '').trim() || undefined : existingPayload?.object || content,
    extractionMethod: 'manual',
    sourceContext: body.sourceContext !== undefined
      ? String(body.sourceContext || '').trim() || undefined
      : existingPayload?.sourceContext || 'Добавлено или исправлено вручную через admin-panel.',
    strength,
    specificity,
    vividness: typeof existingPayload?.vividness === 'number' ? existingPayload.vividness : Math.min(0.65, 0.22 + specificity * 0.3),
  };

  for (const key of Object.keys(payload)) {
    if (payload[key] === undefined || payload[key] === '') delete payload[key];
  }

  return payload;
}

app.get('/api/memory', requireAuth, async (req, res) => {
  try {
    const profile = getMemoryProfile(req.query.profile);
    const userId = getMemoryUserId(profile, req.query.userId);
    const domain = firstQueryValue(req.query.domain)
      ? normalizeMemoryDomain(firstQueryValue(req.query.domain))
      : '';
    const limit = normalizeIntegerQuery(req.query.limit, 100, 500);
    const offset = Math.max(0, normalizeIntegerQuery(req.query.offset, 0, 100000));
    const records = await fetchMemoryRecords(profile, userId, domain);
    const stats = buildMemoryStats(records);
    const filtered = applyMemoryFilters(records, req.query);

    res.json({
      records: filtered.slice(offset, offset + limit),
      total: filtered.length,
      limit,
      offset,
      filters: {
        profile,
        userId,
        domain: domain || undefined,
        q: firstQueryValue(req.query.q) || undefined,
        kind: firstQueryValue(req.query.kind) || undefined,
        status: firstQueryValue(req.query.status) || undefined,
        focus: firstQueryValue(req.query.focus) || undefined,
        includeSynthetic: parseBooleanQuery(req.query.includeSynthetic, true),
      },
      stats,
      domains: MEMORY_DOMAINS,
      kinds: [...MEMORY_KINDS],
      statuses: [...MEMORY_STATUSES],
      focuses: [...MEMORY_FOCUSES],
    });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.statusCode ? err.message : `Ошибка памяти: ${err.message}` });
  }
});

app.post('/api/memory', requireAuth, async (req, res) => {
  try {
    const profile = getMemoryProfile(req.body.profile);
    const userId = getMemoryUserId(profile, req.body.userId);
    if (!userId) throw httpInputError('Не найден userId владельца для выбранного профиля');
    const domain = normalizeMemoryDomain(req.body.domain);
    const id = crypto.randomUUID();
    const payload = buildAdminMemoryPayload({ id, profile, userId, domain, body: req.body, existingPayload: null });
    const vector = await getOpenAiEmbedding(payload.content);
    const collection = await ensureMemoryCollection(profile, domain, vector.length);

    await qdrantRequest(`/collections/${encodeURIComponent(collection)}/points?wait=true`, {
      method: 'PUT',
      body: JSON.stringify({ points: [{ id, vector, payload }] }),
    });

    res.json({ success: true, record: normalizeMemoryPoint({ id, payload }, domain) });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.statusCode ? err.message : `Ошибка сохранения памяти: ${err.message}` });
  }
});

app.patch('/api/memory/:domain/:id', requireAuth, async (req, res) => {
  try {
    const profile = getMemoryProfile(req.body.profile || req.query.profile);
    const userId = getMemoryUserId(profile, req.body.userId || req.query.userId);
    const domain = normalizeMemoryDomain(req.params.domain);
    const id = String(req.params.id || '').trim();
    if (!id) throw httpInputError('id обязателен');

    const existingPayload = await fetchExistingMemoryPayload(profile, domain, id);
    if (!existingPayload) return res.status(404).json({ error: 'Воспоминание не найдено' });
    if (userId && String(existingPayload.userId || '') !== userId) {
      return res.status(404).json({ error: 'Воспоминание не найдено для выбранного userId' });
    }

    const payload = buildAdminMemoryPayload({
      id,
      profile,
      userId: String(existingPayload.userId || userId),
      domain,
      body: req.body,
      existingPayload,
    });
    const vector = await getOpenAiEmbedding(payload.content);
    const collection = await ensureMemoryCollection(profile, domain, vector.length);

    await qdrantRequest(`/collections/${encodeURIComponent(collection)}/points?wait=true`, {
      method: 'PUT',
      body: JSON.stringify({ points: [{ id, vector, payload }] }),
    });

    res.json({ success: true, record: normalizeMemoryPoint({ id, payload }, domain) });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.statusCode ? err.message : `Ошибка обновления памяти: ${err.message}` });
  }
});

app.delete('/api/memory/:domain/:id', requireAuth, async (req, res) => {
  try {
    const profile = getMemoryProfile(req.query.profile);
    const userId = getMemoryUserId(profile, req.query.userId);
    const domain = normalizeMemoryDomain(req.params.domain);
    const id = String(req.params.id || '').trim();
    if (!id) throw httpInputError('id обязателен');

    const existingPayload = await fetchExistingMemoryPayload(profile, domain, id);
    if (!existingPayload) return res.status(404).json({ error: 'Воспоминание не найдено' });
    if (userId && String(existingPayload.userId || '') !== userId) {
      return res.status(404).json({ error: 'Воспоминание не найдено для выбранного userId' });
    }

    const collection = memoryCollection(profile, domain);
    await qdrantRequest(`/collections/${encodeURIComponent(collection)}/points/delete?wait=true`, {
      method: 'POST',
      body: JSON.stringify({ points: [id] }),
    });
    res.json({ success: true });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.statusCode ? err.message : `Ошибка удаления памяти: ${err.message}` });
  }
});

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

function getUserTimeZone() {
  const vars = readEnvFile();
  return vars.USER_TIMEZONE || process.env.USER_TIMEZONE || 'Europe/Moscow';
}

function formatHealthDateTime(value) {
  return new Date(value).toLocaleString('ru-RU', {
    timeZone: getUserTimeZone(),
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatHealthDay(value) {
  return new Date(value).toLocaleDateString('ru-RU', {
    timeZone: getUserTimeZone(),
    day: '2-digit',
    month: 'long',
    year: 'numeric',
    weekday: 'long',
  });
}

function formatHealthTime(value) {
  return new Date(value).toLocaleTimeString('ru-RU', {
    timeZone: getUserTimeZone(),
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatFileDate(value) {
  const date = new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function ensureStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => typeof item === 'string' ? item.trim() : String(item ?? '').trim())
    .filter(Boolean);
}

function formatStructuredValue(value) {
  if (value == null) return '';
  if (Array.isArray(value)) return ensureStringArray(value).join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function formatHealthList(label, value) {
  const items = ensureStringArray(value);
  return items.length ? `${label}: ${items.join(', ')}` : null;
}

function formatHealthScalar(label, value) {
  if (value == null || value === '') return null;
  return `${label}: ${formatStructuredValue(value)}`;
}

function buildHealthLogFilters(query, options = {}) {
  const values = [];
  const clauses = [];
  const meta = {};
  const defaultDays = options.defaultDays ?? 30;

  const profile = firstQueryValue(query.profile);
  if (typeof profile === 'string' && profile.trim()) {
    values.push(profile.trim());
    clauses.push(`profile = $${values.length}`);
    meta.profile = profile.trim();
  }

  const userId = firstQueryValue(query.userId);
  if (typeof userId === 'string' && userId.trim()) {
    if (!/^-?\d+$/.test(userId.trim())) throw httpInputError('userId должен быть числом');
    values.push(userId.trim());
    clauses.push(`"userId" = $${values.length}`);
    meta.userId = userId.trim();
  }

  const kind = firstQueryValue(query.kind);
  if (typeof kind === 'string' && kind.trim()) {
    if (!HEALTH_LOG_KINDS.has(kind.trim())) throw httpInputError('Недопустимый тип записи');
    values.push(kind.trim());
    clauses.push(`kind = $${values.length}`);
    meta.kind = kind.trim();
  }

  const fromRaw = firstQueryValue(query.from);
  const toRaw = firstQueryValue(query.to);
  let from = parseDateQuery(fromRaw, false);
  let to = parseDateQuery(toRaw, true);
  if (fromRaw && !from) throw httpInputError('Некорректная дата from');
  if (toRaw && !to) throw httpInputError('Некорректная дата to');

  const daysRaw = firstQueryValue(query.days);
  if (!from && !to && daysRaw !== 'all' && defaultDays) {
    const days = normalizeIntegerQuery(daysRaw, defaultDays, 3650);
    to = new Date();
    from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
    meta.days = days;
  }

  if (from && to && from.getTime() > to.getTime()) {
    throw httpInputError('Дата from должна быть раньше to');
  }

  if (from) {
    values.push(from);
    clauses.push(`"occurredAt" >= $${values.length}`);
    meta.from = from.toISOString();
  }
  if (to) {
    values.push(to);
    clauses.push(`"occurredAt" <= $${values.length}`);
    meta.to = to.toISOString();
  }

  const search = firstQueryValue(query.q);
  if (typeof search === 'string' && search.trim()) {
    values.push(`%${search.trim()}%`);
    clauses.push(`(
      COALESCE("rawText", '') ILIKE $${values.length}
      OR COALESCE(summary, '') ILIKE $${values.length}
      OR COALESCE(tags::text, '') ILIKE $${values.length}
      OR COALESCE(structured::text, '') ILIKE $${values.length}
    )`);
    meta.q = search.trim();
  }

  return {
    whereSql: clauses.length ? clauses.join(' AND ') : 'TRUE',
    values,
    meta,
  };
}

function normalizeHealthLogRow(row) {
  return {
    id: row.id,
    profile: row.profile ?? null,
    userId: row.userId == null ? null : String(row.userId),
    chatId: row.chatId == null ? null : String(row.chatId),
    kind: row.kind,
    rawText: row.rawText,
    summary: row.summary,
    severity: row.severity,
    occurredAt: row.occurredAt instanceof Date ? row.occurredAt.toISOString() : row.occurredAt,
    timeOfDay: row.timeOfDay,
    structured: row.structured,
    tags: Array.isArray(row.tags) ? row.tags : [],
    photoFileId: row.photoFileId,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
  };
}

function healthBaseSelect() {
  return 'SELECT id, profile, "userId", "chatId", kind, "rawText", summary, severity, "occurredAt", "timeOfDay", structured, tags, "photoFileId", "createdAt" FROM health_logs';
}

function healthRecordSummary(record) {
  return record.summary || record.rawText || '';
}

function buildHealthTxtExport(records, from, to, truncated) {
  const lines = [
    'Дневник здоровья',
    `Период: ${formatHealthDateTime(from)} - ${formatHealthDateTime(to)}`,
    `Записей: ${records.length}${truncated ? ` (показаны первые ${HEALTH_EXPORT_LIMIT})` : ''}`,
    '',
    'Важно: это личный дневник наблюдений, не медицинское заключение.',
    '',
  ];

  let currentDay = '';
  for (const record of records) {
    const day = formatHealthDay(record.occurredAt);
    if (day !== currentDay) {
      currentDay = day;
      lines.push(day);
    }

    const structured = record.structured ?? {};
    const details = [
      formatHealthList('Еда', structured.foods),
      formatHealthList('Напитки', structured.drinks),
      formatHealthList('Симптомы', structured.symptoms),
      formatHealthList('Зоны', structured.bodyAreas),
      formatHealthList('Лекарства', structured.medications),
      formatHealthList('Активности/контакты', structured.activities),
      formatHealthList('Вероятные ингредиенты', structured.possibleIngredients),
      formatHealthList('Пищевые флаги из фото', structured.possibleAllergenFlags),
      formatHealthList('Видимые признаки кожи', structured.visibleFindings),
      formatHealthList('Морфология', structured.morphology),
      formatHealthList('Возможные триггеры', structured.suspectedTriggers),
      formatHealthList('Заметки', structured.notes),
      formatHealthScalar('Распределение', structured.distribution),
      formatHealthScalar('Покраснение', structured.redness),
      formatHealthScalar('Отёк', structured.swelling),
      formatHealthScalar('Текстура кожи', structured.skinTexture),
      formatHealthScalar('Субъективный зуд/дискомфорт', typeof structured.subjectiveDiscomfortLevel === 'number' ? `${structured.subjectiveDiscomfortLevel}/10` : undefined),
      formatHealthScalar('AI-оценка фото недоступна', structured.analysisUnavailableReason),
      formatHealthList('Теги', record.tags),
      record.photoFileId ? `Фото Telegram file_id: ${record.photoFileId}` : null,
    ].filter(Boolean);

    lines.push(`- ${formatHealthTime(record.occurredAt)} (${record.timeOfDay || 'время суток не указано'}) [${HEALTH_KIND_LABELS[record.kind] ?? record.kind}] ${healthRecordSummary(record)}`);
    if (record.severity != null) lines.push(`  Выраженность: ${record.severity}/10`);
    for (const detail of details) lines.push(`  ${detail}`);
    lines.push(`  Исходный текст: ${record.rawText}`);
    lines.push('');
  }

  return lines.join('\n');
}

function csvEscape(value) {
  const text = value == null ? '' : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function buildHealthCsvExport(records) {
  const headers = [
    'id',
    'profile',
    'userId',
    'chatId',
    'kind',
    'kindLabel',
    'occurredAt',
    'timeOfDay',
    'severity',
    'summary',
    'rawText',
    'tags',
    'structured',
    'photoFileId',
    'createdAt',
  ];
  const rows = records.map((record) => [
    record.id,
    record.profile,
    record.userId,
    record.chatId,
    record.kind,
    HEALTH_KIND_LABELS[record.kind] ?? record.kind,
    record.occurredAt,
    record.timeOfDay,
    record.severity,
    record.summary,
    record.rawText,
    Array.isArray(record.tags) ? record.tags.join(', ') : '',
    record.structured ? JSON.stringify(record.structured) : '',
    record.photoFileId,
    record.createdAt,
  ]);
  return '\ufeff' + [headers, ...rows].map((row) => row.map(csvEscape).join(',')).join('\n');
}

app.get('/api/health/logs', requireAuth, async (req, res) => {
  const pool = createDbPool();
  try {
    const filters = buildHealthLogFilters(req.query);
    const limit = normalizeIntegerQuery(req.query.limit, 100, 500);
    const offset = Math.max(0, normalizeIntegerQuery(req.query.offset, 0, 100000));

    const [statsResult, byKindResult, rowsResult] = await Promise.all([
      pool.query(
        `SELECT COUNT(*)::int AS total, MIN("occurredAt") AS "firstOccurredAt", MAX("occurredAt") AS "lastOccurredAt", AVG(severity)::float AS "avgSeverity" FROM health_logs WHERE ${filters.whereSql}`,
        filters.values
      ),
      pool.query(
        `SELECT kind, COUNT(*)::int AS count FROM health_logs WHERE ${filters.whereSql} GROUP BY kind ORDER BY count DESC`,
        filters.values
      ),
      pool.query(
        `${healthBaseSelect()} WHERE ${filters.whereSql} ORDER BY "occurredAt" DESC LIMIT $${filters.values.length + 1} OFFSET $${filters.values.length + 2}`,
        filters.values.concat([limit, offset])
      ),
    ]);

    res.json({
      records: rowsResult.rows.map(normalizeHealthLogRow),
      total: statsResult.rows[0]?.total ?? 0,
      limit,
      offset,
      filters: filters.meta,
      stats: {
        total: statsResult.rows[0]?.total ?? 0,
        firstOccurredAt: statsResult.rows[0]?.firstOccurredAt ?? null,
        lastOccurredAt: statsResult.rows[0]?.lastOccurredAt ?? null,
        avgSeverity: statsResult.rows[0]?.avgSeverity ?? null,
        byKind: byKindResult.rows,
      },
    });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.statusCode ? err.message : `Ошибка БД: ${err.message}` });
  } finally {
    await pool.end();
  }
});

app.get('/api/health/export', requireAuth, async (req, res) => {
  const pool = createDbPool();
  try {
    const format = (firstQueryValue(req.query.format) || 'txt').toString().toLowerCase();
    if (!['txt', 'csv', 'json'].includes(format)) {
      return res.status(400).json({ error: 'format должен быть txt, csv или json' });
    }

    const filters = buildHealthLogFilters(req.query);
    const countResult = await pool.query(`SELECT COUNT(*)::int AS total FROM health_logs WHERE ${filters.whereSql}`, filters.values);
    const rowsResult = await pool.query(
      `${healthBaseSelect()} WHERE ${filters.whereSql} ORDER BY "occurredAt" ASC LIMIT $${filters.values.length + 1}`,
      filters.values.concat([HEALTH_EXPORT_LIMIT])
    );

    const records = rowsResult.rows.map(normalizeHealthLogRow);
    const fallbackDate = new Date().toISOString();
    const from = filters.meta.from || records[0]?.occurredAt || fallbackDate;
    const to = filters.meta.to || records[records.length - 1]?.occurredAt || fallbackDate;
    const filename = `health-diary-${formatFileDate(from)}-${formatFileDate(to)}.${format}`;
    const truncated = (countResult.rows[0]?.total ?? 0) > records.length;

    let content;
    let contentType;
    if (format === 'json') {
      content = JSON.stringify({
        period: { from, to },
        count: records.length,
        total: countResult.rows[0]?.total ?? records.length,
        truncated,
        records,
      }, null, 2);
      contentType = 'application/json; charset=utf-8';
    } else if (format === 'csv') {
      content = buildHealthCsvExport(records);
      contentType = 'text/csv; charset=utf-8';
    } else {
      content = buildHealthTxtExport(records, from, to, truncated);
      contentType = 'text/plain; charset=utf-8';
    }

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(content);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.statusCode ? err.message : `Ошибка БД: ${err.message}` });
  } finally {
    await pool.end();
  }
});

// ── Status ────────────────────────────────────────────────────────────────────

function buildContainerStatus(name, status, running, startedAt, details) {
  const statusLabelMap = {
    running: 'online',
    created: 'создан',
    restarting: 'перезапускается',
    removing: 'удаляется',
    paused: 'на паузе',
    exited: 'остановлен',
    dead: 'не отвечает',
    stopped: 'offline',
    container_not_found: 'контейнер не найден',
    docker_unreachable: 'Docker недоступен',
    status_unreadable: 'статус не прочитан',
  };

  return {
    name,
    status,
    statusLabel: statusLabelMap[status] || statusLabelMap.status_unreadable,
    details: details || null,
    running: Boolean(running),
    startedAt: startedAt || null,
  };
}

function getContainerStatus(name) {
  return new Promise((resolve) => {
    const chunks = [];
    const req = http.request(
      { socketPath: '/var/run/docker.sock', path: `/containers/${name}/json`, method: 'GET' },
      (res) => {
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => {
          const rawBody = Buffer.concat(chunks).toString();

          if (res.statusCode === 404) {
            resolve(buildContainerStatus(name, 'container_not_found', false, null, 'Контейнер с таким именем не найден в Docker.'));
            return;
          }

          try {
            const data = JSON.parse(rawBody);
            if (res.statusCode && res.statusCode >= 400) {
              const message = typeof data?.message === 'string' && data.message.trim()
                ? data.message.trim()
                : `Docker вернул HTTP ${res.statusCode}.`;
              resolve(buildContainerStatus(name, 'status_unreadable', false, null, message));
              return;
            }
            const rawStatus = String(data.State?.Status || '').toLowerCase();
            const running = Boolean(data.State?.Running);
            const startedAt = data.State?.StartedAt || null;
            if (!data.State || (!running && !rawStatus)) {
              resolve(buildContainerStatus(name, 'status_unreadable', false, null, `Docker вернул ответ без поля State${res.statusCode ? ` (HTTP ${res.statusCode})` : ''}.`));
              return;
            }
            const knownStatuses = new Set(['created', 'running', 'paused', 'restarting', 'removing', 'exited', 'dead']);
            const status = knownStatuses.has(rawStatus)
              ? rawStatus
              : running
                ? 'running'
                : 'status_unreadable';
            const details = status === 'running'
              ? 'Контейнер запущен.'
              : status === 'paused'
                ? 'Контейнер поставлен на паузу.'
                : status === 'restarting'
                  ? 'Контейнер сейчас перезапускается.'
                  : status === 'removing'
                    ? 'Контейнер удаляется.'
                    : status === 'created'
                      ? 'Контейнер создан, но ещё не запущен.'
                      : status === 'exited'
                        ? 'Контейнер остановлен.'
                        : status === 'dead'
                          ? 'Контейнер не отвечает и требует проверки.'
                          : `Неизвестный статус Docker: ${rawStatus || 'empty'}.`;
            resolve(
              buildContainerStatus(
                name,
                status,
                running,
                startedAt,
                details
              )
            );
          } catch {
            resolve(buildContainerStatus(name, 'status_unreadable', false, null, `Docker ответил некорректными данными${res.statusCode ? ` (HTTP ${res.statusCode})` : ''}.`));
          }
        });
      }
    );
    req.on('error', () => resolve(buildContainerStatus(name, 'docker_unreachable', false, null, 'Нет доступа к Docker socket.')));
    req.end();
  });
}

app.get('/api/status', requireAuth, async (_, res) => {
  const kira = await getContainerStatus('kira-mind-bot');
  res.json({ containers: [kira], serverTime: new Date().toISOString() });
});

// ── Personality helpers ───────────────────────────────────────────────────────

function readPersonality() {
  if (!fs.existsSync(PERSONALITY_FILE)) return DEFAULT_PERSONALITY;
  try {
    const raw = JSON.parse(fs.readFileSync(PERSONALITY_FILE, 'utf8'));
    // Merge with defaults so missing keys always have a value
    return {
      KiraMindBot: { ...DEFAULT_PERSONALITY.KiraMindBot, ...raw.KiraMindBot },
    };
  } catch {
    return DEFAULT_PERSONALITY;
  }
}

function writePersonality(data) {
  const dir = path.dirname(PERSONALITY_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(PERSONALITY_FILE, JSON.stringify(data, null, 2));
}

app.get('/api/personality', requireAuth, (_, res) => {
  res.json(readPersonality());
});

app.post('/api/personality', requireAuth, (req, res) => {
  try {
    const { KiraMindBot } = req.body;
    if (!KiraMindBot) {
      return res.status(400).json({ error: 'Неверный формат данных' });
    }
    writePersonality({ KiraMindBot });
    res.json({ success: true, message: '✅ Личность сохранена. Перезапустите бота для применения.' });
  } catch (err) {
    res.status(500).json({ error: `Ошибка: ${err.message}` });
  }
});

// ── Static files (React build) ────────────────────────────────────────────────

const DIST = path.join(__dirname, 'dist');
app.use(express.static(DIST));
app.get('/{*path}', (_, res) => res.sendFile(path.join(DIST, 'index.html')));

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Admin panel: http://0.0.0.0:${PORT}`);
  console.log(`📁 Bot env: ${BOT_ENV_FILE} (exists: ${fs.existsSync(BOT_ENV_FILE)})`);
});
