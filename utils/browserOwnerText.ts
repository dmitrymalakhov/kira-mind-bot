import type { BotContext } from '../types';
/** Intake provenance only. A generated task/page/default never becomes an owner instruction. */
export function bindBrowserOwnerText(ctx:Pick<BotContext,'browserOwnerText'|'browserOwnerTextBound'>,turn:{userText:string;isForwarded?:boolean;forwardContext?:unknown;internalContinuation?:boolean}):void {
    ctx.browserOwnerTextBound=true;
    ctx.browserOwnerText=!turn.isForwarded&&!turn.forwardContext&&!turn.internalContinuation?turn.userText:undefined;
}
