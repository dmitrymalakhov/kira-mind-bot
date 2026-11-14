import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { TenantAdministration } from '../platform/administration';
import { OperatorAccountsHttp } from '../platform/operatorAccounts';
import { provisionTenantDatabase, tenantName } from '../platform/store';
import { PublicAccountPolicy } from '../platform/publicAccounts/policy';
import { BotConnections } from '../platform/botConnection';
import { PublicReceipts } from '../platform/publicAccounts/receipts';
import { AccountDeletion } from '../platform/publicAccounts/deletion';
import { DeletionLedger } from '../platform/publicAccounts/deletionLedger';
import { OwnedAccountEraser } from '../platform/publicAccounts/eraser';
import { digest } from '../platform/crypto';
import { ApiError } from '../api/contracts';
import { ChatEntity } from '../entity/ChatEntity';
import { RecurringTaskEntity } from '../entity/RecurringTaskEntity';
import { BotSettingEntity } from '../entity/BotSettingEntity';
import { HealthLogEntity } from '../entity/HealthLogEntity';
import { publicTestPort, publicTestSecrets as secrets, publicTestConfig, withPublicRegistry } from './support/publicAccounts';

const listen=(server:http.Server)=>new Promise<string>(resolve=>server.listen(0,'127.0.0.1',()=>resolve(`http://127.0.0.1:${(server.address() as any).port}`)));
const close=(server:http.Server)=>new Promise<void>(resolve=>{server.closeAllConnections();server.close(()=>resolve());});
const password='synthetic-operator-password-123';

test('real admin entrypoint isolates two tenants across databases, files, memory, settings, exports and worker actions', {skip:!publicTestPort}, async()=>{
    await withPublicRegistry(async(db,store)=>{
        const root=await fs.mkdtemp(path.join(os.tmpdir(),'kira-admin-switch-'));
        const connections:DataSource[]=[],names:string[]=[],roles:string[]=[],restarts:string[]=[];
        const pointId=randomUUID(),taskId=randomUUID();let embeddingCalls=0,socialAllowed=true;
        const collections=new Map<string,Map<string,any>>();
        const vectors=http.createServer(async(req,res)=>{
            const json=(body:any,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body));};
            let text='';for await(const chunk of req)text+=chunk;const body=text?JSON.parse(text):{};
            if(req.url==='/v1/embeddings'){embeddingCalls++;return json({data:[{embedding:Array(1536).fill(0.01)}]});}
            const url=new URL(req.url!,'http://synthetic.invalid'),parts=url.pathname.split('/'),name=decodeURIComponent(parts[2]||'');
            if(url.pathname==='/collections')return json({result:{collections:[...collections.keys()].map(name=>({name}))}});
            const points=collections.get(name);if(!points)return json({status:{error:'not found'}},404);
            if(parts.length===3)return json({result:{config:{params:{vectors:{size:1536,distance:'Cosine'}}},points_count:points.size}});
            if(parts[4]==='scroll'){
                const matches=[...points.values()].filter(point=>(body.filter?.must||[]).every((condition:any)=>String(point.payload[condition.key])===String(condition.match.value)));
                return json({result:{points:matches,next_page_offset:null}});
            }
            if(parts[4]==='delete'){for(const id of body.points)points.delete(id);return json({result:{status:'completed'}});}
            if(parts[3]==='points'&&req.method==='POST')return json({result:body.ids.map((id:string)=>points.get(id)).filter(Boolean)});
            if(parts.length===5&&req.method==='GET')return json({result:points.get(parts[4])});
            if(parts[3]==='points'&&req.method==='PUT'){for(const point of body.points)points.set(point.id,point);return json({result:{status:'completed'}});}
            return json({error:'synthetic unsupported vector operation'},400);
        });
        const vectorUrl=await listen(vectors);
        const cfg=publicTestConfig();cfg.aiLimit=1;cfg.routes=[{provider:'openai',baseUrl:vectorUrl+'/v1',recipientIds:['synthetic-ai']}];
        const policy=new PublicAccountPolicy(db,()=>cfg);
        const worker={status:()=> 'ready',endpoint:()=>({port:1,token:'synthetic'}),restart:async(id:string)=>{restarts.push(id);}};
        const environment={DB_HOST:'127.0.0.1',DB_PORT:publicTestPort,OPENAI_API_KEY:'synthetic-key',OPENAI_BASE_URL:vectorUrl+'/v1',QDRANT_URL:vectorUrl};
        const authority=new TenantAdministration(db,store,secrets,worker,path.join(root,'accounts'),environment,policy);
        let duringVerification:(()=>Promise<void>)|undefined;
        const bots=new BotConnections(store,secrets,{verify:async token=>{
            if(duringVerification){const effect=duringVerification;duringVerification=undefined;await effect();}
            if(token==='synthetic-new-token'||token==='synthetic-rotated-token')return {id:300003,username:'synthetic_replacement_bot'};
            if(token==='synthetic-taken-token')return {id:100002,username:'synthetic_1_bot'};
            throw new ApiError(400,'invalid_bot_token','Synthetic invalid token');
        }});
        const eraser=new OwnedAccountEraser(db,secrets,path.join(root,'accounts'),{getCollections:async()=>({collections:[...collections.keys()].map(name=>({name}))}),
            deleteCollection:async(name:string)=>{collections.delete(name);return true;}} as any);
        const deletion=new AccountDeletion(db,store,secrets,worker,{revokeApple:async()=>{}} as any,
            new DeletionLedger(path.join(root,'ledger'),'synthetic-ledger-signing-key'),eraser,id=>path.join(root,'accounts',tenantName(id)));
        const internal=new OperatorAccountsHttp(store,secrets,worker,bots,new PublicReceipts(db),{username:'admin',password,capacity:10,administration:authority,deletion,
            bridgeSecret:'a'.repeat(64),operator:{introspect:async()=>({authorized:socialAllowed,accountId:randomUUID()})} as any});
        const manager=http.createServer((req,res)=>{void internal.route(req,req.url!, (code,body)=>{res.writeHead(code,{'content-type':'application/json'});res.end(JSON.stringify(body));})
            .catch(error=>{res.writeHead(error.status||error.statusCode||500,{'content-type':'application/json'});res.end(JSON.stringify({error:{code:error.code||'unknown'}}));});});
        const managerUrl=await listen(manager);let server:http.Server|undefined;
        const previous={...process.env};
        try{
            const accounts=[];
            for(let index=0;index<2;index++){
                const account=await store.create(`synthetic_admin_${index}`,'disabled'),role=tenantName(account.id);roles.push(role);
                let name=await provisionTenantDatabase(db,account.id,secrets.derive(account.id,'database'));
                if(index===0){const imported='synthetic_import_'+account.id.replace(/-/g,'');await db.query(`ALTER DATABASE "${name}" RENAME TO "${imported}"`);name=imported;}
                names.push(name);const owner=String(10001+index),namespace=index?role:'synthetic_import',botId=index?role:'kira';
                const credentials={botToken:`${index+100001}:synthetic-only-token`,adminSettings:{USER_TIMEZONE:index?'Asia/Tokyo':'Europe/Amsterdam'},
                    ...(index===0?{telegram:{apiId:12345,apiHash:'synthetic-session-hash',sessionString:'synthetic-session-string'},apiToken:'synthetic-preserved-api-token'}:{}),
                    ...(index===0?{existingStorage:{database:name,memoryNamespace:namespace,memoryBotId:botId}}:{})};
                await db.query('UPDATE kira_accounts SET owner_id=$2,bot_id=$3,bot_username=$4,secrets=$5 WHERE id=$1',
                    [account.id,owner,String(index+100001),`synthetic_${index}_bot`,secrets.seal(credentials,account.id)]);
                await fs.mkdir(path.join(root,'accounts',role,'data'),{recursive:true});
                await fs.writeFile(path.join(root,'accounts',role,'personality.json'),JSON.stringify({KiraMindBot:{characterName:`Synthetic ${index}`,persona:`Synthetic biography ${index}`}}));
                const connection=await new DataSource({type:'postgres',host:'127.0.0.1',port:Number(publicTestPort),username:role,password:secrets.derive(account.id,'database'),database:name,
                    entities:[ChatEntity,RecurringTaskEntity,BotSettingEntity,HealthLogEntity],synchronize:true}).initialize();connections.push(connection);
                await connection.getRepository(ChatEntity).save({chatId:'-10001',profile:'KiraMindBot',title:`Synthetic chat ${index}`,chatType:'supergroup'});
                await connection.getRepository(RecurringTaskEntity).save({id:taskId,profile:'KiraMindBot',chatId:Number(owner),userId:Number(owner),title:`Synthetic task ${index}`,prompt:'Synthetic request',schedule:{kind:'daily',hour:12,minute:0} as any,
                    timezone:'UTC',status:'paused',nextRunAt:new Date('2037-01-01T12:00:00Z')});
                await connection.getRepository(HealthLogEntity).save({id:pointId,userId:Number(owner),profile:'KiraMindBot',kind:'symptom',rawText:`Synthetic health ${index}`,occurredAt:new Date()});
                if(index===0){
                    // Imported accounts can read/write existing tables but never migrate the schema.
                    await db.query(`ALTER DATABASE "${name}" OWNER TO postgres`);
                    await db.query(`GRANT CONNECT ON DATABASE "${name}" TO "${role}"`);
                    assert.equal((await connection.query("SELECT has_schema_privilege(current_user,'public','CREATE') AS allowed"))[0].allowed,false);
                }
                collections.set(namespace+'_memories_general',new Map([[pointId,{id:pointId,payload:{botId,userId:owner,content:`Synthetic memory ${index}`,timestamp:new Date().toISOString(),domain:'general'}}]]));
                accounts.push({...account,owner,namespace,role});
            }
            const [a,b]=accounts;
            Object.assign(process.env,{KIRA_ACCOUNT_AUTH_URL:managerUrl,KIRA_RUNTIME_DATA_DIR:root,ADMIN_USERNAME:'admin',ADMIN_PASSWORD:password,
                BOT_ENV_FILE:path.join(root,'bot.env'),PERSONALITY_FILE:path.join(root,'personality.json'),SESSION_SECRET:'synthetic-session-secret',KIRA_PUBLIC_OPERATOR_ENABLED:'false'});
            await fs.writeFile(process.env.BOT_ENV_FILE!,'DB_HOST=synthetic-unreachable.invalid\nDB_PASSWORD=synthetic-original-secret\nKIRA_ACCOUNTS_MASTER_KEY=synthetic-hidden\n');
            const {app}=require('../admin-panel/server');server=http.createServer(app);const url=await listen(server);
            let cookie='';
            const request=async(resource:string,id?:string,method='GET',body?:any,headers:Record<string,string>={})=>{
                const response=await fetch(url+(id?`/api/account-scopes/${id}/`+resource.replace(/^\/api\//,''):resource),{
                    method,headers:{cookie,origin:url,...(body?{'content-type':'application/json'}:{}),...headers},...(body?{body:JSON.stringify(body)}:{})});
                const set=response.headers.get('set-cookie');if(set)cookie=set.split(';')[0];return response;
            };
            const csrf=async()=> (await(await request('/api/auth/context')).json()).csrfToken;
            const login=await request('/api/login',undefined,'POST',{username:'admin',password},{'x-csrf-token':await csrf()});assert.equal(login.status,200);
            const headers=async()=>({'x-csrf-token':await csrf(),'idempotency-key':randomUUID()});
            const json=async(resource:string,id?:string)=>{const r=await request(resource,id);assert.equal(r.status,200,`${resource}: ${await r.clone().text()}`);return r.json();};
            for(const account of accounts){
                const config=await json('/api/config',account.id);assert.equal(config.USER_TIMEZONE.value,account.id===a.id?'Europe/Amsterdam':'Asia/Tokyo');
                assert.equal(config.OPENAI_API_KEY.readOnly,true);assert.equal(config.DB_NAME.readOnly,true);assert.equal(config.USER_TIMEZONE.readOnly,false);
                assert.equal(config.KIRA_ACCOUNTS_MASTER_KEY,undefined);assert.doesNotMatch(JSON.stringify(config),/synthetic-original-secret/);
                assert.equal((await json('/api/chats',account.id))[0].title,account.id===a.id?'Synthetic chat 0':'Synthetic chat 1');
                assert.equal((await json('/api/recurring-tasks',account.id))[0].title,account.id===a.id?'Synthetic task 0':'Synthetic task 1');
                assert.equal((await json('/api/personality',account.id)).KiraMindBot.characterName,account.id===a.id?'Synthetic 0':'Synthetic 1');
                assert.equal((await json('/api/memory?domain=general',account.id)).records[0].content,account.id===a.id?'Synthetic memory 0':'Synthetic memory 1');
                assert.equal((await json(`/api/memory/general/${pointId}`,account.id)).record.content,account.id===a.id?'Synthetic memory 0':'Synthetic memory 1');
                assert.equal((await request('/api/health/export?format=csv',account.id)).headers.get('x-kira-account-id'),account.id);
            }
            // The same task/chat/point IDs must be resolved only in the chosen tenant.
            assert.equal((await request('/api/chats/-10001/public-mode',a.id,'PATCH',{profile:'KiraMindBot',enabled:true},await headers())).status,200);
            assert.equal((await json('/api/chats',b.id))[0].publicMode,false);
            assert.equal((await request(`/api/recurring-tasks/${taskId}`,b.id,'PATCH',{title:'Synthetic B changed'},await headers())).status,200);
            assert.equal((await json('/api/recurring-tasks',a.id))[0].title,'Synthetic task 0');
            assert.equal((await request('/api/budget-mode',b.id,'POST',{mode:'maximum'},await headers())).status,200);
            assert.equal((await json('/api/budget-mode',a.id)).mode,'normal');
            assert.equal((await request('/api/model-preferences',b.id,'PUT',{quality:'standard',provider:'openai'},await headers())).status,200);
            assert.equal((await json('/api/model-preferences',b.id)).preferences.quality,'standard');
            assert.equal((await json('/api/model-preferences',a.id)).mode,'manual');
            assert.equal((await json('/api/image-recognition',a.id)).settings,null);
            const imageSettings={enabled:false,model:'gpt-image-1',size:'1024x1024',quality:'low'};
            assert.equal((await request('/api/image-generation',b.id,'POST',{settings:imageSettings},await headers())).status,200);
            assert.deepEqual((await json('/api/image-generation',b.id)).settings,imageSettings);
            assert.equal((await json('/api/image-generation',a.id)).settings.enabled,true);
            const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1sAAAAASUVORK5CYII=','base64');
            const upload=await fetch(url+`/api/account-scopes/${a.id}/image-generation/reference`,{method:'POST',headers:{cookie,origin:url,'content-type':'image/png',...await headers()},body:image});
            assert.equal(upload.status,200);assert.equal((await json('/api/image-generation',a.id)).reference.source,'custom');
            assert.equal((await json('/api/image-generation',b.id)).reference.source,'default');
            const directImage=await request('/api/image-generation/reference',a.id);assert.equal(directImage.headers.get('x-kira-account-id'),a.id);assert.deepEqual(Buffer.from(await directImage.arrayBuffer()),image);
            const config=await json('/api/config',b.id),revision=config.USER_TIMEZONE.revision;
            assert.equal((await request('/api/config',b.id,'POST',{USER_TIMEZONE:'UTC'},{...await headers(),'if-match':revision})).status,200);
            assert.equal((await request('/api/config',b.id,'POST',{USER_TIMEZONE:'Europe/Paris'},{...await headers(),'if-match':revision})).status,409);
            assert.equal((await json('/api/config',a.id)).USER_TIMEZONE.value,'Europe/Amsterdam');
            assert.equal((await json('/api/config',b.id)).USER_TIMEZONE.value,'UTC');
            assert.equal((await request('/api/config',a.id,'POST',{DB_NAME:b.role},await headers())).status,400);
            assert.equal((await request('/api/personality',a.id,'POST',{KiraMindBot:{characterName:'Synthetic A changed',persona:'Synthetic story',currentCity:'Synthetic City'}},await headers())).status,200);
            assert.equal((await json('/api/personality',b.id)).KiraMindBot.characterName,'Synthetic 1');
            const mcp=await json('/api/mcp/servers',a.id);
            assert.equal((await request('/api/mcp/servers/synthetic',a.id,'POST',{revision:mcp.revision,config:{description:'Synthetic integration',transport:'http',url:'https://synthetic.example.invalid/mcp',tools:{},headers:{Authorization:'synthetic-mcp-secret'}}},await headers())).status,200);
            assert.equal((await json('/api/mcp/servers',b.id)).servers.length,0);
            assert.doesNotMatch(JSON.stringify(await json('/api/mcp/servers',a.id)),/synthetic-mcp-secret/);
            const snapshots=await Promise.all(accounts.map(account=>json('/api/mcp/servers',account.id)));
            const mcpWrites=await Promise.all(accounts.map(async(account,index)=>request('/api/mcp/servers/concurrent',account.id,'POST',{
                revision:snapshots[index].revision,config:{description:account.username,transport:'http',url:'https://synthetic.example.invalid/mcp',tools:{}}},await headers())));
            mcpWrites.forEach(result=>assert.equal(result.status,200));
            for(const account of accounts)assert.equal((await json('/api/mcp/servers',account.id)).servers.find((server:any)=>server.id==='concurrent').config.description,account.username);
            assert.equal((await request('/api/restart/kira-mind-bot',a.id,'POST',{},await headers())).status,200);assert.deepEqual(restarts,[a.id]);
            // The operator's admin session never supplies consent or free AI calls.
            const memory={domain:'general',content:'Synthetic added memory'};
            assert.equal((await request('/api/memory',b.id,'POST',memory,await headers())).status,403);assert.equal(embeddingCalls,0);
            await policy.setConsent(b.id,{version:1,accepted:true,consentVersion:cfg.catalog.version,recipientIds:['synthetic-ai']});
            const created=await request('/api/memory',b.id,'POST',memory,await headers());assert.equal(created.status,200,await created.clone().text());assert.equal(embeddingCalls,1);
            assert.equal((await json('/api/account-quota',a.id)).quota.dialogue.used,0);assert.equal((await json('/api/account-quota',b.id)).quota.dialogue.used,1);
            assert.equal((await request('/api/memory',b.id,'POST',memory,await headers())).status,429);assert.equal(embeddingCalls,1);
            assert.equal((await request(`/api/memory/general/${pointId}?userId=${a.owner}`,b.id,'DELETE',undefined,await headers())).status,400);
            assert.equal((await request(`/api/memory/general/${pointId}`,b.id,'DELETE',undefined,await headers())).status,200);
            assert.equal((await json('/api/memory?domain=general',a.id)).records[0].content,'Synthetic memory 0');
            // Two concurrent contexts, no process-wide mutable selection.
            const concurrent=await Promise.all(Array.from({length:8},(_,i)=>json('/api/personality',i%2?a.id:b.id)));
            concurrent.forEach((value,i)=>assert.equal(value.KiraMindBot.characterName,i%2?'Synthetic A changed':'Synthetic 1'));
            for(const id of [undefined,'instance',randomUUID()])assert.ok((await request('/api/chats',id)).status>=400);
            assert.equal((await request('/api/config',a.id,'GET',undefined,{'x-kira-account-id':b.id})).status,400);
            assert.equal((await request('/api/budget-mode',a.id,'POST',{mode:'normal'})).status,403);
            // Lifecycle actions use the same real admin entrypoint, canonical manager and tenant data.
            const managed=async(id:string)=>(await json('/api/accounts')).accounts.find((account:any)=>account.id===id);
            const oldView=await managed(a.id),nameKey=randomUUID();
            const renamed=await request(`/api/accounts/${a.id}`,undefined,'PATCH',{displayName:'Синтетическая Кира',revision:oldView.revision},{...await headers(),'idempotency-key':nameKey});
            assert.equal(renamed.status,200);assert.equal((await renamed.json()).account.displayName,'Синтетическая Кира');
            assert.equal((await store.byId(a.id))!.username,a.username);
            assert.equal((await request(`/api/accounts/${a.id}`,undefined,'PATCH',{displayName:'Другой заголовок',revision:oldView.revision},await headers())).status,409);
            assert.equal((await request(`/api/accounts/${a.id}`,undefined,'PATCH',{displayName:'Синтетическая Кира',revision:oldView.revision},{...await headers(),'idempotency-key':nameKey})).status,200);
            const replace=async(token:string,revision:string,key=randomUUID())=>request(`/api/accounts/${a.id}/bot/replacement`,undefined,'POST',{
                botToken:token,confirmation:a.username,revision},{...await headers(),'idempotency-key':key});
            const beforeScope=await authority.context(a.id),beforeCredentials=secrets.open<any>((await store.byId(a.id))!.secrets!,a.id);
            const dataBefore=await Promise.all(['chats','recurring_tasks','health_logs','bot_settings'].map(table=>connections[0].query(`SELECT * FROM ${table} ORDER BY 1`)));
            const personaBefore=await fs.readFile(path.join(root,'accounts',a.role,'personality.json'),'utf8');
            const restartCount=restarts.length;
            let view=await managed(a.id);
            for(const token of ['synthetic-invalid','synthetic-taken-token'])assert.ok((await replace(token,view.revision)).status>=400);
            assert.equal(restarts.length,restartCount);assert.equal((await store.byId(a.id))!.bot_id,'100001');
            duringVerification=async()=>{const state=await authority.context(a.id);await authority.settings(a.id,{USER_TIMEZONE:'Europe/Paris'},state.settingsRevision);};
            assert.equal((await replace('synthetic-new-token',view.revision)).status,409,'concurrent preferences must never be overwritten');
            view=await managed(a.id);const replaceKey=randomUUID();
            assert.equal((await replace('synthetic-new-token',view.revision,replaceKey)).status,200);
            assert.equal((await replace('synthetic-new-token',view.revision,replaceKey)).status,200,'lost replacement reply does not restart twice');
            assert.deepEqual(restarts.slice(restartCount),[a.id]);
            const after=await store.byId(a.id),credentials=secrets.open<any>(after!.secrets!,a.id),afterScope=await authority.context(a.id);
            assert.equal(after!.owner_id,a.owner);assert.equal(after!.bot_id,'300003');assert.equal(Number(after!.update_offset),0);
            assert.equal(credentials.legacyTelegramBotId,'100001');assert.equal(credentials.apiToken,beforeCredentials.apiToken);
            assert.deepEqual(credentials.telegram,beforeCredentials.telegram);assert.deepEqual(credentials.existingStorage,beforeCredentials.existingStorage);
            assert.equal(credentials.adminSettings.USER_TIMEZONE,'Europe/Paris');
            for(const key of ['DB_NAME','DB_USER','KIRA_MEMORY_NAMESPACE','KIRA_MEMORY_BOT_ID'])assert.equal(afterScope.env[key],beforeScope.env[key]);
            assert.deepEqual(await Promise.all(['chats','recurring_tasks','health_logs','bot_settings'].map(table=>connections[0].query(`SELECT * FROM ${table} ORDER BY 1`))),dataBefore);
            assert.equal(await fs.readFile(path.join(root,'accounts',a.role,'personality.json'),'utf8'),personaBefore);
            assert.equal((await json('/api/memory?domain=general',a.id)).records[0].content,'Synthetic memory 0');
            await db.query('UPDATE kira_accounts SET update_offset=55 WHERE id=$1',[a.id]);view=await managed(a.id);
            assert.equal((await replace('synthetic-rotated-token',view.revision)).status,200);assert.equal(Number((await store.byId(a.id))!.update_offset),55);
            assert.equal((await managed(b.id)).bot.username,'synthetic_1_bot');
            const bView=await managed(b.id),remove=async(confirmation:string,revision=bView.revision)=>request(`/api/accounts/${b.id}`,undefined,'DELETE',{confirmation,revision},await headers());
            assert.equal((await remove('synthetic_wrong')).status,400);assert.equal((await remove(b.username,'0'.repeat(64))).status,409);
            const unverified=await request(`/api/accounts/${a.id}`,undefined,'DELETE',{confirmation:a.username,revision:(await managed(a.id)).revision},await headers());
            assert.equal(unverified.status,409);assert.equal((await store.byId(a.id))!.account_state,'active','unverified imported storage is refused before blocking the account');
            const legacy='synthetic-legacy-session-token-123456';await store.session(digest(legacy),b.id);
            const removed=await remove(b.username);assert.equal(removed.status,202);assert.equal((await remove(b.username)).status,202);
            assert.equal(await store.authenticate(digest(legacy)),undefined);assert.equal(await managed(b.id),undefined);
            await deletion.drain();assert.equal(await store.byId(b.id),undefined);
            assert.equal((await db.query('SELECT 1 FROM pg_database WHERE datname=$1',[b.role])).length,0);
            assert.equal((await db.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[b.role])).length,0);
            assert.equal(collections.has(b.role+'_memories_general'),false);assert.equal(collections.has(a.namespace+'_memories_general'),true);
            await assert.rejects(fs.stat(path.join(root,'accounts',b.role)));assert.ok(await fs.stat(path.join(root,'accounts',a.role)));
            assert.equal((await db.query('SELECT state FROM kira_public_deletions WHERE account_id=$1',[b.id]))[0].state,'completed');
            await db.query("UPDATE kira_accounts SET account_state='deleting' WHERE id=$1",[a.id]);
            assert.ok((await request('/api/personality',a.id)).status>=400);
            await assert.rejects(authority.context(a.id));
            for(const operator of [{kind:'password',username:'admin',password:'synthetic-wrong'},{kind:'account',accessToken:'x'.repeat(43),browserCookie:'y'.repeat(43)}]){
                socialAllowed=false;const r=await fetch(managerUrl+'/internal/operator/accounts',{method:'POST',headers:{'content-type':'application/json','x-kira-operator-bridge':'a'.repeat(64)},
                    body:JSON.stringify({version:1,operator,operation:'scope',input:{accountId:b.id}})});assert.ok([401,403].includes(r.status));
            }
        }finally{
            if(server)await close(server);await close(manager);await close(vectors);
            for(const connection of connections)await connection.destroy();
            for(const name of names)await db.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
            for(const role of roles)await db.query(`DROP ROLE IF EXISTS "${role}"`);
            for(const key of Object.keys(process.env))if(!(key in previous))delete process.env[key];Object.assign(process.env,previous);
            await fs.rm(root,{recursive:true,force:true});
        }
    });
});
