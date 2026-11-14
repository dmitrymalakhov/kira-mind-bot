import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { tenantName } from '../platform/store';
import { tenantEnvironment } from '../platform/runtime';
import { PlatformSecrets } from '../platform/crypto';
import { operatorRouteAllowed, operatorUpstreamPath } from '../platform/publicAccounts/operatorProxy';
const { createAccountScope, currentAccountScope } = require('../admin-panel/accountScope');
const { parseAccountSettings } = require('../utils/accountSettings');

function response() { return { statusCode:200,body:undefined as any,headers:{} as any,
    status(code:number){this.statusCode=code;return this;},json(body:any){this.body=body;return this;},
    setHeader(key:string,value:string){this.headers[key]=value;} }; }

test('account scopes isolate overlapping requests, imported memory bindings and files without changing process environment', async()=>{
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'kira-scope-'));
    const ids=[randomUUID(),randomUUID()];
    const contexts=new Map(ids.map((id,index)=>[id,{id,username:`synthetic_${index}`,ownerId:String(10001+index),profile:'KiraMindBot',directory:tenantName(id),
        memoryNamespace:index?'synthetic_new':'synthetic_import',memoryBotId:index?'synthetic_new':'kira',settingsRevision:'a'.repeat(64),
        env:{DB_NAME:`synthetic_${index}`,DB_USER:tenantName(id),DB_PASSWORD:'b'.repeat(64),KIRA_MEMORY_NAMESPACE:index?'synthetic_new':'synthetic_import',KIRA_MEMORY_BOT_ID:index?'synthetic_new':'kira'}}]));
    for(const id of ids)await fs.mkdir(path.join(root,tenantName(id),'data'),{recursive:true});
    let unavailable=false;
    const scope=createAccountScope({accountsRoot:root,env:{KIRA_ACCOUNT_AUTH_URL:'http://synthetic.invalid'},operatorAuth:{manageAccounts:async(_req:any,_op:any,{accountId}:any)=>
        unavailable?{ok:false,status:409,body:{error:{code:'account_not_ready'}}}:{ok:true,body:{version:1,scope:contexts.get(accountId)}}}});
    const req=(id?:string,url='/api/memory')=>({path:url,headers:id?{'x-kira-account-id':id}:{}});
    try{
        await Promise.all(ids.map((id,index)=>new Promise<void>((resolve,reject)=>{
            scope.resolve(req(id),response(),()=>{void(async()=>{
                await new Promise(r=>setTimeout(r,index?2:20));
                assert.equal(currentAccountScope().id,id);assert.equal(currentAccountScope().env.DB_USER,tenantName(id));
                assert.equal(currentAccountScope().env.PERSONALITY_FILE,path.join(root,tenantName(id),'personality.json'));
                assert.equal(currentAccountScope().memoryBotId,index?'synthetic_new':'kira');
                assert.ok(Object.isFrozen(currentAccountScope().env));await currentAccountScope().assertActive();resolve();
            })().catch(reject);}).catch(reject);
        })));
        assert.equal(currentAccountScope(),undefined);
        for(const id of [undefined,'../other',randomUUID()]){
            const res=response();await scope.resolve(req(id),res,()=>assert.fail('must fail closed'));assert.ok([409,503].includes(res.statusCode));
        }
        const instance=response();await scope.resolve(req('instance','/api/config'),instance,()=>{});assert.equal(instance.headers['X-Kira-Account-Id'],'instance');
        const forbidden=response();await scope.resolve(req('instance'),forbidden,()=>assert.fail());assert.equal(forbidden.statusCode,409);
        unavailable=true;const pending=response();await scope.resolve(req(ids[0]),pending,()=>assert.fail());assert.equal(pending.statusCode,409);
        unavailable=false;await fs.symlink(root,path.join(root,tenantName(ids[0]),'personality.json'));
        const unsafe=response();await scope.resolve(req(ids[0]),unsafe,()=>assert.fail());assert.equal(unsafe.statusCode,503);
        assert.doesNotMatch(JSON.stringify(unsafe.body),new RegExp(root));
    }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('scoped resource URLs use the same exact gateway inventory and reject nested authority routes or mismatched selectors',async()=>{
    const id=randomUUID(),prefix=`/api/account-scopes/${id}`;
    for(const [method,resource] of [['GET','/memory'],['PATCH','/chats/-10001/public-mode'],['GET','/health/export'],['GET','/image-generation/reference'],['POST','/restart/kira-mind-bot']])
        assert.equal(operatorRouteAllowed(method,prefix+resource),true);
    for(const resource of ['/accounts','/auth/context','/operator/login-account','/login','/account-scopes/instance/config','/internal/operator/accounts','/memory/../config'])
        assert.equal(operatorRouteAllowed('GET',prefix+resource),false);
    for(const resource of ['%2e%2e/config','memory//general','memory/../config'])assert.throws(()=>operatorUpstreamPath('/operator'+prefix+'/'+resource));
    const scope=createAccountScope({env:{KIRA_ACCOUNT_AUTH_URL:'http://synthetic.invalid'},operatorAuth:{}});
    const req:any={url:prefix+'/health/export?format=csv',headers:{}};scope.rewrite(req,response(),()=>{});
    assert.equal(req.url,'/api/health/export?format=csv');assert.equal(req.headers['x-kira-account-id'],id);
    for(const url of [prefix+'/accounts',prefix+'/auth/context',prefix+'/memory%2fgraph']){
        const res=response();scope.rewrite({url,headers:{}},res,()=>assert.fail());assert.ok(res.statusCode>=400);
    }
    const res=response();scope.rewrite({url:prefix+'/config',headers:{'x-kira-account-id':randomUUID()}},res,()=>assert.fail());assert.equal(res.statusCode,400);
});

test('account preferences cannot override identity, credentials, storage or policy and survive only in that worker',()=>{
    for(const key of ['DB_NAME','DB_PASSWORD','OPENAI_API_KEY','KIRA_BOT_TOKEN','KIRA_ALLOWED_USER_ID','KIRA_MEMORY_NAMESPACE','PERSONALITY_FILE','KIRA_PUBLIC_ACCOUNT','__proto__'])
        assert.throws(()=>parseAccountSettings(Object.fromEntries([[key,'synthetic']]),true));
    for(const patch of [{USER_TIMEZONE:'bad-zone'},{DM_REPORT_ENABLED:'yes'},{DM_REPORT_INTERVAL_MS:'-1'},{INBOX_GUARDIAN_HOUR:'24'}])assert.throws(()=>parseAccountSettings(patch,true));
    assert.deepEqual(parseAccountSettings({USER_TIMEZONE:'Europe/Amsterdam',ELEVENLABS_VOICE_ID:null},true),{USER_TIMEZONE:'Europe/Amsterdam',ELEVENLABS_VOICE_ID:null});
    const id=randomUUID(),account:any={id,owner_id:'10001',bot_username:'synthetic_bot',update_offset:0};
    const env=tenantEnvironment({USER_TIMEZONE:'Asia/Tokyo',OPENAI_API_KEY:'synthetic-key'},account,{botToken:'synthetic-token',adminSettings:{USER_TIMEZONE:'Europe/Amsterdam'}},'/synthetic',new PlatformSecrets('ab'.repeat(32)));
    assert.equal(env.USER_TIMEZONE,'Europe/Amsterdam');assert.equal(env.KIRA_ALLOWED_USER_ID,'10001');assert.equal(env.DB_USER,tenantName(id));
    assert.equal(env.OPENAI_API_KEY,'synthetic-key');
});
