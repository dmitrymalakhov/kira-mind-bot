import { Bot } from "grammy";
import * as fs from 'fs';
import * as path from 'path';
import fetch from 'node-fetch';
import { BotContext } from "../types";
import { processImage, processImageGroup } from "../orchestrator";
import { healthPhotoAgent, shouldRouteHealthPhoto } from "../agents/healthAgent";
import { devLog } from "../utils";
import { addToHistory } from "../utils/history";
import { getBotRef } from "../reminder";
import {
    TEMP_DIR,
    resolveReplyTo,
    saveRemindersFromResult,
    sendResultToUser,
    checkLastFactSaveError,
} from "./shared";
import { getBotGenderedText } from "../persona";

// ── Добавление результатов обработки изображений в историю ─

async function addImageResultsToHistory(ctx: BotContext, result: any): Promise<void> {
    if (result.detectedText) {
        await addToHistory(ctx, 'bot', result.detectedText);
    }
    if (result.description) {
        await addToHistory(ctx, 'bot', result.description);
    }
    await addToHistory(ctx, 'bot', result.responseText);
}

// ── Обработка медиагруппы ──────────────────────────────────

async function processMediaGroup(ctx: BotContext, mediaGroupId: string) {
    try {
        if (!ctx.session.mediaGroups) {
            console.error("Ошибка: медиагруппы не найдены в сессии");
            return;
        }

        if (!ctx.chat) {
            console.error("Ошибка: чат не найден в контексте");
            return;
        }

        const groupInfo = ctx.session.mediaGroups.get(mediaGroupId);
        if (!groupInfo || groupInfo.fileIds.length === 0) return;

        const fileIds = groupInfo.fileIds;
        const caption = groupInfo.caption || "";

        let imageMessage = `[Группа изображений (${fileIds.length} шт.)]${caption ? ` с подписью: "${caption}"` : ''}`;
        await addToHistory(ctx, 'user', imageMessage);

        await ctx.api.sendChatAction(ctx.chat.id, "typing");

        // Скачиваем все изображения из группы
        const buffers: Buffer[] = [];
        const bot = getBotRef();
        for (const fileId of fileIds) {
            const fileInfo = await ctx.api.getFile(fileId);
            if (fileInfo.file_path) {
                const fileUrl = `https://api.telegram.org/file/bot${bot!.token}/${fileInfo.file_path}`;
                try {
                    const response = await fetch(fileUrl);
                    const arrayBuffer = await response.arrayBuffer();
                    buffers.push(Buffer.from(arrayBuffer));
                } catch (error) {
                    console.error(`Ошибка при загрузке изображения: ${fileId}`, error);
                }
            }
        }

        if (buffers.length === 0) {
            const errorMessage = "Не удалось загрузить изображения из группы. Пожалуйста, попробуйте отправить их по одному.";
            await addToHistory(ctx, 'bot', errorMessage);
            await ctx.reply(errorMessage);
            return;
        }

        const history = ctx.session.messageHistory.slice().reverse();
        const result = shouldRouteHealthPhoto(ctx, caption)
            ? await healthPhotoAgent(ctx, buffers[0], caption, fileIds[0], history, buffers.slice(1), fileIds)
            : await processImageGroup(ctx, buffers, caption, history);

        await saveRemindersFromResult(ctx, result);
        await addImageResultsToHistory(ctx, result);

        // Единая отправка результата
        await sendResultToUser(ctx, result);
    } catch (error) {
        console.error("Ошибка при обработке группы изображений:", error);
        await ctx.reply("Произошла ошибка при обработке группы изображений. Пожалуйста, попробуйте еще раз или отправьте изображения по одному. 🌹");
    }
}

// ── Регистрация обработчика изображений ─────────────────────

export function registerPhotoMessageHandler(bot: Bot<BotContext>): void {
    bot.on("message:photo", async (ctx) => {
        try {
            devLog('🖼️ Получено изображение от пользователя:', ctx.from?.id);
            const caption = ctx.message.caption || "";
            const photoInfo = ctx.message.photo;
            const bestPhoto = photoInfo[photoInfo.length - 1];
            const fileId = bestPhoto.file_id;

            // Проверяем, является ли фото частью медиагруппы
            if (ctx.message.media_group_id) {
                const mediaGroupId = ctx.message.media_group_id;

                if (!ctx.session.mediaGroups) {
                    ctx.session.mediaGroups = new Map();
                }

                if (!ctx.session.mediaGroups.has(mediaGroupId)) {
                    ctx.session.mediaGroups.set(mediaGroupId, {
                        fileIds: [fileId],
                        caption: caption,
                        timestamp: Date.now(),
                        processed: false
                    });
                } else {
                    const groupInfo = ctx.session.mediaGroups.get(mediaGroupId);
                    if (!groupInfo) {
                        console.error("Ошибка: медиагруппа не найдена в сессии");
                        return;
                    }

                    groupInfo.fileIds.push(fileId);
                    if (!groupInfo.caption && caption) {
                        groupInfo.caption = caption;
                    }
                    ctx.session.mediaGroups.set(mediaGroupId, groupInfo);
                }

                setTimeout(async () => {
                    if (!ctx.session.mediaGroups) {
                        console.error("Ошибка: медиагруппы не найдены в сессии");
                        return;
                    }

                    const groupInfo = ctx.session.mediaGroups.get(mediaGroupId);
                    if (groupInfo && !groupInfo.processed) {
                        groupInfo.processed = true;
                        ctx.session.mediaGroups.set(mediaGroupId, groupInfo);
                        await processMediaGroup(ctx, mediaGroupId);
                    }
                }, 1000);

                return;
            }

            // Одиночное фото — определяем контекст ответа (reply_to)
            const { isReply, replyToContent, replyToSender } = resolveReplyTo(ctx);

            let imageMessage = `[Изображение]${caption ? ` с подписью: "${caption}"` : ''}`;
            if (isReply && replyToContent) {
                imageMessage = `[В ответ на "${replyToContent}" от ${replyToSender}]: ${imageMessage}`;
            }
            await addToHistory(ctx, 'user', imageMessage);

            await ctx.api.sendChatAction(ctx.chat.id, "typing");

            const fileInfo = await ctx.api.getFile(fileId);

            if (fileInfo.file_path) {
                const fileUrl = `https://api.telegram.org/file/bot${bot.token}/${fileInfo.file_path}`;

                try {
                    const response = await fetch(fileUrl);
                    const arrayBuffer = await response.arrayBuffer();
                    const buffer = Buffer.from(arrayBuffer);

                    const tempFilePath = path.join(TEMP_DIR, `${fileId}.jpg`);
                    fs.writeFileSync(tempFilePath, buffer);

                    const history = ctx.session.messageHistory.slice().reverse();
                    const result = shouldRouteHealthPhoto(ctx, caption)
                        ? await healthPhotoAgent(ctx, buffer, caption, fileId, history, [], [fileId])
                        : await processImage(ctx, buffer, caption, history);

                    await saveRemindersFromResult(ctx, result);
                    await addImageResultsToHistory(ctx, result);

                    // Единая отправка результата вместо дублированного if/else
                    await sendResultToUser(ctx, result);

                    await checkLastFactSaveError(ctx);

                    fs.unlinkSync(tempFilePath);
                } catch (downloadError) {
                    console.error("Ошибка при загрузке изображения:", downloadError);
                    await ctx.reply(getBotGenderedText(
                        "Я получила ваше изображение, но, к сожалению, не смогла его детально проанализировать из-за технической проблемы.",
                        "Я получил ваше изображение, но, к сожалению, не смог его детально проанализировать из-за технической проблемы.",
                    ) + " Могу я чем-то еще помочь вам? 💫");
                }
            } else {
                await ctx.reply(getBotGenderedText(
                    "Я получила ваше изображение, но не могу получить к нему доступ.",
                    "Я получил ваше изображение, но не могу получить к нему доступ.",
                ) + " Возможно, проблема с API Telegram. Пожалуйста, попробуйте отправить изображение еще раз или опишите, что на нем. 🌷");
            }
        } catch (error) {
            console.error("Ошибка при обработке изображения:", error);
            await ctx.reply("Произошла ошибка при обработке изображения. Я очень хочу помочь вам, пожалуйста, попробуйте отправить его еще раз. 🌹");
        }
    });
}
