import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { ApiError } from '../api/contracts';
import { createHash } from 'node:crypto';
import type { IncomingMessage,ServerResponse } from 'node:http';

export interface AccountAiOperation { id: string; background: boolean }
interface Scope extends AccountAiOperation { active: boolean }
const operations = new AsyncLocalStorage<Scope>();
const imageOperations = new AsyncLocalStorage<string>();
export function withAccountImageOperation<T>(id:string,work:()=>Promise<T>):Promise<T>{return imageOperations.run(id,work);}
type Pending = { resolve(value:any):void;reject(error:unknown):void;timer:NodeJS.Timeout };
const pending = new Map<string,Pending>();
let listening = false;

export function currentAccountAiOperation(): AccountAiOperation | undefined {
    const scope=operations.getStore();return scope?.active ? {id:scope.id,background:scope.background} : undefined;
}
export async function withAccountAiOperation<T>(operation:AccountAiOperation,work:()=>Promise<T>):Promise<T>{
    const scope={...operation,active:true};
    return operations.run(scope,async()=>{try{return await work();}finally{scope.active=false;}});
}
/** Explicit user-authorized continuation, independent of a finished HTTP scope's lifetime. */
export function bindAccountAiOperation<T extends (...args:any[])=>Promise<any>>(work:T):T{
    const operation=currentAccountAiOperation();
    return ((...args:Parameters<T>)=>operation?withAccountAiOperation(operation,()=>work(...args)):work(...args)) as T;
}

/** No registry credential in a tenant process. Account authority is the process's parent binding. */
export async function accountAuthority(operation:'outbound'|'admission'|'inbox'|'release',data:Record<string,unknown>):Promise<any>{
    if(!process.env.KIRA_TENANT_ID)return undefined;
    if(!process.send || !process.connected)throw new ApiError(503,'policy_unavailable','Политика аккаунта временно недоступна.');
    if(!listening){
        listening=true;
        process.on('message',(raw:unknown)=>{
            const message=raw as {type?:string;id?:string;ok?:boolean;result?:unknown;error?:{status:number;code:string}};
            if(message?.type!=='kira-account-result' || !message.id)return;
            const waiter=pending.get(message.id);if(!waiter)return;
            pending.delete(message.id);clearTimeout(waiter.timer);
            if(message.ok)waiter.resolve(message.result);
            else waiter.reject(new ApiError(message.error?.status || 503,message.error?.code || 'policy_unavailable','Операция недоступна по политике аккаунта.'));
        });
    }
    if(pending.size>=64)throw new ApiError(503,'policy_unavailable','Политика аккаунта занята.');
    const id=randomUUID();
    return new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{pending.delete(id);reject(new ApiError(503,'policy_unavailable','Политика аккаунта не ответила.'));},10_000);
        pending.set(id,{resolve,reject,timer});
        process.send!({type:'kira-account-request',id,operation,data},(error:Error|null)=>{
            if(!error)return;const p=pending.get(id);if(p){pending.delete(id);clearTimeout(timer);reject(new ApiError(503,'policy_unavailable','Политика аккаунта недоступна.'));}
        });
    });
}
export async function authorizeAccountOutbound(provider:string,endpoint:string,image=false,reserveOnly=false):Promise<void>{
    if(!process.env.KIRA_TENANT_ID)return;
    const current=currentAccountAiOperation();
    // Detached/unscoped work is autonomous, never an implicit continuation of a finished foreground turn.
    const operation=current || {id:`autonomous:${randomUUID()}`,background:true};
    const url=new URL(endpoint);
    if(url.username || url.password)throw new ApiError(403,'consent_required','Неподтверждённый получатель AI.');
    url.search='';url.hash='';
    await accountAuthority('outbound',{operationId:operation.id,provider,endpoint:url.href,image,background:operation.background,reserveOnly,
        ...(image?{imageOperationId:imageOperations.getStore() || operation.id}:{})});
}

export function accountPolicyFetch<T extends (...args:any[])=>Promise<any>>(provider:string,fetcher:T = ((...args:any[])=>(globalThis.fetch as any)(...args)) as T):T{
    return (async (...args:Parameters<T>)=>{
        const input=args[0];
        const endpoint=typeof input==='string' ? input : input instanceof URL ? input.href : input.url;
        if(typeof endpoint!=='string')throw new ApiError(503,'policy_unavailable','Неизвестный получатель AI.');
        const method=String(args[1]?.method || input?.method || 'GET').toUpperCase();
        const metadata=method==='GET' && /\/models(?:\/[A-Za-z0-9._:-]+)?\/?$/.test(new URL(endpoint).pathname);
        if(!process.env.KIRA_TENANT_ID || metadata)return fetcher(...args);
        const image=/\/images\/(generations|edits)(?:\?|$)/.test(endpoint);
        const work=async()=>{
            const moderation=await import('./accountModeration');
            try{
                await authorizeAccountOutbound(provider,endpoint,image,true);
                await moderation.moderateAccountRequest(args[1]?.body);
                await authorizeAccountOutbound(provider,endpoint,image);
                const response=await fetcher(...args);
                await moderation.moderateAccountResponse(response);
                return response;
            }finally{
                const operation=currentAccountAiOperation();
                if(operation)await accountAuthority('release',{operationId:operation.id,imageOperationId:image?(imageOperations.getStore() || operation.id):false});
            }
        };
        const current=currentAccountAiOperation();
        const scoped=()=>image && !imageOperations.getStore()?withAccountImageOperation(`image:${randomUUID()}`,work):work();
        return current?scoped():withAccountAiOperation({id:`autonomous:${randomUUID()}`,background:true},scoped);
    }) as T;
}
/** Keep the OpenAI SDK's Node multipart/stream transport semantics. */
export function accountOpenAiFetch(provider:string):any {
    const nodeFetch=require('node-fetch');
    return accountPolicyFetch(provider,nodeFetch.default || nodeFetch);
}
export function accountHttpOperation(handler:(req:IncomingMessage,res:ServerResponse)=>Promise<unknown>){
    return (req:IncomingMessage,res:ServerResponse)=>{
        const key=typeof req.headers['idempotency-key']==='string'?req.headers['idempotency-key']:randomUUID();
        const id=createHash('sha256').update(`${req.method}:${new URL(req.url || '/','http://localhost').pathname}:${key}`).digest('hex');
        void withAccountAiOperation({id:`api:${id}`,background:false},()=>handler(req,res)).catch(()=>res.destroy());
    };
}
const policyCodes=new Set(['consent_required','account_restricted','account_deleting','autonomous_ai_disabled','quota_exhausted','activation_required','policy_unavailable','operation_closed','moderation_unavailable','content_policy_violation']);
export function accountPolicyError(error:unknown):ApiError|undefined{
    let current=error;
    for(let n=0;n<5 && current && typeof current==='object';n++){
        if(current instanceof ApiError && policyCodes.has(current.code))return current;
        current=(current as {cause?:unknown}).cause;
    }
    return undefined;
}
