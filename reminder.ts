import { Bot, InlineKeyboard } from "grammy";
import { BotContext } from "./types";
import { devLog } from "./utils";
import { REMINDER_EXPIRY_TIME, USER_TIMEZONE } from "./constants";
import { initTelegramClient, searchGroupByTitle, sendMessageToChat, sendMessage } from "./services/telegram";
import { ContactsStore } from "./stores/ContactsStore";
import { ReminderRepository } from "./services/ReminderRepository";
import { ReminderStatus, ReminderTargetChat, ReminderTargetNotificationStatus, RecurrenceRule } from "./types/reminderTypes";
import { ReminderRegistry } from "./stores/ReminderRegistry";
import { buildDefaultTargetReminderMessage } from "./utils/reminderTargetNotification";
import { createOrRefreshReminderMemoryForUserId } from "./services/ReminderMemorySync";
import { config } from "./config";
import { esc, blockquote, RichBlock, sendStructured, editStructured } from "./utils/richMessage";
export { ReminderStatus, ReminderTargetChat, ReminderTargetNotificationStatus, RecurrenceRule };

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
    /** Текст для адресата targetChat. Не должен быть копией личного напоминания владельцу. */
    targetDisplayText?: string;
    /** Отправлять ли targetChat. Без явного enabled напоминание уходит только владельцу. */
    targetChatNotifyStatus?: ReminderTargetNotificationStatus;
    /** Название чата, в котором создано напоминание (для пикера в приватном чате) */
    chatTitle?: string;
    /** Правило повторения: если задано, после срабатывания автоматически создаётся следующее */
    recurrence?: RecurrenceRule;
    /** Сколько раз напоминание было отложено — для эскалации */
    postponeCount?: number;
}

/**
 * Вычисляет дату следующего повторения на основе правила
 */
function getNextOccurrence(fromDate: Date, rule: RecurrenceRule): Date {
    const next = new Date(fromDate);
    switch (rule.type) {
        case 'hourly':
            next.setHours(next.getHours() + rule.interval);
            break;
        case 'daily':
            next.setDate(next.getDate() + rule.interval);
            break;
        case 'weekly':
            if (rule.daysOfWeek && rule.daysOfWeek.length > 0) {
                const sorted = [...rule.daysOfWeek].sort((a, b) => a - b);
                const cur = fromDate.getDay();
                const nextDay = sorted.find(d => d > cur);
                if (nextDay !== undefined) {
                    next.setDate(next.getDate() + (nextDay - cur));
                } else {
                    next.setDate(next.getDate() + 7 - cur + sorted[0]);
                }
            } else {
                next.setDate(next.getDate() + 7 * rule.interval);
            }
            break;
        case 'monthly':
            next.setMonth(next.getMonth() + rule.interval);
            break;
        case 'yearly':
            next.setFullYear(next.getFullYear() + rule.interval);
            break;
    }
    return next;
}

// Хранилище таймеров для напоминаний
const remindersTimers = new Map<string, NodeJS.Timeout>();

// Глобальная ссылка на бот — для reschedule из executor без передачи bot через все слои
let _botRef: Bot<BotContext> | null = null;

export function setBotRef(bot: Bot<BotContext>): void {
    _botRef = bot;
}

export function getBotRef(): Bot<BotContext> | null {
    return _botRef;
}

/**
 * Перепланирует существующее напоминание: отменяет старый таймер и ставит новый.
 * Используется при изменении времени/текста через текстовую команду.
 */
export function rescheduleReminder(reminder: Reminder): void {
    const existing = remindersTimers.get(reminder.id);
    if (existing) {
        clearTimeout(existing);
        remindersTimers.delete(reminder.id);
    }
    const expiry = expiryTimers.get(reminder.id);
    if (expiry) {
        clearTimeout(expiry);
        expiryTimers.delete(reminder.id);
    }
    if (_botRef) {
        scheduleReminder(_botRef, reminder);
    } else {
        console.error('[reminder] rescheduleReminder: _botRef not set');
    }
}

// Хранилище таймеров для проверки истечения срока напоминаний
const expiryTimers = new Map<string, NodeJS.Timeout>();

function logReminderEvent(event: string, reminder: Reminder) {
    const chatRef = Math.abs(reminder.chatId) % 10000;
    console.info(`[reminder] event=${event} id=${reminder.id} chatRef=${chatRef} status=${reminder.status || "pending"} due=${new Date(reminder.dueDate).toISOString()}`);
}

/**
 * Восстанавливает напоминание из БД после рестарта без повторной отправки уже сработавшего уведомления.
 */
export function restoreReminderAfterRestart(bot: Bot<BotContext>, reminder: Reminder): void {
    try {
        if (!reminder.createdAt) {
            reminder.createdAt = new Date();
        }
        if (!reminder.status) {
            reminder.status = ReminderStatus.Pending;
        }

        ReminderRegistry.getInstance().add(reminder);

        if (reminder.status === ReminderStatus.Sent) {
            const expiryAt = new Date(reminder.dueDate).getTime() + REMINDER_EXPIRY_TIME;
            const delayMs = expiryAt - Date.now();

            if (delayMs <= 0) {
                handleExpiredReminder(bot, reminder).catch(e => console.error("[reminder] restore expiry failed:", e));
            } else {
                scheduleExpiryCheck(bot, reminder, delayMs);
                logReminderEvent("restored_sent", reminder);
            }
            return;
        }

        if (reminder.status === ReminderStatus.Expired) {
            logReminderEvent("restored_expired", reminder);
            return;
        }

        scheduleReminder(bot, reminder);
    } catch (error) {
        console.error("Error restoring reminder after restart:", error);
    }
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
export async function resolveTargetChat(target: ReminderTargetChat): Promise<{ chatId: number; label: string } | null> {
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

        // Префикс-строка перед телом напоминания: ⏰ «Напомнила…» / ⚠️ «Не удалось найти…»
        let prefix: string | null = null;
        let targetLabel: string | null = null;

        // Адресату отправляем только после явного согласия владельца при создании напоминания.
        if (reminder.targetChat && reminder.targetChatNotifyStatus === "enabled") {
            const resolved = await resolveTargetChat(reminder.targetChat);
            if (resolved) {
                const client = await initTelegramClient();
                if (client) {
                    const textToSend = reminder.targetDisplayText || buildDefaultTargetReminderMessage(reminder.text);
                    if (reminder.targetChat.type === "group") {
                        await sendMessageToChat(client, resolved.chatId, textToSend);
                    } else {
                        await sendMessage(client, resolved.chatId, textToSend, false, null);
                    }
                    targetLabel = resolved.label;
                    prefix = `⏰ Напомнила тебе и оповестила «${resolved.label}»:`;
                    devLog(`Reminder sent to target chat "${resolved.label}" (${resolved.chatId})`);
                }
            } else {
                const targetDesc = reminder.targetChat.type === "group"
                    ? `группа: ${reminder.targetChat.groupName}`
                    : `контакт: ${reminder.targetChat.contactQuery}`;
                prefix = `⚠️ Не удалось найти чат для напоминания (${targetDesc}). Напоминание здесь:`;
            }
        }

        // В групповых чатах (chatId < 0) не добавляем кнопки —
        // посторонние могут нажимать их и вызывать спам-ответы бота
        const isGroupReminder = reminder.chatId < 0;

        const keyboard = isGroupReminder ? undefined : new InlineKeyboard()
            .text("✅ Выполнено", `reminder_complete_${reminder.id}`)
            .text("⏰ Напомнить позже", `reminder_postpone_${reminder.id}`)
            .row()
            .text("✏️ Изменить", `reminder_edit_${reminder.id}`)
            .text("❌ Отменить", `reminder_cancel_${reminder.id}`);

        const blocks: RichBlock[] = [];
        if (prefix) blocks.push({ type: "paragraph", text: esc(prefix) });
        blocks.push(blockquote(esc(messageText)));

        const sentMessage = await sendStructured(
            bot.api as any,
            reminder.chatId,
            blocks,
            keyboard ? { replyMarkup: keyboard } : {},
        );

        // Сохраняем ID сообщения для последующих обновлений
        reminder.messageId = (sentMessage as { message_id?: number })?.message_id;
        reminder.status = ReminderStatus.Sent;

        // Сохраняем обновлённый статус в БД
        ReminderRepository.update(reminder).catch(e => console.error('[reminder] DB update failed on send:', e));

        // Устанавливаем таймер для проверки истечения срока напоминания
        scheduleExpiryCheck(bot, reminder);

        // Если задано повторение — сразу создаём и планируем следующее
        if (reminder.recurrence) {
            const nextDue = getNextOccurrence(new Date(reminder.dueDate), reminder.recurrence);
            const nextReminder: Reminder = {
                ...reminder,
                id: `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`,
                dueDate: nextDue,
                status: ReminderStatus.Pending,
                messageId: undefined,
                remindAgainAt: undefined,
                createdAt: new Date(),
            };
            ReminderRegistry.getInstance().add(nextReminder);
            ReminderRepository.save(nextReminder).catch(e => console.error('[reminder] DB save failed on recurrence:', e));
            scheduleReminder(bot, nextReminder);
            createOrRefreshReminderMemoryForUserId(String(config.allowedUserId), nextReminder)
                .catch((e) => console.error('[reminder] memory sync failed on recurrence:', e));
            logReminderEvent("scheduled_next_recurrence", nextReminder);
        }

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
function scheduleExpiryCheck(bot: Bot<BotContext>, reminder: Reminder, delayMs: number = REMINDER_EXPIRY_TIME): void {
    try {
        // Устанавливаем таймер для проверки истечения срока напоминания
        const expiryTimerId = setTimeout(() => {
            // Если напоминание все еще в статусе "отправлено", считаем его просроченным
            if (reminder.status === ReminderStatus.Sent) {
                handleExpiredReminder(bot, reminder);
            }

            // Удаляем таймер из хранилища
            expiryTimers.delete(reminder.id);
        }, delayMs);

        // Сохраняем таймер в хранилище
        expiryTimers.set(reminder.id, expiryTimerId);

        devLog(`Scheduled expiry check for reminder ${reminder.id} in ${Math.round(delayMs / 60000)} minutes`);
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

        // Отменяем таймер напоминания, если оно было выполнено до срабатывания
        const timer = remindersTimers.get(reminder.id);
        if (timer) {
            clearTimeout(timer);
            remindersTimers.delete(reminder.id);
        }

        // Отменяем таймер проверки истечения срока, если он существует
        const expiryTimer = expiryTimers.get(reminder.id);
        if (expiryTimer) {
            clearTimeout(expiryTimer);
            expiryTimers.delete(reminder.id);
        }

        // Обновляем сообщение с напоминанием, если есть ID сообщения
        if (reminder.messageId) {
            try {
                const updatedText = reminder.displayText || reminder.text;
                // Обновляем сообщение без клавиатуры: отметка «✅ Выполнено» + тело в blockquote.
                await editStructured(
                    bot.api as any,
                    reminder.chatId,
                    reminder.messageId,
                    [
                        { type: "paragraph", text: "<b>✅ Выполнено</b>" },
                        blockquote(esc(updatedText)),
                    ],
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
    const newDueDate = new Date();
    newDueDate.setMinutes(newDueDate.getMinutes() + postponeTime);
    return postponeReminderUntil(bot, reminder, newDueDate);
}

/**
 * Откладывает напоминание до конкретной даты.
 */
export async function postponeReminderUntil(
    bot: Bot<BotContext>,
    reminder: Reminder,
    newDueDate: Date
): Promise<Reminder | null> {
    try {
        // Отменяем старую запланированную отправку, если перенос делается из списка до срабатывания
        const timer = remindersTimers.get(reminder.id);
        if (timer) {
            clearTimeout(timer);
            remindersTimers.delete(reminder.id);
        }

        // Отменяем таймер проверки истечения срока, если он существует
        const expiryTimer = expiryTimers.get(reminder.id);
        if (expiryTimer) {
            clearTimeout(expiryTimer);
            expiryTimers.delete(reminder.id);
        }

        // Обновляем статус и счётчик откладываний
        reminder.status = ReminderStatus.Postponed;
        reminder.postponeCount = (reminder.postponeCount ?? 0) + 1;

        reminder.dueDate = newDueDate;
        reminder.remindAgainAt = newDueDate;

        // Обновляем сообщение с информацией об отложенном напоминании
        if (reminder.messageId) {
            try {
                const updatedText = reminder.displayText || reminder.text;
                const formattedTime = newDueDate.toLocaleString('ru-RU', {
                    timeZone: USER_TIMEZONE,
                    hour: 'numeric',
                    minute: 'numeric'
                });

                // Обновляем сообщение без клавиатуры: «⏰ Отложено до …» + тело в blockquote.
                await editStructured(
                    bot.api as any,
                    reminder.chatId,
                    reminder.messageId,
                    [
                        { type: "paragraph", text: `<b>⏰ Отложено до ${esc(formattedTime)}</b>` },
                        blockquote(esc(updatedText)),
                    ],
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

        // Эскалация: после 3+ откладываний предлагаем разбить задачу
        if (reminder.postponeCount === 3) {
            const escalationMessages = [
                `Ты уже ${reminder.postponeCount} раза откладывала это 🤔\n\n"${reminder.displayText || reminder.text}"\n\nМожет, разобьём на маленькие шаги? Или просто отменим, если оно больше не актуально?`,
                `Кажется, это задание никак не хочет выполняться 😅 Ты откладывала его уже ${reminder.postponeCount} раза.\n\n"${reminder.displayText || reminder.text}"\n\nХочешь — помогу переформулировать или разбить на части?`,
                `Это напоминание уже ${reminder.postponeCount} раза просит о внимании 💭\n\n"${reminder.displayText || reminder.text}"\n\nМожет, оно стало неактуальным? Или нужна помощь с тем, как к нему подступиться?`,
            ];
            const msg = escalationMessages[Math.floor(Math.random() * escalationMessages.length)];
            bot.api.sendMessage(reminder.chatId, msg).catch(e => console.error('[reminder] escalation message failed:', e));
            logReminderEvent("escalation", reminder);
        }

        // Планируем отправку отложенного напоминания
        scheduleReminder(bot, reminder);

        devLog(`Reminder ${reminder.id} postponed to ${newDueDate.toLocaleString('ru-RU', { timeZone: USER_TIMEZONE })}`);
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
