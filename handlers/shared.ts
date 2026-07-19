import { InlineKeyboard, InputFile } from "grammy";
import { BotContext, ConversationReplyContext, SentMessageContext } from "../types";
import * as fs from 'fs';
import * as path from 'path';
import {
    Reminder,
    ReminderStatus,
    scheduleReminder,
    resolveTargetChat,
    getBotRef,
} from "../reminder";
import { type ProcessingResult } from "../orchestrator";
import { devLog, sendMessage } from "../utils";
import { addToHistory } from "../utils/history";
import { config } from "../config";
import { ReminderRegistry } from "../stores/ReminderRegistry";
import { ReminderRepository } from "../services/ReminderRepository";
import { MAX_SENT_MESSAGE_CONTEXTS, persistSessionNow } from "../services/SessionStorage";
import { getTelegramVoiceReadinessIssue, withTelegramVoiceFile } from "../services/elevenLabsTts";
import { addTargetNotificationButtons, appendTargetNotificationPrompt, buildDefaultTargetReminderMessage } from "../utils/reminderTargetNotification";
import { createOrRefreshReminderMemory } from "../services/ReminderMemorySync";

// ── Константы ──────────────────────────────────────────────

export const TEMP_DIR = path.join(__dirname, 'temp');
if (!fs.existsSync(TEMP_DIR)) {
    console.log('📂 Создание временной директории:', TEMP_DIR);
    fs.mkdirSync(TEMP_DIR, { recursive: true });
    console.log('✅ Временная директория создана');
} else {
    console.log('📂 Временная директория уже существует:', TEMP_DIR);
}

export const ALLOWED_REACTIONS = config.allowedReactions;
export const REACTIONS_ENABLED = config.reactionsEnabled;

export const MEMORY_HEARS_RE = /^(?:что\s+(?:ты\s+)?(?:знаешь|помнишь|помнила)\s+обо?\s+мне|расскажи\s+что\s+(?:ты\s+)?(?:знаешь|помнишь)(?:\s+обо?\s+мне)?|покажи\s+(?:мою\s+)?память|что\s+ты\s+обо\s+мне(?:\s+знаешь)?|что\s+помнишь\s+обо?\s+мне)\??$/i;
export const MEMORY_DELETE_RE = /^(?:забудь[,\s]|удали из памяти|убери из памяти)/i;

// ── Хранение отправленных сообщений ─────────────────────────

export function storeSentMessageText(ctx: BotContext, messageId: number, text: string): void {
    if (!ctx.session.sentMessages) ctx.session.sentMessages = {};
    ctx.session.sentMessages[messageId] = text;

    const storedIds = Object.keys(ctx.session.sentMessages)
        .map(Number)
        .filter(Number.isFinite)
        .sort((a, b) => b - a);

    for (const staleMessageId of storedIds.slice(MAX_SENT_MESSAGE_CONTEXTS)) {
        delete ctx.session.sentMessages[staleMessageId];
    }
}

export function storeSentMessageContext(
    ctx: BotContext,
    messageId: number,
    text: string,
    metadata: Partial<Omit<SentMessageContext, 'messageId' | 'text' | 'createdAt'>> = {},
): void {
    if (!ctx.session.sentMessageContexts) ctx.session.sentMessageContexts = {};
    const existing = ctx.session.sentMessageContexts[messageId];
    ctx.session.sentMessageContexts[messageId] = {
        messageId,
        text,
        kind: metadata.kind ?? existing?.kind ?? 'plain',
        delivery: metadata.delivery ?? existing?.delivery ?? 'text',
        contactId: metadata.contactId ?? existing?.contactId,
        contactName: metadata.contactName ?? existing?.contactName,
        personId: metadata.personId ?? existing?.personId,
        memoryIds: metadata.memoryIds ?? existing?.memoryIds,
        createdAt: existing?.createdAt ?? Date.now(),
    };
    const storedIds = Object.keys(ctx.session.sentMessageContexts)
        .map(Number)
        .filter(Number.isFinite)
        .sort((a, b) => b - a);
    for (const staleMessageId of storedIds.slice(MAX_SENT_MESSAGE_CONTEXTS)) {
        delete ctx.session.sentMessageContexts[staleMessageId];
    }
}

export async function replyAndStore(ctx: BotContext, text: string, options: any = {}) {
    const msg = await sendMessage(ctx, text, options);
    storeSentMessageText(ctx, msg.message_id, text);
    storeSentMessageContext(ctx, msg.message_id, text);
    return msg;
}

// ── Реакции ─────────────────────────────────────────────────

export function maybeReactToUser(ctx: BotContext, emoji?: string) {
    if (!REACTIONS_ENABLED) return;
    if (emoji && emoji !== "NONE") {
        if (ctx.chat?.type === "private" && ALLOWED_REACTIONS.includes(emoji)) {
            ctx.react(emoji as any).catch(e => {
                if (process.env.NODE_ENV === "development") {
                    console.error("Failed to react to message:", e.message);
                }
            });
        } else if (process.env.NODE_ENV === "development") {
            console.warn(`Reaction "${emoji}" not allowed or chat type not supported`);
        }
    }
}

// ── Вспомогательные проверки ───────────────────────────────

export function canSendResultAsVoice(result: ProcessingResult): boolean {
    return Boolean(result.responseText?.trim()) &&
        !result.keyboard &&
        !result.reminderCreated &&
        !result.icsFilePath &&
        !result.documentFilePath &&
        !result.imageGenerated &&
        !result.generatedImageUrl;
}

export function shouldRunProactiveHint(result: ProcessingResult, processedMessage: string): boolean {
    if (!result.responseText?.trim()) return false;
    if (result.reminderCreated) return false;
    if (result.messageDraft) return false;
    if (result.imageGenerated || result.generatedImageUrl) return false;
    if (result.icsFilePath || result.documentFilePath) return false;
    if (result.negotiationSummarySent) return false;
    if (/^Продолжи задачу в браузере через Playwright\.|browserSessionId:/i.test(processedMessage)) return false;
    return true;
}

// ── Голосовые ответы ─────────────────────────────────────────

async function replyWithGeneratedVoiceAndStore(ctx: BotContext, text: string) {
    await ctx.api.sendChatAction(ctx.chat!.id, "record_voice");
    return withTelegramVoiceFile(text, async (voice) => {
        const inputFile = new InputFile(voice.filePath, voice.filename);
        const msg = await ctx.replyWithVoice(inputFile);
        storeSentMessageText(ctx, msg.message_id, text);
        storeSentMessageContext(ctx, msg.message_id, text, { delivery: 'voice' });
        return msg;
    });
}

export async function replyProcessingResult(ctx: BotContext, result: ProcessingResult, voiceRequested: boolean) {
    if (voiceRequested && canSendResultAsVoice(result)) {
        const voiceReadinessIssue = await getTelegramVoiceReadinessIssue(result.responseText);
        if (voiceReadinessIssue) {
            return replyAndStore(
                ctx,
                `${result.responseText}\n\n${voiceReadinessIssue}`
            );
        }

        try {
            return await replyWithGeneratedVoiceAndStore(ctx, result.responseText);
        } catch (voiceError) {
            console.error("[voice-reply] failed to generate or send voice:", voiceError);
            const sent = await replyAndStore(ctx, result.responseText);
            await ctx.reply("Не смогла отправить голосом, поэтому оставила текстом.");
            return sent;
        }
    }

    if (result.keyboard) {
        return replyAndStore(ctx, result.responseText, {
            reply_markup: result.keyboard
        });
    }

    return replyAndStore(ctx, result.responseText);
}

// ── Сессия ──────────────────────────────────────────────────

export async function flushSessionAfterAsyncWork(ctx: BotContext, label: string) {
    await persistSessionNow(ctx).catch((e) => {
        console.error(`[SessionStorage] async flush failed (${label}):`, e);
    });
}

// ── Напоминания ─────────────────────────────────────────────

export async function saveRemindersFromResult(ctx: BotContext, result: ProcessingResult) {
    if (!result.reminderCreated) return;
    if (!Array.isArray(ctx.session.reminders)) ctx.session.reminders = [];
    const list = result.reminderDetailsList ?? (result.reminderDetails ? [result.reminderDetails] : []);
    const targetNotificationCandidates: Reminder[] = [];
    // Название группового чата — для пикера в приватном
    const chatType = ctx.chat?.type;
    const chatTitle = chatType === 'group' || chatType === 'supergroup'
        ? `👥 ${(ctx.chat as any).title ?? 'Группа'}`
        : undefined;
    for (const details of list) {
        const reminder: Reminder = {
            id: details.id,
            text: details.text,
            displayText: details.reminderMessage,
            dueDate: details.dueDate,
            chatId: ctx.chat!.id,
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
        console.info(`[reminder] event=created id=${reminder.id} chatId=${reminder.chatId} due=${new Date(reminder.dueDate).toISOString()}` + (chatTitle ? ` chat="${chatTitle}"` : '') + (details.targetChat ? ` target=${details.targetChat.type}` : ""));
        await ReminderRepository.save(reminder).catch(e => console.error('[reminder] DB save failed on create:', e));

        const bot = getBotRef();
        if (bot) {
            scheduleReminder(bot, reminder);
        }
        await createOrRefreshReminderMemory(ctx, reminder).catch((e) => console.error('[reminder] memory sync failed on create:', e));

        // Валидация targetChat — предупреждаем сразу если группа/контакт не найдены
        if (details.targetChat) {
            resolveTargetChat(details.targetChat).then((resolved) => {
                if (!resolved) {
                    const what = details.targetChat!.type === 'group'
                        ? `группу «${(details.targetChat as any).groupName}»`
                        : `контакт «${(details.targetChat as any).contactQuery}»`;
                    ctx.reply(
                        `⚠️ Не нашла ${what}. Напоминание сохранено, но проверь правильность названия — иначе оно не дойдёт до адресата.`
                    ).catch(() => {});
                }
            }).catch(() => {});
        }
    }

    if (targetNotificationCandidates.length > 0) {
        result.responseText = appendTargetNotificationPrompt(result.responseText, targetNotificationCandidates);
        const keyboard = result.keyboard ?? new InlineKeyboard();
        if (result.keyboard) keyboard.row();
        result.keyboard = addTargetNotificationButtons(keyboard, targetNotificationCandidates);
    }
}

// ── Отправка документов ─────────────────────────────────────

export async function sendDocumentFromResult(ctx: BotContext, result: ProcessingResult): Promise<void> {
    if (!result.documentFilePath) return;

    try {
        await ctx.api.sendChatAction(ctx.chat!.id, "upload_document");
        const fileStream = fs.createReadStream(result.documentFilePath);
        const filename = result.documentFilename || path.basename(result.documentFilePath);
        const inputFile = new InputFile(fileStream, filename);
        await ctx.replyWithDocument(inputFile, result.documentCaption ? {
            caption: result.documentCaption,
        } : undefined);
        fs.unlinkSync(result.documentFilePath);
    } catch (fileError) {
        console.error("Ошибка при отправке документа:", fileError);
        await ctx.reply("Не удалось отправить документ. Попробуй запросить экспорт ещё раз.");
    }
}

// ── Определение контекста ответа (reply_to) ─────────────────

export function resolveReplyTo(ctx: BotContext): {
    isReply: boolean;
    replyToContent: string | undefined;
    replyToSender: string | undefined;
    replyContext: ConversationReplyContext | undefined;
} {
    let isReply = false;
    let replyToContent: string | undefined = undefined;
    let replyToSender: string | undefined = undefined;
    let replyContext: ConversationReplyContext | undefined = undefined;

    const replyTo = ctx.message?.reply_to_message;
    if (replyTo) {
        isReply = true;
        const storedContext = ctx.session.sentMessageContexts?.[replyTo.message_id];
        const storedText = storedContext?.text ?? ctx.session.sentMessages?.[replyTo.message_id];
        if (storedText) {
            replyToContent = storedText;
        } else if (replyTo.text) {
            replyToContent = replyTo.text;
        } else if (replyTo.caption) {
            replyToContent = `[Медиа с подписью: "${replyTo.caption}"]`;
        } else if (replyTo.photo) {
            replyToContent = '[Изображение]';
        } else if (replyTo.voice) {
            const knownVoiceText = storedText;
            replyToContent = knownVoiceText ? `[Голосовое сообщение: "${knownVoiceText}"]` : '[Голосовое сообщение]';
        } else if (replyTo.document) {
            replyToContent = `[Документ: ${replyTo.document.file_name || 'документ'}]`;
        } else {
            replyToContent = '[Сообщение]';
        }

        if (replyTo.from) {
            replyToSender = replyTo.from.username ||
                replyTo.from.first_name ||
                'Пользователь';
        } else {
            replyToSender = 'Неизвестный пользователь';
        }

        replyContext = {
            messageId: replyTo.message_id,
            text: replyToContent,
            sender: replyToSender,
            kind: storedContext?.kind ?? (replyTo.text ? 'plain' : 'unknown'),
            delivery: storedContext?.delivery,
            contactId: storedContext?.contactId,
            contactName: storedContext?.contactName,
            personId: storedContext?.personId,
            memoryIds: storedContext?.memoryIds,
        };
    }

    return { isReply, replyToContent, replyToSender, replyContext };
}

// ── Единая отправка результата обработки ───────────────────

/**
 * Отправляет результат обработки пользователю: ICS-файл, документ,
 * сгенерированное изображение или текстовый ответ.
 *
 * @param voiceRequested — если true, пытается отправить ответ голосовым при возможности
 */
export async function sendResultToUser(
    ctx: BotContext,
    result: ProcessingResult,
    voiceRequested = false,
): Promise<{ message_id: number }> {
    // ICS-файл (календарное событие)
    if (result.reminderCreated && result.icsFilePath) {
        const sent = await replyAndStore(ctx, result.responseText, result.keyboard ? {
            reply_markup: result.keyboard
        } : {});

        try {
            await ctx.api.sendChatAction(ctx.chat!.id, "upload_document");
            const fileStream = fs.createReadStream(result.icsFilePath);
            const filename = path.basename(result.icsFilePath);
            const inputFile = new InputFile(fileStream, filename);
            await ctx.replyWithDocument(inputFile, {
                caption: "Открой этот файл, чтобы добавить событие в свой календарь."
            });
            devLog(`ICS файл ${result.icsFilePath} отправлен пользователю`);
            fs.unlinkSync(result.icsFilePath);
        } catch (fileError) {
            console.error("Ошибка при отправке ICS файла:", fileError);
            await ctx.reply("К сожалению, не удалось отправить файл календаря. Но я всё равно напомню тебе о событии в назначенное время.");
        }
        return sent;
    }

    // Документ
    if (result.documentFilePath) {
        const sent = await replyAndStore(ctx, result.responseText, result.keyboard ? {
            reply_markup: result.keyboard
        } : {});
        await sendDocumentFromResult(ctx, result);
        return sent;
    }

    // Сгенерированное изображение
    if (result.imageGenerated && result.generatedImageUrl) {
        const sent = await replyAndStore(ctx, result.responseText, result.keyboard ? {
            reply_markup: result.keyboard
        } : {});

        try {
            await ctx.api.sendChatAction(ctx.chat!.id, "upload_photo");
            await ctx.replyWithPhoto(result.generatedImageUrl);
            await addToHistory(ctx, 'bot', `[Сгенерированное изображение: ${result.generatedImageUrl}]`);
        } catch (imageError) {
            console.error("Ошибка при отправке сгенерированного изображения:", imageError);
            await ctx.reply("К сожалению, не удалось отправить сгенерированное изображение. Возможно, проблема с URL или сервисом генерации изображений.");
        }
        return sent;
    }

    // Обычный текстовый ответ (с возможной голосовой отправкой)
    return replyProcessingResult(ctx, result, voiceRequested);
}

// ── Проверка ошибок сохранения фактов ──────────────────────

export async function checkLastFactSaveError(ctx: BotContext): Promise<void> {
    if (ctx.session.lastFactSaveError) {
        await ctx.reply(`⚠️ ${ctx.session.lastFactSaveError}`);
        delete ctx.session.lastFactSaveError;
    }
}
