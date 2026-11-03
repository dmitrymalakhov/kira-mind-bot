import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { ApiError } from '../../api/contracts';
import { PlatformSecrets } from '../crypto';
import type { Account } from '../store';
import { tenantName } from '../store';
import type { TenantCredentials } from '../runtime';
import type { ComplaintInput } from './contracts';
import { PublicLimits } from './limits';
import * as v from './validation';

export type ReplyResolver=(account:Account,replyId:string)=>Promise<string|undefined>;
/** Reads the existing scoped runtime receipt, not a client-supplied quote/account or model-selected identity. */
export function ownedReplyResolver(registry:DataSource,secrets:PlatformSecrets):ReplyResolver{
    return async(account,replyId)=>{
        const owner=account.runtime_mode==='api_only'?account.runtime_principal:account.owner_id;
        if(!owner || !account.secrets)return undefined;
        const credentials=secrets.open<TenantCredentials>(account.secrets,account.id),name=tenantName(account.id);
        const database=credentials.existingStorage?.database || name;
        if(!/^[A-Za-z][A-Za-z0-9_]{0,62}$/.test(database) || !/^-?\d+$/.test(String(owner)))throw new ApiError(503,'reply_unavailable','Не удалось проверить сообщение.');
        const connection=await new DataSource({...registry.options,type:'postgres',database,username:name,password:secrets.derive(account.id,'database'),
            entities:[],synchronize:false,logging:false,extra:{max:1}} as any).initialize();
        try{
            const [row]=await connection.query(`SELECT message->>'text' AS text FROM api_operations a
                CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(a.result->'messages')='array' THEN a.result->'messages' ELSE '[]'::jsonb END) AS message
                WHERE a.key LIKE $1 AND a.status='completed' AND message->>'id'=$2 AND message->>'type' IN ('text','photo','voice') LIMIT 1`,
            [`KiraMindBot:${owner}:%`,replyId]);
            return typeof row?.text==='string'?row.text:undefined;
        }finally{await connection.destroy();}
    };
}

export class PublicComplaints{
    constructor(private db:DataSource,private secrets:PlatformSecrets,private limits:PublicLimits,private resolveReply:ReplyResolver){}
    async report(account:Account,raw:Record<string,unknown>){
        v.fields(raw,['version','replyId','category','details'],['version','replyId','category']);v.version(raw);
        const input=raw as unknown as ComplaintInput,replyId=v.text(input.replyId,1,128);
        if(!/^-?\d{1,17}$/.test(replyId) || !['unsafe','privacy','other'].includes(input.category))v.invalid();
        if(input.details!==undefined)v.text(input.details,1,2000);
        await this.limits.take(`complaint:${account.id}`,20,24*3600);
        const text=await this.resolveReply(account,replyId);
        if(text===undefined)throw new ApiError(404,'not_found','Сообщение не найдено в этом аккаунте.');
        const id=randomUUID();
        await this.db.query(`INSERT INTO kira_public_complaints(id,account_id,reply_id,category,details_encrypted) VALUES($1,$2,$3,$4,$5)`,
            [id,account.id,replyId,input.category,this.secrets.seal({details:input.details || null,replyText:text.slice(0,40_000)},`complaint:${account.id}:${id}`)]);
        return {version:1 as const,complaintId:id,status:'received' as const};
    }
    /** Trusted operator surface only. Not exposed as a user-controlled account endpoint or LLM tool. */
    async review(complaintId:string,decision:'restrict'|'dismiss'):Promise<void>{
        v.uuid(complaintId);if(!['restrict','dismiss'].includes(decision))v.invalid();
        await this.db.transaction(async tx=>{
            const [complaint]=await tx.query('SELECT * FROM kira_public_complaints WHERE id=$1 FOR UPDATE',[complaintId]);
            if(!complaint)throw new ApiError(404,'not_found','Обращение не найдено.');
            if(complaint.status!=='received')return;
            if(decision==='restrict')await tx.query("UPDATE kira_accounts SET account_state='restricted',autonomous_ai_enabled=false WHERE id=$1 AND account_state NOT IN ('deleting','deleted')",[complaint.account_id]);
            await tx.query('UPDATE kira_public_complaints SET status=$2 WHERE id=$1',[complaintId,decision==='restrict'?'restricted':'dismissed']);
        });
    }
}
