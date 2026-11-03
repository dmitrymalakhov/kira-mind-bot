import type { Bot } from 'grammy';
import type { BotContext } from '../types';
import { ApiError } from '../api/contracts';
import { accountAuthority } from '../ai/accountPolicy';
import { randomUUID } from 'node:crypto';

/** Metadata for the existing handler framework, outside Telegram's positive bot/user identity domain. */
export const API_ONLY_BOT_INFO={id:0,is_bot:true as const,first_name:'Кира',username:'kira_internal_api',
    can_join_groups:false,can_read_all_group_messages:false,supports_inline_queries:false,
    can_connect_to_business:false,has_main_web_app:false,has_topics_enabled:false,allows_users_to_create_topics:false,
    can_manage_bots:false,supports_join_request_queries:false};
export {API_ONLY_TRANSPORT_TOKEN} from '../utils/runtimeIdentity';

export function installApiOnlyTransport(bot:Bot<BotContext>,ownerId:number):void{
    bot.api.config.use(async (_previous,method,payload)=>{
        const body=payload as Record<string,unknown>;
        if(['sendChatAction','answerCallbackQuery','setMyCommands'].includes(method))return {ok:true,result:true} as any;
        if(!['sendMessage','sendPhoto','sendDocument','sendVoice','editMessageText','editMessageCaption','editMessageReplyMarkup'].includes(method)
            || Number(body.chat_id)!==ownerId)throw new ApiError(409,'telegram_not_connected','Для этой операции нужен подключённый Telegram.');
        if(method.startsWith('edit')){
            // The inbox is immutable evidence of delivery. Updates are separate versioned events, not Telegram network calls.
            if(typeof body.text!=='string' && typeof body.caption!=='string')return {ok:true,result:true} as any;
        }
        const text=typeof body.text==='string'?body.text:typeof body.caption==='string'?body.caption
            :method==='sendPhoto'?'Новое изображение Kira.':method==='sendVoice'?'Новое голосовое сообщение Kira.':'Новый файл Kira.';
        const saved=await accountAuthority('inbox',{sourceKey:`runtime:${randomUUID()}`,kind:'task_result',text});
        return {ok:true,result:{message_id:saved.messageId,date:Math.floor(Date.now()/1000),chat:{id:ownerId,type:'private'},text}} as any;
    });
}
