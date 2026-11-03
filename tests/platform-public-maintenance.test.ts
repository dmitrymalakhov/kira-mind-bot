import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {initializePublicAccounts} from '../platform/publicAccounts/schema';
import {PublicSessions} from '../platform/publicAccounts/sessions';
import {PublicAccountMaintenance} from '../platform/publicAccounts/maintenance';
import {publicTestPort,publicTestSecrets,withPublicRegistry} from './support/publicAccounts';

test('maintenance erases expired encrypted replay/proofs/inventory while preserving active access, restore bindings and durable PKCE ownership', {skip:!publicTestPort},async()=>{
    await withPublicRegistry(async(db,store)=>{
        const account=await store.create('synthetic_maintenance','synthetic-legacy-hash');await initializePublicAccounts(db);
        let now=new Date();const sessions=new PublicSessions(db,publicTestSecrets,()=>now),deviceId=randomUUID();
        const pair=await db.transaction(tx=>sessions.issue(tx,account.id,account.id,deviceId,'Synthetic phone'));
        const next=await sessions.rotate(pair.refreshToken,deviceId,'synthetic-maintenance-refresh');
        const challengeId=randomUUID();
        await db.query(`INSERT INTO kira_public_challenges(id,provider,purpose,device_id,challenge,nonce,state_hash,expires_at,consumed_at,result_encrypted)
            VALUES($1,'telegram','login',$2,'synthetic-challenge','synthetic-nonce','synthetic-state-hash',$3,$4,'synthetic-encrypted-reply')`,[challengeId,deviceId,new Date(now.getTime()+300_000),now]);
        await db.query('INSERT INTO kira_public_pkce_bindings(challenge_hash,challenge_id) VALUES($1,$2)',['synthetic-fixed-pkce-hash',challengeId]);
        for(const [name,expiry] of [['expired',new Date(now.getTime()-1)],['active',new Date(now.getTime()+3600_000)]] as const){
            await db.query('INSERT INTO kira_public_proof_tokens(token_hash,expires_at) VALUES($1,$2)',[name,expiry]);
            await db.query('INSERT INTO kira_public_limits(scope_hash,count,expires_at) VALUES($1,1,$2)',[name,expiry]);
        }
        for(const id of [account.id,randomUUID()])await db.query(`INSERT INTO kira_public_deletions(id,account_id,state,inventory_encrypted,inventory_expires_at)
            VALUES($1,$2,'completed','synthetic-encrypted-bindings',$3)`,[randomUUID(),id,new Date(now.getTime()-1)]);
        now=new Date(now.getTime()+120_001);await new PublicAccountMaintenance(db,()=>now).drain();
        assert.ok(await sessions.authenticate(next.accessToken));
        assert.equal((await db.query('SELECT replay_encrypted FROM kira_public_refresh WHERE replaced_at IS NOT NULL'))[0].replay_encrypted,null);
        assert.equal((await db.query('SELECT result_encrypted FROM kira_public_challenges WHERE id=$1',[challengeId]))[0].result_encrypted,null);
        assert.deepEqual((await db.query('SELECT token_hash FROM kira_public_proof_tokens')).map((r:any)=>r.token_hash),['active']);
        assert.deepEqual((await db.query('SELECT scope_hash FROM kira_public_limits')).map((r:any)=>r.scope_hash),['active']);
        const inventories=await db.query('SELECT account_id,inventory_encrypted FROM kira_public_deletions');
        assert.equal(inventories.find((r:any)=>r.account_id===account.id).inventory_encrypted,'synthetic-encrypted-bindings','restored account ownership is retained until erasure resumes');
        assert.equal(inventories.find((r:any)=>r.account_id!==account.id).inventory_encrypted,'');
        now=new Date(now.getTime()+2*86400_000);await new PublicAccountMaintenance(db,()=>now).drain();
        assert.equal((await db.query('SELECT count(*) FROM kira_public_challenges'))[0].count,'0');
        assert.equal((await db.query('SELECT challenge_id FROM kira_public_pkce_bindings'))[0].challenge_id,challengeId);
    });
});
