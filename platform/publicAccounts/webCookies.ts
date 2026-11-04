import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApiError } from '../../api/contracts';
import type { TokenPair } from './contracts';

export const WEB_ACCESS_COOKIE = '__Host-kira.access';
export const WEB_REFRESH_COOKIE = '__Secure-kira.refresh';
export const WEB_BROWSER_COOKIE = '__Host-kira.browser';
export const WEB_REFRESH_PATH = '/api/v1/web/auth/refresh';

export function equalSecret(actual: string, expected: string): boolean {
    const a = Buffer.from(actual), b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
}

/** Duplicate security-cookie names are rejected, including parent-domain cookie tossing. */
export function webCookie(req: IncomingMessage, name: string): string | undefined {
    const header = req.headers.cookie || '';
    if (header.length > 8192) throw new ApiError(401, 'web_session_invalid', 'Начни вход заново.');
    const matches = header.split(';').map(part => part.trim()).filter(part => part.startsWith(name + '='));
    if (matches.length > 1) throw new ApiError(401, 'web_session_invalid', 'Начни вход заново.');
    const value = matches[0]?.slice(name.length + 1);
    if (value !== undefined && !/^[A-Za-z0-9_-]{32,128}$/.test(value)) throw new ApiError(401, 'web_session_invalid', 'Начни вход заново.');
    return value;
}

function cookie(res: ServerResponse, name: string, value: string, seconds: number, path = '/') {
    const previous = res.getHeader('Set-Cookie');
    const list = previous === undefined ? [] : Array.isArray(previous) ? previous.map(String) : [String(previous)];
    const maxAge = Math.max(0, Math.floor(seconds));
    list.push(`${name}=${value}; Path=${path}; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Lax`);
    res.setHeader('Set-Cookie', list);
}

export function setBrowserCookie(res: ServerResponse, value: string, expiresAt: Date): void {
    cookie(res, WEB_BROWSER_COOKIE, value, (expiresAt.getTime() - Date.now()) / 1000);
}

/** Exactly the canonical access lifetime and fixed refresh-family deadline. */
export function setWebCredentials(res: ServerResponse, pair: TokenPair): void {
    cookie(res, WEB_ACCESS_COOKIE, pair.accessToken, pair.expiresIn);
    cookie(res, WEB_REFRESH_COOKIE, pair.refreshToken, (Date.parse(pair.refreshExpiresAt) - Date.now()) / 1000, WEB_REFRESH_PATH);
}

export function clearWebCredentials(res: ServerResponse): void {
    cookie(res, WEB_ACCESS_COOKIE, '', 0);
    cookie(res, WEB_REFRESH_COOKIE, '', 0, WEB_REFRESH_PATH);
}

export function clearBrowserCookie(res: ServerResponse): void { cookie(res, WEB_BROWSER_COOKIE, '', 0); }
export function webCsrfToken(browserCookie: string, secret: string): string {
    return createHmac('sha256', secret).update('kira-web-csrf-v1\n' + browserCookie).digest('hex');
}

export function requireWebOrigin(req: IncomingMessage, origin: string): void {
    if (req.headers.origin !== origin || (req.headers['sec-fetch-site'] !== undefined && req.headers['sec-fetch-site'] !== 'same-origin')) {
        throw new ApiError(403, 'csrf_invalid', 'Открой страницу аккаунта и повтори действие.');
    }
}
