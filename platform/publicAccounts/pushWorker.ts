import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { PlatformSecrets } from '../crypto';
import { PushTransport, PushOutcome } from './apns';

export class PublicPushWorker {
    private timer?: NodeJS.Timeout;
    private running?: Promise<void>;
    constructor(private db: DataSource,private secrets:PlatformSecrets,private transport:PushTransport) {}
    start(){this.timer=setInterval(()=>{void this.drain();},5000);void this.drain();}
    async close(){clearInterval(this.timer);await this.running;}
    drain():Promise<void>{
        if(this.running)return this.running;
        this.running=this.batch().catch(()=>{console.error('[accounts] push batch failed');}).finally(()=>{this.running=undefined;});
        return this.running;
    }
    private async batch():Promise<void>{
        for(let n=0;n<20;n++){
            const lease=randomUUID();
            const job=await this.db.transaction(async tx=>{
                const [row]=await tx.query(`SELECT * FROM kira_public_push_outbox WHERE next_attempt_at<=now()
                    AND (state='pending' OR (state='sending' AND lease_until<=now())) ORDER BY next_attempt_at,id FOR UPDATE SKIP LOCKED LIMIT 1`);
                if(!row)return undefined;
                await tx.query(`UPDATE kira_public_push_outbox SET state='sending',lease_token=$2,lease_until=now()+interval '1 minute',attempts=attempts+1 WHERE id=$1`,[row.id,lease]);
                return row;
            });
            if(!job)return;
            const [binding]=await this.db.query(`SELECT d.*,e.account_id FROM kira_public_push_devices d
                JOIN kira_public_sessions s ON s.id=d.session_id JOIN kira_public_identities i ON i.id=s.identity_id
                JOIN kira_public_inbox e ON e.id=$1 AND e.account_id=d.account_id JOIN kira_accounts a ON a.id=e.account_id
                WHERE d.session_id=$2 AND d.device_id=$3 AND s.account_id=e.account_id AND s.revoked_at IS NULL AND i.revoked_at IS NULL
                AND s.refresh_expires_at>now() AND a.account_state NOT IN ('deleting','deleted')
                AND NOT EXISTS(SELECT 1 FROM kira_public_deletion_ledger l WHERE l.account_id=a.id)`,[job.event_id,job.session_id,job.device_id]);
            let outcome:PushOutcome|'cancelled'='cancelled';
            if(binding){
                try{outcome=await this.transport.send({id:job.id,eventId:job.event_id,environment:binding.environment,
                    token:this.secrets.open<string>(binding.token_encrypted,`push:${binding.account_id}:${binding.device_id}`)});}
                catch{outcome='retry';}
            }
            await this.db.transaction(async tx=>{
                const [owned]=await tx.query('SELECT id FROM kira_public_push_outbox WHERE id=$1 AND lease_token=$2 FOR UPDATE',[job.id,lease]);
                if(!owned)return;
                if(outcome==='unregistered' && binding)await tx.query('DELETE FROM kira_public_push_devices WHERE account_id=$1 AND device_id=$2 AND token_hash=$3',[binding.account_id,binding.device_id,binding.token_hash]);
                const retry=outcome==='retry';
                await tx.query(`UPDATE kira_public_push_outbox SET state=$3,lease_until=NULL,lease_token=NULL,
                    next_attempt_at=now()+($4::int*interval '1 second') WHERE id=$1 AND lease_token=$2`,
                [job.id,lease,retry?'pending':outcome,Math.min(3600,5*2**Math.min(Number(job.attempts),9))]);
            });
        }
    }
}
