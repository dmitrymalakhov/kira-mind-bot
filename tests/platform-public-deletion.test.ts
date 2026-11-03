import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import { AccountDeletion,AccountEraser } from '../platform/publicAccounts/deletion';
import { DeletionLedger } from '../platform/publicAccounts/deletionLedger';
import { OwnedAccountEraser } from '../platform/publicAccounts/eraser';
import { PublicSessions } from '../platform/publicAccounts/sessions';
import { PublicAccountPolicy } from '../platform/publicAccounts/policy';
import { digest,newToken } from '../platform/crypto';
import { tenantName } from '../platform/store';
import { publicTestConfig,publicTestPort,publicTestSecrets,withPublicRegistry } from './support/publicAccounts';

test('delete blocks access immediately, retries a crash after an effect, revokes Apple and re-erases restored account without touching another owner', {skip:!publicTestPort},async()=>{
    await withPublicRegistry(async(db,store)=>{
        const directory=await fs.mkdtemp(path.join(process.env.KIRA_PUBLIC_TEST_SCRATCH || os.tmpdir(),'kira-public-delete-'));
        try{
            const a=await store.create('synthetic_delete_a','disabled'),b=await store.create('synthetic_delete_b','disabled');
            for(const row of [a,b])await db.query("INSERT INTO kira_public_identities(id,account_id,provider,subject) VALUES($1,$1,'apple',$2)",[row.id,row.id]);
            await db.query('UPDATE kira_public_identities SET credential_encrypted=$2 WHERE id=$1',[a.id,publicTestSecrets.seal({token:'synthetic-apple-revoke-token',clientId:'org.example.synthetic'},`identity:${a.id}`)]);
            const runtime=(id:string)=>path.join(directory,tenantName(id));
            for(const row of [a,b]){await fs.mkdir(runtime(row.id));await fs.writeFile(path.join(runtime(row.id),'owned.txt'),row.id);}
            const sessions=new PublicSessions(db,publicTestSecrets),pair=await db.transaction(tx=>sessions.issue(tx,a.id,a.id,randomUUID(),'Synthetic phone'));
            const auth=(await sessions.authenticate(pair.accessToken))!,legacy=newToken();await store.session(digest(legacy),a.id);
            const grant=newToken();await db.query("INSERT INTO kira_public_reauthentication(token_hash,account_id,session_id,expires_at) VALUES($1,$2,$3,now()+interval '5 minutes')",[digest(grant),a.id,pair.sessionId]);
            const ledger=new DeletionLedger(path.join(directory,'ledger'),'synthetic-ledger-signing-key-32-chars');
            const vectors=new Set([a.id,b.id]),databases=new Set([a.id,b.id]);let fail=true,revoke=0,stops=0;
            const eraser:AccountEraser={validate:async inventory=>{assert.equal(inventory.accountId,a.id);},
                eraseVectors:async inventory=>{vectors.delete(inventory.accountId);if(fail){fail=false;throw Error('Synthetic crash after vector effect');}},
                eraseDatabase:async inventory=>{databases.delete(inventory.accountId);},eraseFiles:async inventory=>{await fs.rm(inventory.runtimeDirectory,{recursive:true,force:true});}};
            const verifier={verify:async()=>{throw Error('Not used');},revokeApple:async(token:string,clientId:string)=>{assert.equal(token,'synthetic-apple-revoke-token');assert.equal(clientId,'org.example.synthetic');revoke++;}};
            const runtimes={status:()=> 'ready',endpoint:()=>{throw Error('Not used');},restart:async(id:string)=>{assert.equal(id,a.id);stops++;}};
            const make=()=>new AccountDeletion(db,store,publicTestSecrets,runtimes,verifier,ledger,eraser,runtime);
            const deletion=make();
            await assert.rejects(()=>deletion.request(auth,{version:1,confirmation:'wrong',reauthenticationToken:grant}),(e:any)=>e.code==='invalid_body');
            const result=await deletion.request(auth,{version:1,confirmation:'delete_my_account',reauthenticationToken:grant});assert.equal(result.status,'deleting');
            assert.equal(await sessions.authenticate(pair.accessToken),undefined);assert.equal(await store.authenticate(digest(legacy)),undefined);
            const policy=new PublicAccountPolicy(db,()=>publicTestConfig());
            await assert.rejects(()=>policy.authorizeOutbound(a.id,{operationId:'late-work',provider:'openai',endpoint:'https://synthetic.example.invalid/v1/chat/completions',image:false,background:false}),(e:any)=>e.code==='account_deleting');
            await deletion.drain();assert.equal((await db.query('SELECT state FROM kira_public_deletions WHERE account_id=$1',[a.id]))[0].state,'pending');
            await db.query('UPDATE kira_public_deletions SET next_attempt_at=now() WHERE account_id=$1',[a.id]);await make().drain();
            assert.equal(await store.byId(a.id),undefined);assert.ok(await store.byId(b.id));assert.equal(revoke,1);assert.equal(stops,1);
            assert.deepEqual([...vectors],[b.id]);assert.deepEqual([...databases],[b.id]);assert.equal(await fs.readFile(path.join(runtime(b.id),'owned.txt'),'utf8'),b.id);
            const [finished]=await db.query('SELECT * FROM kira_public_deletions WHERE account_id=$1',[a.id]);assert.equal(finished.state,'completed');
            assert.deepEqual(publicTestSecrets.open<any>(finished.inventory_encrypted,`deletion:${finished.id}:${a.id}`).providerTokens,[]);
            assert.doesNotMatch(await fs.readFile(path.join(directory,'ledger',`${a.id}.json`),'utf8'),/revoke-token|synthetic_delete_a/);
            // Reproducible stale snapshot restore: account and stores reappear, latest external ledger wins before serving.
            await db.query("INSERT INTO kira_accounts(id,username,password_hash) VALUES($1,'synthetic_restored_deleted','disabled')",[a.id]);
            await db.query("INSERT INTO kira_account_sessions(token_hash,account_id) VALUES($1,$2)",[digest(legacy),a.id]);
            vectors.add(a.id);databases.add(a.id);await fs.mkdir(runtime(a.id));await fs.writeFile(path.join(runtime(a.id),'owned.txt'),'restored');
            await ledger.restoreBarrier(db);assert.equal(await store.authenticate(digest(legacy)),undefined);
            await make().drain();assert.equal(await store.byId(a.id),undefined);assert.deepEqual([...vectors],[b.id]);assert.deepEqual([...databases],[b.id]);assert.equal(revoke,1,'restored cleanup does not retain or replay revoked Apple credential');
        }finally{await fs.rm(directory,{recursive:true,force:true});}
    });
});

test('invalid/tampered restore ledger is rejected and eraser refuses shared/imported/escaped ownership before any deletion', {skip:!publicTestPort},async()=>{
    await withPublicRegistry(async(db,store)=>{
        const directory=await fs.mkdtemp(path.join(process.env.KIRA_PUBLIC_TEST_SCRATCH || os.tmpdir(),'kira-public-ownership-'));
        try{
            const a=await store.create('synthetic_ownership','disabled'),name=tenantName(a.id);
            const ledgerPath=path.join(directory,'ledger'),ledger=new DeletionLedger(ledgerPath,'synthetic-ledger-signing-key-32-chars');
            await ledger.record({version:1,accountId:a.id,deletionId:randomUUID(),blockedAt:new Date().toISOString()});
            const file=path.join(ledgerPath,`${a.id}.json`),record=JSON.parse(await fs.readFile(file,'utf8'));record.record.accountId=randomUUID();await fs.writeFile(file,JSON.stringify(record));
            await assert.rejects(()=>ledger.restoreBarrier(db),/Invalid deletion ledger signature/);
            let vectorDeletes=0;const qdrant={getCollections:async()=>({collections:[]}),deleteCollection:async()=>{vectorDeletes++;}};
            const eraser=new OwnedAccountEraser(db,publicTestSecrets,directory,qdrant as any);
            const inventory={version:1 as const,accountId:a.id,database:name,imported:false,memoryNamespace:name,memoryBotId:name,runtimeDirectory:path.join(directory,name),providerTokens:[]};
            await eraser.validate(inventory);
            await assert.rejects(()=>eraser.eraseVectors({...inventory,imported:true}),/manifest is required/);
            await assert.rejects(()=>eraser.eraseFiles({...inventory,runtimeDirectory:directory}),/ownership mismatch/);
            await assert.rejects(()=>eraser.eraseDatabase({...inventory,database:'postgres'}),/ownership mismatch/);
            await fs.symlink(directory,inventory.runtimeDirectory);
            await assert.rejects(()=>eraser.eraseFiles(inventory),/ownership changed/);assert.equal(vectorDeletes,0);
        }finally{await fs.rm(directory,{recursive:true,force:true});}
    });
});
