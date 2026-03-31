import { Bot, InlineKeyboard } from "grammy";
import { BotContext } from "./types";
import { devLog } from "./utils";
import { REMINDER_EXPIRY_TIME } from "./constants";
import { initTelegramClient, searchGroupByTitle, sendMessageToChat, sendMessage } from "./services/telegram";
import { ContactsStore } from "./stores/ContactsStore";
import { ReminderRepository } from "./services/ReminderRepository";
import { ReminderStatus, ReminderTargetChat } from "./types/reminderTypes";
export { ReminderStatus, ReminderTargetChat };

// Расширенный интерфейс для напоминания с поддержкой статусов
export interface Reminder {
    id: string;
    text: string;               // Исходный текст напоминания (для отладки)
    displayText?: string;       // Текст для отображения пользователю
    dueDate: Date;
    chatId: number;            // Чат с пользователем (для уведомления и кнопок; если нет targetChat — сюда же уходит напоминание)
    status?: ReminderStatus;    // Статус напоминания
    messageId?: number;         // ID сообщения с напоминанием для последующих обновлений
    remindAgainAt?: Date;       // Время повторного напоминания
    createdAt: Date;            // Дата создания напоминания
    /** Если задано — в момент срабатывания отправить напоминание в этот чат (группа или контакт), иначе — в chatId */
    targetChat?: ReminderTargetChat;
    /** Название чата, в котором создано напоминание (для пикера в приватном чате) */
    chatTitle?: string;
}

// Хранилище таймеров для напоминаний
const remindersTimers = new Map<string, NodeJS.Timeout>();

// Хранилище таймеров для проверки истечения срока напоминаний
const expiryTimers = new Map<string, NodeJS.Timeout>();

function logReminderEvent(event: string, reminder: Reminder) {
    const chatRef = Math.abs(reminder.chatId) % 10000;
    console.info(`[reminder] event=${event} id=${reminder.id} chatRef=${chatRef} status=${reminder.status || "pending"} due=${new Date(reminder.dueDate).toISOString()}`);
}

/**
 * Планирует напоминание
 * @param bot Экземпляр бота
 * @param reminder Объект напоминания
 */
export function scheduleReminder(bot: Bot<BotContext>, reminder: Reminder): void {
    try {
        // Устанавливаем время создания напоминания, если оно не было установлено
        if (!reminder.createdAt) {
            reminder.createdAt = new Date();
        }

        // Устанавливаем статус напоминания как "ожидающий", если он не был установлен
        if (!reminder.status) {
            reminder.status = ReminderStatus.Pending;
        }

        // Получаем время до срабатывания напоминания
        const now = new Date();
        const dueDate = new Date(reminder.dueDate);
        const timeUntilReminder = dueDate.getTime() - now.getTime();

        // Если время уже прошло, отправляем напоминание немедленно
        if (timeUntilReminder <= 0) {
            logReminderEvent("send_immediately", reminder);
            sendReminder(bot, reminder);
            return;
        }

        devLog(`Scheduling reminder "${reminder.text}" for ${dueDate.toLocaleString()}`);

        // Устанавливаем таймер для напоминания
        const timerId = setTimeout(() => {
            sendReminder(bot, reminder);
            // Удаляем таймер из хранилища после отправки
            remindersTimers.delete(reminder.id);
        }, timeUntilReminder);

        // Сохраняем таймер в хранилище
        remindersTimers.set(reminder.id, timerId);
        logReminderEvent("scheduled", reminder);

    } catch (error) {
        console.error("Error scheduling reminder:", error);
    }
}

/**
 * Резолвит targetChat в числовой chatId (для группы или контакта).
 * Возвращает { chatId, label } или null при ошибке.
 */
async function resolveTargetChat(target: ReminderTargetChat): Promise<{ chatId: number; label: string } | null> {
    const client = await initTelegramClient();
    if (!client) return null;

    if (target.type === "group") {
        const group = await searchGroupByTitle(client, target.groupName);
        if (!group) return null;
        return { chatId: group.id, label: group.title };
    }

    const contact = await ContactsStore.getInstance().searchContactByName(target.contactQuery);
    if (!contact) return null;
    return { chatId: contact.id, label: `${contact.firstName} ${contact.lastName || ""}`.trim() || target.contactQuery };
}

/**
 * Отправляет напоминание пользователю (и при наличии targetChat — в указанный чат).
 * @param bot Экземпляр бота
 * @param reminder Объект напоминания
 */
async function sendReminder(bot: Bot<BotContext>, reminder: Reminder): Promise<void> {
    try {
        // Используем готовый текст для отображения, если есть
        let messageText = reminder.displayText;

        // Если готового текста нет, формируем стандартный (запасной вариант)
        if (!messageText) {
            const formattedTime = new Date().toLocaleString('ru-RU', {
                hour: 'numeric',
                minute: 'numeric'
            });

            // Генерируем случайное вступление
            const intros = [
                "Привет! 👋",
                "Добрый день! ☀️",
                "Хэй!",
                "Напоминаю! ⏰",
                "Не забудь! 💭",
                "Пора! ⌚"
            ];

            const intro = intros[Math.floor(Math.random() * intros.length)];
            messageText = `${intro} ${reminder.text}`;

            // Добавляем случайное завершение
            const outros = [
                "Удачи! 🍀",
                "Всё получится! ✨",
                "Я с тобой! 💪",
                "Думаю о тебе! 💖"
            ];

            const outro = outros[Math.floor(Math.random() * outros.length)];
            messageText += `\n\n${outro}`;
        }

        let userNotificationText = messageText;
        let targetLabel: string | null = null;

        // Если напоминание нужно отправить в другой чат — отправляем туда текст, пользователю — уведомление с кнопками
        if (reminder.targetChat) {
            const resolved = await resolveTargetChat(reminder.targetChat);
            if (resolved) {
                const client = await initTelegramClient();
                if (client) {
                    const textToSend = reminder.displayText || reminder.text;
                    if (reminder.targetChat.type === "group") {
                        await sendMessageToChat(client, resolved.chatId, textToSend);
                    } else {
                        await sendMessage(client, resolved.chatId, textToSend, false, null);
                    }
                    targetLabel = resolved.label;
                    userNotificationText = `⏰ Напомнила в чате «${resolved.label}»:\n\n${reminder.displayText || reminder.text}`;
                    devLog(`Reminder sent to target chat "${resolved.label}" (${resolved.chatId})`);
                }
            } else {
                userNotificationText = `⚠️ Не удалось найти чат для напоминания (${reminder.targetChat.type === "group" ? "группа: " + reminder.targetChat.groupName : "контакт: " + reminder.targetChat.contactQuery}). Напоминание здесь:\n\n${messageText}`;
            }
        }

        // В групповых чатах (chatId < 0) не добавляем кнопки —
        // посторонние могут нажимать их и вызывать спам-ответы бота
        const isGroupReminder = reminder.chatId < 0;

        const keyboard = isGroupReminder ? undefined : new InlineKeyboard()
            .text("✅ Выполнено", `reminder_complete_${reminder.id}`)
            .text("⏰ Напомнить позже", `reminder_postpone_${reminder.id}`)
            .row()
            .text("❌ Отменить", `reminder_cancel_${reminder.id}`);

        const sentMessage = await bot.api.sendMessage(
            reminder.chatId,
            userNotificationText,
            {
                parse_mode: "Markdown",
                ...(keyboard ? { reply_markup: keyboard } : {}),
            }
        );

        // Сохраняем ID сообщения для последующих обновлений
        reminder.messageId = sentMessage.message_id;
        reminder.status = ReminderStatus.Sent;

        // Сохраняем обновлённый статус в БД
        ReminderRepository.update(reminder).catch(e => console.error('[reminder] DB update failed on send:', e));

        // Устанавливаем таймер для проверки истечения срока напоминания
        scheduleExpiryCheck(bot, reminder);

        devLog(`Reminder sent: "${reminder.text}" with message ID ${reminder.messageId}` + (targetLabel ? ` (also in "${targetLabel}")` : ""));
        logReminderEvent("sent", reminder);
    } catch (error) {
        console.error("Error sending reminder:", error);
    }
}

/**
 * Планирует проверку истечения срока напоминания
 * @param bot Экземпляр бота
 * @param reminder Объект напоминания
 */
function scheduleExpiryCheck(bot: Bot<BotContext>, reminder: Reminder): void {
    try {
        // Устанавливаем таймер для проверки истечения срока напоминания
        const expiryTimerId = setTimeout(() => {
            // Если напоминание все еще в статусе "отправлено", считаем его просроченным
            if (reminder.status === ReminderStatus.Sent) {
                handleExpiredReminder(bot, reminder);
            }

            // Удаляем таймер из хранилища
            expiryTimers.delete(reminder.id);
        }, REMINDER_EXPIRY_TIME);

        // Сохраняем таймер в хранилище
        expiryTimers.set(reminder.id, expiryTimerId);

        devLog(`Scheduled expiry check for reminder ${reminder.id} in ${REMINDER_EXPIRY_TIME / 60000} minutes`);
    } catch (error) {
        console.error("Error scheduling expiry check:", error);
    }
}

/**
 * Обрабатывает просроченное напоминание
 * @param bot Экземпляр бота
 * @param reminder Объект напоминания
 */
async function handleExpiredReminder(bot: Bot<BotContext>, reminder: Reminder): Promise<void> {
    try {
        // Обновляем статус напоминания
        reminder.status = ReminderStatus.Expired;
        ReminderRepository.update(reminder).catch(e => console.error('[reminder] DB update failed on expiry:', e));

        // Проверяем, что сообщение с напоминанием было отправлено
        if (!reminder.messageId) {
            console.error(`Cannot handle expired reminder ${reminder.id}: message ID is not set`);
            return;
        }

        // Отправляем напоминание о просроченном напоминании
        await bot.api.sendMessage(
            reminder.chatId,
            `⚠️ У тебя есть незавершенное напоминание: "${reminder.text}"\n\nПожалуйста, отметь его как выполненное или отложи на другое время.`,
            {
                reply_to_message_id: reminder.messageId
            }
        );

        devLog(`Sent expiry notification for reminder ${reminder.id}`);
        logReminderEvent("expired", reminder);
    } catch (error) {
        console.error("Error handling expired reminder:", error);
    }
}

/**
 * Отмечает напоминание как выполненное
 * @param bot Экземпляр бота
 * @param reminder Объект напоминания
 * @returns Успешность операции
 */
export async function markReminderAsCompleted(bot: Bot<BotContext>, reminder: Reminder): Promise<boolean> {
    try {
        // Обновляем статус напоминания
        reminder.status = ReminderStatus.Completed;

        // Отменяем таймер проверки истечения срока, если он существует
        const expiryTimer = expiryTimers.get(reminder.id);
        if (expiryTimer) {
            clearTimeout(expiryTimer);
            expiryTimers.delete(reminder.id);
        }

        // Обновляем сообщение с напоминанием, если есть ID сообщения
        if (reminder.messageId) {
            try {
                // Создаем текст сообщения с отметкой о выполнении
                let updatedText = reminder.displayText || reminder.text;
                if (!updatedText.includes("✅ Выполнено")) {
                    updatedText = `✅ Выполнено: ${updatedText}`;
                }

                // Обновляем сообщение без клавиатуры
                await bot.api.editMessageText(
                    reminder.chatId,
                    reminder.messageId,
                    updatedText,
                    { parse_mode: "Markdown" }
                );

                // Пытаемся удалить клавиатуру, если не удалось включить отметку в текст
                await bot.api.editMessageReplyMarkup(
                    reminder.chatId,
                    reminder.messageId,
                    { reply_markup: new InlineKeyboard() }
                );
            } catch (editError) {
                console.error("Error updating reminder message:", editError);
                // Ошибка обновления сообщения не должна прерывать процесс отметки напоминания
            }
        }

        await ReminderRepository.update(reminder).catch(e => console.error('[reminder] DB update failed on complete:', e));
        devLog(`Reminder ${reminder.id} marked as completed`);
        logReminderEvent("completed", reminder);
        return true;
    } catch (error) {
        console.error("Error marking reminder as completed:", error);
        return false;
    }
}

/**
 * Откладывает напоминание на указанное время
 * @param bot Экземпляр бота
 * @param reminder Объект напоминания
 * @param postponeTime Время, на которое нужно отложить напоминание (в минутах)
 * @returns Обновленное напоминание или null при ошибке
 */
export async function postponeReminder(
    bot: Bot<BotContext>,
    reminder: Reminder,
    postponeTime: number = 30 // По умолчанию откладываем на 30 минут
): Promise<Reminder | null> {
    try {
        // Отменяем таймер проверки истечения срока, если он существует
        const expiryTimer = expiryTimers.get(reminder.id);
        if (expiryTimer) {
            clearTimeout(expiryTimer);
            expiryTimers.delete(reminder.id);
        }

        // Обновляем статус напоминания
        reminder.status = ReminderStatus.Postponed;

        // Рассчитываем новое время напоминания
        const newDueDate = new Date();
        newDueDate.setMinutes(newDueDate.getMinutes() + postponeTime);
        reminder.dueDate = newDueDate;
        reminder.remindAgainAt = newDueDate;

        // Обновляем сообщение с информацией об отложенном напоминании
        if (reminder.messageId) {
            try {
                // Создаем текст сообщения с информацией об отложенном напоминании
                let updatedText = reminder.displayText || reminder.text;
                const formattedTime = newDueDate.toLocaleString('ru-RU', {
                    hour: 'numeric',
                    minute: 'numeric'
                });

                if (!updatedText.includes("⏰ Отложено")) {
                    updatedText = `⏰ Отложено до ${formattedTime}: ${updatedText}`;
                }

                // Обновляем сообщение без клавиатуры
                await bot.api.editMessageText(
                    reminder.chatId,
                    reminder.messageId,
                    updatedText,
                    { parse_mode: "Markdown" }
                );

                // Пытаемся удалить клавиатуру, если не удалось включить отметку в текст
                await bot.api.editMessageReplyMarkup(
                    reminder.chatId,
                    reminder.messageId,
                    { reply_markup: new InlineKeyboard() }
                );
            } catch (editError) {
                console.error("Error updating postponed reminder message:", editError);
                // Ошибка обновления сообщения не должна прерывать процесс откладывания напоминания
            }
        }

        await ReminderRepository.update(reminder).catch(e => console.error('[reminder] DB update failed on postpone:', e));

        // Планируем отправку отложенного напоминания
        scheduleReminder(bot, reminder);

        devLog(`Reminder ${reminder.id} postponed to ${newDueDate.toLocaleString()}`);
        logReminderEvent("postponed", reminder);
        return reminder;
    } catch (error) {
        console.error("Error postponing reminder:", error);
        return null;
    }
}

/**
 * Отменяет напоминание
 * @param reminderId ID напоминания
 * @returns Успешность отмены
 */
export async function cancelReminder(reminderId: string): Promise<boolean> {
    try {
        // Отменяем таймер напоминания, если он существует
        const timer = remindersTimers.get(reminderId);
        if (timer) {
            clearTimeout(timer);
            remindersTimers.delete(reminderId);
        }

        // Отменяем таймер проверки истечения срока, если он существует
        const expiryTimer = expiryTimers.get(reminderId);
        if (expiryTimer) {
            clearTimeout(expiryTimer);
            expiryTimers.delete(reminderId);
        }

        await ReminderRepository.delete(reminderId).catch(e => console.error('[reminder] DB delete failed on cancel:', e));

        console.info(`[reminder] event=cancelled id=${reminderId}`);
        devLog(`Reminder ${reminderId} cancelled`);
        return true;
    } catch (error) {
        console.error("Error cancelling reminder:", error);
        return false;
    }
}

/**
 * Получает список всех активных напоминаний
 * @returns Массив ID активных напоминаний
 */
export function getActiveReminderIds(): string[] {
    return Array.from(remindersTimers.keys());
}

/**
 * Возвращает отформатированную строку с информацией о напоминании
 * @param reminder Объект напоминания
 */
export function formatReminder(reminder: Reminder): string {
    const formattedTime = new Date(reminder.dueDate).toLocaleString('ru-RU', {
        day: 'numeric',
        month: 'long',
        hour: 'numeric',
        minute: 'numeric'
    });
    return `"${reminder.text}" - ${formattedTime}`;
}
