const assert = require('assert');
const { createMonitoringService, aggregateOverallStatus } = require('../admin-panel/monitoring');

function createJsonResponse(status, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return text;
    },
  };
}

function createFetchStub(routes) {
  return async function fetchStub(url) {
    const route = routes[url];
    if (!route) {
      throw new Error(`Unexpected URL: ${url}`);
    }

    if (route instanceof Error) {
      throw route;
    }

    return route;
  };
}

function createService({ env = {}, vars = {}, routes = {}, postgresShouldFail = false }) {
  return createMonitoringService({
    env,
    readEnvFile: () => vars,
    createDbPool: () => ({
      async query() {
        if (postgresShouldFail) {
          throw new Error('postgres is down');
        }
        return { rows: [{ ok: 1 }] };
      },
      async end() {},
    }),
    getContainerStatus: async () => ({
      status: 'running',
      statusLabel: 'online',
      details: 'Контейнер запущен.',
      running: true,
      startedAt: '2026-06-11T10:00:00.000Z',
    }),
    fetchImpl: createFetchStub(routes),
  });
}

async function testAggregateOverallStatus() {
  assert.strictEqual(aggregateOverallStatus([{ status: 'ok' }, { status: 'disabled' }]), 'ok');
  assert.strictEqual(aggregateOverallStatus([{ status: 'warn' }, { status: 'disabled' }]), 'degraded');
  assert.strictEqual(aggregateOverallStatus([{ status: 'down' }, { status: 'warn' }]), 'down');
}

async function testDisabledChecks() {
  const service = createService({
    env: { NODE_ENV: 'test' },
    vars: {},
    routes: {
      'http://qdrant:6333/': createJsonResponse(200, { version: '1.18.1' }),
      'http://qdrant:6333/collections': createJsonResponse(200, { result: { collections: [] } }),
    },
  });

  const [botApi, userClient, openai, gemini, openrouter, zai] = await Promise.all([
    service.checkTelegramBotApiHealth(),
    service.checkTelegramUserClientHealth(),
    service.checkOpenAiHealth(),
    service.checkGeminiHealth(),
    service.checkOpenRouterHealth(),
    service.checkZaiHealth(),
  ]);

  assert.strictEqual(botApi.status, 'disabled');
  assert.strictEqual(userClient.status, 'disabled');
  assert.strictEqual(openai.status, 'disabled');
  assert.strictEqual(gemini.status, 'disabled');
  assert.strictEqual(openrouter.status, 'disabled');
  assert.strictEqual(zai.status, 'disabled');
}

async function testSnapshotStatuses() {
  const service = createService({
    env: {
      NODE_ENV: 'production',
      OPENAI_API_KEY: 'openai-key',
      GEMINI_API_KEY: 'gemini-key',
      OPENROUTER_API_KEY: 'openrouter-key',
      ZAI_API_KEY: 'zai-key',
      KIRA_BOT_TOKEN: 'bot-token',
      TELEGRAM_API_ID: '12345',
      TELEGRAM_API_HASH: 'hash',
      TELEGRAM_SESSION_STRING: 'session',
      QDRANT_URL: 'http://qdrant:6333',
      KIRA_RUNTIME_HEALTH_URL: 'http://kira-mind-bot:3100',
    },
    vars: {},
    routes: {
      'http://qdrant:6333/': createJsonResponse(200, { version: '1.18.1' }),
      'http://qdrant:6333/collections': createJsonResponse(200, { result: { collections: [{ name: 'memories' }] } }),
      'https://api.telegram.org/botbot-token/getMe': createJsonResponse(200, {
        ok: true,
        result: { username: 'KiraMindBot' },
      }),
      'http://kira-mind-bot:3100/internal/health/telegram-user': createJsonResponse(200, {
        status: 'warn',
        summary: 'Telegram user-client сейчас переподключается.',
        details: 'TIMEOUT в update loop, идёт reconnect.',
        connected: true,
        authorized: true,
        reconnecting: true,
        dc: 2,
      }),
      'https://api.openai.com/v1/models': createJsonResponse(401, {
        error: { message: 'Invalid OpenAI key' },
      }),
      'https://generativelanguage.googleapis.com/v1beta/models?key=gemini-key': createJsonResponse(429, {
        error: { message: 'Rate limited' },
      }),
      'https://openrouter.ai/api/v1/auth/key': createJsonResponse(503, {
        error: { message: 'Upstream unavailable' },
      }),
      'https://api.z.ai/api/paas/v4/models': createJsonResponse(200, {
        data: [{ id: 'glm-5.2' }],
      }),
    },
  });

  const snapshot = await service.getMonitoringSnapshot();
  const byKey = Object.fromEntries(snapshot.checks.map((check) => [check.key, check]));

  assert.strictEqual(snapshot.overallStatus, 'down');
  assert.strictEqual(byKey['postgres'].status, 'ok');
  assert.strictEqual(byKey['qdrant'].status, 'ok');
  assert.strictEqual(byKey['telegram-bot-api'].status, 'ok');
  assert.strictEqual(byKey['telegram-user-client'].status, 'warn');
  assert.strictEqual(byKey['openai'].status, 'down');
  assert.strictEqual(byKey['gemini'].status, 'warn');
  assert.strictEqual(byKey['openrouter'].status, 'down');
  assert.strictEqual(byKey['zai'].status, 'ok');
}

async function testCustomBotContainerName() {
  let requestedContainerName = null;
  const service = createMonitoringService({
    env: { KIRA_BOT_CONTAINER_NAME: 'nova-mind-bot' },
    readEnvFile: () => ({}),
    createDbPool: () => ({ async query() {}, async end() {} }),
    getContainerStatus: async (name) => {
      requestedContainerName = name;
      return {
        status: 'running',
        statusLabel: 'online',
        details: 'Контейнер запущен.',
        running: true,
        startedAt: '2026-06-11T10:00:00.000Z',
      };
    },
  });

  const check = await service.checkKiraContainerHealth();
  assert.strictEqual(requestedContainerName, 'nova-mind-bot');
  assert.strictEqual(check.status, 'ok');
}

async function main() {
  await testAggregateOverallStatus();
  await testDisabledChecks();
  await testSnapshotStatuses();
  await testCustomBotContainerName();
  console.log('testAdminMonitoring: ok');
}

main().catch((error) => {
  console.error('testAdminMonitoring: failed');
  console.error(error);
  process.exit(1);
});
