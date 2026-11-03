import assert from 'node:assert/strict';
import test from 'node:test';
import * as http from 'node:http';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { fork,ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { PublicAccountPolicy } from '../platform/publicAccounts/policy';
import { PublicInbox } from '../platform/publicAccounts/inbox';
import { attachAccountAuthority } from '../platform/publicAccounts/runtimeBridge';
import { publicTestConfig,publicTestPort,publicTestSecrets,withPublicRegistry } from './support/publicAccounts';

test('actual worker SDK/image/embedding transports make zero calls before consent, share one durable quota, and block revoke/fallback/background/filter at execution', {skip:!publicTestPort},async()=>{
    await withPublicRegistry(async(db,store)=>{
        const directory=await fs.mkdtemp(path.join(process.env.KIRA_PUBLIC_TEST_SCRATCH || os.tmpdir(),'kira-public-egress-'));
        const a=await store.create('synthetic_egress_a','disabled'),b=await store.create('synthetic_egress_b','disabled');
        let moderationCalls=0,modelCalls=0,flagged=false;
        const server=http.createServer(async(req,res)=>{
            for await(const _chunk of req){};
            res.setHeader('content-type','application/json');
            if(req.url==='/v1/moderations'){moderationCalls++;res.end(JSON.stringify({results:[{flagged,categories:{}}]}));return;}
            modelCalls++;
            if(req.url==='/v1/embeddings')res.end(JSON.stringify({data:[{embedding:[0,0,0,1]}],usage:{prompt_tokens:4,total_tokens:4}}));
            else if(req.url==='/v1/images/generations')res.end(JSON.stringify({data:[{b64_json:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1kAAAAASUVORK5CYII='}]}));
            else res.end(JSON.stringify({id:'synthetic-response',object:'chat.completion',created:1,model:'synthetic-model',choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:'Synthetic safe answer'}}]}));
        });
        await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
        const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
        const config=publicTestConfig();config.routes=[{provider:'openai',baseUrl:base,recipientIds:['synthetic-ai']}];
        const policy=new PublicAccountPolicy(db,()=>config),inbox=new PublicInbox(db,publicTestSecrets);
        let child:ChildProcess|undefined;
        async function start(){
            child=fork(path.resolve(__dirname,'fixtures/publicAccountPolicyWorker.ts'),[],{cwd:directory,execArgv:['--require',require.resolve('ts-node/register')],
                env:{NODE_ENV:'test',PATH:process.env.PATH,KIRA_TENANT_ID:a.id,KIRA_RUNTIME_MODE:'api_only',KIRA_RUNTIME_PRINCIPAL:'-1',
                    KIRA_RUNTIME_DATA_DIR:path.join(directory,'data'),OPENAI_API_KEY:'synthetic-key',OPENAI_BASE_URL:base,OPENROUTER_API_KEY:'synthetic-key',
                    TS_NODE_PROJECT:path.resolve(__dirname,'../tsconfig.server.json'),
                    KIRA_PUBLIC_MODERATION_API_KEY:'synthetic-filter-key',KIRA_PUBLIC_MODERATION_BASE_URL:base},stdio:['ignore','ignore','pipe','ipc']});
            let diagnostic='';child.stderr?.on('data',chunk=>{diagnostic=(diagnostic+chunk.toString()).slice(-3000);});
            attachAccountAuthority(child,a.id,db,policy,inbox);
            await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Fixture worker startup timeout')),15_000);
                child!.on('message',(m:any)=>{if(m?.type==='fixture-ready'){clearTimeout(timer);resolve();}});child!.once('exit',()=>{clearTimeout(timer);reject(Error('Fixture worker exited: '+diagnostic));});});
        }
        async function stop(){if(!child)return;const value=child;child=undefined;if(value.exitCode!==null || value.signalCode!==null)return;await new Promise<void>(resolve=>{value.once('exit',()=>resolve());value.kill();});}
        async function call(action:string,operationId:string,background=false){
            const id=randomUUID();return new Promise<any>((resolve,reject)=>{
                const timer=setTimeout(()=>{child?.off('message',receive);reject(Error('Fixture operation timeout'));},15_000);
                const receive=(m:any)=>{if(m?.type==='fixture-result' && m.id===id){clearTimeout(timer);child?.off('message',receive);resolve(m);}};
                child!.on('message',receive);child!.send({type:'fixture-call',id,action,operationId,background});
            });
        }
        try{
            await start();
            assert.equal((await call('text','synthetic-operation')).code,'consent_required');assert.equal(modelCalls,0);assert.equal(moderationCalls,0);
            await policy.setConsent(a.id,{version:1,consentVersion:config.catalog.version,accepted:true,recipientIds:['synthetic-ai']});
            assert.equal((await call('text','synthetic-consented-operation')).ok,true);
            assert.equal((await call('embedding','synthetic-consented-operation')).ok,true);
            assert.equal((await call('image','synthetic-consented-operation')).ok,true);
            assert.deepEqual((await policy.quota(a.id)).ai,{limit:20,used:1,reserved:0,remaining:19});assert.equal((await policy.quota(a.id)).images.used,1);
            assert.equal((await policy.quota(b.id)).ai.used,0,'parent binding, not worker-supplied account identity, selects quota');
            await stop();await start();assert.equal((await call('text','synthetic-consented-operation')).ok,true);assert.equal((await policy.quota(a.id)).ai.used,1);
            const before=[modelCalls,moderationCalls];
            assert.equal((await call('fallback','synthetic-consented-operation')).code,'consent_required');assert.deepEqual([modelCalls,moderationCalls],before);
            await db.query('UPDATE kira_accounts SET autonomous_ai_enabled=false WHERE id=$1',[a.id]);
            assert.equal((await call('text','synthetic-background',true)).code,'autonomous_ai_disabled');assert.deepEqual([modelCalls,moderationCalls],before);
            await policy.setConsent(a.id,{version:1,consentVersion:config.catalog.version,accepted:false,recipientIds:[]});
            assert.equal((await call('text','synthetic-after-revoke')).code,'consent_required');assert.deepEqual([modelCalls,moderationCalls],before);
            await policy.setConsent(a.id,{version:1,consentVersion:config.catalog.version,accepted:true,recipientIds:['synthetic-ai']});
            flagged=true;assert.equal((await call('text','synthetic-prohibited-fixture')).code,'content_policy_violation');
            assert.equal(modelCalls,before[0]);assert.equal(moderationCalls,before[1]+1,'a flagged request reaches only the consented filter');
            assert.equal((await policy.quota(a.id)).ai.used,2,'the actual filter attempt commits the logical AI operation once');
        }finally{await stop();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await fs.rm(directory,{recursive:true,force:true});}
    });
});
