import { InlineKeyboard } from 'grammy';
import type { BotContext } from '../types';
import { config } from '../config';
import { browserContextScopeKey } from '../utils/browserRuntimeScope';
import { ApiError } from '../api/contracts';
import { browserUtterance } from './liveBrowserConversation';
import { LiveBrowserSession, liveBrowserSessions, isLiveBrowserTerminal } from './liveBrowserSession';

const assistanceMessages = new WeakMap<LiveBrowserSession, Map<number, string>>();
export function bindBrowserAssistanceMessage(session: LiveBrowserSession, messageId: number, requestId: string) {
    const bindings = assistanceMessages.get(session) ?? new Map<number, string>();
    bindings.set(messageId, requestId);
    while (bindings.size > 64) bindings.delete(bindings.keys().next().value!);
    assistanceMessages.set(session, bindings);
}
export function browserAssistanceForReply(session: LiveBrowserSession, repliedMessageId?: number) {
    return repliedMessageId === undefined ? session.snapshot().assistanceRequest?.requestId
        : assistanceMessages.get(session)?.get(repliedMessageId);
}

export function liveBrowserKeyboard(session: LiveBrowserSession) {
    const snapshot = session.snapshot(), keyboard = new InlineKeyboard();
    const data = (type: string) => `lb:${type}:${session.id}:${snapshot.revision}`;
    if (snapshot.state === 'awaiting_confirmation') keyboard.text('Подтвердить действие', data('yes')).text('Не выполнять', data('no')).row();
    else if (['paused','needs_user','disconnected'].includes(snapshot.state)) keyboard.text('Продолжить', data('resume')).row();
    if (!isLiveBrowserTerminal(snapshot.state)) keyboard.text('Пауза', data('pause')).text('Стоп', data('stop'));
    return keyboard;
}
function telegramContext(ctx: BotContext) {
    return ctx.from?.id === config.allowedUserId && ctx.chat?.type === 'private' && !ctx.sessionStorageKey?.startsWith('api:') && !ctx.agentRuntimeStorageKey;
}
function active(ctx: BotContext) { return telegramContext(ctx) ? liveBrowserSessions.active(ctx.from!.id, browserContextScopeKey(ctx)) : null; }

/** The long agent turn keeps its existing pipeline; only Telegram's update reader is released when it starts. */
export async function runTelegramBrowserResponsive(ctx: BotContext, work: () => Promise<void>) {
    if (!telegramContext(ctx)) return work();
    let release!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    const old = ctx.releaseBrowserUpdate;
    ctx.releaseBrowserUpdate = () => { old?.(); release(); };
    if (active(ctx)) release();
    const running = work();
    // Every caller retains its existing catch/finally/session-flush; no parallel browser executor is created.
    void running.catch(() => {});
    await Promise.race([running, released]);
}

export function notifyLiveBrowserState(ctx: BotContext, session: LiveBrowserSession) {
    let previous = '';
    let chain = Promise.resolve();
    session.onState = () => {
        const snapshot = session.snapshot();
        const key = `${snapshot.state}:${snapshot.assistanceRequest?.requestId ?? snapshot.pendingConfirmation?.confirmationId ?? ''}`;
        if (key === previous) return; previous = key;
        let text: string | undefined;
        if (snapshot.state === 'running' && !session.backgroundDelivery) text = 'Работаю в браузере. Можно написать или сказать поправку, поставить задачу на паузу или остановить.';
        if (session.backgroundDelivery && snapshot.assistanceRequest) {
            text = snapshot.assistanceRequest.prompt + (['login','otp','captcha'].includes(snapshot.assistanceRequest.kind)
                ? '\nЭтот ручной шаг нельзя выполнить в обычном Telegram-чате. Задача остаётся на паузе; не присылай пароль или код сюда.'
                : '\nОтветь текстом или голосом. Задача ждёт на этой же странице.');
        }
        if (session.backgroundDelivery && snapshot.pendingConfirmation) text = snapshot.pendingConfirmation.summary;
        if (text) {
            const keyboard = liveBrowserKeyboard(session);
            chain = chain.then(async () => {
                const message = await ctx.reply(text!, { reply_markup: keyboard });
                if (snapshot.assistanceRequest) bindBrowserAssistanceMessage(session, message.message_id, snapshot.assistanceRequest.requestId);
            }).catch(() => {});
        }
    };
}

export function handleLiveBrowserText(ctx: BotContext, text: string, source: 'text' | 'voice'): boolean {
    const session = active(ctx);
    if (!session || ctx.message?.forward_origin) return false;
    const key = `telegram-${ctx.message?.message_id ?? ctx.update.update_id}-${source}`;
    const body = session.telegramBody({ text, source, assistanceRequestId: browserAssistanceForReply(session, ctx.message?.reply_to_message?.message_id) });
    // Interpret concurrently: an earlier slow model call never blocks a new Pause/Stop button or utterance.
    void browserUtterance(session, key, body).then(async ack => {
        await ctx.reply(ack.reply || 'Состояние браузерной задачи обновлено.', { reply_markup: liveBrowserKeyboard(session) });
    }).catch(async error => { await ctx.reply(error instanceof ApiError ? error.message : 'Не удалось понять команду. Кнопки «Пауза» и «Стоп» доступны.',
        { reply_markup: liveBrowserKeyboard(session) }).catch(() => {}); });
    return true;
}

export async function handleLiveBrowserCallback(ctx: BotContext, data: string): Promise<boolean> {
    if (!data.startsWith('lb:')) return false;
    if (!telegramContext(ctx)) { await ctx.answerCallbackQuery({ text: 'Эта задача недоступна.' }); return true; }
    const match = /^lb:(pause|stop|resume|yes|no):([0-9a-f-]{36}):(\d+)$/.exec(data);
    if (!match) { await ctx.answerCallbackQuery({ text: 'Кнопка устарела.' }); return true; }
    try {
        const session = liveBrowserSessions.get(ctx.from!.id, browserContextScopeKey(ctx), match[2]);
        const snapshot = session.snapshot();
        const type = ['yes','no'].includes(match[1]) ? 'confirm' : match[1];
        const body = session.telegramBody({ type, expectedRevision: Number(match[3]),
            ...(type === 'confirm' ? { confirmationId: snapshot.pendingConfirmation?.confirmationId, decision: match[1] === 'yes' ? 'accept' : 'reject' } : {}) });
        await ctx.answerCallbackQuery({ text: type === 'stop' ? 'Останавливаю…' : 'Проверяю состояние…' });
        void session.command(`telegram-${ctx.callbackQuery!.id}`, body).then(async ack => {
            await ctx.reply(ack.reply || 'Состояние обновлено.', { reply_markup: liveBrowserKeyboard(session) });
        }).catch(async error => { await ctx.reply(error instanceof ApiError ? error.message : 'Не удалось выполнить команду.', { reply_markup: liveBrowserKeyboard(session) }).catch(() => {}); });
    } catch { await ctx.answerCallbackQuery({ text: 'Эта браузерная задача уже недоступна.' }).catch(() => {}); }
    return true;
}
