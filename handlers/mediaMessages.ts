import { Bot } from "grammy";
import { BotContext } from "../types";
import { processMessage } from "../orchestrator";
import { addToHistory } from "../utils/history";
import { saveRemindersFromResult } from "./shared";
import { getBotGenderedText } from "../persona";
import { getForwardedMessageInfo } from "../utils/forwardedMessage";

// ── Обобщённый обработчик для документов и аудиофайлов ──────

async function handleCaptionedMedia(
    ctx: BotContext,
    historyLabel: string,
    responsePrefix: string,
    fallbackResponse: string,
): Promise<void> {
    const caption = ctx.message?.caption || "";

    const forwarded = getForwardedMessageInfo(ctx.message);
    if (forwarded.isForwarded) {
        await addToHistory(ctx, 'user', `[Пересланное сообщение от ${forwarded.source}]`, {
            turn: {
                userText: 'Пересланное сообщение',
                isForwardOnly: true,
                forwardContext: { sender: forwarded.source, text: caption || `[${historyLabel}]` },
            },
        });
        return;
    }

    await addToHistory(ctx, 'user', `[${historyLabel}]${caption ? ` с подписью: "${caption}"` : ''}`);
    await ctx.api.sendChatAction(ctx.chat!.id, "typing");

    let responseText = "";
    if (caption) {
        const result = await processMessage(
            ctx,
            caption,
            false,
            "",
            ctx.session.messageHistory.slice().reverse()
        );

        await saveRemindersFromResult(ctx, result);

        if (result.imageGenerated && result.generatedImageUrl) {
            responseText = `${responsePrefix}. ${result.responseText}`;
            await ctx.reply(responseText);

            try {
                await ctx.api.sendChatAction(ctx.chat!.id, "upload_photo");
                await ctx.replyWithPhoto(result.generatedImageUrl);
                await addToHistory(ctx, 'bot', `[Сгенерированное изображение: ${result.generatedImageUrl}]`);
            } catch (imageError) {
                console.error("Ошибка при отправке сгенерированного изображения:", imageError);
                await ctx.reply("К сожалению, не удалось отправить сгенерированное изображение. Возможно, проблема с URL или сервисом генерации изображений.");
            }
        } else {
            responseText = `${responsePrefix}. ${result.responseText}`;
            await ctx.reply(responseText);
        }
    } else {
        responseText = fallbackResponse;
        await ctx.reply(responseText);
    }

    await addToHistory(ctx, 'bot', responseText);
}

// ── Регистрация обработчиков ───────────────────────────────

export function registerMediaMessageHandler(bot: Bot<BotContext>): void {
    bot.on("message:document", async (ctx) => {
        try {
            const fileName = ctx.message.document.file_name || "документ";
            await handleCaptionedMedia(
                ctx,
                `Документ: ${fileName}`,
                getBotGenderedText(`Я получила твой документ "${fileName}"`, `Я получил твой документ "${fileName}"`),
                getBotGenderedText(`Я получила твой документ "${fileName}".`, `Я получил твой документ "${fileName}".`) +
                    " К сожалению, я пока не могу полностью анализировать содержимое документов, но могу помочь тебе с составлением ответа или напоминанием, связанным с этим документом.\n\nЧем я могу помочь тебе с этим документом? 📄"
            );
        } catch (error) {
            console.error("Ошибка при обработке документа:", error);
            await ctx.reply("Произошла ошибка при обработке документа. Пожалуйста, попробуй еще раз или отправь документ в другом формате. 📑");
        }
    });

    bot.on("message:audio", async (ctx) => {
        try {
            await handleCaptionedMedia(
                ctx,
                "аудиофайл",
                getBotGenderedText("Я получила твой аудиофайл", "Я получил твой аудиофайл"),
                getBotGenderedText("Я получила твой аудиофайл.", "Я получил твой аудиофайл.") +
                    " К сожалению, я пока не могу анализировать аудио, но могу помочь тебе с напоминанием или другими задачами, связанными с этим сообщением.\n\nЧем я могу тебе помочь? 🎵"
            );
        } catch (error) {
            console.error("Ошибка при обработке аудио:", error);
            await ctx.reply("Произошла ошибка при обработке аудио. Пожалуйста, попробуй еще раз или отправь текстовое сообщение. 🎧");
        }
    });
}
