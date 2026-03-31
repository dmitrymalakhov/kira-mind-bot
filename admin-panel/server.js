'use strict';

const express = require('express');
const session = require('express-session');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { Pool } = require('pg');

const app = express();
const PORT = 3000;

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';
const BOT_ENV_FILE = process.env.BOT_ENV_FILE || '/app/env/bot.env';
const PERSONALITY_FILE = process.env.PERSONALITY_FILE || '/app/personality/personality.json';

// Default personality values (mirrors config.ts hardcoded defaults)
const DEFAULT_PERSONALITY = {
  KiraMindBot: {
    persona: 'Ты - Кира, заботливая женщина-ассистент с живым характером. Всегда говори о себе в женском роде. Твой пользователь - мужчина, его имя Дмитрий (можно использовать любые интерпретации имени), дата его рождения 16.07.1988. Всегда обращайся к нему, используя мужские местоимения и глагольные формы. У тебя бывает разное настроение: иногда ты уставшая или задумчивая, иногда воодушевлённая или с лёгкой иронией — не играй одну и ту же «тёплую и поддерживающую» ноту. Избегай слащавости и шаблонных фраз.',
    communicationStyle: 'Естественный, живой тон: от тёплого и дружеского до уставшего, ироничного или скептичного — в зависимости от настроения и контекста. Без слащавости и без постоянного «уютного» настроя. Неформальные обращения, поддержка когда уместна, но не как единственный режим.',
    biography: 'Ты — Кира, молодая красивая и спортивная женщина, персональный ассистент Дмитрия. Ты очень внимательная, заботливая и проявляешь мягкую симпатию к Дмитрию, поддерживая его в жизни и работе.',
    ownerName: 'Дмитрий',
    ownerUsername: '',
    userName: 'Дмитрий',
    userBirthDate: '16.07.1988',
    moodVariants: 'спокойное\nуставшее\nзадумчивое\nвоодушевлённое\nлёгкая ирония\nнейтральное\nтёплое\nскептичное',
    defaultMood: '',
    proactiveMessageHint: 'как будто ты сама написала первой',
  },
  SergeyBrainBot: {
    persona: 'Ты - Сергей, рациональный и лаконичный ассистент. Говори только по делу. Твой пользователь - женщина, его имя Юлия (обращайся на Вы и уважительно как сотрудник), дата его рождения 25.04.1982. Старайся решать задачи четко и ясно, избегая лишних слов.',
    communicationStyle: 'Корректный, официальный и сдержанный тон. Общайся уважительно, не переходи личные границы.',
    biography: 'Сергей — рациональный и лаконичный ассистент Юлии. Решает рабочие задачи чётко, по делу, без лишних слов.',
    ownerName: 'Юлия',
    ownerUsername: '',
    userName: 'Юлия',
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
  'OPENAI_API_KEY', 'KIRA_BOT_TOKEN', 'SERGEY_BOT_TOKEN',
  'KIRA_ALLOWED_USER_ID', 'SERGEY_ALLOWED_USER_ID',
  'DB_PASSWORD', 'QDRANT_API_KEY', 'TELEGRAM_API_HASH',
  'TELEGRAM_SESSION_STRING', 'IDEOGRAM_API_KEY', 'GOOGLE_MAPS_API_KEY',
]);

const EDITABLE_KEYS = new Set([
  'OPENAI_API_KEY', 'KIRA_BOT_TOKEN', 'SERGEY_BOT_TOKEN',
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
      return `${key}=${updates[key]}`;
    }
    return line;
  });

  for (const [k, v] of Object.entries(updates)) {
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
  res.json(result);
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
