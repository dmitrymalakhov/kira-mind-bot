import { Bot, InlineKeyboard } from "grammy";
import { Chat, User } from "grammy/types";
import { Reminder, postponeReminderUntil } from "../reminder";
import { BotContext } from "../types";
import { processMessage } from "../orchestrator";
import { getMessageDraft, saveMessageDraft } from "../agents/sendMessagesAgent";
import {
    NegotiationStore,
    buildNegotiationSummaryText,
    buildNegotiationStopKeyboard,
} from "../stores/NegotiationStore";
import { initTelegramClient, sendMessage as sendTelegramMessage } from "../services/telegram";
import { devLog } from "../utils";
import { addToHistory } from "../utils/history";
import { ContactsStore } from "../stores/ContactsStore";
import { ReminderRegistry } from "../stores/ReminderRegistry";
import { maybeProactiveHint } from "../utils/proactiveMemory";
import { maybeAskMemoryGap } from "../utils/memoryGapDetector";
import { maybeDetectImplicitReminder } from "../utils/implicitReminderDetector";
import { reconsolidateAfterResponse } from "../services/MemoryReconsolidationService";
import { looksLikeBrowserTaskCancellation } from "../utils/browserTaskCancellation";
import { applyReminderEditInput, extractReminderPostponeDate } from "../utils/reminderEditor";
import { stripVoiceReplyDirective, wantsVoiceReply } from "../utils/voiceReply";
import { editMessageTextIfChanged } from "../utils/telegramMessageEdit";
import { normalizeNumbersForVoiceMessage } from "../utils/russianSpeechNumbers";
import { syncReminderMemoryMutation } from "../services/ReminderMemorySync";
import {
    MEMORY_HEARS_RE,
    MEMORY_DELETE_RE,
    resolveReplyTo,
    replyAndStore,
    maybeReactToUser,
    saveRemindersFromResult,
    sendResultToUser,
    checkLastFactSaveError,
    shouldRunProactiveHint,
    flushSessionAfterAsyncWork,
} from "./shared";

// ── Консолидация инициализации группы пересланных сообщений ─

function initOrReuseForwardGroup(
    ctx: BotContext,
    forwardSource: string,
    message: string,
    currentTime: number,
    initialUserMessages: string[],
): void {
    if (!ctx.session.forwardGroups) {
        ctx.session.forwardGroups = {};
    }

    const forwardKey = "current_forward_group";

    if (!ctx.session.forwardGroups[forwardKey]) {
        ctx.session.forwardGroups[forwardKey] = {
            messages: [],
            sources: {},
            lastTime: currentTime,
            timerId: null,
            userMessages: initialUserMessages,
        };
    }

    if (!ctx.session.forwardGroups[forwardKey].sources[forwardSource]) {
        ctx.session.forwardGroups[forwardKey].sources[forwardSource] = [];
    }
    ctx.session.forwardGroups[forwardKey].sources[forwardSource].push(message);
    ctx.session.forwardGroups[forwardKey].lastTime = currentTime;

    if (ctx.session.forwardGroups[forwardKey].timerId) {
        clearTimeout(ctx.session.forwardGroups[forwardKey].timerId);
    }

    const timerId = setTimeout(() => {
        processForwardedGroup(ctx, forwardKey);
    }, 2000);

    ctx.session.forwardGroups[forwardKey].timerId = timerId;
}

// ── Обработка группы пересланных сообщений ─────────────────

async function processForwardedGroup(ctx: BotContext, forwardKey: string) {
    if (!ctx.chat || !ctx.session.forwardGroups) {
        return;
    }

    try {
        const group = ctx.session.forwardGroups[forwardKey];
        if (!group) return;

        const sources = group.sources || {};
        const userMessages = group.userMessages || [];

        if (Object.keys(sources).length === 0 && userMessages.length === 0) {
            devLog("Пустая группа сообщений, нечего обрабатывать");
            delete ctx.session.forwardGroups[forwardKey];
            return;
        }

        // Форматируем информацию для истории сообщений в виде единого треда
        let historyEntry = "[Пересланный тред сообщений]:\n";

        for (const source in sources) {
            const messages = sources[source];
            if (messages.length > 0) {
                historyEntry += `${source}: ${messages.join("\n" + source + ": ")}\n`;
            }
        }

        if (userMessages.length > 0) {
            historyEntry += "\n[Комментарий пользователя]:\n";
            historyEntry += userMessages.join("\n");
        }

        // Проверка на наличие первого сообщения пользователя в истории
        const recentUserMessage = ctx.session.messageHistory.find(msg =>
            msg.role === 'user' &&
            !msg.content.startsWith('[Пересланный тред сообщений]') &&
            !msg.content.startsWith('[Пересланные сообщения') &&
            new Date().getTime() - new Date(msg.timestamp).getTime() < 5000
        );

        if (recentUserMessage && !historyEntry.includes(recentUserMessage.content)) {
            ctx.session.messageHistory = ctx.session.messageHistory.filter(
                msg => msg !== recentUserMessage
            );

            if (userMessages.length === 0) {
                historyEntry += "\n[Комментарий пользователя]:\n";
                historyEntry += recentUserMessage.content;
                userMessages.push(recentUserMessage.content);
            }
        }

        await addToHistory(ctx, 'user', historyEntry);
        await ctx.api.sendChatAction(ctx.chat.id, "typing");

        // Формируем общий текст сообщения для обработки
        let textToProcess = "Пересланные сообщения из треда:\n";

        for (const source in sources) {
            const messages = sources[source];
            if (messages.length > 0) {
                textToProcess += `${source}:\n${messages.join("\n")}\n\n`;
            }
        }

        if (userMessages.length > 0) {
            textToProcess += `Мой комментарий: ${userMessages.join(" ")}`;
        }

        devLog("Обработка треда сообщений:", textToProcess);

        const result = await processMessage(
            ctx,
            textToProcess,
            true,
            "треда сообщений",
            ctx.session.messageHistory.slice().reverse()
        );

        await saveRemindersFromResult(ctx, result);
        await addToHistory(ctx, 'bot', result.responseText);

        // Единая отправка результата
        await sendResultToUser(ctx, result);

        await checkLastFactSaveError(ctx);

        delete ctx.session.forwardGroups[forwardKey];

    } catch (error) {
        console.error("Ошибка при обработке группы пересланных сообщений:", error);
        await ctx.reply("Произошла ошибка при обработке пересланных сообщений. Пожалуйста, попробуйте еще раз.");

        if (ctx.session.forwardGroups) {
            delete ctx.session.forwardGroups[forwardKey];
        }
    }
}

// ── Регистрация обработчика текстовых сообщений ───────────

export function registerTextMessageHandler(bot: Bot<BotContext>): void {
    bot.on("message:text", async (ctx, next) => {
        try {
            devLog('📨 Получено текстовое сообщение от пользователя:', ctx.from?.id);
            const message = ctx.message.text;

            if (message.startsWith('/')) {
                await next();
                return;
            }

            // These messages are handled by dedicated bot.hears handlers in memoryCommands
            if (MEMORY_HEARS_RE.test(message) || MEMORY_DELETE_RE.test(message)) {
                return;
            }

            if (ctx.session.messageEditing && ctx.chat) {
                ctx.session.messageEditing = false;
                const draft = getMessageDraft(ctx.chat.id);
                if (!draft) {
                    await replyAndStore(ctx, "❌ Черновик сообщения не найден или устарел. Создай сообщение заново.");
                    return;
                }
                const preparedMessage = draft.deliveryMode === "voice"
                    ? normalizeNumbersForVoiceMessage(message)
                    : message;

                saveMessageDraft(
                    ctx.chat.id,
                    draft.contactId,
                    preparedMessage,
                    draft.scheduledTime,
                    draft.notifyOnReply,
                    draft.isGroup ?? false,
                    draft.groupTitle,
                    draft.deliveryMode
                );

                const confirmKeyboard = new InlineKeyboard()
                    .text("✅ Отправить", "send_message")
                    .text("✏️ Изменить текст", "edit_message");

                if (!draft.isGroup) {
                    if (draft.deliveryMode === "text") {
                        confirmKeyboard
                            .row()
                            .text("🕒 Изменить время", "change_time")
                            .text(draft.notifyOnReply ? "🔔 Выкл. уведомления" : "🔕 Вкл. уведомления", "toggle_notify");
                    } else {
                        confirmKeyboard
                            .row()
                            .text(draft.notifyOnReply ? "🔔 Выкл. уведомления" : "🔕 Вкл. уведомления", "toggle_notify");
                    }
                }

                confirmKeyboard
                    .row()
                    .text("❌ Отмена", "cancel_message");

                const contactsStore = ContactsStore.getInstance();
                const contact = draft.isGroup ? null : contactsStore.getContact(draft.contactId);
                const recipientLabel = draft.isGroup
                    ? `группы «${draft.groupTitle || draft.contactId}»`
                    : `${contact?.firstName || "контакта"} ${contact?.lastName || ""} ${contact?.username ? '(@' + contact.username + ')' : ''}`.trim();
                const scheduledTimeDisplay = draft.scheduledTime
                    ? draft.scheduledTime.toLocaleString('ru-RU', {
                        day: 'numeric',
                        month: 'long',
                        hour: 'numeric',
                        minute: 'numeric'
                    })
                    : "сейчас";
                const notifyIndicator = draft.notifyOnReply ?
                    "✅ С уведомлением о получении ответа" :
                    "❌ Без уведомления о получении ответа";

                await replyAndStore(ctx,
                    `📤 Обновлено ${draft.deliveryMode === "voice" ? "голосовое сообщение" : "сообщение"} для ${recipientLabel}:\n\n` +
                    `"${preparedMessage}"\n\n` +
                    `Формат: ${draft.deliveryMode === "voice" ? "голосовое сообщение, с представлением ассистента в начале" : "текстовое сообщение"}\n` +
                    `Время отправки: ${scheduledTimeDisplay}\n` +
                    `${draft.isGroup ? "" : `${notifyIndicator}\n`}\n` +
                    `Подтверди отправку или внеси изменения:`,
                    { reply_markup: confirmKeyboard }
                );
                return;
            }

            // Текущее время для отслеживания временных промежутков
            const currentTime = Date.now();

            // Определяем, является ли сообщение пересланным
            const isForwarded = Boolean(ctx.message.forward_from || ctx.message.forward_from_chat || ctx.message.forward_sender_name);
            let forwardSource = '';

            if (ctx.message.forward_from) {
                forwardSource = ctx.message.forward_from.username || ctx.message.forward_from.first_name || "пользователя";
            } else if (ctx.message.forward_from_chat) {
                forwardSource = ctx.message.forward_from_chat.title || "чата";
            } else if (ctx.message.forward_sender_name) {
                forwardSource = ctx.message.forward_sender_name;
            }

            // Проверяем, было ли недавнее обычное сообщение пользователя,
            // которое можно объединить с текущим пересланным сообщением
            if (isForwarded && ctx.session.lastUserMessage &&
                !ctx.session.lastUserMessage.processed &&
                (currentTime - ctx.session.lastUserMessage.timestamp < 5000)) {

                ctx.session.lastUserMessage.processed = true;
                initOrReuseForwardGroup(ctx, forwardSource, message, currentTime, [ctx.session.lastUserMessage.text]);
                return;
            }

            // Обработка обычного пересланного сообщения (без смешивания с сообщением пользователя)
            if (isForwarded) {
                initOrReuseForwardGroup(ctx, forwardSource, message, currentTime, []);
                return;
            }

            // Ожидаем ответ пользователя для активной сессии переговоров (бот вёл переписку от его имени)
            const negotiationSession = NegotiationStore.getByChatId(ctx.chat!.id);
            if (negotiationSession?.waitingForUserReply) {
                const trimmed = message.trim().toLowerCase();
                if (trimmed === "отмена" || trimmed === "отмена переговоров") {
                    const { summaryChatId, summaryMessageId, contactName } = negotiationSession;
                    NegotiationStore.delete(negotiationSession.originalChatId, negotiationSession.contactId);
                    if (summaryChatId != null && summaryMessageId != null) {
                        await editMessageTextIfChanged(ctx.api,
                            summaryChatId,
                            summaryMessageId,
                            `📩 Переговоры с ${contactName} отменены.`,
                            { reply_markup: { inline_keyboard: [] } }
                        ).catch((error) => console.error("[telegram-edit] negotiation cancellation summary update failed:", error));
                    }
                    await replyAndStore(ctx, "Переговоры отменены.");
                    return;
                }
                const client = await initTelegramClient();
                if (client) {
                    const sent = await sendTelegramMessage(client, negotiationSession.contactId, message, true, ctx.chat!.id);
                    if (sent.success) {
                        negotiationSession.history.push({ role: "user", text: message, at: new Date() });
                        negotiationSession.waitingForUserReply = false;
                        NegotiationStore.update(negotiationSession.originalChatId, negotiationSession.contactId, {
                            history: negotiationSession.history,
                            waitingForUserReply: false,
                        });
                        if (negotiationSession.summaryChatId != null && negotiationSession.summaryMessageId != null) {
                            const summaryText = buildNegotiationSummaryText(negotiationSession);
                            await NegotiationStore.editSummary(
                                negotiationSession.summaryChatId,
                                negotiationSession.summaryMessageId,
                                summaryText,
                                buildNegotiationStopKeyboard()
                            ).catch((error) => console.error("[telegram-edit] negotiation summary update failed:", error));
                        }
                        await replyAndStore(ctx, "Отправлено.");
                    } else {
                        await replyAndStore(ctx, "Не удалось отправить сообщение контакту. Попробуй ещё раз.");
                    }
                } else {
                    await replyAndStore(ctx, "Нет связи с Telegram. Попробуй позже.");
                }
                return;
            }

            // Сохраняем последнее сообщение пользователя для возможного объединения с последующими пересланными
            ctx.session.lastUserMessage = {
                text: message,
                timestamp: currentTime,
                processed: false
            };

            // Определяем контекст ответа (reply_to)
            const { isReply, replyToContent, replyToSender } = resolveReplyTo(ctx);

            // Если сообщение является ответом, добавляем эту информацию в историю
            let userMessage = message;
            if (isReply && replyToContent) {
                userMessage = `[В ответ на "${replyToContent}" от ${replyToSender}]: ${message}`;
            }

            await addToHistory(ctx, 'user', userMessage);

            // Устанавливаем таймер для обработки одиночного сообщения
            setTimeout(async () => {
                try {
                if (ctx.session.lastUserMessage &&
                    ctx.session.lastUserMessage.text === message &&
                    !ctx.session.lastUserMessage.processed) {

                    ctx.session.lastUserMessage.processed = true;

                    if (ctx.session.pendingReminderEdit) {
                        const pending = ctx.session.pendingReminderEdit;
                        const isCancel = /^(отмена|отмени|не надо|стоп|cancel)$/iu.test(message.trim());
                        if (isCancel) {
                            ctx.session.pendingReminderEdit = undefined;
                            await ctx.reply('Ок, редактирование напоминания отменено.');
                            return;
                        }

                        if (pending.expiresAt <= Date.now()) {
                            ctx.session.pendingReminderEdit = undefined;
                            await ctx.reply('Время редактирования вышло. Открой /reminders и нажми «Изменить» ещё раз.');
                            return;
                        }

                        const reminder = ReminderRegistry.getInstance().get(pending.reminderId);
                        if (!reminder) {
                            ctx.session.pendingReminderEdit = undefined;
                            await ctx.reply('Не нашла это напоминание. Возможно, оно уже выполнено или отменено.');
                            return;
                        }

                        const editResult = await applyReminderEditInput(ctx, reminder, message);
                        if (!editResult.ok || !editResult.reminder) {
                            await ctx.reply(editResult.responseText);
                            return;
                        }

                        ctx.session.pendingReminderEdit = undefined;
                        const sessIdx = ctx.session.reminders.findIndex(r => r.id === editResult.reminder!.id);
                        if (sessIdx >= 0) ctx.session.reminders[sessIdx] = editResult.reminder;
                        await ctx.reply(editResult.responseText);
                        return;
                    }

                    // Кастомное время для переноса напоминания
                    if (ctx.session.pendingPostpone) {
                        const pending = ctx.session.pendingPostpone;
                        const { reminderId } = pending;
                        const isCancel = /^(отмена|отмени|не надо|стоп|cancel)$/iu.test(message.trim());
                        if (isCancel) {
                            ctx.session.pendingPostpone = undefined;
                            await ctx.reply('Ок, перенос напоминания отменён.');
                            return;
                        }

                        if (pending.expiresAt != null && pending.expiresAt <= Date.now()) {
                            ctx.session.pendingPostpone = undefined;
                            await ctx.reply('Время переноса вышло. Открой /reminders и нажми «Отложить» ещё раз.');
                            return;
                        }

                        ctx.session.pendingPostpone = undefined;
                        const reminder = ReminderRegistry.getInstance().get(reminderId);
                        if (reminder) {
                            const parsed = await extractReminderPostponeDate(reminder, message);
                            if (!parsed.ok || !parsed.dueDate) {
                                await ctx.reply(parsed.responseText);
                                ctx.session.pendingPostpone = pending;
                                return;
                            }

                            const previousReminder: Reminder = { ...reminder, dueDate: new Date(reminder.dueDate) };
                            const updated = await postponeReminderUntil(bot, reminder, parsed.dueDate);
                            if (!updated) {
                                await ctx.reply('Не смогла перенести напоминание. Попробуй ещё раз.');
                                ctx.session.pendingPostpone = pending;
                                return;
                            }

                            ReminderRegistry.getInstance().add(updated);
                            const sessIdx = ctx.session.reminders.findIndex(r => r.id === reminderId);
                            if (sessIdx >= 0) ctx.session.reminders[sessIdx] = updated;
                            await syncReminderMemoryMutation(ctx, previousReminder, updated, 'postpone').catch((e) =>
                                console.error('[reminder] memory sync failed on custom postpone:', e)
                            );
                            await ctx.reply(parsed.responseText);
                        }
                        return;
                    }

                    let messageForProcessing = userMessage;
                    const pendingBrowserTask = ctx.session.pendingBrowserTask;
                    if (pendingBrowserTask) {
                        if (Date.now() > pendingBrowserTask.expiresAt) {
                            if (pendingBrowserTask.sessionId) {
                                import('../agents/browserAgent')
                                    .then((m) => m.cancelPausedBrowserSession(pendingBrowserTask.sessionId))
                                    .catch(() => {});
                            }
                            ctx.session.pendingBrowserTask = undefined;
                        } else {
                            if (looksLikeBrowserTaskCancellation(message)) {
                                if (pendingBrowserTask.sessionId) {
                                    import('../agents/browserAgent')
                                        .then((m) => m.cancelPausedBrowserSession(pendingBrowserTask.sessionId))
                                        .catch(() => {});
                                }
                                ctx.session.pendingBrowserTask = undefined;
                                await replyAndStore(ctx, 'Браузерная задача отменена.');
                                return;
                            }

                            pendingBrowserTask.userAnswer = message;
                            messageForProcessing = [
                                'Продолжи задачу в браузере через Playwright.',
                                `browserSessionId: ${pendingBrowserTask.sessionId ?? 'none'}`,
                                `Исходная задача пользователя: ${pendingBrowserTask.originalTask}`,
                                `Вопрос агента пользователю: ${pendingBrowserTask.question}`,
                                `Ответ пользователя: ${message}`,
                                'Используй ответ как недостающий параметр, подтяни долговременную память как обычно и продолжи выполнение.',
                            ].join('\n');
                        }
                    }

                    let voiceReplyRequested = false;
                    if (messageForProcessing === userMessage && wantsVoiceReply(message)) {
                        voiceReplyRequested = true;
                        messageForProcessing = stripVoiceReplyDirective(messageForProcessing);
                    }

                    await ctx.api.sendChatAction(ctx.chat.id, "typing");

                    const result = await processMessage(
                        ctx,
                        messageForProcessing,
                        false,
                        "",
                        ctx.session.messageHistory.slice().reverse(),
                        undefined,
                        { voiceReplyRequested: voiceReplyRequested }
                    );

                    await saveRemindersFromResult(ctx, result);

                    if (result.negotiationSummarySent) {
                        await addToHistory(ctx, 'bot', '[Переговоры запущены — см. сообщение выше]');
                        maybeReactToUser(ctx, result.botReaction);
                        return;
                    }

                    await addToHistory(ctx, 'bot', result.responseText);

                    // Единая отправка результата вместо дублированного if/else
                    await sendResultToUser(ctx, result, voiceReplyRequested);

                    maybeReactToUser(ctx, result.botReaction);
                    await checkLastFactSaveError(ctx);

                    // Проактивная память
                    if (shouldRunProactiveHint(result, messageForProcessing)) {
                        maybeProactiveHint(ctx, message, result.responseText).catch(() => {});
                    }
                    // Reconsolidation
                    reconsolidateAfterResponse(ctx, message, result.responseText, result.recalledMemories).catch(() => {});
                    // Детекция пробелов
                    maybeAskMemoryGap(ctx, message).catch(() => {});
                    // Детекция неявных напоминаний
                    const wasConversation = !result.reminderCreated && !result.imageGenerated && !result.messageDraft;
                    maybeDetectImplicitReminder(ctx, message, wasConversation).catch(() => {});
                }
                } catch (timerError) {
                    console.error("Ошибка при обработке сообщения в setTimeout:", timerError);
                    try { await ctx.reply("Что-то пошло не так при обработке... Попробуй ещё раз? 💫"); } catch {}
                } finally {
                    await flushSessionAfterAsyncWork(ctx, 'message:text delayed processing');
                }
            }, 2000);
        } catch (error) {
            console.error("Ошибка при обработке сообщения:", error);
            await ctx.reply("Что-то пошло не так... Давай попробуем еще раз? 💫");
        }
    });
}

// Расширяем тип Message для поддержки пересланных сообщений
declare module "grammy/types" {
    interface Message {
        forward_from?: User;
        forward_from_chat?: Chat;
        forward_sender_name?: string;
        reply_to_message?: import("grammy/types").Message;
    }
}
