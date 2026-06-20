'use strict';

const fs = require('fs');
const path = require('path');
const { providers: AI_PROVIDER_REGISTRY } = require('./provider-registry.json');

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_RUNTIME_HEALTH_PORT = Number(process.env.KIRA_RUNTIME_HEALTH_PORT || 3100);
const RUNTIME_HEALTH_METADATA_PATH = path.join(__dirname, 'runtime-health-metadata.json');

function readRuntimeHealthMetadata() {
  if (!fs.existsSync(RUNTIME_HEALTH_METADATA_PATH)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(RUNTIME_HEALTH_METADATA_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function getQdrantClientVersion() {
  const metadata = readRuntimeHealthMetadata();
  const rawVersion = metadata?.qdrantClientVersion;
  return typeof rawVersion === 'string' ? rawVersion.replace(/^[^\d]*/, '') : null;
}

function nowIso() {
  return new Date().toISOString();
}

function toErrorMessage(error) {
  if (error instanceof Error && error.message) return error.message;
  return String(error || 'Неизвестная ошибка');
}

function createTimeoutSignal(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Timeout after ${timeoutMs}ms`)), timeoutMs);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

async function fetchWithMeta(fetchImpl, url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const startedAt = Date.now();
  const timeout = createTimeoutSignal(timeoutMs);

  try {
    const response = await fetchImpl(url, { ...options, signal: timeout.signal });
    const text = await response.text();
    let data = null;

    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }

    return {
      response,
      text,
      data,
      latencyMs: Date.now() - startedAt,
    };
  } finally {
    timeout.clear();
  }
}

function parseSemver(version) {
  const match = typeof version === 'string' ? version.match(/(\d+)\.(\d+)(?:\.(\d+))?/) : null;
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3] || 0),
  };
}

function hasQdrantVersionMismatch(clientVersion, serverVersion) {
  const client = parseSemver(clientVersion);
  const server = parseSemver(serverVersion);

  if (!client || !server) {
    return false;
  }

  return client.major !== server.major;
}

function aggregateOverallStatus(checks) {
  if (checks.some((check) => check.status === 'down')) {
    return 'down';
  }

  if (checks.some((check) => check.status === 'warn')) {
    return 'degraded';
  }

  return 'ok';
}

function buildCheck({
  key,
  label,
  category,
  status,
  summary,
  details,
  latencyMs,
  checkedAt,
  meta,
}) {
  return {
    key,
    label,
    category,
    status,
    summary,
    details,
    latencyMs: typeof latencyMs === 'number' ? latencyMs : undefined,
    checkedAt: checkedAt || nowIso(),
    meta: meta && Object.keys(meta).length ? meta : undefined,
  };
}

function getRuntimeHealthBaseUrl(env) {
  if (env.KIRA_RUNTIME_HEALTH_URL) {
    return String(env.KIRA_RUNTIME_HEALTH_URL).replace(/\/+$/, '');
  }

  const port = Number(env.KIRA_RUNTIME_HEALTH_PORT || DEFAULT_RUNTIME_HEALTH_PORT);
  return `http://kira-mind-bot:${port}`;
}

function buildProviderStatus({ httpStatus, ok, providerLabel }) {
  if (ok) {
    return {
      status: 'ok',
      summary: `${providerLabel} API отвечает.`,
    };
  }

  if (httpStatus === 429) {
    return {
      status: 'warn',
      summary: `${providerLabel} API доступен, но упёрся в rate limit.`,
    };
  }

  if (httpStatus === 401 || httpStatus === 403) {
    return {
      status: 'down',
      summary: `${providerLabel} API отверг ключ авторизации.`,
    };
  }

  if (typeof httpStatus === 'number' && httpStatus >= 500) {
    return {
      status: 'down',
      summary: `${providerLabel} API отвечает серверной ошибкой.`,
    };
  }

  return {
    status: 'down',
    summary: `${providerLabel} API недоступен.`,
  };
}

function trimDetails(text, limit = 280) {
  if (!text) return '';
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function buildProviderRequestOptions(providerId, apiKey) {
  const descriptor = AI_PROVIDER_REGISTRY[providerId];
  if (!descriptor) {
    throw new Error(`Unknown AI provider: ${providerId}`);
  }

  const monitoring = descriptor.monitoring || {};
  if (monitoring.auth === 'query_key') {
    return {
      url: `${monitoring.url}?key=${encodeURIComponent(apiKey)}`,
      options: {},
    };
  }

  return {
    url: monitoring.url,
    options: {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
    },
  };
}

function createMonitoringService({
  readEnvFile,
  createDbPool,
  getContainerStatus,
  fetchImpl = fetch,
  env = process.env,
}) {
  async function checkAiProviderHealth(providerId) {
    const vars = readEnvFile();
    const descriptor = AI_PROVIDER_REGISTRY[providerId];
    const checkedAt = nowIso();

    if (!descriptor) {
      return buildCheck({
        key: providerId,
        label: providerId,
        category: 'ai',
        status: 'disabled',
        summary: `Проверка отключена: неизвестный AI provider ${providerId}.`,
        details: 'Provider отсутствует в общем registry.',
        checkedAt,
      });
    }

    const apiKey = String(vars[descriptor.envKey] || env[descriptor.envKey] || '').trim();
    if (!apiKey) {
      return buildCheck({
        key: providerId,
        label: descriptor.label,
        category: 'ai',
        status: 'disabled',
        summary: `Проверка отключена: ${descriptor.envKey} не задан.`,
        details: `Без ключа нельзя проверить доступность ${descriptor.label} API.`,
        checkedAt,
      });
    }

    try {
      const request = buildProviderRequestOptions(providerId, apiKey);
      const result = await fetchWithMeta(fetchImpl, request.url, request.options);
      const providerStatus = buildProviderStatus({
        httpStatus: result.response.status,
        ok: result.response.ok,
        providerLabel: descriptor.label,
      });

      return buildCheck({
        key: providerId,
        label: descriptor.label,
        category: 'ai',
        status: providerStatus.status,
        summary: providerStatus.summary,
        details: trimDetails(result.data?.error?.message || result.text || `HTTP ${result.response.status}`),
        latencyMs: result.latencyMs,
        checkedAt,
        meta: {
          httpStatus: result.response.status,
          monitoringKind: descriptor.monitoring?.kind || null,
        },
      });
    } catch (error) {
      return buildCheck({
        key: providerId,
        label: descriptor.label,
        category: 'ai',
        status: 'down',
        summary: `${descriptor.label} API недоступен.`,
        details: trimDetails(toErrorMessage(error)),
        checkedAt,
      });
    }
  }

  async function checkKiraContainerHealth() {
    const checkedAt = nowIso();
    const container = await getContainerStatus('kira-mind-bot');

    if (container.status === 'running') {
      return buildCheck({
        key: 'kira-container',
        label: 'Kira Container',
        category: 'runtime',
        status: 'ok',
        summary: 'Контейнер бота запущен.',
        details: container.details || 'Docker сообщает, что контейнер работает.',
        checkedAt,
        meta: {
          containerStatus: container.status,
          startedAt: container.startedAt,
        },
      });
    }

    const warnStatuses = new Set(['created', 'restarting', 'paused']);
    const status = warnStatuses.has(container.status) ? 'warn' : 'down';

    return buildCheck({
      key: 'kira-container',
      label: 'Kira Container',
      category: 'runtime',
      status,
      summary: status === 'warn'
        ? 'Контейнер бота не в рабочем состоянии.'
        : 'Контейнер бота недоступен.',
      details: container.details || `Docker status: ${container.statusLabel}`,
      checkedAt,
      meta: {
        containerStatus: container.status,
        startedAt: container.startedAt,
      },
    });
  }

  async function checkPostgresHealth() {
    const checkedAt = nowIso();
    const startedAt = Date.now();
    const pool = createDbPool();

    try {
      await pool.query('SELECT 1 AS ok');
      return buildCheck({
        key: 'postgres',
        label: 'PostgreSQL',
        category: 'storage',
        status: 'ok',
        summary: 'PostgreSQL отвечает на запрос.',
        details: 'Проверка SELECT 1 завершилась успешно.',
        latencyMs: Date.now() - startedAt,
        checkedAt,
      });
    } catch (error) {
      return buildCheck({
        key: 'postgres',
        label: 'PostgreSQL',
        category: 'storage',
        status: 'down',
        summary: 'PostgreSQL недоступен.',
        details: trimDetails(toErrorMessage(error)),
        latencyMs: Date.now() - startedAt,
        checkedAt,
      });
    } finally {
      await pool.end().catch(() => {});
    }
  }

  async function checkQdrantHealth() {
    const vars = readEnvFile();
    const qdrantUrl = String(vars.QDRANT_URL || env.QDRANT_URL || 'http://qdrant:6333').replace(/\/+$/, '');
    const apiKey = vars.QDRANT_API_KEY || env.QDRANT_API_KEY || '';
    const headers = apiKey ? { 'api-key': apiKey } : {};
    const checkedAt = nowIso();
    const clientVersion = getQdrantClientVersion();

    try {
      const [rootResult, collectionsResult] = await Promise.all([
        fetchWithMeta(fetchImpl, `${qdrantUrl}/`, { headers }),
        fetchWithMeta(fetchImpl, `${qdrantUrl}/collections`, { headers }),
      ]);

      if (!rootResult.response.ok || !collectionsResult.response.ok) {
        const failingResult = !rootResult.response.ok ? rootResult : collectionsResult;
        const status = failingResult.response.status === 429 ? 'warn' : 'down';
        return buildCheck({
          key: 'qdrant',
          label: 'Qdrant',
          category: 'storage',
          status,
          summary: status === 'warn' ? 'Qdrant отвечает с ограничением.' : 'Qdrant недоступен.',
          details: trimDetails(failingResult.text || `HTTP ${failingResult.response.status}`),
          latencyMs: Math.max(rootResult.latencyMs, collectionsResult.latencyMs),
          checkedAt,
          meta: {
            httpStatus: failingResult.response.status,
            serverVersion: rootResult.data?.version || null,
            clientVersion,
          },
        });
      }

      const serverVersion = rootResult.data?.version || null;
      const versionMismatch = hasQdrantVersionMismatch(clientVersion, serverVersion);

      return buildCheck({
        key: 'qdrant',
        label: 'Qdrant',
        category: 'storage',
        status: versionMismatch ? 'warn' : 'ok',
        summary: versionMismatch
          ? 'Qdrant доступен, но версии клиента и сервера расходятся.'
          : 'Qdrant отвечает штатно.',
        details: versionMismatch
          ? `Сервер ${serverVersion || 'unknown'}, клиент ${clientVersion || 'unknown'}. Это не блокирует работу, но повышает риск несовместимости.`
          : 'Эндпоинты / и /collections ответили успешно.',
        latencyMs: Math.max(rootResult.latencyMs, collectionsResult.latencyMs),
        checkedAt,
        meta: {
          httpStatus: collectionsResult.response.status,
          serverVersion,
          clientVersion,
          collectionsCount: Array.isArray(collectionsResult.data?.result?.collections)
            ? collectionsResult.data.result.collections.length
            : undefined,
        },
      });
    } catch (error) {
      return buildCheck({
        key: 'qdrant',
        label: 'Qdrant',
        category: 'storage',
        status: 'down',
        summary: 'Qdrant недоступен.',
        details: trimDetails(toErrorMessage(error)),
        checkedAt,
        meta: {
          clientVersion,
        },
      });
    }
  }

  async function checkTelegramBotApiHealth() {
    const vars = readEnvFile();
    const token = String(vars.KIRA_BOT_TOKEN || env.KIRA_BOT_TOKEN || '').trim();
    const checkedAt = nowIso();

    if (!token) {
      return buildCheck({
        key: 'telegram-bot-api',
        label: 'Telegram Bot API',
        category: 'telegram',
        status: 'disabled',
        summary: 'Проверка отключена: KIRA_BOT_TOKEN не задан.',
        details: 'Без токена бота нельзя выполнить getMe.',
        checkedAt,
      });
    }

    try {
      const result = await fetchWithMeta(fetchImpl, `https://api.telegram.org/bot${token}/getMe`);
      const payload = result.data;

      if (result.response.ok && payload?.ok === true) {
        return buildCheck({
          key: 'telegram-bot-api',
          label: 'Telegram Bot API',
          category: 'telegram',
          status: 'ok',
          summary: 'Bot API отвечает штатно.',
          details: `getMe вернул бота ${payload.result?.username ? `@${payload.result.username}` : 'без username'}.`,
          latencyMs: result.latencyMs,
          checkedAt,
          meta: {
            httpStatus: result.response.status,
            username: payload.result?.username || null,
          },
        });
      }

      const status = result.response.status === 429 ? 'warn' : 'down';
      return buildCheck({
        key: 'telegram-bot-api',
        label: 'Telegram Bot API',
        category: 'telegram',
        status,
        summary: status === 'warn' ? 'Bot API доступен, но ограничивает запросы.' : 'Bot API недоступен.',
        details: trimDetails(payload?.description || result.text || `HTTP ${result.response.status}`),
        latencyMs: result.latencyMs,
        checkedAt,
        meta: {
          httpStatus: result.response.status,
        },
      });
    } catch (error) {
      return buildCheck({
        key: 'telegram-bot-api',
        label: 'Telegram Bot API',
        category: 'telegram',
        status: 'down',
        summary: 'Bot API недоступен.',
        details: trimDetails(toErrorMessage(error)),
        checkedAt,
      });
    }
  }

  async function checkTelegramUserClientHealth() {
    const vars = readEnvFile();
    const apiId = String(vars.TELEGRAM_API_ID || env.TELEGRAM_API_ID || '').trim();
    const apiHash = String(vars.TELEGRAM_API_HASH || env.TELEGRAM_API_HASH || '').trim();
    const sessionString = String(vars.TELEGRAM_SESSION_STRING || env.TELEGRAM_SESSION_STRING || '').trim();
    const checkedAt = nowIso();

    if (!apiId || !apiHash || !sessionString) {
      return buildCheck({
        key: 'telegram-user-client',
        label: 'Telegram User Client',
        category: 'telegram',
        status: 'disabled',
        summary: 'Проверка отключена: TELEGRAM_* настроены не полностью.',
        details: 'Для user-client нужны TELEGRAM_API_ID, TELEGRAM_API_HASH и TELEGRAM_SESSION_STRING.',
        checkedAt,
      });
    }

    try {
      const runtimeBaseUrl = getRuntimeHealthBaseUrl(env);
      const result = await fetchWithMeta(fetchImpl, `${runtimeBaseUrl}/internal/health/telegram-user`);
      const payload = result.data || {};
      const status = payload.status === 'ok' || payload.status === 'warn' || payload.status === 'down' || payload.status === 'disabled'
        ? payload.status
        : result.response.ok
          ? 'ok'
          : 'down';

      return buildCheck({
        key: 'telegram-user-client',
        label: 'Telegram User Client',
        category: 'telegram',
        status,
        summary: String(payload.summary || (status === 'ok' ? 'User client отвечает.' : 'User client вернул диагностику.')),
        details: String(payload.details || result.text || `HTTP ${result.response.status}`),
        latencyMs: result.latencyMs,
        checkedAt,
        meta: {
          httpStatus: result.response.status,
          connected: payload.connected ?? null,
          authorized: payload.authorized ?? null,
          reconnecting: payload.reconnecting ?? null,
          dc: payload.dc ?? null,
          endpoint: payload.endpoint ?? null,
        },
      });
    } catch (error) {
      return buildCheck({
        key: 'telegram-user-client',
        label: 'Telegram User Client',
        category: 'telegram',
        status: 'down',
        summary: 'Не удалось получить runtime-диагностику user-client.',
        details: trimDetails(toErrorMessage(error)),
        checkedAt,
      });
    }
  }

  async function checkOpenAiHealth() {
    return checkAiProviderHealth('openai');
  }

  async function checkGeminiHealth() {
    return checkAiProviderHealth('gemini');
  }

  async function checkOpenRouterHealth() {
    return checkAiProviderHealth('openrouter');
  }

  async function checkZaiHealth() {
    return checkAiProviderHealth('zai');
  }

  async function getMonitoringSnapshot() {
    const checks = await Promise.all([
      checkKiraContainerHealth(),
      checkPostgresHealth(),
      checkQdrantHealth(),
      checkTelegramBotApiHealth(),
      checkTelegramUserClientHealth(),
      checkOpenAiHealth(),
      checkGeminiHealth(),
      checkOpenRouterHealth(),
      checkZaiHealth(),
    ]);

    return {
      generatedAt: nowIso(),
      overallStatus: aggregateOverallStatus(checks),
      checks,
    };
  }

  return {
    getMonitoringSnapshot,
    checkKiraContainerHealth,
    checkPostgresHealth,
    checkQdrantHealth,
    checkTelegramBotApiHealth,
    checkTelegramUserClientHealth,
    checkOpenAiHealth,
    checkGeminiHealth,
    checkOpenRouterHealth,
    checkZaiHealth,
  };
}

module.exports = {
  aggregateOverallStatus,
  createMonitoringService,
};
