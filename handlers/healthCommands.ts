import { Bot, InlineKeyboard } from 'grammy';
import { InputFile } from 'grammy/types';
import * as fs from 'fs';
import * as path from 'path';
import type { BotContext } from '../types';
import type { ProcessingResult } from '../orchestrator';
import { Reminder, ReminderStatus, scheduleReminder } from '../reminder';
import { ReminderRepository } from '../services/ReminderRepository';
import { ReminderRegistry } from '../stores/ReminderRegistry';
import {
    buildHealthMenuResult,
    createHealthExportResult,
    handleHealthCallback,
} from '../agents/healthAgent';
import { addToHistory } from '../utils/history';
import { addTargetNotificationButtons, appendTargetNotificationPrompt, buildDefaultTargetReminderMessage } from '../utils/reminderTargetNotification';
import { createOrRefreshReminderMemory } from '../services/ReminderMemorySync';

export function registerHealthCommands(bot: Bot<BotContext>): void {
    bot.command('health', async (ctx) => {
        const result = buildHealthMenuResult();
        await sendHealthProcessingResult(ctx, bot, result);
    });

    bot.command('health_export', async (ctx) => {
        const match = ctx.message?.text?.match(/(\d{1,3})/);
        const days = match ? Number(match[1]) : 7;
        const result = await createHealthExportResult(ctx, days);
        await sendHealthProcessingResult(ctx, bot, result);
    });

    bot.on('callback_query:data', async (ctx, next) => {
        const data = ctx.callbackQuery.data;
        if (!data.startsWith('health:')) {
            await next();
            return;
        }

        await ctx.answerCallbackQuery().catch(() => {});
        const result = await handleHealthCallback(ctx, data);
        if (result) await sendHealthProcessingResult(ctx, bot, result);
    });
}

async function sendHealthProcessingResult(ctx: BotContext, bot: Bot<BotContext>, result: ProcessingResult): Promise<void> {
    await saveHealthRemindersFromResult(ctx, bot, result);
    await addToHistory(ctx, 'bot', result.responseText);
    const replyOptions = result.keyboard ? { reply_markup: result.keyboard } : undefined;
    await ctx.reply(result.responseText, replyOptions);

    if (!result.documentFilePath) return;

    try {
        await ctx.api.sendChatAction(ctx.chat!.id, 'upload_document');
        const filename = result.documentFilename || path.basename(result.documentFilePath);
        const inputFile = new InputFile(fs.createReadStream(result.documentFilePath), filename);
        await ctx.replyWithDocument(inputFile, result.documentCaption ? { caption: result.documentCaption } : undefined);
        fs.unlinkSync(result.documentFilePath);
    } catch (error) {
        console.error('[health] failed to send export document:', error);
        await ctx.reply('Не удалось отправить файл экспорта. Записи сохранены, попробуй выгрузить ещё раз.');
    }
}

async function saveHealthRemindersFromResult(
    ctx: BotContext,
    bot: Bot<BotContext>,
    result: ProcessingResult
): Promise<void> {
    if (!result.reminderCreated || !ctx.chat) return;
    if (!Array.isArray(ctx.session.reminders)) ctx.session.reminders = [];

    const list = result.reminderDetailsList ?? (result.reminderDetails ? [result.reminderDetails] : []);
    const targetNotificationCandidates: Reminder[] = [];
    const chatType = ctx.chat.type;
    const chatTitle = chatType === 'group' || chatType === 'supergroup'
        ? `👥 ${(ctx.chat as any).title ?? 'Группа'}`
        : undefined;

    for (const details of list) {
        const reminder: Reminder = {
            id: details.id,
            text: details.text,
            displayText: details.reminderMessage,
            dueDate: details.dueDate,
            chatId: ctx.chat.id,
            status: ReminderStatus.Pending,
            createdAt: new Date(),
            targetChat: details.targetChat,
            targetDisplayText: details.targetReminderMessage || (details.targetChat ? buildDefaultTargetReminderMessage(details.text) : undefined),
            targetChatNotifyStatus: details.targetChat ? "pending" : undefined,
            chatTitle,
            recurrence: details.recurrence,
        };
        if (reminder.targetChat) {
            targetNotificationCandidates.push(reminder);
        }
        ctx.session.reminders.push(reminder);
        ReminderRegistry.getInstance().add(reminder);
        await ReminderRepository.save(reminder).catch((error) => console.error('[health] reminder DB save failed:', error));
        scheduleReminder(bot, reminder);
        await createOrRefreshReminderMemory(ctx, reminder).catch((error) => console.error('[health] reminder memory sync failed:', error));
    }

    if (targetNotificationCandidates.length > 0) {
        result.responseText = appendTargetNotificationPrompt(result.responseText, targetNotificationCandidates);
        const keyboard = result.keyboard ?? new InlineKeyboard();
        if (result.keyboard) keyboard.row();
        result.keyboard = addTargetNotificationButtons(keyboard, targetNotificationCandidates);
    }
}
