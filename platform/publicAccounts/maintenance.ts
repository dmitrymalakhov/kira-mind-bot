import type {DataSource} from 'typeorm';

/** Clear short-lived encrypted replies and expired abuse proofs; retain security bindings. */
export class PublicAccountMaintenance {
    private timer?:NodeJS.Timeout;
    private running?:Promise<void>;
    constructor(private db:DataSource,private now=()=>new Date()){}
    start(){this.timer=setInterval(()=>{void this.drain();},60_000);void this.drain();}
    async close(){clearInterval(this.timer);await this.running;}
    drain():Promise<void>{
        if(this.running)return this.running;
        this.running=this.clean().catch(()=>console.error('[accounts] maintenance retry required')).finally(()=>{this.running=undefined;});
        return this.running;
    }
    private async clean():Promise<void>{
        const now=this.now(),retry=new Date(now.getTime()-120_000),history=new Date(now.getTime()-86400_000);
        await this.db.transaction(async tx=>{
            const [lock]=await tx.query('SELECT pg_try_advisory_xact_lock(706283006) AS acquired');if(!lock.acquired)return;
            await tx.query('UPDATE kira_public_refresh SET replay_encrypted=NULL WHERE replaced_at<=$1 AND replay_encrypted IS NOT NULL',[retry]);
            await tx.query('UPDATE kira_public_challenges SET result_encrypted=NULL WHERE consumed_at<=$1 AND result_encrypted IS NOT NULL',[retry]);
            await tx.query('DELETE FROM kira_public_challenges WHERE expires_at<=$1',[history]);
            await tx.query('DELETE FROM kira_public_reauthentication WHERE expires_at<=$1',[now]);
            await tx.query('DELETE FROM kira_public_proof_tokens WHERE expires_at<=$1',[now]);
            await tx.query('DELETE FROM kira_public_web_flows WHERE expires_at<=$1',[now]);
            await tx.query('DELETE FROM kira_public_web_browsers WHERE expires_at<=$1',[now]);
            await tx.query('DELETE FROM kira_public_limits WHERE expires_at<=$1',[now]);
            await tx.query(`UPDATE kira_public_deletions d SET inventory_encrypted='' WHERE d.state='completed'
                AND d.inventory_expires_at<=$1 AND d.inventory_encrypted<>''
                AND NOT EXISTS(SELECT 1 FROM kira_accounts a WHERE a.id=d.account_id)`,[now]);
        });
    }
}
