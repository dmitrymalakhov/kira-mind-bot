import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Bot, InlineKeyboard } from 'grammy';
import type { BotContext } from '../types';
import type { ConsentCatalog } from '../platform/publicAccounts/contracts';
import { esc, heading, paragraph, list, sendStructured } from '../utils/richMessage';

type Consent = { catalog: ConsentCatalog; aiAllowed: boolean };
interface Dependencies {
    ownerId: number; key: string;
    authority(operation: 'consent-read' | 'consent-write', data: Record<string, unknown>): Promise<Consent>;
    now?: () => number;
}

/** Explicit owner consent, using the same catalog and policy as the native/web clients. No AI calls. */
export function registerAccountConsentHandlers(bot: Bot<BotContext>, deps: Dependencies): void {
    const now = deps.now || Date.now;
    const owner = (ctx: BotContext) => ctx.chat?.type === 'private' && ctx.from?.id === deps.ownerId && ctx.chat.id === deps.ownerId;
    const version = (catalog: ConsentCatalog) => createHash('sha256').update(catalog.version).digest('hex').slice(0, 16);
    const signature = (action: string, hash: string, expires: string) => createHmac('sha256', deps.key)
        .update(`kira.telegram-consent.v1:${deps.ownerId}:${action}:${hash}:${expires}`).digest('base64url').slice(0, 16);
    const callback = (action: 'yes' | 'no', catalog: ConsentCatalog) => {
        const hash = version(catalog), expires = Math.floor((now() + 24 * 3600_000) / 1000).toString(36);
        return `account_ai:${action}:${hash}:${expires}:${signature(action, hash, expires)}`;
    };
    const show = async (ctx: BotContext) => {
        if (!owner(ctx)) return;
        try {
            const state = await deps.authority('consent-read', { ownerId: deps.ownerId });
            const recipients = state.catalog.recipients;
            await sendStructured(ctx.api, deps.ownerId, [
                heading('Обработка данных AI-сервисами', 2),
                paragraph(state.aiAllowed ? 'Согласие на текущий список получателей включено.' : 'AI-запросы выключены до вашего согласия.'),
                paragraph('При выполнении запросов данные могут передаваться следующим получателям. Согласие можно отозвать здесь в любое время; оно не включает самостоятельные AI-задачи.'),
                ...recipients.flatMap(recipient => [
                    heading(esc(recipient.name), 3),
                    list([`Данные: ${esc(recipient.data.join(', '))}`, `Цели: ${esc(recipient.purposes.join(', '))}`,
                        `Политика: ${esc(recipient.policyUrl)}`]),
                ]),
                ...(!recipients.length ? [paragraph('Список получателей ещё не настроен оператором. Включить AI сейчас нельзя.')] : []),
            ]);
            // The decision follows the entire catalog, even when it spans multiple Telegram messages.
            const keyboard = new InlineKeyboard().text('Не разрешаю / отозвать', callback('no', state.catalog));
            if (recipients.length) keyboard.row().text('Разрешаю', callback('yes', state.catalog));
            await sendStructured(ctx.api, deps.ownerId, [paragraph('Разрешить обработку данных перечисленными AI-сервисами?')], { replyMarkup: keyboard });
        } catch {
            await sendStructured(ctx.api, deps.ownerId, [paragraph('Не удалось прочитать согласие. Повторите /ai_consent позже.')]);
        }
    };
    bot.command('ai_consent', show);
    bot.command('start', (ctx, next) => ctx.match === 'ai_consent' ? show(ctx) : next());
    bot.callbackQuery(/^account_ai:/, async ctx => {
        if (!owner(ctx)) { await ctx.answerCallbackQuery({ text: 'Только для владельца в личном чате.' }); return; }
        const match = /^account_ai:(yes|no):([a-f0-9]{16}):([0-9a-z]{1,8}):([A-Za-z0-9_-]{16})$/.exec(ctx.callbackQuery.data);
        if (!match || !deps.key || parseInt(match[3], 36) * 1000 <= now()
            || !timingSafeEqual(Buffer.from(match[4]), Buffer.from(signature(match[1], match[2], match[3])))) {
            await ctx.answerCallbackQuery({ text: 'Кнопка устарела. Откройте /ai_consent.' }); return;
        }
        try {
            const state = await deps.authority('consent-read', { ownerId: deps.ownerId });
            if (version(state.catalog) !== match[2]) {
                await ctx.answerCallbackQuery({ text: 'Список получателей изменился. Откройте /ai_consent.' }); return;
            }
            const accepted = match[1] === 'yes';
            await deps.authority('consent-write', { ownerId: deps.ownerId, consent: { version: 1, consentVersion: state.catalog.version,
                accepted, recipientIds: accepted ? state.catalog.recipients.map(r => r.id) : [] } });
            await ctx.answerCallbackQuery({ text: accepted ? 'Согласие сохранено.' : 'Согласие отозвано.' });
            await sendStructured(ctx.api, deps.ownerId, [paragraph(accepted
                ? 'Согласие сохранено. Можно общаться с Кирой. Изменить выбор: /ai_consent.'
                : 'Согласие отозвано. Новые AI-запросы остановлены. Настройки и обычные напоминания остаются доступны.')]);
        } catch {
            await ctx.answerCallbackQuery({ text: 'Не удалось подтвердить сохранение. Проверьте /ai_consent.' });
        }
    });
}
