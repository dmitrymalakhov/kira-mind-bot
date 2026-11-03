import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { ApiError } from '../../api/contracts';
import { PlatformSecrets } from '../crypto';
import type { AccountStore } from '../store';
import { tenantName } from '../store';
import type { AccountRuntimes,TenantCredentials } from '../runtime';
import type { AuthenticatedAccount } from './identities';
import { consumeReauthentication } from './identities';
import type { DeletionReply } from './contracts';
import { revokeSession } from './sessions';
import type { IdentityVerifier } from './providers';
import { DeletionLedger } from './deletionLedger';
import * as v from './validation';

export interface OwnedDeletionInventory {
    version:1;accountId:string;database:string;imported:boolean;memoryNamespace:string;memoryBotId:string;
    runtimeDirectory:string;providerTokens:Array<{provider:'apple';token:string;clientId:string}>;
}
export interface AccountEraser {
    validate(inventory:OwnedDeletionInventory):Promise<void>;
    eraseVectors(inventory:OwnedDeletionInventory):Promise<void>;
    eraseDatabase(inventory:OwnedDeletionInventory):Promise<void>;
    eraseFiles(inventory:OwnedDeletionInventory):Promise<void>;
}
const STEPS=['stop_runtime','validate','apple_revoke','vectors','database','files','registry'] as const;
export class AccountDeletion {
    private timer?:NodeJS.Timeout;private running?:Promise<void>;
    constructor(private db:DataSource,private store:AccountStore,private secrets:PlatformSecrets,private runtimes:AccountRuntimes,
        private verifier:IdentityVerifier,private ledger:DeletionLedger,private eraser:AccountEraser,private runtimeDirectory:(accountId:string)=>string){}

    async request(auth:AuthenticatedAccount,raw:Record<string,unknown>):Promise<DeletionReply>{
        v.fields(raw,['version','confirmation','reauthenticationToken'],['version','confirmation','reauthenticationToken']);v.version(raw);
        if(raw.confirmation!=='delete_my_account')v.invalid();v.text(raw.reauthenticationToken,32,128);
        const result=await this.db.transaction(async tx=>{
            const [a]=await tx.query('SELECT * FROM kira_accounts WHERE id=$1 FOR UPDATE',[auth.account.id]);
            if(!a)throw new ApiError(401,'unauthorized','Аккаунт недоступен.');
            const [old]=await tx.query('SELECT * FROM kira_public_deletions WHERE account_id=$1',[a.id]);
            if(old)return {version:1 as const,status:'deleting' as const,deletionId:old.id,requestedAt:new Date(old.requested_at).toISOString()};
            const [session]=await tx.query(`SELECT id FROM kira_public_sessions WHERE id=$1 AND account_id=$2 AND revoked_at IS NULL AND access_expires_at>now()`,[auth.session.id,a.id]);
            if(!session)throw new ApiError(401,'unauthorized','Подтверди вход заново.');
            await consumeReauthentication(tx,a.id,auth.session.id,String(raw.reauthenticationToken),new Date());
            const credentials=a.secrets?this.secrets.open<TenantCredentials>(a.secrets,a.id):undefined;
            const name=tenantName(a.id),id=randomUUID(),requestedAt=new Date().toISOString();
            const providerTokens:OwnedDeletionInventory['providerTokens']=[];
            for(const identity of await tx.query("SELECT * FROM kira_public_identities WHERE account_id=$1 AND provider='apple' AND credential_encrypted IS NOT NULL",[a.id])){
                const credential=this.secrets.open<{token:string;clientId:string}>(identity.credential_encrypted,`identity:${identity.id}`);
                providerTokens.push({provider:'apple',...credential});
            }
            const inventory:OwnedDeletionInventory={version:1,accountId:a.id,database:credentials?.existingStorage?.database || name,
                imported:Boolean(credentials?.existingStorage),memoryNamespace:credentials?.existingStorage?.memoryNamespace || name,
                memoryBotId:credentials?.existingStorage?.memoryBotId || name,runtimeDirectory:this.runtimeDirectory(a.id),providerTokens};
            await tx.query("UPDATE kira_accounts SET account_state='deleting',autonomous_ai_enabled=false,pairing_hash=NULL,pairing_expires=NULL WHERE id=$1",[a.id]);
            await tx.query('INSERT INTO kira_public_deletion_ledger(account_id,deletion_id,blocked_at) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[a.id,id,requestedAt]);
            for(const s of await tx.query('SELECT id FROM kira_public_sessions WHERE account_id=$1',[a.id]))await revokeSession(tx,s.id);
            await tx.query('DELETE FROM kira_account_sessions WHERE account_id=$1',[a.id]);
            await tx.query('DELETE FROM kira_public_push_devices WHERE account_id=$1',[a.id]);
            await tx.query(`INSERT INTO kira_public_deletions(id,account_id,inventory_encrypted,requested_at) VALUES($1,$2,$3,$4)`,
                [id,a.id,this.secrets.seal(inventory,`deletion:${id}:${a.id}`),requestedAt]);
            return {version:1 as const,status:'deleting' as const,deletionId:id,requestedAt};
        });
        // Successful acceptance includes a durable external tombstone before destructive cleanup starts.
        await this.ledger.record({version:1,accountId:auth.account.id,deletionId:result.deletionId,blockedAt:result.requestedAt});
        return result;
    }

    start(){this.timer=setInterval(()=>{void this.drain();},30_000);void this.drain();}
    async close(){clearInterval(this.timer);await this.running;}
    drain():Promise<void>{if(this.running)return this.running;this.running=this.batch().catch(()=>console.error('[accounts] deletion batch failed')).finally(()=>{this.running=undefined;});return this.running;}
    private async batch():Promise<void>{
        for(let n=0;n<10;n++){
            const lease=randomUUID();
            const job=await this.db.transaction(async tx=>{
                const [row]=await tx.query(`SELECT * FROM kira_public_deletions WHERE state<>'completed' AND next_attempt_at<=now()
                    AND (lease_until IS NULL OR lease_until<=now()) ORDER BY requested_at FOR UPDATE SKIP LOCKED LIMIT 1`);
                if(!row)return undefined;
                await tx.query(`UPDATE kira_public_deletions SET state='running',lease_token=$2,lease_until=now()+interval '10 minutes',attempts=attempts+1 WHERE id=$1`,[row.id,lease]);return row;
            });
            if(!job)return;
            try{
                const inventory=this.secrets.open<OwnedDeletionInventory>(job.inventory_encrypted,`deletion:${job.id}:${job.account_id}`);
                if(inventory.accountId!==job.account_id)throw Error('Deletion inventory mismatch');
                await this.ledger.record({version:1,accountId:job.account_id,deletionId:job.id,blockedAt:new Date(job.requested_at).toISOString()});
                for(const step of STEPS){
                    if(job.completed_steps.includes(step))continue;
                    const [owned]=await this.db.query('SELECT id FROM kira_public_deletions WHERE id=$1 AND lease_token=$2 AND lease_until>now()',[job.id,lease]);
                    if(!owned)throw Error('Deletion lease expired');
                    if(step==='validate')await this.eraser.validate(inventory);
                    else if(step==='stop_runtime')await this.runtimes.restart(job.account_id);
                    else if(step==='apple_revoke')for(const credential of inventory.providerTokens)await this.verifier.revokeApple(credential.token,credential.clientId);
                    else if(step==='vectors')await this.eraser.eraseVectors(inventory);
                    else if(step==='database')await this.eraser.eraseDatabase(inventory);
                    else if(step==='files')await this.eraser.eraseFiles(inventory);
                    else if(step==='registry')await this.eraseRegistry(job.account_id);
                    job.completed_steps.push(step);
                    await this.db.query(`UPDATE kira_public_deletions SET completed_steps=$3::jsonb,lease_until=now()+interval '10 minutes' WHERE id=$1 AND lease_token=$2`,[job.id,lease,JSON.stringify(job.completed_steps)]);
                }
                await this.db.transaction(async tx=>{
                    const sanitized={...inventory,providerTokens:[]};
                    // Keep only encrypted ownership bindings through the backup window; never retain revoked provider tokens.
                    await tx.query(`UPDATE kira_public_deletions SET state='completed',inventory_encrypted=$3,lease_until=NULL,lease_token=NULL,
                        inventory_expires_at=now()+interval '31 days' WHERE id=$1 AND lease_token=$2`,[job.id,lease,this.secrets.seal(sanitized,`deletion:${job.id}:${job.account_id}`)]);
                    await tx.query('UPDATE kira_public_deletion_ledger SET completed_at=COALESCE(completed_at,now()) WHERE account_id=$1',[job.account_id]);
                });
            }catch{
                await this.db.query(`UPDATE kira_public_deletions SET state='pending',lease_until=NULL,lease_token=NULL,
                    next_attempt_at=now()+interval '1 minute' WHERE id=$1 AND lease_token=$2`,[job.id,lease]);
                console.error('[accounts] deletion retry required');
            }
        }
    }
    private async eraseRegistry(accountId:string):Promise<void>{
        await this.db.transaction(async tx=>{
            // Explicit FK order. Ledger/task are deliberately outside all account cascades.
            await tx.query('DELETE FROM kira_public_push_outbox WHERE event_id IN (SELECT id FROM kira_public_inbox WHERE account_id=$1)',[accountId]);
            await tx.query('DELETE FROM kira_public_challenges WHERE account_id=$1',[accountId]);
            await tx.query('DELETE FROM kira_public_reauthentication WHERE account_id=$1',[accountId]);
            await tx.query(`DELETE FROM kira_public_app_keys k WHERE device_id IN (SELECT device_id FROM kira_public_sessions WHERE account_id=$1)
                AND NOT EXISTS(SELECT 1 FROM kira_public_sessions s WHERE s.device_id=k.device_id AND s.account_id<>$1 AND s.revoked_at IS NULL AND s.refresh_expires_at>now())`,[accountId]);
            await tx.query('DELETE FROM kira_public_sessions WHERE account_id=$1',[accountId]);
            await tx.query('DELETE FROM kira_accounts WHERE id=$1',[accountId]);
        });
    }
}
