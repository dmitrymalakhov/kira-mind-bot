'use strict';

const express = require('express');
const session = require('express-session');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { Pool } = require('pg');
const {
  OPENAI_MODEL_KEYS,
  OPENAI_MODEL_PRESETS,
  buildOpenAIModelEntries,
  findActiveModelPresetId,
} = require('./openaiModelHelpers');

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
  SergeyBrainBot: {
    characterName: 'ассистент',
    persona: 'Ты - рациональный и лаконичный ассистент. Говори только по делу. Твоя владелица - женщина. Обращайся на Вы и уважительно как сотрудник. Если имя владелицы известно из настроек или контекста, можешь его использовать. Дата её рождения 25.04.1982. Старайся решать задачи четко и ясно, избегая лишних слов.',
    communicationStyle: 'Корректный, официальный и сдержанный тон. Общайся уважительно, не переходи личные границы.',
    biography: 'Ты — рациональный и лаконичный ассистент своей владелицы. Решаешь рабочие задачи чётко, по делу, без лишних слов.',
    ownerName: 'владелица',
    ownerUsername: '',
    userName: 'владелица',
    userBirthDate: '25.04.1982',
    moodVariants: 'нейтральное\nсдержанное\nсосредоточенное\nделовое\nлаконичное\nуставшее',
    defaultMood: '',
    proactiveMessageHint: 'как будто ты сам написал первым',
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
  'OPENAI_API_KEY', 'ELEVENLABS_API_KEY', 'KIRA_BOT_TOKEN', 'SERGEY_BOT_TOKEN',
  'KIRA_ALLOWED_USER_ID', 'SERGEY_ALLOWED_USER_ID',
  'DB_PASSWORD', 'QDRANT_API_KEY', 'TELEGRAM_API_HASH',
  'TELEGRAM_SESSION_STRING', 'IDEOGRAM_API_KEY', 'GOOGLE_MAPS_API_KEY',
]);

const EDITABLE_KEYS = new Set([
  'OPENAI_API_KEY', 'KIRA_BOT_TOKEN', 'SERGEY_BOT_TOKEN',
  ...OPENAI_MODEL_KEYS,
  'ELEVENLABS_API_KEY', 'ELEVENLABS_VOICE_ID', 'ELEVENLABS_VOICE_NAME',
  'ELEVENLABS_MODEL_ID', 'ELEVENLABS_OUTPUT_FORMAT',
  'ELEVENLABS_VOICE_STABILITY', 'ELEVENLABS_VOICE_SIMILARITY_BOOST',
  'ELEVENLABS_VOICE_STYLE', 'ELEVENLABS_VOICE_SPEED',
  'ELEVENLABS_VOICE_USE_SPEAKER_BOOST', 'ELEVENLABS_MAX_TEXT_CHARS',
  'KIRA_ALLOWED_USER_ID', 'SERGEY_ALLOWED_USER_ID',
  'DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME',
  'VECTOR_PROVIDER', 'QDRANT_URL', 'QDRANT_API_KEY', 'VECTOR_SEARCH_THRESHOLD',
  'TELEGRAM_API_ID', 'TELEGRAM_API_HASH', 'TELEGRAM_SESSION_STRING',
  'GOOGLE_MAPS_API_KEY', 'IDEOGRAM_API_KEY',
  'USER_TIMEZONE', 'REMINDER_EXPIRY_TIME_MS',
  'PROACTIVE_ONLY_PRIVATE_CHAT', 'GROUP_PUBLIC_MODE',
  'KIRA_PROACTIVE_ENABLED', 'KIRA_PROACTIVE_INTERVAL_MS',
  'KIRA_PROACTIVE_QUIET_HOURS_ENABLED', 'KIRA_PROACTIVE_QUIET_HOUR_START', 'KIRA_PROACTIVE_QUIET_HOUR_END',
  'DM_REPORT_ENABLED', 'DM_REPORT_INTERVAL_MS', 'DM_REPORT_QUIET_HOURS_ENABLED',
  'INBOX_GUARDIAN_ENABLED', 'INBOX_GUARDIAN_HOUR', 'INBOX_GUARDIAN_LOOKBACK_HOURS', 'INBOX_GUARDIAN_MIN_AGE_MINUTES',
  'MEMORY_INSIGHT_ENABLED', 'MEMORY_INSIGHT_INTERVAL_MS',
  'SERGEY_PROACTIVE_ENABLED', 'SERGEY_PROACTIVE_INTERVAL_MS',
  'SERGEY_PROACTIVE_QUIET_HOURS_ENABLED', 'SERGEY_PROACTIVE_QUIET_HOUR_START', 'SERGEY_PROACTIVE_QUIET_HOUR_END',
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

app.get('/api/config', requireAuth, (req, res) => {
  const vars = readEnvFile();
  const result = {};
  for (const [key, value] of Object.entries(vars)) {
    if (SENSITIVE_KEYS.has(key) && value && value.length > 6) {
      result[key] = { value: value.slice(0, 4) + '••••', masked: true };
    } else {
      result[key] = { value, masked: false };
    }
  }
  Object.assign(result, buildOpenAIModelEntries(vars, BOT_ENV_FILE));
  res.json(result);
});

app.get('/api/model-presets', requireAuth, (req, res) => {
  const vars = readEnvFile();
  res.json({
    presets: OPENAI_MODEL_PRESETS,
    activePresetId: findActiveModelPresetId(vars),
    configPath: BOT_ENV_FILE,
  });
});

app.post('/api/config', requireAuth, (req, res) => {
  const updates = {};
  for (const [key, value] of Object.entries(req.body)) {
    if (!EDITABLE_KEYS.has(key)) continue;
    if (typeof value === 'string' && value.includes('••••')) continue;
    updates[key] = value;
  }

  const ok = writeEnvFile(updates);
  if (ok) {
    res.json({ success: true, message: '✅ Сохранено. Перезапустите боты для применения.' });
  } else {
    res.status(500).json({ error: 'Файл конфигурации не найден. Проверьте volume.' });
  }
});

app.post('/api/restart/:service', requireAuth, async (req, res) => {
  const { service } = req.params;
  if (!['kira-mind-bot', 'sergey-brain-bot'].includes(service)) {
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
      'SELECT "chatId", title, "chatType", username, profile, "publicMode", "allowedDomains", "forbiddenTopics", "firstSeenAt", "lastSeenAt" FROM chats ORDER BY "lastSeenAt" DESC'
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
  const { topics } = req.body;
  if (typeof topics !== 'string') {
    return res.status(400).json({ error: 'Поле topics должно быть строкой' });
  }
  const pool = createDbPool();
  try {
    const result = await pool.query(
      'UPDATE chats SET "forbiddenTopics" = $1 WHERE "chatId" = $2',
      [topics, chatId]
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
  const { domains } = req.body;
  if (!Array.isArray(domains)) {
    return res.status(400).json({ error: 'Поле domains должно быть массивом строк' });
  }
  const pool = createDbPool();
  try {
    const result = await pool.query(
      'UPDATE chats SET "allowedDomains" = $1 WHERE "chatId" = $2',
      [JSON.stringify(domains), chatId]
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
  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'Поле enabled должно быть boolean' });
  }
  const pool = createDbPool();
  try {
    const result = await pool.query(
      'UPDATE chats SET "publicMode" = $1 WHERE "chatId" = $2',
      [enabled, chatId]
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
  return 'SELECT id, "userId", "chatId", kind, "rawText", summary, severity, "occurredAt", "timeOfDay", structured, tags, "photoFileId", "createdAt" FROM health_logs';
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

function getContainerStatus(name) {
  return new Promise((resolve) => {
    const chunks = [];
    const req = http.request(
      { socketPath: '/var/run/docker.sock', path: `/v1.41/containers/${name}/json`, method: 'GET' },
      (res) => {
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString());
            resolve({
              name,
              status: data.State?.Status || 'unknown',
              running: data.State?.Running || false,
              startedAt: data.State?.StartedAt || null,
            });
          } catch {
            resolve({ name, status: 'unknown', running: false, startedAt: null });
          }
        });
      }
    );
    req.on('error', () => resolve({ name, status: 'unreachable', running: false, startedAt: null }));
    req.end();
  });
}

app.get('/api/status', requireAuth, async (_, res) => {
  const [kira, sergey] = await Promise.all([
    getContainerStatus('kira-mind-bot'),
    getContainerStatus('sergey-brain-bot'),
  ]);
  res.json({ containers: [kira, sergey], serverTime: new Date().toISOString() });
});

// ── Personality helpers ───────────────────────────────────────────────────────

function readPersonality() {
  if (!fs.existsSync(PERSONALITY_FILE)) return DEFAULT_PERSONALITY;
  try {
    const raw = JSON.parse(fs.readFileSync(PERSONALITY_FILE, 'utf8'));
    // Merge with defaults so missing keys always have a value
    return {
      KiraMindBot: { ...DEFAULT_PERSONALITY.KiraMindBot, ...raw.KiraMindBot },
      SergeyBrainBot: { ...DEFAULT_PERSONALITY.SergeyBrainBot, ...raw.SergeyBrainBot },
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
    const { KiraMindBot, SergeyBrainBot } = req.body;
    if (!KiraMindBot || !SergeyBrainBot) {
      return res.status(400).json({ error: 'Неверный формат данных' });
    }
    writePersonality({ KiraMindBot, SergeyBrainBot });
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
