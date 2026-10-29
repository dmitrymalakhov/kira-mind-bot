import { createHash, randomUUID } from 'node:crypto';
import type { Bot, MiddlewareFn } from 'grammy';
import { InlineKeyboard } from 'grammy';
import { AppDataSource } from '../data-source';
import type { BotContext } from '../types';
import type { MessageClassification, ProcessingResult } from '../orchestrator';
import { config } from '../config';
import { editReplyMarkupIfChanged } from '../utils/telegramMessageEdit';
const store = require('../admin-panel/productAnalyticsStore');

export interface ProductAnalyticsTask {
    id: string; actor: string; channel: 'telegram' | 'api'; startedAt: number;
    scenario: string; kind: string; persisted?: boolean; delivered?: boolean;
    status?: string; technicalOk?: boolean; deferred?: boolean;
    observed?: boolean;
}

export function analyticsActor(owner: number | string = config.allowedUserId): string {
    return createHash('sha256').update(`${process.env.KIRA_TENANT_ID || process.env.KIRA_INSTANCE_NAME || 'local'}:${owner}`).digest('hex');
}

// Telemetry must not turn an otherwise valid user request into a failure.
async function safely(work: () => Promise<unknown>): Promise<boolean> {
    if (!AppDataSource.isInitialized) return false;
    try { await work(); return true; }
    catch { console.warn('[product-analytics] запись недоступна'); return false; }
}

export async function initializeProductAnalytics(): Promise<void> {
    await safely(() => store.ensureProductAnalyticsSchema(AppDataSource));
}

export async function recordPreferenceChange(feature: string, enabled: boolean): Promise<void> {
    await safely(() => store.recordPreference(AppDataSource, analyticsActor(), feature, enabled));
}

export function productAnalyticsMiddleware(): MiddlewareFn<BotContext> {
    return async (ctx, next) => {
        if (!ctx.session?.isAllowedUser || ctx.from?.id !== config.allowedUserId || ctx.chat?.type !== 'private') return next();
        const data = ctx.callbackQuery?.data;
        if (data?.startsWith('pa:')) {
            const [, rating, id] = data.split(':');
            if (rating === 'issues' && store.UUID.test(id || '') && ctx.callbackQuery?.message) {
                const keyboard = new InlineKeyboard().text('Пришлось исправлять', `pa:corrected:${id}`).row()
                    .text('Ошибка памяти', `pa:memory_wrong:${id}`).text('Ошибка доверия', `pa:trust:${id}`).row()
                    .text('Назад', `pa:back:${id}`);
                await editReplyMarkupIfChanged(ctx.api, ctx.callbackQuery.message as any, keyboard);
                await ctx.answerCallbackQuery(); return;
            }
            if (rating === 'back' && store.UUID.test(id || '') && ctx.callbackQuery?.message) {
                await editReplyMarkupIfChanged(ctx.api, ctx.callbackQuery.message as any, feedbackKeyboard(id));
                await ctx.answerCallbackQuery(); return;
            }
            if (!store.UUID.test(id || '') || !store.FEEDBACK.includes(rating)) {
                await ctx.answerCallbackQuery({ text: 'Оценка недоступна' }); return;
            }
            const feedbackId = createHash('sha256').update(`feedback:${ctx.callbackQuery!.id}`).digest('hex');
            const uuid = `${feedbackId.slice(0, 8)}-${feedbackId.slice(8, 12)}-4${feedbackId.slice(13, 16)}-8${feedbackId.slice(17, 20)}-${feedbackId.slice(20, 32)}`;
            let saved = false;
            await safely(async () => { saved = await store.assessTask(AppDataSource, id, analyticsActor(ctx.from!.id), rating, 'user', uuid); });
            await ctx.answerCallbackQuery({ text: saved ? 'Спасибо, оценка сохранена' : 'Не удалось сохранить оценку' });
            return;
        }
        if (!ctx.message && !data) return next();
        // Edited messages, reactions and callbacks that only rate an answer are not new tasks.
        const seed = ctx.sessionStorageKey?.startsWith('api:') ? ctx.session.apiActionVersion
            : ctx.update.update_id ? `tg:${ctx.update.update_id}` : undefined;
        const digest = seed ? createHash('sha256').update(`${analyticsActor()}:${seed}`).digest('hex') : undefined;
        const id = digest ? `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}` : randomUUID();
        const task: ProductAnalyticsTask = { id, actor: analyticsActor(ctx.from.id), channel: ctx.sessionStorageKey?.startsWith('api:') ? 'api' : 'telegram',
            startedAt: Date.now(), scenario: 'other', kind: 'interactive' };
        task.persisted = await safely(() => store.startTask(AppDataSource, task));
        ctx.productAnalytics = task;
        let lastDelivery = 0;
        // Wrap only this update's context; do not install per-update transformers on the shared API.
        const target = ctx as any;
        const originals = new Map<string, any>();
        for (const method of ['reply', 'replyWithPhoto', 'replyWithDocument', 'replyWithVoice', 'replyWithVideo', 'replyWithLocation']) {
            if (typeof target[method] !== 'function') continue;
            const original = target[method]; originals.set(method, original);
            target[method] = async (...args: any[]) => { const result = await original.apply(ctx, args); lastDelivery = Date.now(); return result; };
        }
        try {
            await next();
            if (!task.observed && lastDelivery) await updateTask(ctx, { status: 'delivered', delivered: true });
        }
        catch (error) { await updateTask(ctx, { status: 'failed', technicalOk: false }); throw error; }
        finally { for (const [method, original] of originals) target[method] = original; }
        // Direct command handlers do not all expose semantic outcomes; leave those unassessed.
    };
}

export async function updateTask(ctx: Pick<BotContext, 'productAnalytics'>, values: { status?: string; technicalOk?: boolean; delivered?: boolean; offered?: boolean; scenario?: string }): Promise<void> {
    const task = ctx.productAnalytics;
    if (!task?.persisted) return;
    if (values.status && !store.STATUSES.includes(values.status)) return;
    if (values.scenario && !store.SCENARIOS.includes(values.scenario)) return;
    await safely(() => AppDataSource.query(`UPDATE product_analytics_tasks SET
        status=COALESCE($2,status), technical_ok=COALESCE($3,technical_ok),
        delivered_at=CASE WHEN $4 THEN COALESCE(delivered_at,now()) ELSE delivered_at END,
        feedback_offered=feedback_offered OR $5, scenario=COALESCE($6,scenario)
        WHERE id=$1 AND actor=$7`, [task.id, values.status ?? null, values.technicalOk ?? null,
        values.delivered === true, values.offered === true, values.scenario ?? null, task.actor]));
    Object.assign(task, { ...(values.status ? { status: values.status } : {}), ...(values.scenario ? { scenario: values.scenario } : {}) });
}

export function classificationScenario(classification: MessageClassification): string {
    const intent = classification.intent;
    if (intent === 'НАПОМИНАНИЕ') return 'reminder';
    if (classification.details?.memoryTask && classification.details.memoryTask !== 'none') return 'memory';
    if (intent === 'ВЕБ_ПОИСК' || classification.details?.knowledgeSource === 'external_current') return 'search';
    if (['РАЗГОВОР', 'ВОЗМОЖНОСТИ_БОТА'].includes(intent)) return 'conversation';
    return intent === 'НЕОПРЕДЕЛЕНО' ? 'other' : 'action';
}

export async function observeClassification(ctx: BotContext, classification: MessageClassification): Promise<void> {
    await updateTask(ctx, { scenario: classificationScenario(classification) });
}

export async function continueAnalyticsTask(ctx: BotContext, id?: string): Promise<void> {
    const task = ctx.productAnalytics;
    if (!task?.persisted || !id || id === task.id || !store.UUID.test(id)) return;
    await safely(async () => {
        const rows = await AppDataSource.query('SELECT * FROM product_analytics_tasks WHERE id=$1 AND actor=$2', [id, task.actor]);
        if (!rows.length) return;
        await AppDataSource.query("UPDATE product_analytics_tasks SET kind='continuation',parent_id=$2,status='cancelled' WHERE id=$1 AND actor=$3", [task.id, id, task.actor]);
        Object.assign(task, { id, startedAt: new Date(rows[0].started_at).getTime(), scenario: rows[0].scenario, delivered: false });
    });
}

export async function observeResult(ctx: BotContext, result: ProcessingResult): Promise<void> {
    if (!ctx?.productAnalytics) return;
    ctx.productAnalytics.observed = true;
    const status = result.operationStatus;
    ctx.productAnalytics.status = status === 'failed' ? 'failed' : status === 'unknown' ? 'unknown' : status === 'needs_input' || result.clarificationQuestion ? 'waiting' : 'running';
    ctx.productAnalytics.technicalOk = status === 'ok' ? true : status === 'failed' || status === 'unknown' ? false : undefined;
    ctx.productAnalytics.deferred = result.awaitingDeferredResult === true;
    await updateTask(ctx, { status: ctx.productAnalytics.status, technicalOk: ctx.productAnalytics.technicalOk });
}

export function feedbackKeyboard(id: string): InlineKeyboard {
    return new InlineKeyboard().text('👍 Помогло', `pa:helpful:${id}`).text('👎 Не помогло', `pa:unhelpful:${id}`)
        .row().text('Сообщить об ошибке', `pa:issues:${id}`);
}

export async function recordDeferredOutcome(id: string | undefined, owner: number, status: 'delivered' | 'failed' | 'unknown' | 'cancelled', delivered = false): Promise<void> {
    if (!id || !store.UUID.test(id)) return;
    await safely(() => AppDataSource.query(`UPDATE product_analytics_tasks SET status=$3,
        delivered_at=CASE WHEN $3='delivered' OR $4 THEN COALESCE(delivered_at,now()) ELSE delivered_at END
        WHERE id=$1 AND actor=$2 AND delivered_at IS NULL`, [id, analyticsActor(owner), status, delivered]));
}

export async function sendProactiveWithFeedback(bot: Bot<BotContext>, chatId: number, text: string, scenario: 'conversation' | 'memory') {
    const task: ProductAnalyticsTask = { id: randomUUID(), actor: analyticsActor(config.allowedUserId), channel: 'telegram',
        startedAt: Date.now(), kind: 'proactive', scenario };
    // Feedback is only collected in the owner's private chat.
    if (chatId === config.allowedUserId) task.persisted = await safely(() => store.startTask(AppDataSource, task));
    try {
        const sent = await bot.api.sendMessage(chatId, text, task.persisted ? { reply_markup: feedbackKeyboard(task.id) } : undefined);
        await updateTask({ productAnalytics: task }, { status: 'delivered', delivered: true, offered: task.persisted });
        return sent;
    } catch (error) { await updateTask({ productAnalytics: task }, { status: 'failed', technicalOk: false }); throw error; }
}

export async function recordResultDelivery(ctx: BotContext, result: ProcessingResult, send: () => Promise<{ message_id: number }>, options: { feedback?: boolean } = {}): Promise<{ message_id: number }> {
    const task = ctx.productAnalytics;
    await observeResult(ctx, result);
    const offered = Boolean(options.feedback !== false && task?.persisted && !result.keyboard && !task.deferred && !result.clarificationQuestion && task.status !== 'waiting');
    if (offered) result.keyboard = feedbackKeyboard(task!.id);
    try {
        const sent = await send();
        if (result.operationStatus === 'failed' || result.operationStatus === 'unknown') await observeResult(ctx, result);
        await updateTask(ctx, { delivered: !task?.deferred && task?.status !== 'waiting', offered,
            status: task?.deferred || task?.status === 'waiting' ? 'waiting' : task?.status === 'failed' || task?.status === 'unknown' ? task.status : 'delivered' });
        if (task) task.delivered = true;
        return sent;
    } catch (error) { await updateTask(ctx, { status: 'failed', technicalOk: false }); throw error; }
}

export async function recordBackgroundDelivery(kind: 'proactive' | 'reminder_delivery' | 'recurring', scenario: string,
    owner: number, key: string, deliveredAt: number): Promise<void> {
    const digest = createHash('sha256').update(`${analyticsActor(owner)}:${kind}:${key}`).digest('hex');
    const id = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
    const task: ProductAnalyticsTask = { id, actor: analyticsActor(owner), channel: 'telegram', startedAt: deliveredAt, kind, scenario };
    task.persisted = await safely(() => store.startTask(AppDataSource, task));
    await updateTask({ productAnalytics: task }, { status: 'delivered', delivered: true, technicalOk: true });
}

export function registerProductAnalytics(bot: Bot<BotContext>): void { bot.use(productAnalyticsMiddleware()); }
