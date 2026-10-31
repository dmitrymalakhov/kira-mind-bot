import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApiError } from './contracts';
import { readBody } from './server';
import { LiveBrowserRegistry, liveBrowserSessions, LIVE_BROWSER_CAPABILITY } from '../services/liveBrowserSession';
import { browserUtterance, interpretBrowserControl } from '../services/liveBrowserConversation';

const ROOT = '/api/v1/browser/sessions';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
export const BROWSER_ROUTE = new RegExp(`^${ROOT}/(${UUID})(?:/(events|observers|heartbeat|commands|input|utterances))?$`, 'i');
export function isBrowserApiRoute(path: string, method: string) {
    if (path === `${ROOT}/active`) return method === 'GET';
    const match = BROWSER_ROUTE.exec(path);
    return Boolean(match && (method === 'GET' ? !match[2] || match[2] === 'events' : method === 'POST' && match[2] && match[2] !== 'events'));
}
function commandKey(req: IncomingMessage) {
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(key)) throw new ApiError(400, 'idempotency_key_required', 'Нужен Idempotency-Key.');
    return key;
}
/** Called only after normal Bearer auth; this lane is independent of the held conversation mutex. */
export class BrowserSessionApi {
    readonly capability = LIVE_BROWSER_CAPABILITY;
    constructor(readonly owner: number, readonly scope: string, private readonly inModelScope: <T>(work: () => Promise<T>) => Promise<T>,
        private readonly registry: LiveBrowserRegistry = liveBrowserSessions, private readonly interpret = interpretBrowserControl) {}
    active(operationId?: string) { return this.registry.active(this.owner, this.scope, operationId); }
    async handle(req: IncomingMessage, res: ServerResponse, url: URL) {
        const json = (value: unknown) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
        if (!isBrowserApiRoute(url.pathname, req.method ?? '')) throw new ApiError(404, 'not_found', 'Ресурс не найден.');
        if (url.pathname === `${ROOT}/active`) return json({ session: this.active(url.searchParams.get('operationId') ?? undefined)?.snapshot() ?? null });
        const [, id, action] = BROWSER_ROUTE.exec(url.pathname)!;
        const session = this.registry.get(this.owner, this.scope, id);
        if (req.method === 'GET' && !action) return json({ session: session.snapshot() });
        if (action === 'events') {
            const observerId = url.searchParams.get('observerId');
            const after = url.searchParams.has('after') ? Number(url.searchParams.get('after')) : undefined;
            // Validate before emitting headers, so authentication/ownership errors stay ordinary JSON.
            session.heartbeat(observerId);
            let cleanup = () => {};
            const keepalive = setInterval(() => { if (!res.destroyed && !res.write(': keepalive\n\n')) res.destroy(); }, 5000);
            keepalive.unref();
            res.once('close', () => { clearInterval(keepalive); cleanup(); });
            cleanup = session.subscribe(observerId, event => {
                if (res.destroyed || res.writableLength > 1024 * 1024) return false;
                if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8',
                    'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no', 'Connection': 'keep-alive' });
                res.write(`id: ${event.seq}\nevent: ${event.event}\ndata: ${JSON.stringify(event)}\n\n`);
                return res.writableLength <= 1024 * 1024;
            }, () => { if (!res.writableEnded) res.end(); }, after);
            return;
        }
        const body = await readBody(req, 12 * 1024);
        const allowed: Record<string, string[]> = {
            observers: ['observerId'], heartbeat: ['observerId'], commands: ['type','observerId','expectedRevision','leaseId','confirmationId','decision'],
            input: ['observerId','leaseId','expectedRevision','frameSeq','pageId','navigationEpoch','viewportRevision','input'],
            utterances: ['observerId','leaseId','expectedRevision','assistanceRequestId','source','text'],
        };
        if (Object.keys(body).some(field => !allowed[action]?.includes(field))) throw new ApiError(422, 'invalid_body', 'Неизвестное поле запроса.');
        if (action === 'heartbeat') return json(session.heartbeat(body.observerId));
        const key = commandKey(req);
        if (action === 'observers') {
            const ack = await session.receipt(key, body, async () => ({ commandId: key, accepted: true,
                session: session.registerObserver(body.observerId).session }));
            return json({ observerId: body.observerId, session: ack.session });
        }
        if (action === 'commands') return json(await session.command(key, body));
        if (action === 'input') return json(await session.humanInput(key, body));
        if (action === 'utterances') return json(await this.inModelScope(() => browserUtterance(session, key, body, this.interpret)));
        throw new ApiError(404, 'not_found', 'Ресурс не найден.');
    }
}
