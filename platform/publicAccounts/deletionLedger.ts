import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { constants } from 'node:fs';
import { createHmac,timingSafeEqual } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { canonicalJson,UUID } from './validation';

interface Tombstone {version:1;accountId:string;deletionId:string;blockedAt:string}
/** Lives outside tenant data and snapshot restore sets. No names, credentials or content. */
export class DeletionLedger {
    constructor(private directory:string,private key:string){}
    private signature(value:Tombstone){return createHmac('sha256',this.key).update(canonicalJson(value)).digest('hex');}
    private async directoryReady(){
        await fs.mkdir(this.directory,{recursive:true,mode:0o700});
        const stat=await fs.lstat(this.directory);
        if(stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode&0o077)!==0)throw Error('Deletion ledger directory must be private');
    }
    async record(value:Tombstone):Promise<void>{
        await this.directoryReady();
        if(!UUID.test(value.accountId) || !UUID.test(value.deletionId) || !Number.isFinite(Date.parse(value.blockedAt)))throw Error('Invalid deletion tombstone');
        const filename=path.join(this.directory,`${value.accountId}.json`);
        const temporary=path.join(this.directory,`.pending-${randomUUID()}`);
        const encoded=JSON.stringify({record:value,signature:this.signature(value)})+'\n';
        try{
            const file=await fs.open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
            try{await file.writeFile(encoded);await file.sync();}finally{await file.close();}
            await fs.link(temporary,filename);
            const dir=await fs.open(this.directory,'r');try{await dir.sync();}finally{await dir.close();}
        }catch(error){
            if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
            const existing=await this.read(filename);
            if(existing.accountId!==value.accountId || existing.deletionId!==value.deletionId)throw Error('Conflicting deletion ledger');
        }finally{await fs.unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
    }
    async restoreBarrier(db:DataSource):Promise<void>{
        await this.directoryReady();
        for(const name of await fs.readdir(this.directory)){
            if(!/^[0-9a-f-]{36}\.json$/.test(name))continue;
            const record=await this.read(path.join(this.directory,name));
            if(name!==`${record.accountId}.json`)throw Error('Deletion ledger identity mismatch');
            await db.transaction(async tx=>{
                await tx.query(`INSERT INTO kira_public_deletion_ledger(account_id,deletion_id,blocked_at) VALUES($1,$2,$3)
                    ON CONFLICT(account_id) DO NOTHING`,[record.accountId,record.deletionId,record.blockedAt]);
                await tx.query("UPDATE kira_accounts SET account_state='deleting',autonomous_ai_enabled=false WHERE id=$1 AND account_state<>'deleted'",[record.accountId]);
                await tx.query('DELETE FROM kira_account_sessions WHERE account_id=$1',[record.accountId]);
                await tx.query('UPDATE kira_public_sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE account_id=$1',[record.accountId]);
                await tx.query('DELETE FROM kira_public_push_devices WHERE account_id=$1',[record.accountId]);
                await tx.query(`UPDATE kira_public_deletions SET state='pending',completed_steps='[]',next_attempt_at=now(),lease_until=NULL,lease_token=NULL
                    WHERE account_id=$1 AND state='completed' AND inventory_encrypted<>'' AND EXISTS(SELECT 1 FROM kira_accounts WHERE id=$1)`,[record.accountId]);
            });
        }
    }
    private async read(filename:string):Promise<Tombstone>{
        const file=await fs.open(filename,constants.O_RDONLY|constants.O_NOFOLLOW);
        try{
            if((await file.stat()).size>4096)throw Error('Invalid deletion ledger record');
            const value=JSON.parse(await file.readFile('utf8')),record=value.record as Tombstone;
            if(record?.version!==1 || !UUID.test(record.accountId) || !UUID.test(record.deletionId) || !Number.isFinite(Date.parse(record.blockedAt)))throw Error('Invalid deletion ledger record');
            const actual=Buffer.from(String(value.signature),'hex'),expected=Buffer.from(this.signature(record),'hex');
            if(actual.length!==expected.length || !timingSafeEqual(actual,expected))throw Error('Invalid deletion ledger signature');
            return record;
        }finally{await file.close();}
    }
}
