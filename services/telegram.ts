import { Api, TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { ContactsStore } from "../stores/ContactsStore";
import { MessageTracker } from "../MessageTracker";
import { devLog } from "../utils";
import { config } from "../config";
import { Api as GrammyApi } from "grammy";

let botApi: GrammyApi | null = null;

/**
 * Сохраняет ссылку на Bot API (grammy) для отправки сообщений от имени бота в группы,
 * где бот является участником.
 */
export function setBotApi(api: GrammyApi): void {
    botApi = api;
}

// Хранилище таймеров для запланированных сообщений
const messageTimers = new Map<number, NodeJS.Timeout>();

let telegramClient: TelegramClient | null = null;

/**
 * Инициализирует и устанавливает соединение с клиентом Telegram
 * @returns Подключенный клиент Telegram или undefined при ошибке
 */
export async function initTelegramClient(): Promise<TelegramClient | undefined> {
    try {
        if (telegramClient) {
            return telegramClient;
        }

        // Проверка наличия учетных данных в .env
        const apiId = process.env.TELEGRAM_API_ID;
        const apiHash = process.env.TELEGRAM_API_HASH;
        const sessionString = process.env.TELEGRAM_SESSION_STRING;

        if (!apiId || !apiHash || !sessionString) {
            console.error("Для подключения к аккаунту Telegram необходимо настроить учетные данные в файле .env (TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_SESSION_STRING)");
            return;
        }

        telegramClient = new TelegramClient(
            new StringSession(sessionString),
            parseInt(apiId),
            apiHash,
            {
                connectionRetries: 5,
                useWSS: true
            }
        );

        await telegramClient.connect();

        if (!await telegramClient.isUserAuthorized()) {
            console.error("Пользователь не авторизован в Telegram");
            return;
        }

        // После успешного подключения предзагружаем список контактов
        await preloadContactsList();

        return telegramClient;
    } catch (error) {
        console.error("Ошибка при подключении к аккаунту Telegram:", error);
        return undefined;
    }
}

/**
 * Отправляет сообщение указанному контакту с элегантной подписью
 * @param client Клиент Telegram
 * @param contactId ID контакта в Telegram
 * @param message Текст сообщения
 * @param notifyOnReply Флаг для уведомления о получении ответа
 * @param originalChatId ID чата, куда нужно пересылать ответ
 * @returns Результат отправки с идентификатором сообщения
 */
export async function sendMessage(
    client: TelegramClient,
    contactId: number,
    message: string,
    notifyOnReply: boolean = false,
    originalChatId: number | null = null
): Promise<{ success: boolean, messageId: number | null }> {
    try {
        // Добавляем подпись к сообщению
        const botName = config.characterName || "Кира";
        const botUsername = config.botUsername || "KiraMindBot";

        // Элегантная подпись с разделительной линией
        const signature = `\n\n──────────\n✉️ Сообщение от личного ассистента ${botName} | @${botUsername}`;
        const messageWithSignature = message + signature;

        // Отправляем сообщение с подписью
        const sentMessage = await client.sendMessage(contactId, { message: messageWithSignature });
        const messageId = sentMessage.id;
        devLog(`Сообщение отправлено контакту ${contactId}, ID сообщения: ${messageId}`);

        // Обновляем время последнего взаимодействия с контактом
        const contactsStore = ContactsStore.getInstance();
        contactsStore.updateLastInteraction(contactId);

        // Если требуется уведомление о получении ответа, сохраняем информацию о сообщении
        if (notifyOnReply && originalChatId && messageId) {
            // Получаем экземпляр трекера сообщений
            const messageTracker = MessageTracker.getInstance();

            // Добавляем сообщение для отслеживания
            messageTracker.trackMessage(messageId, contactId, originalChatId);
        }

        return { success: true, messageId };
    } catch (error) {
        console.error(`Ошибка при отправке сообщения контакту ${contactId}:`, error);
        return { success: false, messageId: null };
    }
}

/** Результат поиска группы/чата по названию */
export interface GroupChat {
    id: number;
    title: string;
}

/**
 * Ищет группу или канал по названию (точное или частичное совпадение).
 * @param client Клиент Telegram
 * @param titleQuery Название или часть названия группы (например, "Каркас: Leads")
 * @returns Найденная группа или null
 */
export async function searchGroupByTitle(
    client: TelegramClient,
    titleQuery: string
): Promise<GroupChat | null> {
    try {
        const dialogs = await client.getDialogs({});
        const query = titleQuery.trim().toLowerCase();
        for (const dialog of dialogs) {
            if (!dialog.isGroup && !dialog.isChannel) continue;
            const title = (dialog.title || dialog.name || "").trim();
            if (!title) continue;
            // Точное совпадение или название содержит запрос
            if (title.toLowerCase() === query || title.toLowerCase().includes(query)) {
                const id = dialog.id != null ? Number(dialog.id) : undefined;
                if (id === undefined || !Number.isFinite(id)) continue;
                return { id, title };
            }
        }
        // Дополнительный проход: запрос может содержать название группы (например, пользователь ввёл "Каркас: Leads")
        for (const dialog of dialogs) {
            if (!dialog.isGroup && !dialog.isChannel) continue;
            const title = (dialog.title || dialog.name || "").trim().toLowerCase();
            if (!title) continue;
            if (query.includes(title) || title.includes(query)) {
                const id = dialog.id != null ? Number(dialog.id) : undefined;
                if (id === undefined || !Number.isFinite(id)) continue;
                return { id: id, title: (dialog.title || dialog.name || "").trim() };
            }
        }
        return null;
    } catch (error) {
        console.error("Ошибка при поиске группы по названию:", error);
        return null;
    }
}

/**
 * Отправляет сообщение в группу/чат.
 * Если бот является участником группы — отправляет через Bot API (от имени бота).
 * Иначе — через личный аккаунт пользователя (MTProto).
 * @param client Клиент Telegram
 * @param chatId ID чата (группы/супергруппы/канала) в формате MTProto
 * @param message Текст сообщения
 * @returns Результат отправки
 */
export async function sendMessageToChat(
    client: TelegramClient,
    chatId: number,
    message: string
): Promise<{ success: boolean, messageId: number | null }> {
    try {
        const botName = config.characterName || "Кира";
        const botUsername = config.botUsername || "KiraMindBot";
        const signature = `\n\n──────────\n✉️ ${botName} | @${botUsername}`;
        const messageWithSignature = message + signature;

        // Пробуем отправить через Bot API, если бот является участником этой группы
        if (botApi) {
            try {
                const sent = await botApi.sendMessage(chatId, messageWithSignature);
                devLog(`Сообщение отправлено в чат ${chatId} через Bot API, ID сообщения: ${sent.message_id}`);
                return { success: true, messageId: sent.message_id };
            } catch (botApiError: any) {
                devLog(`Bot API не смог отправить в чат ${chatId} (бот не в группе?): ${botApiError?.message}. Отправляю через личный аккаунт...`);
            }
        }

        // Fallback: отправляем через личный аккаунт пользователя (MTProto)
        const sentMessage = await client.sendMessage(chatId, { message: messageWithSignature });
        const messageId = sentMessage.id;
        devLog(`Сообщение отправлено в чат ${chatId} через MTProto, ID сообщения: ${messageId}`);
        return { success: true, messageId };
    } catch (error) {
        console.error(`Ошибка при отправке сообщения в чат ${chatId}:`, error);
        return { success: false, messageId: null };
    }
}

/**
 * Планирует отправку сообщения контакту
 * @param contactId ID контакта
 * @param message Текст сообщения
 * @param scheduledTime Время отправки
 * @param notifyOnReply Флаг для уведомления о получении ответа
 * @param originalChatId ID чата, куда нужно пересылать ответ
 * @returns ID запланированного сообщения или null при ошибке
 */
export function scheduleMessageSend(
    contactId: number,
    message: string,
    scheduledTime: Date,
    notifyOnReply: boolean = false,
    originalChatId: number | null = null
): number | null {
    try {
        // Получаем хранилище контактов
        const contactsStore = ContactsStore.getInstance();

        // Проверяем, существует ли контакт
        const contact = contactsStore.getContact(contactId);
        if (!contact) {
            console.error(`Контакт с ID ${contactId} не найден`);
            return null;
        }

        // Планируем сообщение с дополнительной информацией
        const scheduledMessage = contactsStore.scheduleMessage(
            contactId,
            message,
            scheduledTime,
            notifyOnReply,
            originalChatId
        );

        devLog(`Запланировано сообщение #${scheduledMessage.id} для контакта ${contactId} на ${scheduledTime.toLocaleString()}`);

        // Вычисляем время до отправки
        const now = new Date();
        const timeUntilSend = scheduledTime.getTime() - now.getTime();

        if (timeUntilSend <= 0) {
            // Если время уже наступило, отправляем сразу
            sendScheduledMessage(scheduledMessage.id);
        } else {
            // Устанавливаем таймер для отправки
            const timerId = setTimeout(() => {
                sendScheduledMessage(scheduledMessage.id);
                // Удаляем таймер из хранилища после отправки
                messageTimers.delete(scheduledMessage.id);
            }, timeUntilSend);

            // Сохраняем таймер в хранилище
            messageTimers.set(scheduledMessage.id, timerId);
        }

        return scheduledMessage.id;
    } catch (error) {
        console.error("Ошибка при планировании отправки сообщения:", error);
        return null;
    }
}

/**
 * Отправляет запланированное сообщение
 * @param messageId ID запланированного сообщения
 * @returns Успешность операции
 */
export async function sendScheduledMessage(messageId: number): Promise<boolean> {
    try {
        // Получаем хранилище контактов
        const contactsStore = ContactsStore.getInstance();

        // Получаем запланированное сообщение
        const message = contactsStore.getScheduledMessage(messageId);
        if (!message || message.status !== 'pending') {
            console.error(`Запланированное сообщение #${messageId} не найдено или уже отправлено/отменено`);
            return false;
        }

        // Инициализируем клиент Telegram
        const client = await initTelegramClient();
        if (!client) {
            console.error(`Не удалось инициализировать клиент Telegram для отправки сообщения #${messageId}`);
            contactsStore.updateMessageStatus(messageId, 'failed');
            return false;
        }

        // Отправляем сообщение
        const sendResult = await sendMessage(
            client,
            message.contactId,
            message.text,
            message.notifyOnReply || false,
            message.originalChatId || null
        );

        // Обновляем статус сообщения
        if (sendResult.success) {
            contactsStore.updateMessageStatus(messageId, 'sent');
            if (sendResult.messageId) {
                contactsStore.updateMessageId(messageId, sendResult.messageId);
            }
        } else {
            contactsStore.updateMessageStatus(messageId, 'failed');
        }

        return sendResult.success;
    } catch (error) {
        console.error(`Ошибка при отправке запланированного сообщения #${messageId}:`, error);
        // Получаем хранилище контактов и обновляем статус сообщения
        const contactsStore = ContactsStore.getInstance();
        contactsStore.updateMessageStatus(messageId, 'failed');
        return false;
    }
}

/**
 * Отменяет запланированное сообщение
 * @param messageId ID запланированного сообщения
 * @returns Успешность операции
 */
export function cancelScheduledMessage(messageId: number): boolean {
    try {
        // Получаем хранилище контактов
        const contactsStore = ContactsStore.getInstance();

        // Получаем запланированное сообщение
        const message = contactsStore.getScheduledMessage(messageId);
        if (!message || message.status !== 'pending') {
            console.error(`Запланированное сообщение #${messageId} не найдено или уже отправлено/отменено`);
            return false;
        }

        // Отменяем таймер, если он существует
        const timer = messageTimers.get(messageId);
        if (timer) {
            clearTimeout(timer);
            messageTimers.delete(messageId);
        }

        // Обновляем статус сообщения
        return contactsStore.cancelScheduledMessage(messageId);
    } catch (error) {
        console.error(`Ошибка при отмене запланированного сообщения #${messageId}:`, error);
        return false;
    }
}

/**
 * Предзагружает список контактов в хранилище при инициализации клиента
 */
export async function preloadContactsList(): Promise<void> {
    try {
        if (!telegramClient || !await telegramClient.isUserAuthorized()) {
            console.error("Клиент Telegram не инициализирован или не авторизован");
            return;
        }

        // Получаем хранилище контактов
        const contactsStore = ContactsStore.getInstance();

        // Синхронизируем контакты
        const syncedCount = await contactsStore.syncContactsFromTelegram(telegramClient);
        devLog(`Предзагружено ${syncedCount} контактов в хранилище`);

    } catch (error) {
        console.error("Ошибка при предзагрузке списка контактов:", error);
    }
}

/**
 * Проверяет, находится ли пользователь в контактах владельца аккаунта
 * @param userId ID пользователя Telegram
 * @returns Promise<boolean> - true если пользователь в контактах, false если нет
 */
export async function isUserInContacts(userId: number): Promise<boolean> {
    try {
        // Получаем хранилище контактов
        const contactsStore = ContactsStore.getInstance();

        // Проверяем инициализировано ли хранилище контактов
        if (!contactsStore.isReady()) {
            // Если нет, пробуем инициализировать клиент и загрузить контакты
            if (!telegramClient) {
                await initTelegramClient();
            }

            if (telegramClient) {
                await preloadContactsList();
            } else {
                console.error("Не удалось инициализировать клиент Telegram");
                return false;
            }
        }

        // Ищем контакт с указанным userId
        const contacts = contactsStore.getAllContacts();
        return contacts.some(contact => contact.id === userId);

    } catch (error) {
        console.error("Ошибка при проверке контактов пользователя:", error);
        return false;
    }
}

/**
 * Периодическая очистка старых запланированных сообщений
 * Вызывается автоматически раз в день
 */
export function cleanupOldScheduledMessages(): void {
    try {
        const contactsStore = ContactsStore.getInstance();
        const cleanedCount = contactsStore.cleanupOldMessages(30); // Хранить историю 30 дней

        if (cleanedCount > 0) {
            devLog(`Очищено ${cleanedCount} старых запланированных сообщений`);
        }
    } catch (error) {
        console.error("Ошибка при очистке старых запланированных сообщений:", error);
    }
}

// Настраиваем периодическую очистку старых сообщений
setInterval(cleanupOldScheduledMessages, 24 * 60 * 60 * 1000); // Каждые 24 часа