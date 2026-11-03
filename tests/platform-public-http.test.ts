import assert from 'node:assert/strict';
import test from 'node:test';
import * as http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { AddressInfo } from 'node:net';
import { PublicAccountsHttp } from '../platform/publicAccounts/http';
import { OfficialIdentityVerifier } from '../platform/publicAccounts/providers';
import { OfficialAppProof } from '../platform/publicAccounts/proof';
import { createPlatformServer } from '../platform/server';
import { loadJose } from '../platform/publicAccounts/cryptoModules';
import { digest,newToken,passwordHash } from '../platform/crypto';
import { AccountDeletion } from '../platform/publicAccounts/deletion';
import { DeletionLedger } from '../platform/publicAccounts/deletionLedger';
import { publicTestConfig,publicTestPort,publicTestSecrets,withPublicRegistry } from './support/publicAccounts';

async function listen(server:http.Server){await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;}
async function close(server:http.Server){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}

test('real HTTP/provider crypto creates API-only account, preserves legacy bearer, rotates native family and closes password signup', {skip:!publicTestPort},async()=>{
    await withPublicRegistry(async(db,store)=>{
        const jose=await loadJose(),config=publicTestConfig(),keys=await jose.generateKeyPair('RS256',{extractable:true});
        const jwk=await jose.exportJWK(keys.publicKey);jwk.kid='synthetic-http-key';
        const workerToken=newToken();
        const worker=http.createServer((req,res)=>{assert.equal(req.headers.authorization,`Bearer ${workerToken}`);res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true,mode:'api_only'}));});
        await listen(worker);
        const runtimes={status:()=> 'ready',endpoint:()=>({port:(worker.address() as AddressInfo).port,token:workerToken}),restart:async()=>{}};
        const publicAccounts=new PublicAccountsHttp(db,store,publicTestSecrets,runtimes,config,{
            identityVerifier:new OfficialIdentityVerifier(config,fetch,()=>new Date(),{google:jose.createLocalJWKSet({keys:[jwk]})}),
            proofVerifier:new OfficialAppProof(db,config,async()=>new Response(JSON.stringify({success:true,hostname:config.captcha.hostname,challenge_ts:new Date().toISOString()}))),
        });
        const server=createPlatformServer({store,secrets:publicTestSecrets,runtimes,telegram:{} as any,publicAccounts});
        const url=await listen(server);
        const call=async(path:string,method='GET',token?:string,body?:unknown,key?:string)=>{
            const response=await fetch(url+path,{method,headers:{...(token?{authorization:`Bearer ${token}`}:{ }),...(body?{'content-type':'application/json'}:{}),...(key?{'idempotency-key':key}:{})},...(body?{body:JSON.stringify(body)}:{})});
            return {status:response.status,data:await response.json() as any};
        };
        try{
            assert.equal((await call('/api/v1/accounts/register','POST',undefined,{username:'synthetic_new',password:'synthetic-password-123'})).status,410);
            assert.equal((await call('/api/v1/accounts/login','POST',undefined,{username:'synthetic_legacy',password:'synthetic-password-123'})).data.error.code,'invalid_credentials');
            const deviceId=randomUUID().toUpperCase();
            const challenge=await call('/api/v1/auth/challenges','POST',undefined,{version:1,provider:'google',purpose:'login',deviceId});
            assert.equal(challenge.status,200);
            const jwt=await new jose.SignJWT({sub:'synthetic-http-subject',nonce:challenge.data.nonce,email:'synthetic@example.invalid'})
                .setProtectedHeader({alg:'RS256',kid:jwk.kid}).setIssuer('https://accounts.google.com').setAudience(config.google.clientId).setIssuedAt().setExpirationTime('5m').sign(keys.privateKey);
            const body={version:1,challengeId:challenge.data.challengeId,state:challenge.data.state,deviceId,deviceName:'Synthetic phone',identityToken:jwt,
                proof:{type:'hcaptcha',token:'synthetic-http-captcha-'+randomUUID(),reason:'unsupported'}};
            const login=await call('/api/v1/auth/google','POST',undefined,body,'synthetic-http-login');
            assert.equal(login.status,200,JSON.stringify(login.data));
            assert.equal(login.data.expiresIn,900);assert.equal(login.data.account.bot,null);
            assert.equal(login.data.account.accountState,'registered');assert.equal(login.data.account.runtimeState,'not_activated');
            assert.equal(login.data.account.isReady,false);assert.equal(login.data.account.autonomousAiEnabled,false);
            const account=(await store.byId(login.data.account.id))!;assert.equal(account.owner_id,null);assert.equal(account.secrets,null);
            const repeat=await call('/api/v1/auth/google','POST',undefined,body,'synthetic-http-login');assert.equal(repeat.data.accessToken,login.data.accessToken);
            const token=login.data.accessToken;
            assert.equal((await call('/api/v1/account/consents','GET',token)).data.aiAllowed,false);
            const accept=await call('/api/v1/account/consents','PUT',token,{version:1,consentVersion:config.catalog.version,accepted:true,recipientIds:['synthetic-ai']},'synthetic-consent-save');
            assert.equal(accept.status,200);assert.equal(accept.data.aiAllowed,true);
            assert.equal((await call('/api/v1/account/quota','GET',token)).data.quota.ai.remaining,20);
            const activation=await call('/api/v1/account/activate','POST',token,{version:1},'synthetic-activation');
            assert.equal(activation.status,202);assert.equal(activation.data.account.isReady,true);
            assert.equal((await call('/api/v1/status','GET',token)).data.mode,'api_only','owner_id/bot is not a runtime routing gate');
            const legacy=newToken();await store.session(digest(legacy),account.id);
            assert.equal((await call('/api/v1/account','GET',legacy)).data.account.id,account.id);
            assert.equal((await call('/api/v1/account/sessions','GET',token)).data.sessions.length,1);
            const refresh={version:1,refreshToken:login.data.refreshToken,deviceId};
            const rotated=await call('/api/v1/auth/refresh','POST',undefined,refresh,'synthetic-refresh');
            assert.equal(rotated.status,200);assert.notEqual(rotated.data.accessToken,token);
            assert.equal((await call('/api/v1/account','GET',token)).status,401);
            assert.deepEqual((await call('/api/v1/auth/refresh','POST',undefined,refresh,'synthetic-refresh')).data,rotated.data);
            assert.equal((await call('/api/v1/auth/logout','POST',rotated.data.accessToken,{version:1},'synthetic-logout')).status,200);
            assert.equal((await call('/api/v1/auth/logout','POST',rotated.data.accessToken,{version:1},'synthetic-logout')).status,401,'terminal logout cannot replay through a revoked bearer');
            assert.equal((await call('/api/v1/account','GET',rotated.data.accessToken)).status,401);
            assert.equal((await call('/api/v1/account','GET',legacy)).status,200,'current native logout does not silently revoke independent legacy import key');
        }finally{await close(server);await close(worker);}
    });
});

test('HTTP unknown App Attest key closes its challenge; a fresh challenge is required and no crypto failure permits proof replacement', {skip:!publicTestPort},async()=>{
    await withPublicRegistry(async(db,store)=>{
        const config=publicTestConfig(),account=await store.create('synthetic_key_recovery',await passwordHash('synthetic-existing-password'));
        const runtimes={status:()=> 'waiting',endpoint:()=>{throw Error('No worker needed');},restart:async()=>{}};
        const publicAccounts=new PublicAccountsHttp(db,store,publicTestSecrets,runtimes,config,{
            proofVerifier:new OfficialAppProof(db,config,async()=>new Response(JSON.stringify({success:true,hostname:config.captcha.hostname,challenge_ts:new Date().toISOString()}))),
        });
        const server=createPlatformServer({store,secrets:publicTestSecrets,runtimes,telegram:{} as any,publicAccounts}),url=await listen(server),deviceId=randomUUID();
        const post=async(route:string,body:unknown,key?:string)=>{
            const response=await fetch(url+'/api/v1/'+route,{method:'POST',headers:{'content-type':'application/json',...(key?{'idempotency-key':key}:{})},body:JSON.stringify(body)});
            return {status:response.status,data:await response.json() as any};
        };
        try{
            const request={version:1,provider:'password',purpose:'login',deviceId};
            const first=(await post('auth/challenges',request)).data;
            assert.deepEqual(first.proofRequirement,{mode:'app_attest_or_hcaptcha',reason:null});
            const body={version:1,challengeId:first.challengeId,state:first.state,deviceId,deviceName:'Synthetic reinstall',username:account.username,password:'synthetic-existing-password',
                proof:{type:'app_attest',keyId:randomBytes(32).toString('base64'),assertion:Buffer.from('synthetic unknown-key assertion').toString('base64')}};
            const unknown=await post('auth/password',body,'synthetic-key-recovery');
            assert.equal(unknown.status,403);assert.equal(unknown.data.error.code,'app_attest_key_unknown');
            assert.equal((await db.query('SELECT count(*) FROM kira_public_sessions'))[0].count,'0');
            const fallback={...body,proof:{type:'hcaptcha',token:'synthetic-key-captcha',reason:'unsupported'}};
            assert.equal((await post('auth/password',fallback,'synthetic-key-recovery')).data.error.code,'idempotency_conflict');
            assert.equal((await post('auth/password',fallback,'synthetic-key-recovery-new')).data.error.code,'challenge_invalid');
            const fresh=(await post('auth/challenges',request)).data;assert.notEqual(fresh.challengeId,first.challengeId);
            const login=await post('auth/password',{...fallback,challengeId:fresh.challengeId,state:fresh.state},'synthetic-new-proof-login');
            assert.equal(login.status,200,'a genuinely new flow can use a supported proof; old challenge cannot downgrade');
            const authenticated={authorization:`Bearer ${login.data.accessToken}`,'content-type':'application/json'};
            const activation=await fetch(url+'/api/v1/account/activate',{method:'POST',headers:{...authenticated,'idempotency-key':'synthetic-unpaired-activation'},body:JSON.stringify({version:1})});
            assert.equal(activation.status,202);const activated=(await activation.json() as any).account;
            assert.equal(activated.id,account.id);assert.equal(activated.runtimeMode,'api_only');assert.equal(activated.autonomousAiEnabled,false);
            assert.ok(Number((await store.byId(account.id))!.runtime_principal)<0);
            const botConnection=await fetch(url+'/api/v1/account/bot',{method:'PUT',headers:authenticated,body:JSON.stringify({botToken:'synthetic-unusable-bot-token'})});
            assert.equal(botConnection.status,409);assert.equal((await botConnection.json() as any).error.code,'runtime_mode_fixed');
            assert.deepEqual(publicTestSecrets.open((await store.byId(account.id))!.secrets!,account.id),{runtimeMode:'api_only'},'unsupported legacy connection cannot overwrite API-only credentials');
        }finally{await close(server);}
    });
});

test('lost HTTP deletion acceptance retries as401 and does not prove completed erasure or create a new account', {skip:!publicTestPort},async()=>{
    await withPublicRegistry(async(db,store)=>{
        const directory=await mkdtemp(path.join(tmpdir(),'kira-public-delete-http-'));
        const config=publicTestConfig(),account=await store.create('synthetic_delete_http',await passwordHash('synthetic-existing-password'));
        const runtimes={status:()=> 'waiting',endpoint:()=>{throw Error('No worker needed');},restart:async()=>{}};
        const publicAccounts=new PublicAccountsHttp(db,store,publicTestSecrets,runtimes,config,{
            proofVerifier:new OfficialAppProof(db,config,async()=>new Response(JSON.stringify({success:true,hostname:config.captcha.hostname,challenge_ts:new Date().toISOString()}))),
        });
        const ledger=new DeletionLedger(directory,publicTestSecrets.derive('deletion-ledger','api'));
        publicAccounts.deletion=new AccountDeletion(db,store,publicTestSecrets,runtimes,{verify:async()=>{throw Error('Not used');},revokeApple:async()=>{}},ledger,
            {validate:async()=>{},eraseVectors:async()=>{},eraseDatabase:async()=>{},eraseFiles:async()=>{}},id=>path.join(directory,id));
        const [identity]=await db.query("INSERT INTO kira_public_identities(id,account_id,provider,subject) VALUES($1,$2,'password',$3) RETURNING id",[randomUUID(),account.id,account.id]);
        const deviceId=randomUUID(),pair=await db.transaction(tx=>publicAccounts.sessions.issue(tx,account.id,identity.id,deviceId,'Synthetic phone'));
        const server=createPlatformServer({store,secrets:publicTestSecrets,runtimes,telegram:{} as any,publicAccounts});
        let dropDeletionResponse=true;
        server.prependListener('request',(req,res)=>{if(req.method==='DELETE' && req.url==='/api/v1/account' && dropDeletionResponse){dropDeletionResponse=false;res.end=(()=>{res.destroy();return res;}) as typeof res.end;}});
        const url=await listen(server),headers={authorization:`Bearer ${pair.accessToken}`,'content-type':'application/json'};
        try{
            const challenge=await fetch(url+'/api/v1/auth/challenges',{method:'POST',headers,body:JSON.stringify({version:1,provider:'password',purpose:'reauthenticate',deviceId})}).then(r=>r.json()) as any;
            const reauthResponse=await fetch(url+'/api/v1/auth/password',{method:'POST',headers:{...headers,'idempotency-key':'synthetic-delete-reauth'},body:JSON.stringify({version:1,challengeId:challenge.challengeId,state:challenge.state,deviceId,deviceName:'Synthetic phone',username:account.username,password:'synthetic-existing-password',proof:{type:'hcaptcha',token:'synthetic-delete-reauth-captcha',reason:'unsupported'}})});
            assert.equal(reauthResponse.status,200);const reauth=await reauthResponse.json() as any;
            assert.deepEqual(Object.keys(reauth).sort(),['expiresAt','reauthenticationToken','version']);
            const request={method:'DELETE',headers:{...headers,'idempotency-key':'synthetic-delete-lost-response'},body:JSON.stringify({version:1,confirmation:'delete_my_account',reauthenticationToken:reauth.reauthenticationToken})};
            await assert.rejects(()=>fetch(url+'/api/v1/account',request),'the server commits acceptance but the transport drops its response');
            assert.equal((await fetch(url+'/api/v1/account',request)).status,401,'revoked bearer cannot replay a terminal receipt');
            assert.equal((await store.byId(account.id))!.account_state,'deleting','401 alone never means erasure completed');
            const jobs=await db.query('SELECT state FROM kira_public_deletions WHERE account_id=$1',[account.id]);assert.equal(jobs.length,1);assert.equal(jobs[0].state,'pending');
            assert.deepEqual(await readdir(directory),[`${account.id}.json`]);
            assert.equal((await db.query('SELECT count(*) FROM kira_accounts'))[0].count,'1','uncertain outcome never signs up a replacement account');
        }finally{await close(server);await rm(directory,{recursive:true,force:true});}
    });
});

test('native password flow preserves existing credentials while invalid proof/callback never issues a session', {skip:!publicTestPort},async()=>{
    await withPublicRegistry(async(db,store)=>{
        const config=publicTestConfig(),account=await store.create('synthetic_password_user',await passwordHash('synthetic-existing-password'));
        const runtimes={status:()=> 'waiting',endpoint:()=>{throw Error('No runtime required');},restart:async()=>{}};
        const publicAccounts=new PublicAccountsHttp(db,store,publicTestSecrets,runtimes,config,{
            proofVerifier:new OfficialAppProof(db,config,async()=>new Response(JSON.stringify({success:true,hostname:config.captcha.hostname,challenge_ts:new Date().toISOString()}))),
        });
        const deviceId=randomUUID();
        const challenge=await publicAccounts.identities.challenge({version:1,provider:'password',purpose:'login',deviceId});
        const body={version:1,challengeId:challenge.challengeId,state:challenge.state,deviceId,deviceName:'Synthetic phone',username:account.username,password:'synthetic-existing-password',
            proof:{type:'hcaptcha',token:'synthetic-existing-password-captcha',reason:'unsupported'}};
        await assert.rejects(()=>publicAccounts.identities.authenticate('password',{...body,state:'wrong-state-value-32-chars-long-now'},'synthetic-wrong-state','192.0.2.1'),(e:any)=>e.code==='challenge_invalid');
        const logged=await publicAccounts.identities.authenticate('password',body,'synthetic-password-login','192.0.2.1');
        assert.equal(logged.kind,'login');if(logged.kind==='login')assert.equal(logged.accountId,account.id);
        assert.equal((await publicAccounts.identities.list(account.id))[0].provider,'password');
        const server=createPlatformServer({store,secrets:publicTestSecrets,runtimes,telegram:{} as any,publicAccounts}),url=await listen(server);
        try{
            const legacyResponse=await fetch(url+'/api/v1/accounts/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:account.username,password:'synthetic-existing-password'})});
            assert.equal(legacyResponse.status,200);const legacy=await legacyResponse.json() as any;assert.equal(legacy.expiresIn,2592000);
            assert.equal((await store.authenticate(digest(legacy.accessToken)))?.id,account.id);
            const headers={authorization:`Bearer ${legacy.accessToken}`,'content-type':'application/json'};
            const consent=await fetch(url+'/api/v1/account/consents',{headers}).then(r=>r.json()) as any;
            assert.equal(consent.aiAllowed,false,'legacy login never grants implicit AI consent');
            const accepted=await fetch(url+'/api/v1/account/consents',{method:'PUT',headers:{...headers,'idempotency-key':'synthetic-legacy-explicit-consent'},body:JSON.stringify({version:1,consentVersion:consent.catalog.version,accepted:true,recipientIds:consent.catalog.recipients.map((r:any)=>r.id)})});
            assert.equal(accepted.status,200);assert.equal((await accepted.json() as any).aiAllowed,true,'existing client credentials can reach an explicit consent route');
            const prooflessNative=await fetch(url+'/api/v1/auth/password',{method:'POST',headers:{'content-type':'application/json','idempotency-key':'synthetic-no-native-bypass'},body:JSON.stringify({username:account.username,password:'synthetic-existing-password'})});
            assert.equal(prooflessNative.status,400,'native proof requirements are unchanged');
        }finally{await close(server);}
    });
});
