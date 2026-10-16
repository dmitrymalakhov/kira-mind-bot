import { Bot, InlineKeyboard } from 'grammy';
import { config } from '../config';
import type { BotContext } from '../types';
import { getBudgetMode, setBudgetMode } from '../services/budgetModeService';
import { BUDGET_MODE_COPY, BUDGET_MODES, parseBudgetMode, type BudgetMode } from '../utils/budgetMode';
import { editStructuredCtx, esc, heading, paragraph, sendStructured, type RichBlock } from '../utils/richMessage';

export function buildBudgetMenu(mode: BudgetMode) {
    const blocks: RichBlock[] = [
        heading('Бюджет AI', 2),
        paragraph(`Текущий режим: <b>${esc(BUDGET_MODES[mode].title)}</b>`),
        paragraph(esc(BUDGET_MODE_COPY.pausedSummary)),
        paragraph(esc(BUDGET_MODE_COPY.activeSummary)),
        paragraph(esc(BUDGET_MODE_COPY.notice)),
    ];
    const nextMode = mode === 'maximum' ? 'normal' : 'maximum';
    const keyboard = new InlineKeyboard().text(
        mode === 'maximum' ? 'Вернуть обычный режим' : 'Включить максимальную экономию',
        `budget:${nextMode}`,
    );
    return { blocks, keyboard };
}

export function registerBudgetCommands(bot: Bot<BotContext>): void {
    bot.command(['budget', 'settings'], async (ctx) => {
        if (ctx.from?.id !== config.allowedUserId) {
            await ctx.reply('Настройка бюджета доступна только владельцу.');
            return;
        }
        const arg = ctx.match.trim().toLowerCase();
        const requested = arg === 'on' ? 'maximum' : arg === 'off' ? 'normal' : parseBudgetMode(arg);
        if (arg && !requested && arg !== 'status') {
            await ctx.reply('Используй /budget, /budget on или /budget off.');
            return;
        }
        if (requested) await setBudgetMode(requested);
        const { blocks, keyboard } = buildBudgetMenu(await getBudgetMode(true));
        await sendStructured(ctx.api as any, ctx.chat.id, blocks, { replyMarkup: keyboard });
    });

    bot.callbackQuery(/^budget:(normal|maximum)$/, async (ctx) => {
        if (ctx.from.id !== config.allowedUserId) {
            await ctx.answerCallbackQuery({ text: 'Настройка доступна только владельцу.', show_alert: true });
            return;
        }
        const mode = parseBudgetMode(ctx.match[1])!;
        try {
            await setBudgetMode(mode);
        } catch {
            await ctx.answerCallbackQuery({ text: 'Не удалось сохранить режим. Попробуй ещё раз.', show_alert: true });
            return;
        }
        await ctx.answerCallbackQuery({ text: 'Режим бюджета сохранён' });
        const { blocks, keyboard } = buildBudgetMenu(mode);
        await editStructuredCtx(ctx, blocks, { replyMarkup: keyboard });
    });
}
