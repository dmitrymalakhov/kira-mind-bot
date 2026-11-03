import type { IncomingMessage } from 'node:http';
import type { DataSource } from 'typeorm';
import { ApiError } from '../../api/contracts';
import { readBody } from '../../api/server';
import { digest } from '../crypto';
import type { PublicAccountConfig } from './config';
import { loadJose } from './cryptoModules';
import { revokeSession } from './sessions';

const TRUSTED={apple:{issuer:'https://appleid.apple.com',keys:'https://appleid.apple.com/auth/keys'},
    google:{issuer:'https://accounts.google.com',keys:'https://www.googleapis.com/oauth2/v3/certs'}};
const RISC='https://schemas.openid.net/secevent/risc/event-type/';
const OAUTH='https://schemas.openid.net/secevent/oauth/event-type/';
const invalid=()=>new ApiError(400,'invalid_provider_event','Уведомление провайдера не подтверждено.');

/** Historical signed events have no expiry semantics. Verify signature/issuer/audience/jti, then dedupe durably. */
export class ProviderSecurityEvents{
    private keys=new Map<string,any>();
    constructor(private db:DataSource,private config:PublicAccountConfig,private now=()=>new Date(),private testKeys?:Partial<Record<'apple'|'google',any>>){}
    async receive(provider:'apple'|'google',token:string):Promise<void>{
        if(!this.config[provider].clientId)throw new ApiError(503,'provider_unavailable','Получатель событий не настроен.');
        const jose=await loadJose();let keys=this.testKeys?.[provider] || this.keys.get(provider);
        if(!keys){keys=jose.createRemoteJWKSet(new URL(TRUSTED[provider].keys),{timeoutDuration:8000});this.keys.set(provider,keys);}
        let payload:any;
        try{
            const verified=await jose.compactVerify(token,keys,{algorithms:['RS256']});
            payload=JSON.parse(Buffer.from(verified.payload).toString('utf8'));
            const audience=Array.isArray(payload.aud)?payload.aud:[payload.aud];
            if(payload.iss!==TRUSTED[provider].issuer || !audience.includes(this.config[provider].clientId)
                || typeof payload.jti!=='string' || !payload.jti || payload.jti.length>256 || typeof payload.iat!=='number'
                || !Number.isFinite(payload.iat) || payload.iat*1000>this.now().getTime()+300_000)throw invalid();
        }catch{throw invalid();}
        let events=payload.events;
        if(typeof events==='string'){try{events=JSON.parse(events);}catch{throw invalid();}}
        if(!events || typeof events!=='object' || Array.isArray(events))throw invalid();
        const changes:Array<{sub:string;time:number;disable:boolean;restrict:boolean}>=[];
        if(provider==='apple'){
            if(['consent-revoked','account-deleted'].includes(events.type))changes.push({sub:events.sub,time:events.event_time || payload.iat,disable:true,restrict:false});
        }else{
            for(const [type,raw]of Object.entries(events)){
                const event=raw as any,subject=event?.subject;
                if(![RISC+'sessions-revoked',OAUTH+'tokens-revoked',RISC+'account-disabled',RISC+'account-credential-change-required'].includes(type))continue;
                if(!subject || !['iss-sub','id_token_claims'].includes(subject.subject_type) || (subject.iss && ![TRUSTED.google.issuer,TRUSTED.google.issuer+'/'].includes(subject.iss)))continue;
                changes.push({sub:subject.sub,time:event.event_time || payload.iat,disable:type===RISC+'account-disabled',restrict:type===RISC+'account-disabled' && event.reason==='hijacking'});
            }
        }
        if(changes.some(c=>typeof c.sub!=='string' || !c.sub || c.sub.length>512 || typeof c.time!=='number' || !Number.isFinite(c.time) || c.time*1000>this.now().getTime()+300_000))throw invalid();
        await this.db.transaction(async tx=>{
            const inserted=await tx.query(`INSERT INTO kira_public_security_events(event_hash,provider) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING event_hash`,[digest(`${provider}:${payload.jti}`),provider]);
            if(!inserted.length)return;
            for(const change of changes){
                const [identity]=await tx.query('SELECT * FROM kira_public_identities WHERE provider=$1 AND subject=$2 FOR UPDATE',[provider,change.sub]);
                if(!identity)continue;
                const last=identity.last_used_at?Math.floor(new Date(identity.last_used_at).getTime()/1000):0;
                if(change.time<last)continue; // A delayed historical event cannot revoke a proven newer login.
                if(change.disable && identity.revocation_reason!=='user')await tx.query("UPDATE kira_public_identities SET revoked_at=$2,revocation_reason='provider' WHERE id=$1",[identity.id,new Date(change.time*1000)]);
                if(change.restrict)await tx.query("UPDATE kira_accounts SET account_state='restricted',autonomous_ai_enabled=false WHERE id=$1 AND account_state NOT IN ('deleting','deleted')",[identity.account_id]);
                for(const session of await tx.query('SELECT id FROM kira_public_sessions WHERE identity_id=$1',[identity.id]))await revokeSession(tx,session.id);
            }
        });
    }
    async request(req:IncomingMessage,provider:'apple'|'google'):Promise<void>{
        if(req.method!=='POST')throw new ApiError(405,'method_not_allowed','Ожидается POST.');
        let token:string;
        if(provider==='apple'){
            const body=await readBody(req);if(Object.keys(body).some(k=>k!=='payload') || typeof body.payload!=='string')throw invalid();token=body.payload;
        }else{
            if(req.headers['content-type']?.split(';')[0]!=='application/secevent+jwt')throw new ApiError(415,'unsupported_media_type','Ожидается security event token.');
            let size=0;const chunks:Buffer[]=[];
            for await(const chunk of req){const buffer=Buffer.from(chunk);size+=buffer.length;if(size>32_768)throw invalid();chunks.push(buffer);}
            token=Buffer.concat(chunks).toString('utf8').trim();
        }
        if(token.length>32_768 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token))throw invalid();
        await this.receive(provider,token);
    }
}
