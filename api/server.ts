import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import * as http from 'node:http';
import { ApiBackend, ApiError, ApiOperationStore } from './contracts';
import { ExternalApiOptions } from './options';
import { parseSettingsPatch } from './settings';
import { MAX_SCENE_BODY_BYTES, parseSceneTurn } from './scene';

const PREFIX = '/api/v1';
const MAX_BODY_BYTES = 64 * 1024;

function hash(text: string): string { return createHash('sha256').update(text).digest('hex'); }

export async function readBody(req: http.IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<Record<string, unknown>> {
    if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
        throw new ApiError(415, 'unsupported_media_type', 'Ожидается application/json.');
    }
    if (Number(req.headers['content-length']) > maxBytes) {
        req.resume();
        throw new ApiError(413, 'body_too_large', 'Слишком большой запрос.');
    }
    const content = await new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let failed = false;
        req.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > maxBytes) {
                if (!failed) reject(new ApiError(413, 'body_too_large', 'Слишком большой запрос.'));
                failed = true;
            } else if (!failed) chunks.push(Buffer.from(chunk));
        });
        req.once('end', () => { if (!failed) resolve(Buffer.concat(chunks)); });
        req.once('error', reject);
        req.once('aborted', () => reject(new ApiError(400, 'request_aborted', 'Запрос прерван.')));
    });
    let value: unknown;
    try { value = JSON.parse(content.toString('utf8')); }
    catch { throw new ApiError(400, 'invalid_json', 'Некорректный JSON.'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new ApiError(400, 'invalid_body', 'Ожидается объект JSON.');
    }
    return value as Record<string, unknown>;
}

/** Independent of Telegram and AI imports so the entire HTTP boundary can be tested offline. */
export function createExternalApiServer(
    options: ExternalApiOptions, backend: ApiBackend, operations: ApiOperationStore,
): http.Server {
    const expectedToken = Buffer.from(hash(options.token));
    let requests = 0;
    let windowStarted = Date.now();
    let busy = false;
    const server = http.createServer(async (req, res) => {
        const requestId = randomUUID();
        res.setHeader('X-Request-Id', requestId);
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        const json = (status: number, value: unknown) => {
            res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(value));
        };
        try {
            const bearer = req.headers.authorization?.match(/^Bearer ([^\s]+)$/i)?.[1] ?? '';
            if (!bearer || !timingSafeEqual(expectedToken, Buffer.from(hash(bearer)))) {
                res.setHeader('WWW-Authenticate', 'Bearer');
                req.resume();
                throw new ApiError(401, 'unauthorized', 'Нужен действующий токен доступа.');
            }
            if (Date.now() - windowStarted >= 60_000) { windowStarted = Date.now(); requests = 0; }
            if (++requests > 120) {
                res.setHeader('Retry-After', '60');
                req.resume();
                throw new ApiError(429, 'rate_limited', 'Слишком много запросов.');
            }
            const url = new URL(req.url ?? '/', 'http://localhost');
            const path = url.pathname;
            if (path === `${PREFIX}/model-preferences`) {
                if (req.method === 'GET' && backend.modelPreferences) return json(200, await backend.modelPreferences());
                if (req.method === 'PUT' && backend.updateModelPreferences) return json(200, await backend.updateModelPreferences(await readBody(req)));
                res.setHeader('Allow', 'GET, PUT');
                req.resume();
                throw new ApiError(405, 'method_not_allowed', 'Ожидается GET или PUT.');
            }
            if (path === `${PREFIX}/settings`) {
                if (req.method === 'GET' && backend.settings) return json(200, await backend.settings());
                if (req.method === 'PATCH' && backend.updateSettings) {
                    const patch = parseSettingsPatch(await readBody(req));
                    return json(200, await backend.updateSettings(patch));
                }
                res.setHeader('Allow', 'GET, PATCH');
                req.resume();
                throw new ApiError(405, 'method_not_allowed', 'Ожидается GET или PATCH.');
            }
            if (req.method === 'GET') {
                if (path === `${PREFIX}/status`) return json(200, await backend.status());
                if (path === `${PREFIX}/capabilities`) return json(200, await backend.capabilities());
                if (path === `${PREFIX}/reminders`) return json(200, await backend.reminders());
                if (path === `${PREFIX}/tasks`) return json(200, await backend.tasks());
                if (path === `${PREFIX}/dialogue-jobs` && backend.dialogueJobs) return json(200, await backend.dialogueJobs());
                if (path === `${PREFIX}/model-settings`) return json(200, await backend.modelSettings());
                if (path === `${PREFIX}/scene`) return json(200, await backend.sceneCapabilities());
                if (path === `${PREFIX}/history`) {
                    const limit = Number(url.searchParams.get('limit') ?? 20);
                    if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
                        throw new ApiError(400, 'invalid_limit', 'limit должен быть от 1 до 20.');
                    }
                    return json(200, await backend.history(limit));
                }
                const fileMatch = path.match(/^\/api\/v1\/files\/([0-9a-f-]{36})$/);
                if (fileMatch) {
                    const file = await backend.file(fileMatch[1]);
                    res.writeHead(200, {
                        'Content-Type': 'application/octet-stream',
                        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
                    });
                    return res.end(file.data);
                }
            }
            if (path === `${PREFIX}/model-settings`) {
                if (req.method !== 'PUT') {
                    res.setHeader('Allow', 'GET, PUT');
                    req.resume();
                    throw new ApiError(405, 'method_not_allowed', 'Ожидается GET или PUT.');
                }
                // Applies from the next turn: a running turn has already read its mode.
                return json(200, await backend.saveModelSettings(await readBody(req)));
            }
            if (path === `${PREFIX}/scene/turns` || path === `${PREFIX}/scene/action-results`) {
                if (req.method !== 'POST') {
                    res.setHeader('Allow', 'POST');
                    req.resume();
                    throw new ApiError(405, 'method_not_allowed', 'Ожидается POST.');
                }
                const isTurn = path.endsWith('/turns');
                const body = await readBody(req, isTurn ? MAX_SCENE_BODY_BYTES : MAX_BODY_BYTES);
                const turn = isTurn ? parseSceneTurn(body) : undefined;
                const preset = turn ? await backend.sceneReady(turn) : null; // vision refused before any receipt
                const sceneKey = req.headers['idempotency-key'];
                if (isTurn && (typeof sceneKey !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(sceneKey))) {
                    throw new ApiError(400, 'idempotency_key_required', 'Нужен Idempotency-Key: 8–128 букв, цифр, _ или -.');
                }
                if (busy) {
                    res.setHeader('Retry-After', '2');
                    throw new ApiError(409, 'conversation_busy', 'Предыдущий запрос ещё выполняется.');
                }
                busy = true;
                try {
                    if (!turn) return json(200, await backend.sceneActionResult(body));
                    const fingerprint = hash(`${path}:${JSON.stringify(body)}`);
                    return json(200, await operations.run(`${options.ownerId}:scene:${hash(sceneKey as string)}`, fingerprint,
                        () => backend.sceneTurn(turn, preset)));
                } finally { busy = false; }
            }
            const dialogueJobMatch = path.match(/^\/api\/v1\/dialogue-jobs\/([0-9a-f-]{36})$/);
            if (dialogueJobMatch && req.method === 'DELETE' && backend.cancelDialogueJob) {
                req.resume();
                return json(200, await backend.cancelDialogueJob(dialogueJobMatch[1]));
            }
            if (path !== `${PREFIX}/messages` && path !== `${PREFIX}/actions`) {
                throw new ApiError(404, 'not_found', 'Ресурс не найден.');
            }
            if (req.method !== 'POST') {
                res.setHeader('Allow', 'POST');
                req.resume();
                throw new ApiError(405, 'method_not_allowed', 'Ожидается POST.');
            }
            const body = await readBody(req);
            const isAction = path.endsWith('/actions');
            const deferredDialogue = !isAction && typeof req.headers.prefer === 'string' && req.headers.prefer.split(',').some(value => value.trim().toLowerCase() === 'respond-async');
            const field = isAction ? 'actionToken' : 'text';
            const value = body[field];
            if (Object.keys(body).some(key => key !== field) || typeof value !== 'string'
                || !value.trim() || value.length > (isAction ? 32_000 : 8_000)) {
                throw new ApiError(400, 'invalid_body', `Передай только непустое поле ${field}.`);
            }
            const idempotencyKey = req.headers['idempotency-key'];
            if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(idempotencyKey)) {
                throw new ApiError(400, 'idempotency_key_required', 'Нужен Idempotency-Key: 8–128 букв, цифр, _ или -.');
            }
            await backend.turnReady(); // before the synchronous busy check and set below, which must stay atomic
            if (busy) {
                res.setHeader('Retry-After', '2');
                throw new ApiError(409, 'conversation_busy', 'Предыдущий запрос ещё выполняется.');
            }
            busy = true;
            try {
                // Actions also deduplicate across different client keys: one button may execute only once.
                const fingerprint = `${deferredDialogue ? 'async:' : ''}${hash(`${path}:${value}`)}`;
                const result = await operations.run(`${options.ownerId}:request:${hash(idempotencyKey)}`, fingerprint,
                    () => isAction
                        ? operations.run(`${options.ownerId}:action:${hash(value)}`, fingerprint, () => backend.action(value))
                        : backend.message(value.trim(), { deferredDialogue }));
                if (deferredDialogue && result.backgroundJob) res.setHeader('Preference-Applied', 'respond-async');
                json(200, result);
            } finally { busy = false; }
        } catch (error) {
            const safe = error instanceof ApiError ? error
                : new ApiError(500, 'internal_error', 'Не удалось выполнить запрос.');
            if (!(error instanceof ApiError)) console.error(`[external-api] request=${requestId} failed`);
            if (!res.headersSent && !res.destroyed) {
                json(safe.status, { error: { code: safe.code, message: safe.message }, requestId });
            }
        }
    });
    server.requestTimeout = 30_000; // Limits upload time, not the duration of AI execution.
    server.headersTimeout = 15_000;
    server.timeout = 0;
    return server;
}
