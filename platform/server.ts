import * as http from 'node:http';
import { randomUUID } from 'node:crypto';
import { ApiError } from '../api/contracts';
import { readBody } from '../api/server';
import { MAX_SCENE_BODY_BYTES } from '../api/scene';
import { checkPassword, digest, newToken, passwordHash, PlatformSecrets } from './crypto';
import { Account, AccountStore } from './store';
import { AccountRuntimes, TenantCredentials } from './runtime';
import { TelegramGateway } from './telegram';

export interface PlatformOptions {
    store: AccountStore;
    secrets: PlatformSecrets;
    runtimes: AccountRuntimes;
    telegram: TelegramGateway;
    reservedBotIds?: string[];
}

function publicAccount(account: Account, runtimes: AccountRuntimes) {
    return { id: account.id, username: account.username,
        bot: account.bot_id ? { id: account.bot_id, username: account.bot_username,
            connected: Boolean(account.owner_id), status: runtimes.status(account.id) } : null };
}

function fields(body: Record<string, unknown>, expected: string[]): void {
    if (Object.keys(body).some(key => !expected.includes(key)) || expected.some(key => typeof body[key] !== 'string')) {
        throw new ApiError(400, 'invalid_body', `Передай только поля: ${expected.join(', ')}.`);
    }
}

/** Bounded, per-key windows. Proxy headers never establish an identity or bypass a limit. */
class RequestLimits {
    private windows = new Map<string, { count: number; until: number }>();
    take(key: string, limit: number) {
        const now = Date.now();
        if (this.windows.size > 10_000) {
            for (const [id, value] of this.windows) if (value.until <= now) this.windows.delete(id);
            if (this.windows.size > 10_000 && !this.windows.has(key)) throw new ApiError(429, 'rate_limited', 'Повтори позже.');
        }
        let value = this.windows.get(key);
        if (!value || value.until <= now) { value = { count: 0, until: now + 60_000 }; this.windows.set(key, value); }
        if (++value.count > limit) throw new ApiError(429, 'rate_limited', 'Слишком много запросов. Повтори через минуту.');
    }
}

async function proxy(req: http.IncomingMessage, res: http.ServerResponse, endpoint: { port: number; token: string }, route: string) {
    const body = ['POST', 'PATCH', 'PUT'].includes(req.method || '')
        ? JSON.stringify(await readBody(req, route === '/api/v1/scene/turns' ? MAX_SCENE_BODY_BYTES : undefined)) : undefined;
    req.resume();
    return new Promise<void>((resolve, reject) => {
        const upstream = http.request({ host: '127.0.0.1', port: endpoint.port, path: req.url, method: req.method,
            headers: { authorization: `Bearer ${endpoint.token}`, ...(body ? {
                'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
            } : {}), ...(typeof req.headers.prefer === 'string' ? { prefer: req.headers.prefer } : {}),
                ...(typeof req.headers['idempotency-key'] === 'string' ? { 'idempotency-key': req.headers['idempotency-key'] } : {}) },
        }, response => {
            res.statusCode = response.statusCode || 502;
            for (const name of ['content-type', 'content-disposition', 'retry-after', 'preference-applied']) {
                if (response.headers[name]) res.setHeader(name, response.headers[name]!);
            }
            response.on('error', reject);
            response.on('end', resolve);
            response.pipe(res);
        });
        upstream.setTimeout(600_000, () => upstream.destroy(new Error('Runtime timeout')));
        upstream.once('error', () => reject(new ApiError(502, 'kira_unavailable', 'Кира временно недоступна. После сбоя повторяй действие с прежним Idempotency-Key.')));
        upstream.end(body);
    });
}

export function createPlatformServer(options: PlatformOptions): http.Server {
    const { store, secrets, runtimes, telegram } = options;
    const limits = new RequestLimits();
    const connecting = new Set<string>();
    let authenticating = 0;
    // A missing username pays the same password derivation cost as an existing one.
    const dummyHash = passwordHash(newToken());
    const server = http.createServer(async (req, res) => {
        const requestId = randomUUID();
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Request-Id', requestId);
        const json = (status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
        try {
            const url = new URL(req.url || '/', 'http://localhost');
            const route = url.pathname;
            const authRoute = route === '/api/v1/accounts/register' || route === '/api/v1/accounts/login';
            if (authRoute) {
                limits.take(`auth:${req.socket.remoteAddress}`, 20);
                if (authenticating >= 8) throw new ApiError(429, 'rate_limited', 'Вход временно перегружен. Повтори позже.');
                authenticating++;
                try {
                    if (req.method !== 'POST') throw new ApiError(405, 'method_not_allowed', 'Ожидается POST.');
                    const body = await readBody(req);
                    fields(body, ['username', 'password']);
                    const username = (body.username as string).toLowerCase();
                    const password = body.password as string;
                    if (!/^[a-z0-9_]{3,40}$/.test(username) || password.length < 12 || password.length > 256) {
                        throw new ApiError(400, 'invalid_credentials', 'Логин: 3–40 латинских букв, цифр или _. Пароль: 12–256 символов.');
                    }
                    let account: Account;
                    if (route.endsWith('/register')) account = await store.create(username, await passwordHash(password));
                    else {
                        const existing = await store.byUsername(username);
                        const matches = await checkPassword(password, existing?.password_hash || await dummyHash);
                        if (!existing || !matches) throw new ApiError(401, 'invalid_credentials', 'Неверный логин или пароль.');
                        account = existing;
                    }
                    const token = newToken();
                    await store.session(digest(token), account.id);
                    return json(route.endsWith('/register') ? 201 : 200, {
                        account: publicAccount(account, runtimes), accessToken: token, tokenType: 'Bearer', expiresIn: 30 * 24 * 3600,
                    });
                } finally { authenticating--; }
            }
            limits.take(`request:${req.socket.remoteAddress}`, 600);
            const bearer = req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{32,128})$/i)?.[1];
            const account = bearer ? await store.authenticate(digest(bearer)) : undefined;
            if (!account) {
                res.setHeader('WWW-Authenticate', 'Bearer');
                throw new ApiError(401, 'unauthorized', 'Нужен токен аккаунта.');
            }
            limits.take(`account:${account.id}`, 120);
            if (route === '/api/v1/account' && req.method === 'GET') return json(200, { account: publicAccount(account, runtimes) });
            if (route === '/api/v1/accounts/logout' && req.method === 'POST') {
                await store.logout(digest(bearer!));
                req.resume();
                return json(200, { ok: true });
            }
            if (route === '/api/v1/account/telegram' && req.method === 'GET') {
                const credentials = account.secrets ? secrets.open<TenantCredentials>(account.secrets, account.id) : undefined;
                return json(200, { personalSessionConfigured: Boolean(credentials?.telegram) });
            }
            if (route === '/api/v1/account/telegram' && req.method === 'DELETE') {
                if (connecting.has(account.id)) throw new ApiError(409, 'connection_busy', 'Подключение уже изменяется.');
                connecting.add(account.id);
                try {
                    req.resume();
                    const credentials = account.secrets ? secrets.open<TenantCredentials>(account.secrets, account.id) : undefined;
                    if (credentials?.telegram && account.secrets) {
                        delete credentials.telegram;
                        await store.updateSecrets(account.id, account.secrets, secrets.seal(credentials, account.id));
                        await runtimes.restart(account.id);
                        return json(202, { personalSessionConfigured: false, status: 'restarting' });
                    }
                    return json(200, { personalSessionConfigured: false });
                } finally { connecting.delete(account.id); }
            }
            if (route === '/api/v1/account/bot' && req.method === 'PUT') {
                if (account.owner_id) throw new ApiError(409, 'bot_already_connected', 'Бот уже подключён.');
                if (connecting.has(account.id)) throw new ApiError(409, 'connection_busy', 'Подключение уже выполняется.');
                connecting.add(account.id);
                try {
                    const body = await readBody(req);
                    fields(body, ['botToken']);
                    const token = body.botToken as string;
                    const bot = await telegram.verify(token);
                    if (options.reservedBotIds?.includes(String(bot.id))) throw new ApiError(409, 'bot_unavailable', 'Этот бот зарезервирован администратором.');
                    const pairingCode = newToken();
                    await store.connect(account.id, String(bot.id), bot.username,
                        secrets.seal({ botToken: token }, account.id), digest(pairingCode));
                    return json(202, { status: 'awaiting_telegram', pairingUrl: `https://t.me/${bot.username}?start=${pairingCode}`, expiresIn: 900 });
                } finally { connecting.delete(account.id); }
            }
            if (route === '/api/v1/account/telegram' && req.method === 'PUT') {
                if (!account.owner_id || !account.secrets) throw new ApiError(409, 'telegram_pairing_required', 'Сначала подключи бота.');
                const body = await readBody(req);
                if (Object.keys(body).some(key => !['apiId', 'apiHash', 'sessionString'].includes(key))
                    || !Number.isSafeInteger(body.apiId) || Number(body.apiId) <= 0
                    || typeof body.apiHash !== 'string' || !/^[0-9a-f]{32}$/i.test(body.apiHash)
                    || typeof body.sessionString !== 'string' || !body.sessionString || body.sessionString.length > 20_000) {
                    throw new ApiError(400, 'invalid_body', 'Нужны apiId, apiHash и sessionString личного Telegram-аккаунта.');
                }
                if (connecting.has(account.id)) throw new ApiError(409, 'connection_busy', 'Подключение уже выполняется.');
                connecting.add(account.id);
                try {
                    const telegramSession = { apiId: Number(body.apiId), apiHash: body.apiHash, sessionString: body.sessionString };
                    await telegram.verifySession(telegramSession, account.owner_id);
                    const credentials = secrets.open<TenantCredentials>(account.secrets, account.id);
                    credentials.telegram = telegramSession;
                    await store.updateSecrets(account.id, account.secrets, secrets.seal(credentials, account.id));
                    await runtimes.restart(account.id);
                    return json(202, { status: 'restarting' });
                } finally { connecting.delete(account.id); }
            }
            const readable = req.method === 'GET' && (/^\/api\/v1\/(status|capabilities|history|reminders|tasks|dialogue-jobs|settings|model-settings|scene)$/.test(route)
                || /^\/api\/v1\/files\/[0-9a-f-]{36}$/.test(route));
            const writable = (req.method === 'POST' && /^\/api\/v1\/(messages|actions|scene\/turns|scene\/action-results)$/.test(route))
                || (req.method === 'PATCH' && route === '/api/v1/settings')
                || (req.method === 'PUT' && route === '/api/v1/model-settings')
                || (req.method === 'DELETE' && /^\/api\/v1\/dialogue-jobs\/[0-9a-f-]{36}$/.test(route));
            if (!readable && !writable) throw new ApiError(404, 'not_found', 'Ресурс не найден.');
            if (!account.owner_id) throw new ApiError(409, 'telegram_pairing_required', 'Сначала подключи своего бота и открой ссылку подтверждения в Telegram.');
            await proxy(req, res, runtimes.endpoint(account), route);
        } catch (error) {
            req.resume();
            const safe = error instanceof ApiError ? error : new ApiError(500, 'internal_error', 'Не удалось выполнить запрос.');
            if (!(error instanceof ApiError)) console.error(`[accounts] request=${requestId} failed`);
            if (safe.status === 429) res.setHeader('Retry-After', '60');
            if (!res.headersSent && !res.destroyed) json(safe.status, { error: { code: safe.code, message: safe.message }, requestId });
            else if (!res.writableEnded) res.destroy();
        }
    });
    server.requestTimeout = 30_000;
    server.headersTimeout = 15_000;
    return server;
}
