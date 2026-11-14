/** Telegram message IDs belong to one bot conversation, while account history remains stable. */
export function telegramSessionTransport<T extends object>(snapshot:T,key:string,env:NodeJS.ProcessEnv=process.env,fromCurrentWorker=false):T & {telegramBotId?:string}{
    if(key.startsWith('api:') || env.KIRA_RUNTIME_MODE==='api_only')return snapshot;
    if(!env.KIRA_SESSION_LEGACY_TELEGRAM_BOT_ID && !(snapshot as {telegramBotId?:string}).telegramBotId)return snapshot;
    const botId=/^(\d{5,20}):/.exec(env.KIRA_BOT_TOKEN || '')?.[1];
    if(!botId)return snapshot;
    const state={...snapshot} as Record<string,any>;
    const previous=state.telegramBotId || env.KIRA_SESSION_LEGACY_TELEGRAM_BOT_ID;
    if(!fromCurrentWorker && previous && previous!==botId){
        state.sentMessages={};state.sentMessageContexts={};
        for(const field of ['pendingQuickChoices','pendingPostpone','pendingReminderEdit','pendingRecurringTaskEdit','lastSchedulableRequest','chatPromptWatchState'])delete state[field];
        if(Array.isArray(state.messageHistory))state.messageHistory=state.messageHistory.map((entry:any)=>{
            const next={...entry};for(const field of ['messageId','replyToMessageId','sourceMessageId','ui','uiRefresh'])delete next[field];return next;
        });
    }
    state.telegramBotId=botId;
    return state as T & {telegramBotId:string};
}
