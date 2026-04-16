import { Bot, InlineKeyboard } from "grammy";
import { BotContext } from "../types";
import { Reminder, cancelReminder, markReminderAsCompleted, postponeReminder } from "../reminder";
import { getActiveReminders, buildReminderCard, buildPostponeKeyboard, buildRemindersList, buildChatPicker } from "../utils/reminderCard";
import { ReminderRegistry } from "../stores/ReminderRegistry";
import { sendMessageFromDraft, deleteMessageDraft, saveMessageDraft, getMessageDraft } from "../agents/sendMessagesAgent";
import { ContactsStore } from "../stores/ContactsStore";
import {
    NegotiationStore,
    buildNegotiationSummaryText,
    buildNegotiationStopKeyboard,
} from "../stores/NegotiationStore";
import { initTelegramClient, sendMessage as sendTelegramMessage } from "../services/telegram";
import { getMessagesSummary, handleStudyChatPeriodCallback } from "../agents/readMessagesAgent";
import { sendMessage } from "../utils";
import type { StudyChatPeriod } from "../utils/studyChatFlow";

/**
 * Регистрирует обработчики колбэков для бота
 * @param bot Экземпляр бота
 */
export function registerCallback(bot: Bot<BotContext>): void {
    bot.on("callback_query:data", async (ctx, next) => {
        try {
            const callbackData = ctx.callbackQuery.data;

            if (callbackData === "negotiation_start") {
                const chatId = ctx.chat?.id;
                const messageId = ctx.callbackQuery.message?.message_id;
                if (chatId == null || messageId == null) {
                    await ctx.answerCallbackQuery({ text: "Ошибка: чат не найден" });
                    return;
                }
                const pending = NegotiationStore.getPendingStart(chatId);
                if (!pending) {
                    await ctx.answerCallbackQuery({ text: "Предложение истекло. Запроси переговоры заново." });
                    return;
                }
                const client = await initTelegramClient();
                if (!client) {
                    await ctx.answerCallbackQuery({ text: "Нет связи с Telegram. Попробуй позже." });
                    return;
                }
                const sendResult = await sendTelegramMessage(
                    client,
                    pending.contactId,
                    pending.firstMessageText,
                    true,
                    chatId
                );
                if (!sendResult.success) {
                    await ctx.answerCallbackQuery({ text: "Не удалось отправить сообщение контакту." });
                    return;
                }
                NegotiationStore.clearPendingStart(chatId);
                const session = {
                    contactId: pending.contactId,
                    contactName: pending.contactName,
                    originalChatId: chatId,
                    taskDescription: pending.taskDescription,
                    history: [{ role: "bot" as const, text: pending.firstMessageText, at: new Date() }],
                    createdAt: new Date(),
                    lastSentMessageId: sendResult.messageId ?? undefined,
                    summaryChatId: chatId,
                    summaryMessageId: messageId,
                };
                NegotiationStore.set(session);
                const summaryText = buildNegotiationSummaryText(session);
                const keyboard = buildNegotiationStopKeyboard();
                try {
                    await ctx.api.editMessageText(chatId, messageId, summaryText, {
                        reply_markup: keyboard,
                    });
                } catch (_) {}
                await ctx.answerCallbackQuery({ text: "Переговоры начаты" });
                return;
            }

            if (callbackData === "negotiation_stop") {
                const chatId = ctx.chat?.id;
                if (chatId == null) {
                    await ctx.answerCallbackQuery({ text: "Ошибка: чат не найден" });
                    return;
                }
                const session = NegotiationStore.getActiveSessionByChatId(chatId);
                if (!session) {
                    await ctx.answerCallbackQuery({ text: "Переговоры уже завершены" });
                    return;
                }
                const { originalChatId, contactId, contactName, summaryChatId, summaryMessageId } = session;
                NegotiationStore.delete(originalChatId, contactId);
                await ctx.answerCallbackQuery({ text: "Переговоры завершены" });
                if (summaryChatId != null && summaryMessageId != null) {
                    try {
                        await ctx.api.editMessageText(
                            summaryChatId,
                            summaryMessageId,
                            `📩 Переговоры с ${contactName} завершены по твоей инициативе.`
                        );
                        await ctx.api.editMessageReplyMarkup(summaryChatId, summaryMessageId, {
                            reply_markup: new InlineKeyboard(),
                        });
                    } catch (_) {}
                }
                return;
            }

            // ── Пикер чатов с напоминаниями (из приватного чата) ────────────────
            if (callbackData === 'reminder_chat_back') {
                ctx.session.viewingRemindersInChat = undefined;
                await ctx.answerCallbackQuery();
                const chats = ReminderRegistry.getInstance().getChatsWithActive();
                if (ctx.callbackQuery.message?.message_id) {
                    if (chats.length === 0) {
                        await ctx.api.editMessageText(
                            ctx.callbackQuery.message.chat.id,
                            ctx.callbackQuery.message.message_id,
                            '✅ Все напоминания выполнены!',
                            { reply_markup: new InlineKeyboard() }
                        );
                    } else if (chats.length === 1) {
                        const active = ReminderRegistry.getInstance().getActiveByChatId(chats[0].chatId);
                        const { text, keyboard } = buildReminderCard(active, 0, chats.length > 1);
                        await ctx.api.editMessageText(
                            ctx.callbackQuery.message.chat.id,
                            ctx.callbackQuery.message.message_id,
                            text,
                            { reply_markup: keyboard }
                        );
                    } else {
                        const { text, keyboard } = buildChatPicker(chats);
                        await ctx.api.editMessageText(
                            ctx.callbackQuery.message.chat.id,
                            ctx.callbackQuery.message.message_id,
                            text,
                            { reply_markup: keyboard }
                        );
                    }
                }
                return;
            }

            if (callbackData.startsWith('reminder_chat_')) {
                const chatId = parseInt(callbackData.replace('reminder_chat_', ''), 10);
                if (isNaN(chatId)) {
                    await ctx.answerCallbackQuery();
                    return;
                }
                ctx.session.viewingRemindersInChat = chatId;
                const active = ReminderRegistry.getInstance().getActiveByChatId(chatId);
                const allChats = ReminderRegistry.getInstance().getChatsWithActive();
                const showBack = allChats.length > 1;
                await ctx.answerCallbackQuery();
                if (ctx.callbackQuery.message?.message_id) {
                    if (active.length === 0) {
                        await ctx.api.editMessageText(
                            ctx.callbackQuery.message.chat.id,
                            ctx.callbackQuery.message.message_id,
                            '✅ Нет активных напоминаний в этом чате.',
                            { reply_markup: showBack ? new InlineKeyboard().text('↩️ К чатам', 'reminder_chat_back') : new InlineKeyboard() }
                        );
                    } else {
                        const { text, keyboard } = buildReminderCard(active, 0, showBack);
                        await ctx.api.editMessageText(
                            ctx.callbackQuery.message.chat.id,
                            ctx.callbackQuery.message.message_id,
                            text,
                            { reply_markup: keyboard }
                        );
                    }
                }
                return;
            }

            // ── Навигация по карточкам напоминаний ──────────────────────────────
            if (callbackData === 'reminders_nav_noop') {
                await ctx.answerCallbackQuery();
                return;
            }

            if (callbackData === 'reminders_list') {
                const active = getActiveReminders(ctx);
                await ctx.answerCallbackQuery();
                if (ctx.callbackQuery.message?.message_id) {
                    if (active.length === 0) {
                        await ctx.api.editMessageText(
                            ctx.callbackQuery.message.chat.id,
                            ctx.callbackQuery.message.message_id,
                            '✅ Все напоминания выполнены!',
                            { reply_markup: new InlineKeyboard() }
                        );
                    } else {
                        const { text, keyboard } = buildRemindersList(active);
                        await ctx.api.editMessageText(
                            ctx.callbackQuery.message.chat.id,
                            ctx.callbackQuery.message.message_id,
                            text,
                            { reply_markup: keyboard }
                        );
                    }
                }
                return;
            }

            if (callbackData.startsWith('reminders_nav_')) {
                const idx = parseInt(callbackData.replace('reminders_nav_', ''), 10);
                const active = getActiveReminders(ctx);
                const safeIdx = Math.max(0, Math.min(idx, active.length - 1));
                const showBack = !!ctx.session.viewingRemindersInChat;

                if (active.length === 0) {
                    await ctx.answerCallbackQuery({ text: 'Нет активных напоминаний' });
                    if (ctx.callbackQuery.message?.message_id) {
                        const cid = ctx.callbackQuery.message.chat.id;
                        const mid = ctx.callbackQuery.message.message_id;
                        await ctx.api.editMessageText(cid, mid, '✅ Все напоминания выполнены!',
                            { reply_markup: showBack ? new InlineKeyboard().text('↩️ К чатам', 'reminder_chat_back') : new InlineKeyboard() }
                        );
                    }
                    return;
                }

                const { text, keyboard } = buildReminderCard(active, safeIdx, showBack);
                await ctx.answerCallbackQuery();
                if (ctx.callbackQuery.message?.message_id) {
                    await ctx.api.editMessageText(
                        ctx.callbackQuery.message.chat.id,
                        ctx.callbackQuery.message.message_id,
                        text,
                        { reply_markup: keyboard }
                    );
                }
                return;
            }

            // ── Отмена напоминания ──────────────────────────────────────────────
            if (callbackData.startsWith("reminder_cancel_")) {
                const reminderId = callbackData.replace("reminder_cancel_", "");
                if (!reminderId) {
                    await ctx.answerCallbackQuery({ text: "Произошла ошибка при обработке запроса" });
                    return;
                }

                const reminder = ReminderRegistry.getInstance().get(reminderId);
                if (!reminder) {
                    await ctx.answerCallbackQuery({ text: "Напоминание не найдено" });
                    return;
                }

                const reminderDisplayText = reminder.displayText || reminder.text;
                await cancelReminder(reminderId);
                ReminderRegistry.getInstance().remove(reminderId);
                ctx.session.reminders = ctx.session.reminders.filter(r => r.id !== reminderId);
                await ctx.answerCallbackQuery({ text: "Напоминание отменено" });

                const showBack = !!ctx.session.viewingRemindersInChat;
                const callbackMidCancel = ctx.callbackQuery.message?.message_id;
                const isReminderCardCancel = callbackMidCancel !== undefined && callbackMidCancel !== reminder.messageId;
                if (ctx.callbackQuery.message?.message_id) {
                    const cid = ctx.callbackQuery.message.chat.id;
                    const mid = ctx.callbackQuery.message.message_id;
                    if (isReminderCardCancel) {
                        // Кнопка нажата на карточке из /reminders — обновляем карточку
                        const remaining = getActiveReminders(ctx);
                        if (remaining.length === 0) {
                            await ctx.api.editMessageText(cid, mid, '✅ Все напоминания выполнены!',
                                { reply_markup: showBack ? new InlineKeyboard().text('↩️ К чатам', 'reminder_chat_back') : new InlineKeyboard() }
                            );
                        } else {
                            const { text, keyboard } = buildReminderCard(remaining, 0, showBack);
                            await ctx.api.editMessageText(cid, mid, text, { reply_markup: keyboard });
                        }
                    } else {
                        // Кнопка нажата на самом уведомлении — заменяем его текстом об отмене
                        await ctx.api.editMessageText(cid, mid, `❌ Отменено: ${reminderDisplayText}`,
                            { reply_markup: new InlineKeyboard() }
                        );
                    }
                }
            } else if (callbackData.startsWith("study_chat:")) {
                const period = callbackData.replace("study_chat:", "") as StudyChatPeriod;
                if (!["week", "month", "3months", "year"].includes(period)) {
                    await ctx.answerCallbackQuery({ text: "Неизвестный период" });
                    return;
                }
                await ctx.answerCallbackQuery({ text: "Читаю переписку..." });
                const { responseText } = await handleStudyChatPeriodCallback(ctx, period);
                if (ctx.callbackQuery.message?.message_id) {
                    await ctx.api.editMessageText(
                        ctx.callbackQuery.message.chat.id,
                        ctx.callbackQuery.message.message_id,
                        responseText,
                        { reply_markup: new InlineKeyboard() }
                    );
                } else {
                    await ctx.reply(responseText);
                }
            // Проверяем, что колбэк связан с напоминанием
            } else if (callbackData.startsWith("reminder_")) {
                // Извлекаем действие и ID напоминания из данных колбэка
                const [action, reminderId] = callbackData.replace("reminder_", "").split("_");

                if (!reminderId) {
                    console.error(`Invalid reminder ID: ${reminderId}`);
                    await ctx.answerCallbackQuery({ text: "Произошла ошибка при обработке запроса" });
                    return;
                }

                // Ищем напоминание в глобальном реестре (работает из любого чата)
                const reminder = ReminderRegistry.getInstance().get(reminderId);

                if (!reminder) {
                    console.error(`Reminder with ID ${reminderId} not found`);
                    await ctx.answerCallbackQuery({ text: "Напоминание не найдено" });
                    return;
                }

                const showBack = !!ctx.session.viewingRemindersInChat;

                // Обрабатываем действие
                if (action === "complete") {
                    await markReminderAsCompleted(bot, reminder);
                    ReminderRegistry.getInstance().remove(reminderId);
                    ctx.session.reminders = ctx.session.reminders.filter(r => r.id !== reminderId);
                    await ctx.answerCallbackQuery({ text: "Выполнено! ✅" });

                    // Если кнопка нажата на самом уведомлении — markReminderAsCompleted уже обновил его,
                    // перезаписывать не нужно. Если кнопка нажата на карточке из /reminders — обновляем карточку.
                    const callbackMid = ctx.callbackQuery.message?.message_id;
                    const isReminderCard = callbackMid !== undefined && callbackMid !== reminder.messageId;
                    if (isReminderCard) {
                        const remaining = getActiveReminders(ctx);
                        const cid = ctx.callbackQuery.message!.chat.id;
                        if (remaining.length === 0) {
                            await ctx.api.editMessageText(cid, callbackMid, '✅ Все напоминания выполнены!',
                                { reply_markup: showBack ? new InlineKeyboard().text('↩️ К чатам', 'reminder_chat_back') : new InlineKeyboard() }
                            );
                        } else {
                            const { text, keyboard } = buildReminderCard(remaining, 0, showBack);
                            await ctx.api.editMessageText(cid, callbackMid, text, { reply_markup: keyboard });
                        }
                    }
                } else if (action === "postpone") {
                    await ctx.answerCallbackQuery();
                    if (ctx.callbackQuery.message?.message_id) {
                        await ctx.api.editMessageReplyMarkup(
                            ctx.callbackQuery.message.chat.id,
                            ctx.callbackQuery.message.message_id,
                            { reply_markup: buildPostponeKeyboard(reminderId) }
                        );
                    }
                }
            } else if (callbackData.startsWith("postpone_")) {
                // Обработка выбора времени откладывания
                const parts = callbackData.replace("postpone_", "").split("_");
                const postponeTime = parts[parts.length - 1];
                const reminderId = parts.slice(0, -1).join("_");

                if (!reminderId) {
                    console.error(`Invalid reminder ID: ${reminderId}`);
                    await ctx.answerCallbackQuery({ text: "Произошла ошибка при обработке запроса" });
                    return;
                }

                // Нажата кнопка «Назад» — восстанавливаем карточку напоминания
                if (postponeTime === "back") {
                    const active = getActiveReminders(ctx);
                    const showBackOnBack = !!ctx.session.viewingRemindersInChat;
                    await ctx.answerCallbackQuery();
                    if (ctx.callbackQuery.message?.message_id) {
                        if (active.length === 0) {
                            await ctx.api.editMessageText(
                                ctx.callbackQuery.message.chat.id,
                                ctx.callbackQuery.message.message_id,
                                '✅ Все напоминания выполнены!',
                                { reply_markup: showBackOnBack ? new InlineKeyboard().text('↩️ К чатам', 'reminder_chat_back') : new InlineKeyboard() }
                            );
                        } else {
                            const idx = Math.max(0, active.findIndex(r => r.id === reminderId));
                            const { text, keyboard } = buildReminderCard(active, idx, showBackOnBack);
                            await ctx.api.editMessageText(
                                ctx.callbackQuery.message.chat.id,
                                ctx.callbackQuery.message.message_id,
                                text,
                                { reply_markup: keyboard }
                            );
                        }
                    }
                    return;
                }

                const reminder = ReminderRegistry.getInstance().get(reminderId);

                if (!reminder) {
                    console.error(`Reminder with ID ${reminderId} not found`);
                    await ctx.answerCallbackQuery({ text: "Напоминание не найдено" });
                    return;
                }

                let minutes: number;
                let notificationText: string;
                let newDueDate: Date;

                if (postponeTime === "tomorrow") {
                    newDueDate = new Date();
                    newDueDate.setDate(newDueDate.getDate() + 1);
                    newDueDate.setHours(9, 0, 0, 0);
                    minutes = Math.floor((newDueDate.getTime() - new Date().getTime()) / 60000);
                    notificationText = "Напоминание отложено на завтра (9:00)";
                } else if (postponeTime === "week") {
                    newDueDate = new Date();
                    newDueDate.setDate(newDueDate.getDate() + 7);
                    newDueDate.setHours(9, 0, 0, 0);
                    minutes = Math.floor((newDueDate.getTime() - new Date().getTime()) / 60000);
                    notificationText = "Напоминание отложено на неделю (9:00)";
                } else {
                    minutes = parseInt(postponeTime);
                    if (isNaN(minutes)) {
                        console.error(`Invalid postpone time: ${postponeTime}`);
                        await ctx.answerCallbackQuery({ text: "Произошла ошибка при обработке запроса" });
                        return;
                    }
                    newDueDate = new Date();
                    newDueDate.setMinutes(newDueDate.getMinutes() + minutes);
                    if (minutes === 60) {
                        notificationText = "Напоминание отложено на 1 час";
                    } else if (minutes === 180) {
                        notificationText = "Напоминание отложено на 3 часа";
                    } else {
                        notificationText = `Напоминание отложено на ${minutes} минут`;
                    }
                }

                const updatedReminder = await postponeReminder(bot, reminder, minutes);

                if (updatedReminder) {
                    ReminderRegistry.getInstance().add(updatedReminder);
                    const sessIdx = ctx.session.reminders.findIndex(r => r.id === reminderId);
                    if (sessIdx !== -1) ctx.session.reminders[sessIdx] = updatedReminder;

                    await ctx.answerCallbackQuery({ text: notificationText });

                    if (ctx.callbackQuery.message?.message_id) {
                        const chatId = ctx.callbackQuery.message.chat.id;
                        const messageId = ctx.callbackQuery.message.message_id;
                        const showBackAfterPostpone = !!ctx.session.viewingRemindersInChat;
                        const formattedTime = newDueDate.toLocaleString('ru-RU', {
                            day: 'numeric', month: 'long', hour: 'numeric', minute: 'numeric'
                        });
                        const confirmText = `⏰ Напоминание перенесено\n\nСледующий сигнал: ${formattedTime}`;
                        const backKeyboard = new InlineKeyboard().text('📋 К списку напоминаний', 'reminders_nav_0');
                        if (showBackAfterPostpone) backKeyboard.row().text('↩️ К чатам', 'reminder_chat_back');
                        await ctx.api.editMessageText(chatId, messageId, confirmText, { reply_markup: backKeyboard });
                    }
                } else {
                    await ctx.answerCallbackQuery({ text: "Произошла ошибка при откладывании напоминания" });
                }
            } else if (callbackData === "send_message") {
                // Если нажата кнопка "Отправить", отправляем сообщение
                if (ctx.chat) {
                    const success = await sendMessageFromDraft(ctx.chat.id);

                    if (success) {
                        await ctx.answerCallbackQuery({ text: "Сообщение отправлено!" });
                        await ctx.reply("✅ Сообщение успешно отправлено!");
                    } else {
                        await ctx.answerCallbackQuery({ text: "Ошибка отправки" });
                        await ctx.reply("❌ Не удалось отправить сообщение. Пожалуйста, попробуйте ещё раз.");
                    }
                }
            } else if (callbackData === "edit_message") {
                // Если нажата кнопка "Изменить текст", запрашиваем новый текст
                await ctx.answerCallbackQuery({ text: "Введите новый текст сообщения" });
                await ctx.reply("📝 Пожалуйста, введите новый текст сообщения:");

                // Устанавливаем состояние редактирования в сессии
                if (ctx.chat) {
                    ctx.session.messageEditing = true;
                }
            } else if (callbackData === "change_time") {
                // Если нажата кнопка "Изменить время", запрашиваем новое время
                await ctx.answerCallbackQuery({ text: "Выберите новое время" });

                // Создаем клавиатуру с вариантами времени
                const timeKeyboard = new InlineKeyboard()
                    .text("Сейчас", "time_now")
                    .text("Через 1 час", "time_1h")
                    .row()
                    .text("В 9:00 завтра", "time_tomorrow_9")
                    .text("В 12:00 завтра", "time_tomorrow_12");

                await ctx.reply("🕒 Выберите время отправки:", {
                    reply_markup: timeKeyboard
                });
            } else if (callbackData === "toggle_notify") {
                // Обработка переключения уведомлений о получении ответа
                if (ctx.chat) {
                    const draft = getMessageDraft(ctx.chat.id);

                    if (!draft) {
                        await ctx.answerCallbackQuery({ text: "Ошибка: черновик не найден" });
                        await ctx.reply("❌ Произошла ошибка. Пожалуйста, начните создание сообщения заново.");
                        return;
                    }

                    // Переключаем флаг уведомления
                    const newNotifyValue = !draft.notifyOnReply;

                    // Сохраняем обновленный черновик (для группы уведомления недоступны)
                    saveMessageDraft(
                        ctx.chat.id,
                        draft.contactId,
                        draft.text,
                        draft.scheduledTime,
                        newNotifyValue,
                        draft.isGroup ?? false,
                        draft.groupTitle
                    );

                    // Получаем информацию о контакте (для группы не применимо)
                    if (draft.isGroup) {
                        await ctx.answerCallbackQuery({ text: "Для группы эта опция недоступна" });
                        return;
                    }
                    const contactsStore = ContactsStore.getInstance();
                    const contact = contactsStore.getContact(draft.contactId);

                    if (!contact) {
                        await ctx.answerCallbackQuery({ text: "Ошибка: контакт не найден" });
                        await ctx.reply("❌ Произошла ошибка. Пожалуйста, начните создание сообщения заново.");
                        return;
                    }

                    // Определяем время отправки для отображения
                    let scheduledTimeDisplay = "сейчас";
                    if (draft.scheduledTime) {
                        scheduledTimeDisplay = draft.scheduledTime.toLocaleString('ru-RU', {
                            day: 'numeric',
                            month: 'long',
                            hour: 'numeric',
                            minute: 'numeric'
                        });
                    }

                    // Добавляем индикатор уведомления о получении ответа
                    let notifyIndicator = newNotifyValue ?
                        "✅ С уведомлением о получении ответа" :
                        "❌ Без уведомления о получении ответа";

                    // Создаем обновленную клавиатуру
                    const confirmKeyboard = new InlineKeyboard()
                        .text("✅ Отправить", "send_message")
                        .text("✏️ Изменить текст", "edit_message")
                        .row()
                        .text("🕒 Изменить время", "change_time")
                        .text(newNotifyValue ? "🔔 Выкл. уведомления" : "🔕 Вкл. уведомления", "toggle_notify")
                        .row()
                        .text("❌ Отмена", "cancel_message");

                    // Формируем обновленное сообщение с предварительным просмотром
                    const responseText = `📤 Подготовлено сообщение для ${contact.firstName} ${contact.lastName || ''} ${contact.username ? '(@' + contact.username + ')' : ''}:\n\n` +
                        `"${draft.text}"\n\n` +
                        `Время отправки: ${scheduledTimeDisplay}\n` +
                        `${notifyIndicator}\n\n` +
                        `Подтверди отправку или внеси изменения:`;

                    // Отправляем уведомление в колбэке
                    await ctx.answerCallbackQuery({
                        text: newNotifyValue ?
                            "Уведомление о получении ответа включено" :
                            "Уведомление о получении ответа выключено"
                    });

                    // Обновляем сообщение с черновиком
                    await ctx.editMessageText(responseText, {
                        reply_markup: confirmKeyboard
                    });
                }
            } else if (callbackData === "unread_summary") {
                await ctx.answerCallbackQuery();
                const summary = await getMessagesSummary(24);
                if (summary) {
                    await sendMessage(ctx, summary);
                } else {
                    await ctx.reply("У тебя нет непрочитанных сообщений в Telegram за последние 24 часа. Все сообщения прочитаны! 📬");
                }
            } else if (callbackData === "cancel_message") {
                // Если нажата кнопка "Отмена", удаляем черновик
                if (ctx.chat) {
                    deleteMessageDraft(ctx.chat.id);
                }

                await ctx.answerCallbackQuery({ text: "Отправка отменена" });
                await ctx.reply("❌ Отправка сообщения отменена.");
            } else if (callbackData.startsWith("time_")) {
                // Обработка выбора времени отправки
                if (ctx.chat) {
                    // Получаем текущий черновик
                    const draft = getMessageDraft(ctx.chat.id);

                    if (!draft) {
                        await ctx.answerCallbackQuery({ text: "Ошибка: черновик не найден" });
                        await ctx.reply("❌ Произошла ошибка. Пожалуйста, начните создание сообщения заново.");
                        return;
                    }

                    let scheduledTime: Date | null = null;
                    let timeDescription = "сейчас";

                    if (callbackData === "time_now") {
                        // Отправка сейчас (оставляем null)
                        scheduledTime = null;
                    } else if (callbackData === "time_1h") {
                        // Через 1 час
                        scheduledTime = new Date();
                        scheduledTime.setHours(scheduledTime.getHours() + 1);
                        timeDescription = "через 1 час";
                    } else if (callbackData === "time_tomorrow_9") {
                        // Завтра в 9:00
                        scheduledTime = new Date();
                        scheduledTime.setDate(scheduledTime.getDate() + 1);
                        scheduledTime.setHours(9, 0, 0, 0);
                        timeDescription = "завтра в 9:00";
                    } else if (callbackData === "time_tomorrow_12") {
                        // Завтра в 12:00
                        scheduledTime = new Date();
                        scheduledTime.setDate(scheduledTime.getDate() + 1);
                        scheduledTime.setHours(12, 0, 0, 0);
                        timeDescription = "завтра в 12:00";
                    }

                    // Сохраняем обновленный черновик с новым временем (для группы отложенная отправка недоступна)
                    if (draft.isGroup) {
                        await ctx.answerCallbackQuery({ text: "Для группы доступна только отправка сейчас" });
                        return;
                    }
                    saveMessageDraft(
                        ctx.chat.id,
                        draft.contactId,
                        draft.text,
                        scheduledTime,
                        draft.notifyOnReply
                    );

                    // Получаем информацию о контакте
                    const contactsStore = ContactsStore.getInstance();
                    const contact = contactsStore.getContact(draft.contactId);

                    if (!contact) {
                        await ctx.answerCallbackQuery({ text: "Ошибка: контакт не найден" });
                        await ctx.reply("❌ Произошла ошибка. Пожалуйста, начните создание сообщения заново.");
                        return;
                    }

                    // Отправляем подтверждение обновления времени
                    await ctx.answerCallbackQuery({ text: `Время изменено на ${timeDescription}` });

                    // Добавляем индикатор уведомления о получении ответа
                    let notifyIndicator = draft.notifyOnReply ?
                        "✅ С уведомлением о получении ответа" :
                        "❌ Без уведомления о получении ответа";

                    // Создаем клавиатуру для подтверждения отправки с кнопкой переключения уведомлений
                    const confirmKeyboard = new InlineKeyboard()
                        .text("✅ Отправить", "send_message")
                        .text("✏️ Изменить текст", "edit_message")
                        .row()
                        .text("🕒 Изменить время", "change_time")
                        .text(draft.notifyOnReply ? "🔔 Выкл. уведомления" : "🔕 Вкл. уведомления", "toggle_notify")
                        .row()
                        .text("❌ Отмена", "cancel_message");

                    // Формируем обновленное сообщение с предварительным просмотром
                    const responseText = `📤 Подготовлено сообщение для ${contact.firstName} ${contact.lastName || ''} ${contact.username ? '(@' + contact.username + ')' : ''}:\n\n` +
                        `"${draft.text}"\n\n` +
                        `Время отправки: ${timeDescription}\n` +
                        `${notifyIndicator}\n\n` +
                        `Подтверди отправку или внеси изменения:`;

                    await ctx.editMessageText(responseText, {
                        reply_markup: confirmKeyboard
                    });
                }
            }

            // Пропустить необработанные callback-и (например, mem_del из memoryCommands)
            await next();
        } catch (error) {
            console.error("Error handling callback query:", error);
            try {
                await ctx.answerCallbackQuery({ text: "Произошла ошибка при обработке запроса" });
            } catch (answerError) {
                console.error("Error answering callback query:", answerError);
            }
        }
    });
}