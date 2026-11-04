import * as http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApiError } from '../../api/contracts';
import type { PublicAccountConfig } from './config';
import type { PublicWebConfig } from './webConfig';
import { publicClientAddress } from './limits';
import type { PublicLimits } from './limits';

const GET = new Set(['auth/context','config','ai-preset','chats','recurring-tasks','memory','memory/graph','health/logs','health/export',
    'status','monitoring/health','ai-usage/summary','ai-usage/traces','personality','local-models','mcp/servers','image-recognition',
    'image-generation','image-generation/connection','image-generation/reference','budget-mode','background-features','product-analytics','model-preferences']);
const POST = new Set(['login','logout','config','ai-preset','personality','local-models','image-recognition','image-generation',
    'image-generation/reference','budget-mode','background-features','product-analytics/review','memory','operator/link-account','operator/unlink-account','operator/login-account']);
const PUT = new Set(['model-preferences','product-analytics/targets']);
const SEGMENT = '[A-Za-z0-9_.-]{1,128}';

/** Fixed method/path inventory. Neither decoded nor rewritten internal paths are proxied. */
export function operatorRouteAllowed(method: string, path: string): boolean {
    if (method === 'GET' && (path === '/' || /^\/(assets\/[A-Za-z0-9_.-]+\.(js|css)|brand\/[A-Za-z0-9_.-]+\.(png|svg|webp|ico)|site\.webmanifest)$/.test(path))) return true;
    if (!path.startsWith('/api/')) return false;
    const api = path.slice(5);
    if (method === 'GET' && GET.has(api) || method === 'POST' && POST.has(api) || method === 'PUT' && PUT.has(api)) return true;
    if (method === 'GET' && new RegExp(`^memory/${SEGMENT}/${SEGMENT}$`).test(api)) return true;
    if (method === 'POST' && new RegExp(`^(restart/${SEGMENT}|recurring-tasks/${SEGMENT}/run|mcp/servers/${SEGMENT}(/check)?)$`).test(api)) return true;
    if (method === 'PUT' && new RegExp(`^mcp/servers/${SEGMENT}$`).test(api)) return true;
    if (method === 'PATCH' && new RegExp(`^(chats/-?[0-9]{1,20}/(forbidden-topics|allowed-domains|public-mode)|recurring-tasks/${SEGMENT}|memory/${SEGMENT}/${SEGMENT})$`).test(api)) return true;
    return method === 'DELETE' && (api === 'image-generation/reference' || new RegExp(`^(recurring-tasks/${SEGMENT}|mcp/servers/${SEGMENT}|memory/${SEGMENT}/${SEGMENT})$`).test(api));
}

export function operatorUpstreamPath(rawUrl: string): string {
    const rawPath = rawUrl.split('?', 1)[0];
    let decoded: string;
    try { decoded = decodeURIComponent(rawPath); } catch { throw new ApiError(404, 'not_found', 'Ресурс не найден.'); }
    if (decoded !== rawPath || rawPath.includes('\\') || rawPath.includes('//') || /(?:^|\/)\.{1,2}(?:\/|$)/.test(rawPath) || !rawPath.startsWith('/operator/')) {
        throw new ApiError(404, 'not_found', 'Ресурс не найден.');
    }
    return rawPath.slice('/operator'.length);
}

export async function proxyOperator(req: IncomingMessage, res: ServerResponse, config: PublicAccountConfig, settings: PublicWebConfig, limits?: PublicLimits): Promise<void> {
    if (!settings.operatorEnabled || !settings.operatorBridgeSecret) throw new ApiError(404, 'not_found', 'Ресурс не найден.');
    const path = operatorUpstreamPath(req.url || '/');
    if (!operatorRouteAllowed(req.method || '', path)) throw new ApiError(404, 'not_found', 'Ресурс не найден.');
    const ip = publicClientAddress(req, config.gateway.peers, config.gateway.secret);
    if (limits && ['/api/login','/api/auth/context','/api/operator/login-account','/api/operator/link-account','/api/operator/unlink-account'].includes(path)) {
        await limits.take(`operator-auth-ip:${ip}`, 30, 60);
    }
    const target = new URL(settings.operatorTarget);
    // The production loader supplies a fixed Docker service; only test dependency
    // injection can select another target. Requests never supply a URL or Host.
    const length = req.headers['content-length'];
    const maxBytes = 10 * 1024 * 1024;
    if (length !== undefined && (!/^[0-9]+$/.test(length) || Number(length) > maxBytes)) throw new ApiError(413, 'body_too_large', 'Слишком большой запрос.');
    if (req.method === 'GET' && (Number(length || 0) !== 0 || req.headers['transfer-encoding'])) throw new ApiError(400, 'invalid_body', 'Некорректный запрос.');
    const headers: http.OutgoingHttpHeaders = {};
    for (const name of ['cookie','content-type','content-length','accept','origin','x-csrf-token','idempotency-key']) {
        if (typeof req.headers[name] === 'string') headers[name] = req.headers[name];
    }
    headers.host = target.host;
    headers['x-kira-operator-bridge'] = settings.operatorBridgeSecret;
    headers['x-kira-client-ip'] = ip;
    headers['x-forwarded-proto'] = 'https';
    headers['x-forwarded-host'] = new URL(settings.origin).host;
    headers['x-forwarded-prefix'] = '/operator';
    const query = new URL(req.url || '/', settings.origin).search;
    await new Promise<void>((resolve, reject) => {
        let received = 0;
        const upstream = http.request({ hostname: target.hostname, port: target.port || 80, path: path + query, method: req.method, headers }, response => {
            res.statusCode = response.statusCode || 502;
            for (const name of ['content-type','set-cookie','content-disposition','vary','content-security-policy','referrer-policy','x-content-type-options']) {
                if (response.headers[name]) res.setHeader(name, response.headers[name]!);
            }
            res.setHeader('Cache-Control', 'no-store');
            if (response.headers.location) {
                const redirect = new URL(response.headers.location, target);
                if (redirect.origin !== target.origin) { response.destroy(); reject(new ApiError(502, 'operator_unavailable', 'Панель временно недоступна.')); return; }
                res.setHeader('Location', '/operator' + redirect.pathname + redirect.search);
            }
            response.on('error', () => reject(new ApiError(502, 'operator_unavailable', 'Панель временно недоступна.')));
            response.on('end', resolve);
            response.pipe(res);
        });
        upstream.setTimeout(60_000, () => upstream.destroy());
        upstream.once('error', () => reject(new ApiError(502, 'operator_unavailable', 'Панель временно недоступна.')));
        req.on('data', (chunk: Buffer) => { received += chunk.length; if (received > maxBytes) upstream.destroy(); });
        req.once('aborted', () => upstream.destroy());
        req.pipe(upstream);
    });
}
