import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as http from "node:http";
import { AccountDeletion } from "../platform/publicAccounts/deletion";
import { DeletionLedger } from "../platform/publicAccounts/deletionLedger";
import { PublicAccountMaintenance } from "../platform/publicAccounts/maintenance";
import { tenantEnvironment } from "../platform/runtime";
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomBytes } from "node:crypto";
import { revokeSession } from "../platform/publicAccounts/sessions";
import { digest } from '../platform/crypto';
import { publicTestPort, publicTestSecrets, withPublicRegistry } from './support/publicAccounts';
import { publicWebHarness, WebTestClient, webOperatorPassword, webBridgeSecret } from './support/publicWeb';

test('web links the existing account, shares canonical identity and history with native login, refreshes and revokes its session', { skip: !publicTestPort }, async () => {
    await withPublicRegistry(async (db, store) => {
        const h = await publicWebHarness(db, store);
        try {
            const owner = await h.account(), other = await h.account(), browser = h.client(), phone = h.client();
            const legacy = await phone.call('/api/v1/accounts/login', { username: owner.username, password: 'synthetic-existing-password-123' });
            assert.equal(legacy.status, 200, JSON.stringify(legacy.data));
            const native = await h.nativePassword(phone, owner);
            assert.equal(native.status, 200, JSON.stringify(native.data));
            assert.equal(native.data.account.id, owner.id);
            const login = await h.webLogin(browser, owner);
            assert.deepEqual(Object.keys(login.data).sort(), ['account', 'version']);
            assert.ok(login.setCookies.every(cookie => cookie.includes('HttpOnly') && cookie.includes('Secure')));
            assert.equal(browser.cookies.get(h.cookieNames.refresh)?.path, '/api/v1/web/auth/refresh');
            assert.ok(!browser.cookieHeader('/operator/api/config').includes(h.cookieNames.refresh));
            const grant = await h.reauth(browser, owner);
            const link = await h.webFlow(browser, 'google', 'link', grant);
            const linked = await h.webComplete(browser, link, 'synthetic-linked-google');
            assert.equal(linked.status, 200, JSON.stringify(linked.data));
            assert.equal(linked.data.provider, 'google');
            const identities = await browser.web('api/account/identities');
            assert.equal(identities.status, 200, JSON.stringify(identities.data));
            assert.deepEqual(identities.data.identities.map((item: any) => item.provider).sort(), ['google', 'password']);
            const googleBrowser = h.client(); await googleBrowser.bootstrap();
            const googleFlow = await h.webFlow(googleBrowser, 'google');
            const googleLogin = await h.webComplete(googleBrowser, googleFlow, 'synthetic-linked-google');
            assert.equal(googleLogin.status, 200, JSON.stringify(googleLogin.data));
            assert.equal(googleLogin.data.account.id, owner.id);
            const nativeHistory = await phone.call('/api/v1/history', undefined, { token: native.data.accessToken });
            const webHistory = await googleBrowser.web('api/history');
            assert.equal(nativeHistory.status, 200, JSON.stringify(nativeHistory.data));
            assert.deepEqual(webHistory.data, nativeHistory.data);
            assert.equal(webHistory.data.messages[0].text, owner.marker);
            assert.equal((await store.byId(owner.id))!.secrets, owner.sealed);
            assert.equal((await db.query('SELECT count(*) FROM kira_accounts'))[0].count, '2');
            assert.equal((await db.query('SELECT count(*) FROM kira_public_consents'))[0].count, '0');
            assert.equal((await browser.call('/operator/api/auth/context')).data.accountAuthorized, false);
            assert.equal((await browser.call('/operator/api/operator/login-account', {})).status, 401);
            assert.equal((await browser.call('/operator/api/config', undefined, { headers: { 'x-operator-role': 'admin', authorization: 'Bearer injected' } })).status, 401);
            const access = browser.value(h.cookieNames.access), refresh = browser.value(h.cookieNames.refresh);
            const [session] = await db.query('SELECT id FROM kira_public_sessions WHERE access_hash=$1', [digest(access)]);
            await db.query("UPDATE kira_public_sessions SET access_expires_at=now()-interval '1 second' WHERE id=$1", [session.id]);
            assert.equal((await browser.web('session')).status, 401);
            assert.equal((await browser.web('auth/refresh', { version: 1 })).status, 200);
            assert.notEqual(browser.value(h.cookieNames.access), access);
            assert.notEqual(browser.value(h.cookieNames.refresh), refresh);
            assert.equal((await browser.web('session')).data.account.id, owner.id);
            assert.equal((await browser.web('auth/logout', { version: 1 })).status, 200);
            assert.equal(browser.value(h.cookieNames.access), '');
            assert.equal(browser.value(h.cookieNames.refresh), '');
            assert.ok((await db.query('SELECT revoked_at FROM kira_public_sessions WHERE id=$1', [session.id]))[0].revoked_at);
            assert.equal(await h.accounts.sessions.authenticate(access), undefined);
            const [revoked] = await db.query('SELECT device_id FROM kira_public_sessions WHERE id=$1', [session.id]);
            await assert.rejects(() => h.accounts.sessions.rotate(refresh, revoked.device_id, 'synthetic-stale-replay'), /./);
            assert.equal((await phone.call('/api/v1/history', undefined, { token: native.data.accessToken })).status, 200, 'logging out browser leaves native session alive');
            assert.equal((await store.byId(other.id))!.secrets, other.sealed);
        } finally { await h.shutdown(); }
    });
});

test('web logout revokes its exact family after access expiry and terminal refresh failure, then permits another existing account', { skip: !publicTestPort }, async () => {
    await withPublicRegistry(async (db, store) => {
        const h = await publicWebHarness(db, store);
        try {
            const a = await h.account(), b = await h.account(), c = h.client(), nativeClient = h.client();
            await h.webLogin(c,a); const native = await h.nativePassword(nativeClient,a);
            const access = c.value(h.cookieNames.access), [session] = await db.query('SELECT * FROM kira_public_sessions WHERE access_hash=$1',[digest(access)]);
            await db.query("UPDATE kira_public_sessions SET access_expires_at=now()-interval '1 second',refresh_expires_at=now()-interval '1 second' WHERE id=$1",[session.id]);
            assert.equal((await c.web('auth/refresh',{version:1})).status,401);
            assert.equal(c.value(h.cookieNames.access),''); assert.equal(c.value(h.cookieNames.refresh),'');
            assert.equal((await c.bootstrap()).data.hasBrowserSession,true);
            const foreign = h.client(); await foreign.bootstrap();
            assert.equal((await foreign.web('auth/logout',{version:1})).status,200);
            assert.equal((await db.query('SELECT revoked_at FROM kira_public_sessions WHERE id=$1',[session.id]))[0].revoked_at,null);
            assert.equal((await c.web('auth/logout',{version:1}, {headers:{origin:'https://foreign.invalid'}})).status,403);
            assert.equal((await c.web('auth/logout',{version:1})).status,200);
            assert.ok((await db.query('SELECT revoked_at FROM kira_public_sessions WHERE id=$1',[session.id]))[0].revoked_at);
            assert.equal((await nativeClient.call('/api/v1/account',undefined,{token:native.data.accessToken})).data.account.id,a.id);
            await h.webLogin(c,b); assert.equal((await c.web('session')).data.account.id,b.id);
            assert.equal((await c.web('auth/logout',{version:1})).status,200);
            await h.webLogin(c,a);
            const [validRefreshSession] = await db.query('SELECT * FROM kira_public_sessions WHERE access_hash=$1',[digest(c.value(h.cookieNames.access))]);
            await db.query("UPDATE kira_public_sessions SET access_expires_at=now()-interval '1 second' WHERE id=$1",[validRefreshSession.id]);
            c.cookies.delete(h.cookieNames.access); // Browser actually expires the 15-minute cookie.
            assert.equal((await c.web('auth/logout',{version:1})).status,200);
            assert.ok((await db.query('SELECT revoked_at FROM kira_public_sessions WHERE id=$1',[validRefreshSession.id]))[0].revoked_at);
        } finally { await h.shutdown(); }
    });
});

test('web proof, lost-response recovery and Telegram callback are browser-bound, one-use, encrypted and linked-only', { skip: !publicTestPort }, async () => {
    await withPublicRegistry(async (db, store) => {
        const h = await publicWebHarness(db,store);
        try {
            const a = await h.account(), c = h.client(), foreign = h.client(); await c.bootstrap();await foreign.bootstrap();
            const nativeConfig = await c.call('/api/v1/auth/config');
            assert.equal(nativeConfig.data.providers.find((p:any)=>p.provider==='telegram').redirectUri,h.config.telegram.redirectUri);
            assert.equal((await c.bootstrap()).data.providers.find((p:any)=>p.provider==='telegram').redirectUri,h.settings.origin+'/api/v1/web/auth/telegram/callback');
            const unknown = await h.webFlow(c,'google');
            assert.equal((await h.webComplete(c,unknown,'synthetic-unlinked-same-email')).status,409);
            assert.equal((await db.query('SELECT count(*) FROM kira_accounts'))[0].count,'1');
            const password = await h.webFlow(c,'password');
            assert.equal((await c.web('auth/password',{version:1,flowId:password.flowId,username:a.username,password:'synthetic-existing-password-123',captchaToken:h.captcha()},{headers:{'x-csrf-token':'foreign'}})).status,403);
            assert.equal((await foreign.web('auth/password',{version:1,flowId:password.flowId})).status,401);
            const logged = await h.webComplete(c,password,a.username);assert.equal(logged.status,200,JSON.stringify(logged.data));
            const recovered = await c.web('auth/password',{version:1,flowId:password.flowId});assert.equal(recovered.status,200);assert.equal(recovered.data.account.id,a.id);
            const changed = await h.webComplete(c,password,a.username);assert.equal(changed.status,409);assert.equal(changed.data.error.code,'idempotency_conflict');
            const grant = await h.reauth(c,a), tg = await h.webFlow(c,'telegram','link',grant), code = h.prepareTelegram(tg,'synthetic-web-telegram');
            const callback = '/api/v1/web/auth/telegram/callback?'+new URLSearchParams({state:code.state,code:code.code});
            assert.equal((await foreign.call(callback)).status,401);
            assert.equal((await c.call(callback+'&state=duplicate')).status,400);
            assert.equal(h.exchanges.length,0,'callback alone cannot exchange provider code before CAPTCHA');
            const results = await Promise.all([c.call(callback),c.call(callback)]); assert.deepEqual(results.map(r=>r.status).sort(),[303,401]);
            assert.equal(h.exchanges.length,0);
            const [stored] = await db.query('SELECT * FROM kira_public_web_flows WHERE challenge_id=$1',[tg.flowId]);
            assert.ok(!JSON.stringify(stored).includes(code.code));assert.ok(!JSON.stringify(stored).includes(code.state));
            const linked = await h.webComplete(c,tg,'');assert.equal(linked.status,200,JSON.stringify(linked.data));assert.equal(linked.data.provider,'telegram');
            assert.equal(h.exchanges.length,1);assert.equal(h.exchanges[0].redirect,h.settings.origin+'/api/v1/web/auth/telegram/callback');
            assert.equal((await c.web('auth/telegram',{version:1,flowId:tg.flowId})).status,200);
            assert.equal(h.exchanges.length,1,'receipt recovery cannot repeat code exchange');
            assert.equal((await db.query('SELECT count(*) FROM kira_public_consents'))[0].count,'0');
            const phone = h.client(), verifier = randomBytes(48).toString('base64url');
            const native = await phone.call('/api/v1/auth/challenges',{version:1,provider:'telegram',purpose:'login',deviceId:phone.nativeDevice,codeChallenge:createHash('sha256').update(verifier).digest('base64url'),codeChallengeMethod:'S256'});
            const nativeCode = h.prepareTelegram({...native.data,flowId:native.data.challengeId},'synthetic-web-telegram');
            const phoneLogin = await phone.call('/api/v1/auth/telegram',{version:1,challengeId:native.data.challengeId,state:native.data.state,deviceId:phone.nativeDevice,deviceName:'Synthetic native phone',authorizationCode:nativeCode.code,codeVerifier:verifier,proof:{type:'hcaptcha',token:h.captcha(),reason:'unsupported'}});
            assert.equal(phoneLogin.status,200,JSON.stringify(phoneLogin.data));assert.equal(phoneLogin.data.account.id,a.id);
            assert.equal((await store.byId(a.id))!.secrets,a.sealed);
            const serialized = JSON.stringify(await db.query('SELECT * FROM kira_public_web_flows'));
            assert.doesNotMatch(serialized,/synthetic-profile@example|Synthetic external profile|synthetic-captcha/);
        } finally {await h.shutdown();}
    });
});

test('operator requires explicit exact-account proof and password, rechecks canonical authority on every request and preserves private recovery', { skip: !publicTestPort }, async () => {
    await withPublicRegistry(async(db,store)=>{
        const h=await publicWebHarness(db,store);
        try {
            const a=await h.account(),b=await h.account(),c=h.client(),other=h.client();await h.webLogin(c,a);await h.webLogin(other,b);
            await c.call('/operator/api/auth/context');
            const grant=await h.reauth(c,a), body={operatorPassword:webOperatorPassword,reauthenticationToken:grant,confirmedAccountId:a.id};
            assert.equal((await c.call('/operator/api/operator/link-account',body)).status,401);
            assert.equal((await c.call('/operator/api/login',{username:'synthetic_operator',password:webOperatorPassword})).status,200);
            assert.equal((await c.call('/operator/api/operator/link-account',{...body,confirmedAccountId:b.id})).status,401);
            assert.equal((await c.call('/operator/api/operator/link-account',body)).status,200);
            assert.equal((await c.call('/operator/api/operator/link-account',body)).status,409);
            assert.equal((await c.web('session')).data.operatorAccess,true);
            await c.call('/operator/api/logout',{});await c.call('/operator/api/auth/context');
            assert.equal((await c.call('/operator/api/config')).status,401,'transport/role alone does not establish local operator intent');
            assert.equal((await c.call('/operator/api/operator/login-account',{})).status,200);
            assert.equal((await c.call('/operator/api/config')).data.globalOperatorOnly,true);
            const access=c.value(h.cookieNames.access), [session]=await db.query('SELECT * FROM kira_public_sessions WHERE access_hash=$1',[digest(access)]);
            await db.query("UPDATE kira_public_sessions SET access_expires_at=now()-interval '1 second' WHERE id=$1",[session.id]);c.cookies.delete(h.cookieNames.access);
            assert.equal((await c.call('/operator/api/config')).status,401);
            assert.equal((await c.web('auth/refresh',{version:1})).status,200);
            assert.equal((await c.call('/operator/api/config')).status,200);
            assert.ok(h.operatorRequests.every(row=>!row.cookieNames.includes(h.cookieNames.refresh)&&!row.authorization));
            await c.call('/operator/api/logout',{});assert.equal((await c.web('session')).data.account.id,a.id);
            await c.call('/operator/api/auth/context');await c.call('/operator/api/operator/login-account',{});
            await h.accounts.sessions.logout(a.id,session.id);assert.equal((await c.call('/operator/api/config')).status,401);
            assert.equal((await other.web('session')).data.account.id,b.id);
            // The old private operator password remains independent of central availability.
            const privateClient = new WebTestClient(h.operatorBase,'192.0.2.99');const privateContext=await privateClient.call('/api/auth/context');
            const privateOrigin = h.operatorBase;
            const recovery=await privateClient.call('/api/login',{username:'synthetic_operator',password:webOperatorPassword},{headers:{origin:privateOrigin,'x-csrf-token':privateClient.csrf}}); assert.equal(recovery.status,200,JSON.stringify({data:recovery.data,context:privateContext.data,contextCookies:privateContext.setCookies,cookies:[...privateClient.cookies.keys()],csrf:!!privateClient.csrf,origin:privateOrigin}));
            h.settings.operatorEnabled=false;
            assert.equal((await privateClient.call('/api/config')).status,200);
        } finally {await h.shutdown();}
    });
});

function latch() {let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}
async function bounded<T>(promise:Promise<T>):Promise<T>{let timer:ReturnType<typeof setTimeout>;try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Synthetic barrier timeout')),5000);})]);}finally{clearTimeout(timer!);}}

test('operator introspection cannot combine a session read before revocation with a role granted afterwards', {skip:!publicTestPort},async()=>{
    await withPublicRegistry(async(db,store)=>{
        const h=await publicWebHarness(db,store),original=db.query.bind(db),read=latch(),resume=latch();let pending:Promise<any>|undefined;
        try {
            const a=await h.account(),c=h.client();await h.webLogin(c,a);const access=c.value(h.cookieNames.access);
            const [session]=await original('SELECT id FROM kira_public_sessions WHERE access_hash=$1',[digest(access)]);
            (db as any).query=async(sql:string,args:any[])=>{const result=await original(sql,args);if(args?.[0]===digest(access)&&sql.includes('kira_public_sessions')){read.resolve();await resume.promise;}return result;};
            pending=h.accounts.web!.operator.introspect(access,c.value(h.cookieNames.browser));await bounded(read.promise);
            await h.accounts.sessions.logout(a.id,session.id);
            await original('INSERT INTO kira_public_operator_grants(account_id) VALUES($1)',[a.id]);
            resume.resolve();assert.equal((await pending).authorized,false);
            assert.equal((await h.accounts.web!.operator.introspect(access,c.value(h.cookieNames.browser))).authorized,false);
        }finally{resume.resolve();await Promise.allSettled([pending]);(db as any).query=original;await h.shutdown();}
    });
});

test('operator role mutation waits for session revocation and cannot consume proof or grant after it commits', {skip:!publicTestPort},async()=>{
    await withPublicRegistry(async(db,store)=>{
        const h=await publicWebHarness(db,store),blocker=db.createQueryRunner();let pending:Promise<any>|undefined;
        try {
            const a=await h.account(),c=h.client();await h.webLogin(c,a);const grant=await h.reauth(c,a),access=c.value(h.cookieNames.access);
            const [session]=await db.query('SELECT id FROM kira_public_sessions WHERE access_hash=$1',[digest(access)]);
            await blocker.connect();await blocker.startTransaction();await blocker.query('SELECT id FROM kira_public_sessions WHERE id=$1 FOR UPDATE',[session.id]);
            pending=h.accounts.web!.operator.setGrant(access,c.value(h.cookieNames.browser),grant,a.id,true).then(value=>({value}),error=>({error}));
            await bounded((async()=>{while(true){const [row]=await db.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND cardinality(pg_blocking_pids(pid))>0");if(row.count)return;await new Promise(resolve=>setTimeout(resolve,10));}})());
            await revokeSession(blocker.manager,session.id);await blocker.commitTransaction();
            assert.equal((await pending).error.code,'unauthorized');
            assert.equal((await db.query('SELECT count(*) FROM kira_public_operator_grants'))[0].count,'0');
            assert.equal((await db.query('SELECT consumed_at FROM kira_public_reauthentication WHERE token_hash=$1',[digest(grant)]))[0].consumed_at,null);
        }finally{if(blocker.isTransactionActive)await blocker.rollbackTransaction();await Promise.allSettled([pending]);await blocker.release();await h.shutdown();}
    });
});

test('web metadata is erased by actual account deletion and TTL maintenance while another account and its role survive', {skip:!publicTestPort},async()=>{
    await withPublicRegistry(async(db,store)=>{
        const h=await publicWebHarness(db,store),directory=await fs.mkdtemp(path.join(os.tmpdir(),'kira-web-delete-'));
        try{
            const a=await h.account(),b=await h.account(),c=h.client(),other=h.client();await h.webLogin(c,a);await h.webLogin(other,b);
            for(const row of [a,b])await db.query('INSERT INTO kira_public_operator_grants(account_id) VALUES($1)',[row.id]);
            const grant=await h.reauth(c,a),auth=(await h.accounts.sessions.authenticate(c.value(h.cookieNames.access)))!;
            await h.webFlow(c,'google','reauthenticate');await h.webFlow(other,'google','reauthenticate');
            const deletion=new AccountDeletion(db,store,publicTestSecrets,h.runtimes,{verify:async()=>{throw Error('Not used');},revokeApple:async()=>{}},
                new DeletionLedger(path.join(directory,'ledger'),'synthetic-web-ledger-key-32-chars'),{
                    validate:async value=>assert.equal(value.accountId,a.id),eraseVectors:async()=>{},eraseDatabase:async()=>{},eraseFiles:async()=>{}
                },id=>path.join(directory,id));
            await deletion.request(auth,{version:1,confirmation:'delete_my_account',reauthenticationToken:grant});
            assert.equal((await c.web('session')).status,401);assert.equal((await h.accounts.web!.operator.introspect(c.value(h.cookieNames.access),c.value(h.cookieNames.browser))).authorized,false);
            await deletion.drain();assert.equal(await store.byId(a.id),undefined);
            assert.equal((await db.query('SELECT count(*) FROM kira_public_web_browsers WHERE account_id=$1',[a.id]))[0].count,'0');
            assert.equal((await db.query('SELECT count(*) FROM kira_public_operator_grants WHERE account_id=$1',[a.id]))[0].count,'0');
            assert.equal((await other.web('session')).data.account.id,b.id);assert.equal((await other.web('session')).data.operatorAccess,true);
            assert.equal((await db.query('SELECT count(*) FROM kira_public_web_flows'))[0].count,'2','other account login and pending reauth only');
            await db.query("UPDATE kira_public_web_flows SET expires_at=now()-interval '1 second'");await new PublicAccountMaintenance(db).drain();
            assert.equal((await db.query('SELECT count(*) FROM kira_public_web_flows'))[0].count,'0');
            assert.equal((await other.web('session')).data.account.id,b.id);
            const workerEnv=tenantEnvironment({KIRA_OPERATOR_BRIDGE_SECRET:webBridgeSecret,KIRA_PUBLIC_WEB_ORIGIN:h.settings.origin,KIRA_ACCOUNT_AUTH_URL:h.base},await store.byId(b.id) as any,{apiToken:'synthetic-worker-key'} as any,directory,publicTestSecrets);
            for(const key of ['KIRA_OPERATOR_BRIDGE_SECRET','KIRA_PUBLIC_WEB_ORIGIN','KIRA_ACCOUNT_AUTH_URL'])assert.equal(workerEnv[key],undefined);
        }finally{await h.shutdown();await fs.rm(directory,{recursive:true,force:true});}
    });
});

test('raw operator path tricks cannot reach internal bridge and public headers cannot establish authority', {skip:!publicTestPort},async()=>{
    await withPublicRegistry(async(db,store)=>{
        const h=await publicWebHarness(db,store);
        try{
            const c=h.client();const before=h.operatorRequests.length;
            for(const raw of ['/operator/../internal/operator/session','/operator/%2e%2e/internal/operator/session','/operator/%252e%252e/internal/operator/session','/operator//api/config','/operator/api/../../internal/operator/session','/operator/api%2fconfig','/operator/api/..%5cconfig','/operator/api/internal/operator/session']){
                const result=await new Promise<number>((resolve,reject)=>{const req=http.request({hostname:new URL(h.base).hostname,port:new URL(h.base).port,path:raw,method:'POST',headers:{'x-kira-operator-bridge':webBridgeSecret,'content-type':'application/json'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode!));});req.on('error',reject);req.end('{}');});
                assert.equal(result,404,raw);
            }
            assert.equal(h.operatorRequests.length,before);
            assert.equal((await c.call('/operator/api/config',undefined,{headers:{'x-kira-operator-bridge':webBridgeSecret,'x-operator-role':'admin'}})).status,401);
            assert.equal((await c.call('/internal/operator/session',{version:1,accessToken:'a'.repeat(43),browserCookie:'b'.repeat(43)})).status,401);
        }finally{await h.shutdown();}
    });
});
