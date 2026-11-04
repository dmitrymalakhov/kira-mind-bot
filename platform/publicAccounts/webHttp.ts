import type { IncomingMessage, ServerResponse } from 'node:http';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { DataSource } from 'typeorm';
import { ApiError } from '../../api/contracts';
import { readBody } from '../../api/server';
import type { AccountStore } from '../store';
import { PlatformSecrets } from '../crypto';
import type { PublicAccountsHttp } from './http';
import { publicAuthConfig } from './config';
import type { AuthenticatedAccount } from './identities';
import { PublicWebAuth, WebAuthDependencies } from './webAuth';
import { PublicOperatorBridge } from './operatorBridge';
import { proxyOperator } from './operatorProxy';
import type { PublicWebConfig } from './webConfig';
import type { WebProvider } from './webContracts';
import * as v from './validation';

export const ACCOUNT_CONSOLE_CSP = "default-src 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; "
    + "script-src 'self' https://accounts.google.com/gsi/client https://hcaptcha.com https://*.hcaptcha.com; "
    + "style-src 'self' https://accounts.google.com/gsi/style https://hcaptcha.com https://*.hcaptcha.com; "
    + "connect-src 'self' https://accounts.google.com/gsi/ https://hcaptcha.com https://*.hcaptcha.com; "
    + "frame-src https://accounts.google.com/gsi/ https://hcaptcha.com https://*.hcaptcha.com; img-src 'self' data:; font-src 'self'";

const READ = new Set(['account','account/identities','account/sessions','account/consents','account/quota','status','history','settings','model-settings','model-preferences']);
function accountRouteAllowed(method: string, endpoint: string): boolean {
    if (method === 'GET') return READ.has(endpoint);
    if (method === 'PATCH') return endpoint === 'settings';
    if (method === 'PUT') return ['account/consents','model-preferences'].includes(endpoint);
    return method === 'DELETE' && /^account\/(identities|sessions)\/[0-9a-f-]{36}$/i.test(endpoint);
}

export class PublicWebHttp {
    readonly auth: PublicWebAuth;
    readonly operator: PublicOperatorBridge;
    constructor(private owner: PublicAccountsHttp, db: DataSource, store: AccountStore, secrets: PlatformSecrets,
        readonly settings: PublicWebConfig, dependencies: WebAuthDependencies = {}) {
        this.auth = new PublicWebAuth(db, store, secrets, owner.sessions, owner.config, owner.limits, settings, account => owner.view(account), dependencies);
        this.operator = new PublicOperatorBridge(db, owner.sessions, settings);
    }

    private security(res: ServerResponse): void {
        res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
        res.setHeader('Content-Security-Policy', ACCOUNT_CONSOLE_CSP);
    }

    private async authenticated(req: IncomingMessage) {
        const browser = await this.auth.browser(req);
        const auth = await this.auth.authenticate(req);
        if (!auth || auth.session.device_id !== browser.deviceId || auth.account.id !== browser.accountId || auth.session.id !== browser.sessionId) throw new ApiError(401, 'unauthorized', 'Войди в аккаунт ещё раз.');
        return { browser, auth };
    }

    async route(req: IncomingMessage, res: ServerResponse, route: string, json: (status: number, body: unknown) => void): Promise<boolean> {
        const rawPath = (req.url || '/').split('?', 1)[0];
        const protectedPath = [route, rawPath].some(value => ['/operator','/account','/api/v1/web/','/internal/operator/'].some(prefix => value.startsWith(prefix)));
        if (protectedPath && (rawPath !== route || /[%\\]/.test(rawPath) || rawPath.includes('//') || /(?:^|\/)\.{1,2}(?:\/|$)/.test(rawPath))) {
            throw new ApiError(404, 'not_found', 'Ресурс не найден.');
        }
        if (route === '/operator' || route.startsWith('/operator/')) {
            if (!this.settings.operatorEnabled) throw new ApiError(404, 'not_found', 'Ресурс не найден.');
            if (route === '/operator' && req.method === 'GET') { res.writeHead(303, { Location: '/operator/' }); res.end(); }
            else await proxyOperator(req, res, this.owner.config, this.settings, this.owner.limits);
            return true;
        }
        if (route.startsWith('/internal/operator/')) return this.operator.route(req, route, json);
        const isStatic = route === '/account' || route.startsWith('/account/');
        const isWeb = route.startsWith('/api/v1/web/') && !route.startsWith('/api/v1/web/api/');
        if (!isStatic && !isWeb) return false;
        this.security(res);
        if (isStatic) {
            if (req.method !== 'GET') throw new ApiError(405, 'method_not_allowed', 'Недопустимый метод.');
            if (route === '/account') { res.writeHead(303, { Location: '/account/' }); res.end(); return true; }
            const assets: Record<string, [string,string]> = { '/account/': ['index.html','text/html; charset=utf-8'],
                '/account/account.js': ['account.js','application/javascript; charset=utf-8'], '/account/account.css': ['account.css','text/css; charset=utf-8'] };
            const asset = assets[route];
            if (!asset) throw new ApiError(404, 'not_found', 'Ресурс не найден.');
            const content = await fs.readFile(path.join(process.cwd(), 'account-console', asset[0]));
            res.writeHead(200, { 'Content-Type': asset[1] }); res.end(content); return true;
        }
        if (route === '/api/v1/web/config' && req.method === 'GET') {
            await this.owner.authLimit(req);
            const browser = await this.auth.browser(req, res, true);
            const native = publicAuthConfig(this.owner.config);
            json(200, { ...native, providers: native.providers.filter(provider => provider.provider !== 'apple').map(provider => provider.provider === 'telegram'
                    ? { ...provider, redirectUri: this.settings.origin + '/api/v1/web/auth/telegram/callback' } : provider),
                proof: { ...native.proof, appAttest: false, appAttestAppId: null }, channel: 'web', publicRegistration: false, hasBrowserSession: Boolean(browser.sessionId), csrfToken: this.auth.csrf(browser) });
            return true;
        }
        if (route === '/api/v1/web/session' && req.method === 'GET') {
            const { auth } = await this.authenticated(req);
            json(200, { version: 1, account: await this.owner.view(auth.account), operatorAccess: await this.operator.authorized(auth.account.id),
                operatorLinkingAvailable: this.settings.operatorEnabled }); return true;
        }
        if (route === '/api/v1/web/auth/pending' && req.method === 'GET') {
            const query = new URL(req.url || '/', this.settings.origin).searchParams;
            if ([...query.keys()].some(key => key !== 'flowId') || query.getAll('flowId').length > 1) v.invalid();
            const flowId = query.has('flowId') ? v.uuid(query.get('flowId')) : undefined;
            json(200, await this.auth.pending(await this.auth.browser(req), flowId)); return true;
        }
        if (route === '/api/v1/web/auth/telegram/callback' && req.method === 'GET') {
            await this.owner.authLimit(req);
            await this.auth.telegramCallback(await this.auth.browser(req), new URL(req.url || '/', this.settings.origin).searchParams);
            res.writeHead(303, { Location: this.settings.origin + '/account/' }); res.end(); return true;
        }
        const posts = new Set(['/api/v1/web/auth/challenges','/api/v1/web/auth/google','/api/v1/web/auth/telegram',
            '/api/v1/web/auth/password','/api/v1/web/auth/refresh','/api/v1/web/auth/logout']);
        if (!posts.has(route)) throw new ApiError(404, 'not_found', 'Ресурс не найден.');
        if (req.method !== 'POST') throw new ApiError(405, 'method_not_allowed', 'Недопустимый метод.');
        const ip = await this.owner.authLimit(req);
        const browser = await this.auth.browser(req);
        this.auth.requireCsrf(req, browser);
        const body = await readBody(req), auth = await this.auth.authenticate(req);
        if (route === '/api/v1/web/auth/challenges') json(200, await this.auth.challenge(browser, body, auth));
        else if (route === '/api/v1/web/auth/refresh' || route === '/api/v1/web/auth/logout') {
            v.fields(body, ['version'], ['version']); v.version(body);
            if (route.endsWith('/refresh')) await this.auth.refresh(req, browser, res);
            else await this.auth.logout(req, browser, res);
            json(200, { version: 1, ok: true });
        } else json(200, await this.auth.complete(browser, route.split('/').pop() as WebProvider, body, ip, res, auth));
        return true;
    }

    async resolveApi(req: IncomingMessage, url: URL): Promise<{ path: string; auth: AuthenticatedAccount }|undefined> {
        const prefix = '/api/v1/web/api/';
        if (!url.pathname.startsWith(prefix)) return undefined;
        const endpoint = url.pathname.slice(prefix.length);
        if (!accountRouteAllowed(req.method || '', endpoint) || /[%\\]/.test(req.url?.split('?', 1)[0] || '')) throw new ApiError(404, 'not_found', 'Ресурс не найден.');
        const { browser, auth } = await this.authenticated(req);
        if (req.method !== 'GET') this.auth.requireCsrf(req, browser);
        return { path: '/api/v1/' + endpoint, auth };
    }
}
