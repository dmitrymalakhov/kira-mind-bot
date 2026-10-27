import type { BotContext } from '../types';

export interface BrowserRuntimeOwner { userId: number; chatId?: number; sessionScopeKey?: string; }

export function browserContextScopeKey(ctx: BotContext): string {
    return ctx.agentRuntimeStorageKey ?? ctx.sessionStorageKey ?? String(ctx.chat?.id ?? 0);
}

export function browserRuntimeOwnerKey(userId: number, chatId?: number, scopeKey = String(chatId ?? 0)): string {
    return JSON.stringify([userId, chatId ?? 0, scopeKey]);
}

export function browserRunBelongsToContext(state: BrowserRuntimeOwner, ctx: BotContext): boolean {
    return state.userId === (ctx.from?.id ?? 0) && state.chatId === ctx.chat?.id &&
        (state.sessionScopeKey ?? String(state.chatId ?? 0)) === browserContextScopeKey(ctx);
}
