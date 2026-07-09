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
let telegramClientInitPromise: Promise<TelegramClient | undefined> | null = null;
let preloadContactsPromise: Promise<void> | null = null;
let telegramClientLastError: string | null = null;
let telegramClientLastErrorAt: string | null = null;
let telegramClientLastReadyAt: string | null = null;
let telegramClientInitStartedAt: string | null = null;

interface TelegramUserClientCredentials {
    apiId: number;
    apiHash: string;
    sessionString: string;
}

interface TelegramClientInitOptions {
    preloadContacts?: boolean;
    silent?: boolean;
}

interface PreloadContactsOptions {
    client?: TelegramClient;
    silent?: boolean;
}

type TelegramHealthStatus = 'ok' | 'warn' | 'down' | 'disabled';

interface TelegramClientDiagnosticState {
    connected?: boolean;
    disconnected?: boolean;
    session?: {
        dcId?: number;
    };
    _reconnecting?: boolean;
    _sender?: {
        _reconnecting?: boolean;
        _disconnected?: boolean;
        _connection?: {
            _ip?: string;
            _port?: number;
            _dcId?: number;
        };
    };
}

export interface TelegramUserClientHealth {
    status: TelegramHealthStatus;
    summary: string;
    details: string;
    checkedAt: string;
    configured: boolean;
    connected: boolean;
    authorized: boolean;
    reconnecting: boolean;
    dc: number | null;
    endpoint: string | null;
    error: string | null;
    lastReadyAt: string | null;
    lastErrorAt: string | null;
}

function resolveTelegramHealthState(
    connected: boolean,
    authorized: boolean,
    reconnecting: boolean
): { status: TelegramHealthStatus; summary: string; details: string } {
    if (reconnecting) {
        return {
            status: 'warn',
            summary: 'Telegram user-client подключён, но находится в reconnect-состоянии.',
            details: 'Клиент держит reconnect-loop и ещё не восстановил стабильное соединение.',
        };
    }

    if (connected && authorized) {
        return {
            status: 'ok',
            summary: 'Telegram user-client подключён и авторизован.',
            details: 'Клиент прошёл connect() и isUserAuthorized().',
        };
    }

    if (authorized) {
        return {
            status: 'warn',
            summary: 'Telegram user-client авторизован, но соединение сейчас не активно.',
            details: 'Сессия валидна, но transport-соединение ещё не восстановилось.',
        };
    }

    return {
        status: 'down',
        summary: 'Telegram user-client не готов к работе.',
        details: 'Клиент не подтвердил готовность.',
    };
}

function getTelegramUserClientCredentials(): TelegramUserClientCredentials | null {
    const rawApiId = process.env.TELEGRAM_API_ID?.trim();
    const apiHash = process.env.TELEGRAM_API_HASH?.trim();
    const sessionString = process.env.TELEGRAM_SESSION_STRING?.trim();

    if (!rawApiId || !apiHash || !sessionString) {
        return null;
    }

    const apiId = Number(rawApiId);
    if (!Number.isFinite(apiId)) {
        return null;
    }

    return {
        apiId,
        apiHash,
        sessionString,
    };
}

function rememberTelegramClientError(error: unknown): void {
    telegramClientLastError = error instanceof Error ? error.message : String(error);
    telegramClientLastErrorAt = new Date().toISOString();
}

function clearTelegramClientError(): void {
    telegramClientLastError = null;
    telegramClientLastErrorAt = null;
}

function logTelegramClientMessage(message: string, error?: unknown, silent: boolean = false): void {
    if (silent) {
        return;
    }

    if (error !== undefined) {
        console.error(message, error);
        return;
    }

    console.error(message);
}

function buildTelegramClientDiagnostics(client: TelegramClient | null): {
    connected: boolean;
    reconnecting: boolean;
    dc: number | null;
    endpoint: string | null;
} {
    if (!client) {
        return {
            connected: false,
            reconnecting: false,
            dc: null,
            endpoint: null,
        };
    }

    const diagnosticClient = client as TelegramClient & TelegramClientDiagnosticState;
    const sender = diagnosticClient._sender;
    const connection = sender?._connection;
    const dc = connection?._dcId ?? diagnosticClient.session?.dcId ?? null;
    const endpoint = connection?._ip && connection?._port
        ? `${connection._ip}:${connection._port}`
        : null;

    return {
        connected: Boolean(diagnosticClient.connected) && !Boolean(diagnosticClient.disconnected),
        reconnecting: Boolean(diagnosticClient._reconnecting || sender?._reconnecting),
        dc: typeof dc === 'number' ? dc : null,
        endpoint,
    };
}

function createTelegramClient(credentials: TelegramUserClientCredentials): TelegramClient {
    return new TelegramClient(
        new StringSession(credentials.sessionString),
        credentials.apiId,
        credentials.apiHash,
        {
            connectionRetries: 5,
            useWSS: true,
        }
    );
}

async function disconnectTelegramClientSafely(client: TelegramClient): Promise<void> {
    try {
        await client.disconnect();
    } catch {
        // ignore cleanup errors
    }
}

async function connectAndAuthorizeTelegramClient(
    client: TelegramClient,
    options: { timeoutMs?: number } = {}
): Promise<boolean> {
    const initPromise = (async () => {
        await client.connect();
        return client.isUserAuthorized();
    })();

    if (!options.timeoutMs) {
        return initPromise;
    }

    return new Promise<boolean>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`TIMEOUT after ${options.timeoutMs}ms`)), options.timeoutMs);

        initPromise.then(
            (authorized) => {
                clearTimeout(timer);
                resolve(authorized);
            },
            (error: unknown) => {
                clearTimeout(timer);
                reject(error);
            }
        );
    });
}

/**
 * Инициализирует и устанавливает соединение с клиентом Telegram
 * @returns Подключенный клиент Telegram или undefined при ошибке
 */
export async function initTelegramClient(options: TelegramClientInitOptions = {}): Promise<TelegramClient | undefined> {
    const { preloadContacts = true, silent = false } = options;

    if (telegramClient) {
        const diagnostics = buildTelegramClientDiagnostics(telegramClient);
        if (diagnostics.connected && !diagnostics.reconnecting) {
            const authorized = await telegramClient.isUserAuthorized().catch(() => false);
            if (authorized) {
                if (preloadContacts) {
                    await preloadContactsList({ client: telegramClient, silent });
                }
                return telegramClient;
            }
            await disconnectTelegramClientSafely(telegramClient);
            telegramClient = null;
        }
    }

    if (telegramClientInitPromise) {
        const client = await telegramClientInitPromise;
        if (client && preloadContacts) {
            await preloadContactsList({ client, silent });
        }
        return client;
    }

    telegramClientInitStartedAt = new Date().toISOString();
    telegramClientInitPromise = (async () => {
        const credentials = getTelegramUserClientCredentials();
        if (!credentials) {
            logTelegramClientMessage(
                "Для подключения к аккаунту Telegram необходимо настроить учетные данные в файле .env (TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_SESSION_STRING)",
                undefined,
                silent
            );
            return undefined;
        }

        const client = telegramClient ?? createTelegramClient(credentials);
        const shouldCleanupClient = telegramClient == null;

        try {
            if (!await connectAndAuthorizeTelegramClient(client)) {
                rememberTelegramClientError("Пользователь не авторизован в Telegram");
                logTelegramClientMessage("Пользователь не авторизован в Telegram", undefined, silent);
                if (shouldCleanupClient) {
                    await disconnectTelegramClientSafely(client);
                }
                telegramClient = null;
                return undefined;
            }

            telegramClient = client;
            clearTelegramClientError();
            telegramClientLastReadyAt = new Date().toISOString();
            return telegramClient;
        } catch (error) {
            rememberTelegramClientError(error);
            if (shouldCleanupClient) {
                await disconnectTelegramClientSafely(client);
            }
            telegramClient = null;
            logTelegramClientMessage("Ошибка при подключении к аккаунту Telegram:", error, silent);
            return undefined;
        }
    })();

    try {
        const client = await telegramClientInitPromise;
        if (client && preloadContacts) {
            await preloadContactsList({ client, silent });
        }
        return client;
    } finally {
        telegramClientInitPromise = null;
        telegramClientInitStartedAt = null;
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
        const botName = config.characterName;
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

/**
 * Отправляет голосовое сообщение указанному контакту от имени Telegram-аккаунта пользователя.
 * Текстовое представление не прикладывается: ассистент представляется внутри самого аудио.
 */
export async function sendVoiceMessage(
    client: TelegramClient,
    contactId: number,
    voiceFilePath: string,
    notifyOnReply: boolean = false,
    originalChatId: number | null = null
): Promise<{ success: boolean, messageId: number | null }> {
    try {
        const sentMessage = await client.sendFile(contactId, {
            file: voiceFilePath,
            voiceNote: true,
        });
        const messageId = sentMessage.id;
        devLog(`Голосовое сообщение отправлено контакту ${contactId}, ID сообщения: ${messageId}`);

        const contactsStore = ContactsStore.getInstance();
        contactsStore.updateLastInteraction(contactId);

        if (notifyOnReply && originalChatId && messageId) {
            const messageTracker = MessageTracker.getInstance();
            messageTracker.trackMessage(messageId, contactId, originalChatId);
        }

        return { success: true, messageId };
    } catch (error) {
        console.error(`Ошибка при отправке голосового сообщения контакту ${contactId}:`, error);
        return { success: false, messageId: null };
    }
}

/** Результат поиска группы/чата по названию */
export interface GroupChat {
    id: number;
    title: string;
}

export interface TelegramReadableChat {
    id: number;
    title: string;
    chatType: 'private' | 'group' | 'channel' | 'unknown';
    username?: string;
}

function dialogChatType(dialog: any): TelegramReadableChat['chatType'] {
    if (dialog.isUser) return 'private';
    if (dialog.isGroup) return 'group';
    if (dialog.isChannel) return 'channel';
    return 'unknown';
}

function dialogTitle(dialog: any): string {
    const entity = dialog.entity || {};
    const title = dialog.title || dialog.name || entity.title;
    if (title) return String(title).trim();

    const nameParts = [entity.firstName || entity.first_name, entity.lastName || entity.last_name]
        .map((part) => String(part || '').trim())
        .filter(Boolean);
    return nameParts.join(' ') || 'Без названия';
}

/**
 * Возвращает чаты, доступные пользовательскому Telegram-аккаунту через MTProto.
 * Используется для источников наблюдений, куда бот может быть не добавлен.
 */
export async function listReadableTelegramChats(limit = 200): Promise<TelegramReadableChat[]> {
    try {
        const client = await initTelegramClient();
        if (!client) return [];

        const dialogs = await client.getDialogs({ limit });
        const result: TelegramReadableChat[] = [];
        const seen = new Set<number>();

        for (const dialog of dialogs as any[]) {
            const id = dialog.id != null ? Number(dialog.id) : NaN;
            if (!Number.isFinite(id) || seen.has(id)) continue;
            seen.add(id);

            const title = dialogTitle(dialog);
            if (!title) continue;

            const username = dialog.entity?.username ? String(dialog.entity.username) : undefined;
            result.push({
                id,
                title,
                chatType: dialogChatType(dialog),
                username,
            });
        }

        return result.sort((a, b) => a.title.localeCompare(b.title, 'ru'));
    } catch (error) {
        console.error("Ошибка при получении списка Telegram-чатов:", error);
        return [];
    }
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
        const botName = config.characterName;
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
 * Отправляет голосовое сообщение в группу/чат через MTProto.
 * Для voice-режима не используем Bot API, чтобы сообщение ушло от аккаунта владельца.
 */
export async function sendVoiceMessageToChat(
    client: TelegramClient,
    chatId: number,
    voiceFilePath: string
): Promise<{ success: boolean, messageId: number | null }> {
    try {
        const sentMessage = await client.sendFile(chatId, {
            file: voiceFilePath,
            voiceNote: true,
        });
        const messageId = sentMessage.id;
        devLog(`Голосовое сообщение отправлено в чат ${chatId} через MTProto, ID сообщения: ${messageId}`);
        return { success: true, messageId };
    } catch (error) {
        console.error(`Ошибка при отправке голосового сообщения в чат ${chatId}:`, error);
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
export async function preloadContactsList(options: PreloadContactsOptions = {}): Promise<void> {
    const { client: providedClient, silent = false } = options;
    const client = providedClient ?? telegramClient;

    if (!client) {
        logTelegramClientMessage("Клиент Telegram не инициализирован или не авторизован", undefined, silent);
        return;
    }

    if (preloadContactsPromise) {
        await preloadContactsPromise;
        return;
    }

    preloadContactsPromise = (async () => {
        try {
            if (!await client.isUserAuthorized()) {
                logTelegramClientMessage("Клиент Telegram не инициализирован или не авторизован", undefined, silent);
                return;
            }

            const contactsStore = ContactsStore.getInstance();
            const syncedCount = await contactsStore.syncContactsFromTelegram(client);
            devLog(`Предзагружено ${syncedCount} контактов в хранилище`);
        } catch (error) {
            rememberTelegramClientError(error);
            logTelegramClientMessage("Ошибка при предзагрузке списка контактов:", error, silent);
        }
    })();

    try {
        await preloadContactsPromise;
    } finally {
        preloadContactsPromise = null;
    }
}

export async function getTelegramUserClientHealth(): Promise<TelegramUserClientHealth> {
    const checkedAt = new Date().toISOString();
    const credentials = getTelegramUserClientCredentials();
    let diagnosticClient: TelegramClient | null = null;

    if (!credentials) {
        return {
            status: 'disabled',
            summary: 'Проверка user-client отключена: TELEGRAM_* настроены не полностью.',
            details: 'Нужны TELEGRAM_API_ID, TELEGRAM_API_HASH и TELEGRAM_SESSION_STRING.',
            checkedAt,
            configured: false,
            connected: false,
            authorized: false,
            reconnecting: false,
            dc: null,
            endpoint: null,
            error: null,
            lastReadyAt: telegramClientLastReadyAt,
            lastErrorAt: telegramClientLastErrorAt,
        };
    }

    const currentDiagnostics = buildTelegramClientDiagnostics(telegramClient);

    if (currentDiagnostics.reconnecting) {
        return {
            status: 'warn',
            summary: 'Telegram user-client сейчас переподключается.',
            details: telegramClientLastError || 'Клиент держит reconnect-loop, но ещё не считается окончательно упавшим.',
            checkedAt,
            configured: true,
            connected: currentDiagnostics.connected,
            authorized: true,
            reconnecting: true,
            dc: currentDiagnostics.dc,
            endpoint: currentDiagnostics.endpoint,
            error: telegramClientLastError,
            lastReadyAt: telegramClientLastReadyAt,
            lastErrorAt: telegramClientLastErrorAt,
        };
    }

    if (telegramClientInitPromise) {
        return {
            status: 'warn',
            summary: 'Telegram user-client ещё инициализируется.',
            details: telegramClientLastError || 'Общая инициализация клиента уже запущена и ещё не завершилась.',
            checkedAt,
            configured: true,
            connected: currentDiagnostics.connected,
            authorized: currentDiagnostics.connected,
            reconnecting: currentDiagnostics.reconnecting,
            dc: currentDiagnostics.dc,
            endpoint: currentDiagnostics.endpoint,
            error: telegramClientLastError,
            lastReadyAt: telegramClientLastReadyAt,
            lastErrorAt: telegramClientLastErrorAt ?? telegramClientInitStartedAt,
        };
    }

    try {
        if (telegramClient) {
            const connected = Boolean(telegramClient.connected) && !telegramClient.disconnected;
            const authorized = await telegramClient.isUserAuthorized();
            const diagnostics = buildTelegramClientDiagnostics(telegramClient);
            const health = resolveTelegramHealthState(connected, authorized, diagnostics.reconnecting);

            return {
                status: health.status,
                summary: health.summary,
                details: telegramClientLastError || health.details,
                checkedAt,
                configured: true,
                connected,
                authorized,
                reconnecting: diagnostics.reconnecting,
                dc: diagnostics.dc,
                endpoint: diagnostics.endpoint,
                error: telegramClientLastError,
                lastReadyAt: telegramClientLastReadyAt,
                lastErrorAt: telegramClientLastErrorAt,
            };
        }

        diagnosticClient = createTelegramClient(credentials);
        const authorized = await connectAndAuthorizeTelegramClient(
            diagnosticClient,
            { timeoutMs: 5000 }
        );
        const connected = Boolean(diagnosticClient.connected) && !diagnosticClient.disconnected;
        const diagnostics = buildTelegramClientDiagnostics(diagnosticClient);
        const health = resolveTelegramHealthState(connected, authorized, diagnostics.reconnecting);

        return {
            status: health.status,
            summary: health.summary,
            details: telegramClientLastError || health.details,
            checkedAt,
            configured: true,
            connected,
            authorized,
            reconnecting: diagnostics.reconnecting,
            dc: diagnostics.dc,
            endpoint: diagnostics.endpoint,
            error: telegramClientLastError,
            lastReadyAt: telegramClientLastReadyAt,
            lastErrorAt: telegramClientLastErrorAt,
        };
    } catch (error) {
        rememberTelegramClientError(error);
        return {
            status: currentDiagnostics.connected ? 'warn' : 'down',
            summary: currentDiagnostics.connected
                ? 'Telegram user-client отвечает нестабильно.'
                : 'Telegram user-client не отвечает.',
            details: toErrorMessage(error),
            checkedAt,
            configured: true,
            connected: currentDiagnostics.connected,
            authorized: currentDiagnostics.connected,
            reconnecting: currentDiagnostics.reconnecting,
            dc: currentDiagnostics.dc,
            endpoint: currentDiagnostics.endpoint,
            error: telegramClientLastError,
            lastReadyAt: telegramClientLastReadyAt,
            lastErrorAt: telegramClientLastErrorAt,
        };
    } finally {
        if (diagnosticClient) {
            await disconnectTelegramClientSafely(diagnosticClient);
        }
    }
}

function toErrorMessage(error: unknown): string {
    if (error instanceof Error && error.message) {
        return error.message;
    }
    return String(error || 'Неизвестная ошибка');
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
const scheduledMessagesCleanupInterval = setInterval(cleanupOldScheduledMessages, 24 * 60 * 60 * 1000); // Каждые 24 часа
scheduledMessagesCleanupInterval.unref();
