import type { ChildProcess } from 'node:child_process';
import type { DataSource } from 'typeorm';
import { ApiError } from '../../api/contracts';
import type { PublicAccountPolicy, OutboundAdmission } from './policy';
import type { PublicInbox } from './inbox';
import * as v from './validation';

export function attachAccountAuthority(child:ChildProcess,accountId:string,db:DataSource,policy:PublicAccountPolicy,inbox:PublicInbox):void{
    child.on('message',(raw:unknown)=>{
        const message=raw as {type?:string;id?:string;operation?:string;data?:Record<string,unknown>};
        if(message?.type!=='kira-account-request')return;
        void (async()=>{
            let result:unknown;
            try{
                const id=v.uuid(message.id),data=v.object(message.data);
                if(message.operation==='outbound'){
                    v.fields(data,['operationId','provider','endpoint','image','background','reserveOnly','imageOperationId'],['operationId','provider','endpoint','image','background']);
                    if(data.reserveOnly!==undefined && typeof data.reserveOnly!=='boolean')v.invalid();
                    if(data.imageOperationId!==undefined)v.text(data.imageOperationId,1,512);
                    await policy.authorizeOutbound(accountId,data as unknown as OutboundAdmission);
                }else if(message.operation==='release'){
                    v.fields(data,['operationId','imageOperationId'],['operationId']);
                    const image=data.imageOperationId===false?false:data.imageOperationId===undefined?undefined:v.text(data.imageOperationId,1,512);
                    await policy.release(accountId,v.text(data.operationId,1,512),image);
                }else if(message.operation==='admission'){
                    v.fields(data,[]);
                    const [allowed]=await db.query(`SELECT id FROM kira_accounts WHERE id=$1 AND account_state NOT IN ('deleting','deleted')
                        AND NOT EXISTS(SELECT 1 FROM kira_public_deletion_ledger l WHERE l.account_id=kira_accounts.id)`,[accountId]);
                    if(!allowed)throw new ApiError(403,'account_deleting','Аккаунт удаляется.');
                }else if(message.operation==='inbox'){
                    v.fields(data,['sourceKey','kind','text','resourceId'],['sourceKey','kind','text']);
                    result=await inbox.append(accountId,v.text(data.sourceKey,1,512),data.kind as any,{text:v.text(data.text,1,40_000),
                        ...(data.resourceId===undefined?{}:{resourceId:v.text(data.resourceId,1,128)})});
                }else throw new ApiError(403,'policy_unavailable','Неизвестная операция.');
                if(child.connected)child.send({type:'kira-account-result',id,ok:true,result});
            }catch(error){
                const safe=error instanceof ApiError?error:new ApiError(503,'policy_unavailable','Политика аккаунта недоступна.');
                if(child.connected && typeof message.id==='string' && message.id.length<=64)child.send({type:'kira-account-result',id:message.id,ok:false,error:{status:safe.status,code:safe.code}});
            }
        })();
    });
}
