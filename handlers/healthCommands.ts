import { Bot } from 'grammy';
import { InputFile } from 'grammy/types';
import * as fs from 'fs';
import * as path from 'path';
import type { BotContext } from '../types';
import type { ProcessingResult } from '../orchestrator';
import {
    buildHealthMenuResult,
    createHealthExportResult,
    handleHealthCallback,
} from '../agents/healthAgent';
import { addToHistory } from '../utils/history';

export function registerHealthCommands(bot: Bot<BotContext>): void {
    bot.command('health', async (ctx) => {
        const result = buildHealthMenuResult();
        await sendHealthProcessingResult(ctx, result);
    });

    bot.command('health_export', async (ctx) => {
        const match = ctx.message?.text?.match(/(\d{1,3})/);
        const days = match ? Number(match[1]) : 7;
        const result = await createHealthExportResult(ctx, days);
        await sendHealthProcessingResult(ctx, result);
    });

    bot.on('callback_query:data', async (ctx, next) => {
        const data = ctx.callbackQuery.data;
        if (!data.startsWith('health:')) {
            await next();
            return;
        }

        await ctx.answerCallbackQuery().catch(() => {});
        const result = await handleHealthCallback(ctx, data);
        if (result) await sendHealthProcessingResult(ctx, result);
    });
}

async function sendHealthProcessingResult(ctx: BotContext, result: ProcessingResult): Promise<void> {
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
