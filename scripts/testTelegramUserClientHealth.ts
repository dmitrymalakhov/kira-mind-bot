import assert from "node:assert/strict";
import type { TelegramClient } from "telegram";
import {
    __resetTelegramUserClientHealthRuntimeState,
    __resetTelegramUserClientHealthTestDependencies,
    __setTelegramUserClientHealthRuntimeState,
    __setTelegramUserClientHealthTestDependencies,
    getTelegramUserClientHealth,
} from "../services/telegram";

type FakeTelegramClient = TelegramClient & {
    connected?: boolean;
    disconnected?: boolean;
    _reconnecting?: boolean;
    session?: { dcId?: number };
    _sender?: {
        _reconnecting?: boolean;
        _connection?: {
            _ip?: string;
            _port?: number;
            _dcId?: number;
        };
    };
    isUserAuthorized: () => Promise<boolean>;
};

const originalEnv = {
    TELEGRAM_API_ID: process.env.TELEGRAM_API_ID,
    TELEGRAM_API_HASH: process.env.TELEGRAM_API_HASH,
    TELEGRAM_SESSION_STRING: process.env.TELEGRAM_SESSION_STRING,
};

function createFakeClient(options: {
    connected: boolean;
    authorized: boolean;
    reconnecting?: boolean;
    dc?: number;
    endpoint?: string | null;
}): FakeTelegramClient {
    const [ip, port] = options.endpoint ? options.endpoint.split(":") : [undefined, undefined];
    return {
        connected: options.connected,
        disconnected: !options.connected,
        _reconnecting: Boolean(options.reconnecting),
        session: { dcId: options.dc ?? 2 },
        _sender: {
            _reconnecting: Boolean(options.reconnecting),
            _connection: ip && port
                ? {
                    _ip: ip,
                    _port: Number(port),
                    _dcId: options.dc ?? 2,
                }
                : undefined,
        },
        isUserAuthorized: async () => options.authorized,
    } as FakeTelegramClient;
}

function setupEnv(): void {
    process.env.TELEGRAM_API_ID = "12345";
    process.env.TELEGRAM_API_HASH = "hash";
    process.env.TELEGRAM_SESSION_STRING = "session";
}

function resetHarness(): void {
    __resetTelegramUserClientHealthTestDependencies();
    __resetTelegramUserClientHealthRuntimeState();
    process.env.TELEGRAM_API_ID = originalEnv.TELEGRAM_API_ID;
    process.env.TELEGRAM_API_HASH = originalEnv.TELEGRAM_API_HASH;
    process.env.TELEGRAM_SESSION_STRING = originalEnv.TELEGRAM_SESSION_STRING;
}

async function testRecoversStaleRuntimeClient(): Promise<void> {
    setupEnv();

    const staleClient = createFakeClient({
        connected: false,
        authorized: true,
        dc: 2,
        endpoint: "149.154.167.41:443",
    });
    const recoveredClient = createFakeClient({
        connected: true,
        authorized: true,
        dc: 2,
        endpoint: "149.154.167.41:443",
    });

    __setTelegramUserClientHealthRuntimeState({
        telegramClient: staleClient,
        telegramClientLastReadyAt: "2026-06-27T19:55:59.478Z",
    });
    __setTelegramUserClientHealthTestDependencies({
        reinitializeClient: async () => recoveredClient,
        createClient: () => {
            throw new Error("diagnostic client must not be created when runtime recovery succeeds");
        },
    });

    const health = await getTelegramUserClientHealth();

    assert.equal(health.status, "ok");
    assert.equal(health.connected, true);
    assert.equal(health.authorized, true);
    assert.match(health.summary, /восстановил соединение/i);
    assert.match(health.details, /stale runtime-client/i);
}

async function testWarnsWhenOnlyDiagnosticClientCanConnect(): Promise<void> {
    setupEnv();

    const staleClient = createFakeClient({
        connected: false,
        authorized: true,
        dc: 2,
        endpoint: "149.154.167.41:443",
    });
    const diagnosticClient = createFakeClient({
        connected: true,
        authorized: true,
        dc: 2,
        endpoint: "149.154.167.41:443",
    });

    let disconnectCalled = false;

    __setTelegramUserClientHealthRuntimeState({
        telegramClient: staleClient,
    });
    __setTelegramUserClientHealthTestDependencies({
        reinitializeClient: async () => undefined,
        createClient: () => diagnosticClient,
        connectAndAuthorize: async () => true,
        disconnectClient: async () => {
            disconnectCalled = true;
        },
    });

    const health = await getTelegramUserClientHealth();

    assert.equal(health.status, "warn");
    assert.equal(health.connected, false);
    assert.equal(health.authorized, true);
    assert.match(health.summary, /runtime-клиент остаётся stale/i);
    assert.equal(disconnectCalled, true);
}

async function testReturnsDownWhenRecoveryAndDiagnosticFail(): Promise<void> {
    setupEnv();

    const staleClient = createFakeClient({
        connected: false,
        authorized: true,
        dc: 2,
    });

    __setTelegramUserClientHealthRuntimeState({
        telegramClient: staleClient,
    });
    __setTelegramUserClientHealthTestDependencies({
        reinitializeClient: async () => undefined,
        createClient: () => createFakeClient({
            connected: false,
            authorized: false,
            dc: 2,
        }),
        connectAndAuthorize: async () => {
            throw new Error("Diagnostic connect failed");
        },
        disconnectClient: async () => {},
    });

    const health = await getTelegramUserClientHealth();

    assert.equal(health.status, "down");
    assert.match(health.details, /Diagnostic connect failed/);
}

async function testReconnectStateRemainsWarn(): Promise<void> {
    setupEnv();

    const reconnectingClient = createFakeClient({
        connected: true,
        authorized: true,
        reconnecting: true,
        dc: 2,
        endpoint: "149.154.167.41:443",
    });

    __setTelegramUserClientHealthRuntimeState({
        telegramClient: reconnectingClient,
    });

    const health = await getTelegramUserClientHealth();

    assert.equal(health.status, "warn");
    assert.equal(health.reconnecting, true);
    assert.match(health.summary, /переподключается/i);
}

async function main(): Promise<void> {
    try {
        await testRecoversStaleRuntimeClient();
        resetHarness();

        await testWarnsWhenOnlyDiagnosticClientCanConnect();
        resetHarness();

        await testReturnsDownWhenRecoveryAndDiagnosticFail();
        resetHarness();

        await testReconnectStateRemainsWarn();
        resetHarness();

        console.log("telegramUserClientHealth checks passed");
        process.exit(0);
    } finally {
        resetHarness();
    }
}

main().catch((error) => {
    console.error("telegramUserClientHealth checks failed");
    console.error(error);
    process.exit(1);
});
