import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { DataSource } from 'typeorm';
import { OwnedAccountEraser } from '../platform/publicAccounts/eraser';
import { PublicComplaints,ownedReplyResolver } from '../platform/publicAccounts/complaints';
import { PublicLimits } from '../platform/publicAccounts/limits';
import { PublicAccountPolicy } from '../platform/publicAccounts/policy';
import { provisionTenantDatabase,tenantName } from '../platform/store';
import { publicTestConfig,publicTestPort,publicTestSecrets,withPublicRegistry } from './support/publicAccounts';

test('owned receipt complaint lookup and physical database/vector/file erasure stay scoped to the owning account', {skip:!publicTestPort},async()=>{
    await withPublicRegistry(async(db,store)=>{
        const directory=await fs.mkdtemp(path.join(process.env.KIRA_PUBLIC_TEST_SCRATCH || os.tmpdir(),'kira-public-stores-'));
        const a=await store.create('synthetic_owned_a','disabled'),b=await store.create('synthetic_owned_b','disabled');
        const accounts=[a,b];const databases:string[]=[];
        try{
            for(const [index,account]of accounts.entries()){
                const name=await provisionTenantDatabase(db,account.id,publicTestSecrets.derive(account.id,'database'));databases.push(name);
                const connection=await new DataSource({...db.options,type:'postgres',database:name,username:name,password:publicTestSecrets.derive(account.id,'database'),synchronize:false,entities:[],logging:false} as any).initialize();
                try{
                    await connection.query('CREATE TABLE api_operations(key text PRIMARY KEY,status text,result jsonb)');
                    await connection.query("INSERT INTO api_operations VALUES($1,'completed',$2::jsonb)",[`KiraMindBot:${-(index+1)}:request:synthetic`,JSON.stringify({messages:[{id:index===0?-1234500000000000:-1234500000000001,type:'text',text:`Synthetic own reply ${index}`} ]})]);
                }finally{await connection.destroy();}
                await db.query("UPDATE kira_accounts SET runtime_mode='api_only',runtime_principal=$2,secrets=$3 WHERE id=$1",[account.id,String(-(index+1)),publicTestSecrets.seal({runtimeMode:'api_only'},account.id)]);
                await fs.mkdir(path.join(directory,name));await fs.writeFile(path.join(directory,name,'owned.txt'),account.id);
            }
            const own=(await store.byId(a.id))!,other=(await store.byId(b.id))!;
            const resolver=ownedReplyResolver(db,publicTestSecrets);
            assert.equal(await resolver(own,'-1234500000000000'),'Synthetic own reply 0');assert.equal(await resolver(own,'-1234500000000001'),undefined);
            assert.equal(await resolver(other,'-1234500000000001'),'Synthetic own reply 1');
            const complaints=new PublicComplaints(db,publicTestSecrets,new PublicLimits(db,'synthetic-complaint-limits-secret-32'),resolver);
            await assert.rejects(()=>complaints.report(own,{version:1,replyId:'-1234500000000001',category:'unsafe'}),(e:any)=>e.code==='not_found');
            await assert.rejects(()=>complaints.report(own,{version:1,replyId:'-1234500000000000',category:'unsafe',accountId:b.id}),(e:any)=>e.code==='invalid_body');
            const complaint=await complaints.report(own,{version:1,replyId:'-1234500000000000',category:'unsafe',details:'Synthetic review detail'});
            const saved=(await db.query('SELECT * FROM kira_public_complaints WHERE id=$1',[complaint.complaintId]))[0];
            assert.doesNotMatch(saved.details_encrypted,/Synthetic own reply|Synthetic review/);
            await complaints.review(complaint.complaintId,'restrict');assert.equal((await store.byId(a.id))!.account_state,'restricted');assert.equal((await store.byId(b.id))!.account_state,'active');
            const policy=new PublicAccountPolicy(db,()=>publicTestConfig());
            await assert.rejects(()=>policy.reserve(a.id,'after-restriction'),(e:any)=>e.code==='account_restricted');
            const names=[`${databases[0]}_memories_general`,`${databases[0]}_domain_configs`,`${databases[1]}_memories_general`,'unrelated_memories_general'];const removed:string[]=[];
            const qdrant={getCollections:async()=>({collections:names.map(name=>({name}))}),deleteCollection:async(name:string)=>{removed.push(name);}};
            const eraser=new OwnedAccountEraser(db,publicTestSecrets,directory,qdrant as any);
            const inventory={version:1 as const,accountId:a.id,database:databases[0],imported:false,memoryNamespace:databases[0],memoryBotId:databases[0],runtimeDirectory:path.join(directory,databases[0]),providerTokens:[]};
            await eraser.eraseVectors(inventory);assert.deepEqual(removed,names.slice(0,2));
            await eraser.eraseDatabase(inventory);assert.equal((await db.query('SELECT datname FROM pg_database WHERE datname=$1',[databases[0]])).length,0);
            assert.equal(await resolver(other,'-1234500000000001'),'Synthetic own reply 1');
            await eraser.eraseFiles(inventory);assert.equal(await fs.readFile(path.join(directory,databases[1],'owned.txt'),'utf8'),b.id);
        }finally{
            for(const name of databases){await db.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);if((await db.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[name])).length)await db.query(`DROP ROLE "${name}"`);}
            await fs.rm(directory,{recursive:true,force:true});
        }
    });
});
