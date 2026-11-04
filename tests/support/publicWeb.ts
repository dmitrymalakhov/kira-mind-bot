import assert from 'node:assert/strict';
import * as http from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { loadJose } from '../../platform/publicAccounts/cryptoModules';
import { OfficialIdentityVerifier } from '../../platform/publicAccounts/providers';
import { OfficialAppProof } from '../../platform/publicAccounts/proof';
import { PublicAccountsHttp } from '../../platform/publicAccounts/http';
import { createPlatformServer } from '../../platform/server';
import { newToken, passwordHash } from '../../platform/crypto';
import { WEB_ACCESS_COOKIE, WEB_BROWSER_COOKIE, WEB_REFRESH_COOKIE } from '../../platform/publicAccounts/webCookies';
import { publicTestConfig, publicTestSecrets } from './publicAccounts';

const adminRequire = createRequire(path.resolve(process.cwd(), 'admin-panel/package.json'));
const express = adminRequire('express');
const { createOperatorAuth } = adminRequire('./operatorAuth.js');
export const webSyntheticOrigin = 'https://synthetic.example.invalid';
export const webSyntheticPassword = 'synthetic-existing-password-123';
export const webOperatorPassword = 'synthetic-operator-password-123';
export const webBridgeSecret = '56'.repeat(32);
export const listen = async (server: http.Server) => { await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); return `http://127.0.0.1:${(server.address() as AddressInfo).port}`; };
export const close = async (server: http.Server) => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); };

/** A path-aware cookie jar: in particular, refresh never accompanies operator requests. */
export class WebTestClient {
    readonly cookies = new Map<string, { value: string; path: string }>();
    csrf = ''; operatorCsrf = ''; readonly nativeDevice = randomUUID();
    constructor(readonly base: string, readonly ip: string) {}
    value(name: string): string { return this.cookies.get(name)?.value || ''; }
    cookieHeader(route: string): string { return [...this.cookies].filter(([, row]) => route === row.path || route.startsWith(row.path.endsWith('/') ? row.path : row.path + '/'))
        .map(([name, row]) => `${name}=${row.value}`).join('; '); }
    async call(route: string, body?: unknown, options: { method?: string; token?: string; headers?: Record<string,string>; key?: string } = {}) {
        const method = options.method || (body === undefined ? 'GET' : 'POST');
        const headers: Record<string,string> = { 'x-kira-gateway-secret': 'synthetic-gateway-handoff-key', 'x-kira-client-ip': this.ip,
            cookie: this.cookieHeader(route), ...(method === 'GET' ? {} : { origin: webSyntheticOrigin, 'x-csrf-token': route.startsWith('/operator/') ? this.operatorCsrf : this.csrf,
                'content-type': 'application/json', 'idempotency-key': options.key || randomUUID() }),
            ...(options.token ? { authorization: `Bearer ${options.token}` } : {}), ...options.headers };
        const response = await fetch(this.base + route, { method, headers, redirect: 'manual', ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        const setCookies = (response.headers as any).getSetCookie() as string[];
        for (const text of setCookies) {
            const [entry, ...attributes] = text.split(';'), index = entry.indexOf('='), name = entry.slice(0,index), value = entry.slice(index+1);
            const attrs = Object.fromEntries(attributes.map(part => part.trim().split('=').map(value => value.trim())).map(([key,value]) => [key.toLowerCase(),value]));
            if (attrs['max-age'] === '0') this.cookies.delete(name);
            else this.cookies.set(name, { value, path: attrs.path || '/' });
        }
        const text = await response.text(), data = response.headers.get('content-type')?.includes('application/json') && text ? JSON.parse(text) : text;
        if (typeof data?.csrfToken === 'string') { if (route.startsWith('/operator/')) this.operatorCsrf = data.csrfToken; else this.csrf = data.csrfToken; }
        return { status: response.status, data: data as any, headers: response.headers, setCookies };
    }
    async bootstrap() { const result = await this.call('/api/v1/web/config'); assert.equal(result.status,200); return result; }
    web(route: string, body?: unknown, options?: Parameters<WebTestClient['call']>[2]) { return this.call('/api/v1/web/' + route, body, options); }
}

export async function publicWebHarness(db: any, store: any) {
    const jose = await loadJose(), keys = await jose.generateKeyPair('RS256', { extractable: true });
    const jwk = await jose.exportJWK(keys.publicKey); jwk.kid = 'synthetic-web-oidc-key';
    const jwks = jose.createLocalJWKSet({ keys: [jwk] });
    const config = publicTestConfig(); config.readyCapabilities!.push = false;
    config.gateway = { peers: ['127.0.0.1'], secret: 'synthetic-gateway-handoff-key' };
    const settings = { origin: webSyntheticOrigin, operatorEnabled: true, operatorBridgeSecret: webBridgeSecret, operatorTarget: 'http://127.0.0.1:9' };
    const exchanges: Array<{ redirect: string; scopes?: string }> = [], captchaCalls: string[] = [];
    const codes = new Map<string, { subject: string; nonce: string; challenge: string; redirect: string }>();
    const sign = (provider: 'google'|'telegram', subject: string, nonce: string, overrides: Record<string,unknown> = {}) =>
        new jose.SignJWT({ sub: subject, nonce, email: 'synthetic-profile@example.invalid', name: 'Synthetic external profile', picture: 'https://synthetic.example.invalid/profile.png', ...overrides })
            .setProtectedHeader({ alg: 'RS256', kid: jwk.kid }).setIssuer(provider === 'google' ? 'https://accounts.google.com' : 'https://oauth.telegram.org')
            .setAudience(config[provider].clientId).setIssuedAt().setExpirationTime('5m').sign(keys.privateKey);
    const verifier = (cfg: typeof config) => new OfficialIdentityVerifier(cfg, async (input, init) => {
        assert.equal(String(input), 'https://oauth.telegram.org/token');
        const form = new URLSearchParams(String(init?.body)), code = codes.get(form.get('code') || '');
        assert.equal((init?.headers as any).authorization, `Basic ${Buffer.from(`${cfg.telegram.clientId}:${cfg.telegram.clientSecret}`).toString('base64')}`);
        if (!code || code.redirect !== form.get('redirect_uri') || createHash('sha256').update(form.get('code_verifier') || '').digest('base64url') !== code.challenge) return new Response('{}',{status:400});
        codes.delete(form.get('code')!); exchanges.push({ redirect: form.get('redirect_uri')! });
        return new Response(JSON.stringify({ id_token: await sign('telegram',code.subject,code.nonce) }));
    }, () => new Date(), { google: jwks, telegram: jwks });
    const proof = new OfficialAppProof(db, config, async (input, init) => {
        assert.equal(String(input),'https://api.hcaptcha.com/siteverify');
        const form = new URLSearchParams(String(init?.body)); assert.equal(form.get('secret'),config.captcha.secret); assert.equal(form.get('sitekey'),config.captcha.siteKey);
        captchaCalls.push(form.get('response')!);
        return new Response(JSON.stringify({ success: form.get('response')?.startsWith('synthetic-captcha-'), hostname: config.captcha.hostname, challenge_ts: new Date().toISOString() }));
    });
    const workers = new Map<string,{ server: http.Server; port: number; token: string; marker: string }>();
    const runtimes = { status: () => 'ready', endpoint: (account: any) => { const value = workers.get(account.id); if (!value) throw Error('Synthetic worker missing'); return { port:value.port,token:value.token }; }, restart: async (_id: string) => {} };
    const accounts = new PublicAccountsHttp(db,store,publicTestSecrets,runtimes,config,{ identityVerifier:verifier(config),proofVerifier:proof,
        webConfig:settings,webDependencies:{identityVerifierFactory:verifier,proofVerifier:proof} });
    const server = createPlatformServer({store,secrets:publicTestSecrets,runtimes,telegram:{} as any,publicAccounts:accounts});
    const base = await listen(server);
    const app = express(), operator = createOperatorAuth({ username:'synthetic_operator',password:webOperatorPassword,sessionSecret:'synthetic-operator-session-secret',cookieName:'synthetic.private.sid',env:{
        KIRA_PUBLIC_OPERATOR_ENABLED:'true',KIRA_PUBLIC_WEB_ORIGIN:webSyntheticOrigin,KIRA_OPERATOR_BRIDGE_SECRET:webBridgeSecret,KIRA_ACCOUNT_AUTH_URL:base } });
    const operatorRequests: Array<{ path: string; cookieNames: string[]; authorization: unknown }> = [];
    app.use((req: any, _res: any, next: any) => { operatorRequests.push({path:req.path,cookieNames:String(req.headers.cookie||'').split(';').map((part:string)=>part.trim().split('=')[0]),authorization:req.headers.authorization});next(); });
    app.use(operator.prepare);app.use(express.json());app.use(operator.session);app.use(operator.csrfGuard);operator.register(app);
    app.post('/api/login',operator.rateLimit,operator.login);
    app.post('/api/logout',(req:any,res:any)=>req.session.destroy(()=>res.json({success:true})));
    app.get('/api/config',operator.requireAuth,(_req:any,res:any)=>res.json({globalOperatorOnly:true}));
    app.post('/api/config',operator.requireAuth,(_req:any,res:any)=>res.json({saved:true}));
    const opServer=http.createServer(app),operatorBase=await listen(opServer);settings.operatorTarget=operatorBase;
    let clients=1,existing=0;
    const client=()=>new WebTestClient(base,`192.0.2.${clients++}`);
    const captcha=()=>`synthetic-captcha-${randomUUID()}`;
    const account=async()=>{
        const index=++existing,row=await store.create(`synthetic_web_${index}`,await passwordHash(webSyntheticPassword));
        const workerToken=newToken(),marker=`synthetic-history-${index}`;
        const worker=http.createServer((req,res)=>{assert.equal(req.headers.authorization,`Bearer ${workerToken}`);res.setHeader('content-type','application/json');
            res.end(JSON.stringify(req.url?.startsWith('/api/v1/history')?{messages:[{role:'user',text:marker,createdAt:'2026-01-01T12:00:00Z'}]}:{syntheticWorker:index}));});
        await listen(worker);workers.set(row.id,{server:worker,port:(worker.address() as AddressInfo).port,token:workerToken,marker});
        const sealed=publicTestSecrets.seal({botToken:'synthetic-personal-bot-token',apiToken:workerToken,existingStorage:{database:`synthetic_tenant_${index}`,memoryNamespace:`synthetic_memory_${index}`,memoryBotId:`synthetic_bot_${index}`}},row.id);
        await db.query('UPDATE kira_accounts SET owner_id=$2,bot_id=$3,bot_username=$4,secrets=$5 WHERE id=$1',[row.id,String(42424000+index),String(51515000+index),`synthetic_bot_${index}`,sealed]);
        return {...(await store.byId(row.id)),sealed,marker};
    };
    const prepareTelegram=(flow:any,subject:string)=>{
        const url=new URL(flow.authorizationUrl),code=`synthetic-telegram-code-${randomUUID()}`;
        assert.equal(url.searchParams.get('scope'),'openid profile');assert.ok(url.search.includes('scope=openid+profile'));
        codes.set(code,{subject,nonce:flow.nonce,challenge:url.searchParams.get('code_challenge')!,redirect:url.searchParams.get('redirect_uri')!});
        return{code,state:url.searchParams.get('state')!,url};
    };
    const webFlow=async(c:WebTestClient,name:'password'|'google'|'telegram',purpose='login',grant?:string)=>{
        const response=await c.web('auth/challenges',{version:1,provider:name,purpose,...(grant?{reauthenticationToken:grant}:{})});assert.equal(response.status,200,JSON.stringify(response.data));return response.data;
    };
    const webComplete=async(c:WebTestClient,flow:any,value:string)=>{
        const fields=flow.provider==='password'?{username:value,password:webSyntheticPassword}:flow.provider==='google'?{identityToken:await sign('google',value,flow.nonce)}:{};
        return c.web('auth/'+flow.provider,{version:1,flowId:flow.flowId,captchaToken:captcha(),...fields});
    };
    const webLogin=async(c:WebTestClient,row:any)=>{await c.bootstrap();const flow=await webFlow(c,'password');const result=await webComplete(c,flow,row.username);assert.equal(result.status,200,JSON.stringify(result.data));assert.equal(result.data.account.id,row.id);return result;};
    const reauth=async(c:WebTestClient,row:any)=>{const flow=await webFlow(c,'password','reauthenticate');const result=await webComplete(c,flow,row.username);assert.equal(result.status,200,JSON.stringify(result.data));return result.data.reauthenticationToken as string;};
    const nativePassword=async(c:WebTestClient,row:any)=>{
        const response=await c.call('/api/v1/auth/challenges',{version:1,provider:'password',purpose:'login',deviceId:c.nativeDevice});assert.equal(response.status,200);const flow=response.data;
        return c.call('/api/v1/auth/password',{version:1,challengeId:flow.challengeId,state:flow.state,deviceId:c.nativeDevice,deviceName:'Synthetic native phone',username:row.username,password:webSyntheticPassword,proof:{type:'hcaptcha',token:captcha(),reason:'unsupported'}});
    };
    const cookieNames={access:WEB_ACCESS_COOKIE,browser:WEB_BROWSER_COOKIE,refresh:WEB_REFRESH_COOKIE};
    const shutdown=async()=>{await close(server);await close(opServer);for(const value of workers.values())await close(value.server);};
    return{db,store,config,settings,accounts,server,base,operatorBase,runtimes,client,account,captcha,sign,prepareTelegram,webFlow,webComplete,webLogin,reauth,nativePassword,cookieNames,captchaCalls,exchanges,operatorRequests,shutdown};
}
