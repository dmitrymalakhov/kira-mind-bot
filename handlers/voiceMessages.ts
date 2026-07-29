import { Bot } from "grammy";
import * as fs from 'fs';
import * as path from 'path';
import { BotContext } from "../types";
import { processMessage } from "../orchestrator";
import { downloadVoiceMessage, transcribeAudio } from "../services/speechRecognition";
import { devLog } from "../utils";
import { addToHistory } from "../utils/history";
import { stripVoiceReplyDirective, wantsVoiceReply } from "../utils/voiceReply";
import {
    TEMP_DIR,
    resolveReplyTo,
    saveRemindersFromResult,
    sendResultToUser,
    checkLastFactSaveError,
} from "./shared";
import { handleRecurringTaskText } from "../services/recurringTaskService";
import { getBotGenderedText } from "../persona";

// ── Регистрация обработчика голосовых сообщений ─────────────

export function registerVoiceMessageHandler(bot: Bot<BotContext>): void {
    bot.on("message:voice", async (ctx) => {
        try {
            devLog('🎤 Получено голосовое сообщение от пользователя:', ctx.from?.id);
            await ctx.api.sendChatAction(ctx.chat.id, "typing");

            const { isReply, replyToContent, replyToSender } = resolveReplyTo(ctx);

            let voiceMessage = '[Голосовое сообщение]';
            if (isReply && replyToContent) {
                voiceMessage = `[В ответ на "${replyToContent}" от ${replyToSender}]: ${voiceMessage}`;
            }
            const recurringContextHistory = ctx.session.messageHistory
                .slice(0, 8)
                .reverse()
                .map(({ role, content }) => ({ role, content: content.slice(0, 2_000) }));
            await addToHistory(ctx, 'user', voiceMessage);

            const voice = ctx.message.voice;
            const fileId = voice.file_id;

            const processingMsg = await ctx.reply("Слушаю твое сообщение, секунду... 🎧");

            const fileInfo = await ctx.api.getFile(fileId);

            if (fileInfo.file_path) {
                const fileUrl = `https://api.telegram.org/file/bot${bot.token}/${fileInfo.file_path}`;
                const tempFilePath = path.join(TEMP_DIR, `${fileId}.ogg`);

                try {
                    await downloadVoiceMessage(fileUrl, tempFilePath);

                    const transcribedText = await transcribeAudio(tempFilePath);

                    if (transcribedText && transcribedText.trim() !== '') {
                        // Обновляем запись в истории с распознанным текстом
                        let transcribedMessage = `[Голосовое сообщение]: ${transcribedText}`;
                        const lastUserMsgIndex = ctx.session.messageHistory.findIndex(msg => msg.role === 'user');
                        if (lastUserMsgIndex !== -1) {
                            if (isReply && replyToContent) {
                                // Для reply сохраняем контекст ответа, заменяя только плейсхолдер
                                ctx.session.messageHistory[lastUserMsgIndex].content =
                                    ctx.session.messageHistory[lastUserMsgIndex].content.replace(
                                        '[Голосовое сообщение]',
                                        `[Голосовое сообщение]: ${transcribedText}`
                                    );
                            } else {
                                ctx.session.messageHistory[lastUserMsgIndex].content = transcribedMessage;
                            }
                        } else {
                            await addToHistory(ctx, 'user', transcribedMessage);
                        }

                        await ctx.api.editMessageText(
                            ctx.chat.id,
                            processingMsg.message_id,
                            getBotGenderedText(
                                `Я распознала твое голосовое сообщение:\n\n"${transcribedText}"\n\nОбрабатываю...`,
                                `Я распознал твое голосовое сообщение:\n\n"${transcribedText}"\n\nОбрабатываю...`,
                            )
                        );

                        try {
                            if (await handleRecurringTaskText(ctx, transcribedText, {
                                messageId: ctx.message.message_id,
                                contextHistory: recurringContextHistory,
                            })) {
                                await ctx.api.editMessageText(
                                    ctx.chat.id,
                                    processingMsg.message_id,
                                    getBotGenderedText(
                                        `Я распознала голосовую команду:\n\n"${transcribedText}"`,
                                        `Я распознал голосовую команду:\n\n"${transcribedText}"`,
                                    ),
                                ).catch(() => {});
                                if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
                                return;
                            }
                            const voiceReplyRequested = wantsVoiceReply(transcribedText);
                            const textForProcessing = voiceReplyRequested
                                ? stripVoiceReplyDirective(transcribedText)
                                : transcribedText;

                            const result = await processMessage(
                                ctx,
                                textForProcessing,
                                false,
                                "",
                                ctx.session.messageHistory.slice().reverse(),
                                undefined,
                                { voiceReplyRequested: voiceReplyRequested }
                            );

                            await saveRemindersFromResult(ctx, result);
                            await addToHistory(ctx, 'bot', result.responseText);

                            // Единая отправка результата вместо дублированного if/else
                            await sendResultToUser(ctx, result, voiceReplyRequested);
                            ctx.session.lastSchedulableRequest = {
                                text: textForProcessing,
                                messageId: ctx.message.message_id,
                                contextHistory: recurringContextHistory,
                                createdAt: Date.now(),
                            };

                            await checkLastFactSaveError(ctx);
                        } catch (processingError) {
                            console.error("Ошибка при обработке распознанного текста:", processingError);
                            await ctx.reply(getBotGenderedText(
                                `Я распознала твое сообщение как: "${transcribedText}",`,
                                `Я распознал твое сообщение как: "${transcribedText}",`,
                            ) + " но возникла ошибка при его обработке. Можешь отправить текстом?");
                        }
                    } else {
                        const noTextResponse = getBotGenderedText(
                            "Я получила твое голосовое сообщение, но не смогла разобрать, что ты говоришь.",
                            "Я получил твое голосовое сообщение, но не смог разобрать, что ты говоришь.",
                        ) + " Можешь повторить погромче или прислать текстовое сообщение? 🙏";
                        await ctx.api.editMessageText(ctx.chat.id, processingMsg.message_id, noTextResponse);
                    }

                    fs.unlinkSync(tempFilePath);
                } catch (processingError) {
                    console.error("Ошибка при обработке голосового сообщения:", processingError);

                    const errorResponse = getBotGenderedText(
                        "Я получила твое голосовое сообщение, но возникла техническая проблема при его обработке.",
                        "Я получил твое голосовое сообщение, но возникла техническая проблема при его обработке.",
                    ) + " Можешь отправить текстом? 🙏";
                    await addToHistory(ctx, 'bot', errorResponse);
                    await ctx.api.editMessageText(ctx.chat.id, processingMsg.message_id, errorResponse);

                    if (fs.existsSync(tempFilePath)) {
                        fs.unlinkSync(tempFilePath);
                    }
                }
            } else {
                const noFilePathResponse = getBotGenderedText(
                    "Я получила твое голосовое сообщение, но не могу получить к нему доступ.",
                    "Я получил твое голосовое сообщение, но не могу получить к нему доступ.",
                ) + " Возможно, проблема с API Telegram. Можешь отправить текстом? 🎤";
                await addToHistory(ctx, 'bot', noFilePathResponse);
                await ctx.api.editMessageText(ctx.chat.id, processingMsg.message_id, noFilePathResponse);
            }
        } catch (error) {
            console.error("Ошибка при обработке голосового сообщения:", error);
            await ctx.reply("Произошла ошибка при обработке твоего голосового сообщения. Пожалуйста, попробуй еще раз или отправь свой вопрос текстом. 🙏");
        }
    });
}
