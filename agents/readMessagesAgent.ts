import { Api, TelegramClient } from "telegram";
import { NewMessage } from "telegram/events";
import { MessageHistory } from "../types";
import { BotContext } from "../types";
import { MessageClassification, ProcessingResult } from "../orchestrator";
import { initTelegramClient, preloadContactsList, searchGroupByTitle } from "../services/telegram";
import { MessageStore, StoredMessage } from "../stores/MessageStore";
import { devLog, isLikelyBot, notifyUser } from "../utils";
import { MessageTracker } from "../MessageTracker";
import { ContactsStore } from "../stores/ContactsStore";
import {
    NegotiationStore,
    buildNegotiationSummaryText,
    buildNegotiationStopKeyboard,
    type NegotiationSession,
} from "../stores/NegotiationStore";
import { config } from "../config";
import { getBotPersona, getCommunicationStyle } from "../persona";
import { createChatCompletionForTask } from "../ai/chatCompletion";
import { sendMessage as sendTelegramMessage } from "../services/telegram";
import { InlineKeyboard } from "grammy";
import { studyChatAndSaveFacts } from "../utils/studyChatPipeline";
import {
    StudyChatPeriod,
    extractFactsAboutUserFromConversation,
    getMessagesInDateRange,
} from "../utils/studyChatFlow";
import { resolveRelationshipFromMemory } from "../utils/resolveRelationshipFromMemory";
import { runUpdateLongTermMemoryAgent } from "./updateLongTermMemoryAgent";
import { queueMessage as queueForReflection, markChatAsBot } from "../services/reflectionModeService";
import { ChatGroupRepository } from "../services/ChatGroupRepository";
import { persistSessionNow } from "../services/SessionStorage";
import { createIncomingTelegramQueue, type IncomingTelegramQueueJob } from "../services/IncomingTelegramQueue";


// Глобальное хранилище сообщений
const messageStore = MessageStore.getInstance();
const STUDY_CHAT_PERIOD_SELECTION_TTL_MS = 15 * 60 * 1000;
const processingStudyChatRequests = new Set<string>();
const processingChatAnalysisRequests = new Set<string>();

const CHAT_ANALYSIS_PERIOD_DAYS: Record<StudyChatPeriod, number> = {
    week: 7,
    month: 30,
    '3months': 90,
    year: 365,
};

const CHAT_ANALYSIS_PERIOD_LABELS: Record<StudyChatPeriod, string> = {
    week: 'неделю',
    month: 'месяц',
    '3months': 'квартал',
    year: 'год',
};

const CHAT_ANALYSIS_PERIOD_TITLES: Record<StudyChatPeriod, string> = {
    week: 'неделя',
    month: 'месяц',
    '3months': 'квартал',
    year: 'год',
};

const VOICE_CHAT_ANALYSIS_MAX_CHARS = 900;

function getVoiceChatAnalysisInstruction(): string {
    return [
        'Режим голосового ответа: ответ должен быть короткой устной сводкой.',
        `Максимум ${VOICE_CHAT_ANALYSIS_MAX_CHARS} символов, без Markdown, списков, таблиц и длинных цитат.`,
        'Сфокусируйся только на главном: срочное, решения, дедлайны, блокеры и действия, которые ждут от пользователя.',
        'Не пересказывай фоновые обсуждения и не добавляй вступления вроде "я проанализировала".',
    ].join(' ');
}

let isListening: boolean = false;

interface TelegramSenderLike {
    firstName?: string;
    lastName?: string;
    username?: string;
    bot?: boolean;
}

interface TelegramMessageLike {
    id: number;
    chatId?: unknown;
    message?: string;
    date: number;
    media?: {
        className?: string;
    };
    fromId?: unknown;
    peerId?: unknown;
    replyTo?: {
        replyToMsgId?: number;
    };
    getSender?: () => Promise<unknown>;
}

const MAX_PENDING_INCOMING_TELEGRAM_JOBS_PER_CHAT = 20;
const MAX_PENDING_INCOMING_TELEGRAM_JOBS_TOTAL = 120;
const MAX_CONCURRENT_INCOMING_TELEGRAM_WORKERS = 2;
const MAX_INCOMING_TELEGRAM_JOB_AGE_MS = 15 * 60 * 1000;
const INCOMING_QUEUE_WARN_WAIT_MS = 2_000;
const INCOMING_QUEUE_WARN_PROCESS_MS = 5_000;

function toNumberId(value: unknown): number | undefined {
    const id = Number(value);
    return Number.isFinite(id) ? id : undefined;
}

function getTelegramPeerUserId(peer: unknown): unknown {
    if (!peer || typeof peer !== "object") {
        return undefined;
    }

    if (!("userId" in peer)) {
        return undefined;
    }

    return (peer as { userId?: unknown }).userId;
}

function getTelegramMessageChatId(message: TelegramMessageLike): number | undefined {
    return toNumberId(message.chatId ?? getTelegramPeerUserId(message.peerId));
}

function getTelegramMessageSenderId(message: TelegramMessageLike): number | undefined {
    return toNumberId(getTelegramPeerUserId(message.fromId) ?? getTelegramPeerUserId(message.peerId));
}

function getTelegramMessageText(message: TelegramMessageLike): string {
    const text = message.message?.trim() || "";
    const mediaLabel = message.media?.className?.replace("MessageMedia", "").trim();

    if (!mediaLabel) {
        return text;
    }

    if (!text) {
        return `[${mediaLabel}]`;
    }

    return `${text} [${mediaLabel}]`;
}

function buildIncomingStoredMessage(
    message: TelegramMessageLike,
    senderId: number,
    senderName: string,
    senderUsername?: string,
    isBot: boolean = false
): StoredMessage {
    return {
        id: message.id,
        senderId,
        senderName,
        senderUsername,
        text: getTelegramMessageText(message),
        date: new Date(message.date * 1000),
        isRead: false,
        isBot,
    };
}

function buildIncomingPlaceholderMessage(message: TelegramMessageLike, senderId: number): StoredMessage {
    return buildIncomingStoredMessage(
        message,
        senderId,
        "Неизвестный пользователь",
        undefined,
        false
    );
}

function describeTelegramSender(sender: unknown): {
    senderName: string;
    senderUsername?: string;
    isBot: boolean;
} {
    const typedSender = sender as TelegramSenderLike | undefined;
    const senderUsername = typedSender?.username?.trim();
    const senderName = [typedSender?.firstName?.trim(), typedSender?.lastName?.trim()]
        .filter((part): part is string => Boolean(part))
        .join(" ")
        .trim() || senderUsername || "Неизвестный пользователь";

    return {
        senderName,
        senderUsername: senderUsername || undefined,
        isBot: Boolean(typedSender?.bot || (senderUsername && isLikelyBot(senderUsername))),
    };
}

const incomingTelegramQueue = createIncomingTelegramQueue<TelegramMessageLike>({
    concurrency: MAX_CONCURRENT_INCOMING_TELEGRAM_WORKERS,
    getMessageId: (message) => message.id,
    logLabel: "telegram-incoming-queue",
    maxAgeMs: MAX_INCOMING_TELEGRAM_JOB_AGE_MS,
    maxPendingPerChat: MAX_PENDING_INCOMING_TELEGRAM_JOBS_PER_CHAT,
    maxPendingTotal: MAX_PENDING_INCOMING_TELEGRAM_JOBS_TOTAL,
    processJob: processIncomingTelegramMessage,
    warnProcessMs: INCOMING_QUEUE_WARN_PROCESS_MS,
    warnWaitMs: INCOMING_QUEUE_WARN_WAIT_MS,
});

function createStudyChatRequestId(): string {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function getChatAnalysisDateRange(period: StudyChatPeriod): { startDate: Date; endDate: Date } {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - CHAT_ANALYSIS_PERIOD_DAYS[period]);
    return { startDate, endDate };
}

function detectExplicitChatAnalysisPeriod(message: string): StudyChatPeriod | undefined {
    const text = message.toLowerCase();
    if (/(?:за|последн(?:ие|юю|ий|его)?)\s+(?:недел[юяи]|7\s*(?:дн|дней|дня))/iu.test(text)) return 'week';
    if (/(?:за|последн(?:ие|юю|ий|его)?)\s+(?:квартал|3\s*месяц|три\s+месяц)/iu.test(text)) return '3months';
    if (/(?:за|последн(?:ие|юю|ий|его)?)\s+(?:год|12\s*месяц)/iu.test(text)) return 'year';
    if (/(?:за|последн(?:ие|юю|ий|его)?)\s+(?:месяц|30\s*(?:дн|дней|дня))/iu.test(text)) return 'month';
    return undefined;
}

function withChatAnalysisPeriodHeader(text: string, period: StudyChatPeriod, voiceReplyRequested: boolean = false): string {
    if (voiceReplyRequested) {
        return `Коротко за ${CHAT_ANALYSIS_PERIOD_LABELS[period]}: ${text}`;
    }
    return `Период анализа: ${CHAT_ANALYSIS_PERIOD_TITLES[period]}.\n\n${text}`;
}

/**
 * Пытается сгенерировать ответ контакту по задаче и истории или запросить ответ у пользователя.
 * Возвращает true, если обработали (отправили ответ или спросили пользователя).
 */
async function tryGenerateReplyOrAskUser(
    originalChatId: number,
    contactId: number,
    session: NegotiationSession,
    contactText: string,
    contactName: string
): Promise<boolean> {
    const historyLines = session.history
        .slice(-10)
        .map((h) => `${h.role === "bot" ? "Мы" : h.role === "contact" ? "Контакт" : "Пользователь"}: ${h.text}`)
        .join("\n");
    const contactCommunicationContext = session.contactCommunicationContext?.trim()
        ? `\nКонтекст адаптации под собеседника:\n${session.contactCommunicationContext}\n`
        : '';
    const prompt = `
Задача переговоров: ${session.taskDescription}
${contactCommunicationContext}

История переписки (последние сообщения):
${historyLines}

Контакт только что написал: «${contactText}»

Можешь ли ты составить короткий ответ от имени пользователя (естественный, по делу)?
- Если можешь ответить сам, выбери форму, тон и структуру ответа так, чтобы собеседнику было проще понять и принять сообщение.
- Используй контекст адаптации только осторожно: не говори, что знаешь что-то из памяти/портрета, и не раскрывай личные факты без необходимости.
- Не добавляй факты, суммы, даты, обещания или решения, которых нет в задаче, истории или словах пользователя.
- Если для ответа нужны данные от пользователя (сумма, дата, выбор, личное предпочтение) — ответь в формате: {"needUserInput": true, "questionForUser": "краткий вопрос пользователю"}
- Если можешь ответить сам — ответь в формате: {"replyText": "текст ответа контакту"}
Ответь только JSON, без markdown.`;

    try {
        const resp = await createChatCompletionForTask('messageAnalysis', {
            messages: [
                {
                    role: "system",
                    content: `${getBotPersona()} Стиль: ${getCommunicationStyle()}. Ты помогаешь вести переговоры от имени ${config.ownerName}. Отвечай только валидным JSON.`,
                },
                { role: "user", content: prompt },
            ],
            temperature: 1,
        });
        const text = (resp.choices[0]?.message?.content || "").trim();
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return false;
        const data = JSON.parse(jsonMatch[0]) as { needUserInput?: boolean; questionForUser?: string; replyText?: string };
        if (data.needUserInput && data.questionForUser) {
            session.waitingForUserReply = true;
            NegotiationStore.update(originalChatId, contactId, { waitingForUserReply: true });
            const summaryText = buildNegotiationSummaryText(session, {
                appendWaiting: `${data.questionForUser}\n\nНапиши ответ сюда или нажми «Завершить».`,
            });
            if (session.summaryChatId != null && session.summaryMessageId != null) {
                await NegotiationStore.editSummary(
                    session.summaryChatId,
                    session.summaryMessageId,
                    summaryText,
                    buildNegotiationStopKeyboard()
                );
            } else {
                const msg = `📩 ${contactName} написал: «${contactText}»\n\n${data.questionForUser}\n\nНапиши ответ сюда или «отмена».`;
                await NegotiationStore.notifyUser(originalChatId, msg);
            }
            return true;
        }
        if (data.replyText) {
            const client = await initTelegramClient();
            if (!client) return false;
            const sendResult = await sendTelegramMessage(client, contactId, data.replyText, true, originalChatId);
            if (!sendResult.success) return false;
            session.history.push({ role: "bot", text: data.replyText, at: new Date() });
            session.lastSentMessageId = sendResult.messageId ?? undefined;
            NegotiationStore.update(originalChatId, contactId, {
                history: session.history,
                lastSentMessageId: session.lastSentMessageId,
            });
            if (session.summaryChatId != null && session.summaryMessageId != null) {
                const summaryText = buildNegotiationSummaryText(session);
                await NegotiationStore.editSummary(
                    session.summaryChatId,
                    session.summaryMessageId,
                    summaryText,
                    buildNegotiationStopKeyboard()
                );
            }
            return true;
        }
    } catch (e) {
        console.error("tryGenerateReplyOrAskUser error", e);
    }
    return false;
}

function handleIncomingMessageEvent(event: { message?: TelegramMessageLike; isPrivate?: boolean }): void {
    try {
        const message = event.message;
        if (!message) {
            return;
        }

        const chatId = getTelegramMessageChatId(message);
        const senderId = getTelegramMessageSenderId(message);
        if (chatId === undefined || senderId === undefined) {
            return;
        }

        if (senderId.toString() === String(config.allowedUserId)) {
            devLog(`Пропускаем сообщение из "Избранного" (self-chat): ${getTelegramMessageText(message) || "[Медиа]"}`);
            return;
        }

        messageStore.addMessage(String(chatId), buildIncomingPlaceholderMessage(message, senderId));

        incomingTelegramQueue.enqueue({
            chatId,
            enqueuedAt: Date.now(),
            message,
            onDiscard: () => {
                messageStore.removeMessage(String(chatId), message.id);
            },
        });
    } catch (error) {
        console.error("Ошибка при быстром приёме нового сообщения:", error);
    }
}

async function processIncomingTelegramMessage(job: IncomingTelegramQueueJob<TelegramMessageLike>): Promise<void> {
    const message = job.message;
    const chatId = job.chatId;
    const senderId = getTelegramMessageSenderId(message);

    if (senderId === undefined) {
        return;
    }

    let senderName = "Неизвестный пользователь";
    let senderUsername: string | undefined;
    let isBot = false;

    try {
        const sender = await message.getSender?.();
        const described = describeTelegramSender(sender);
        senderName = described.senderName;
        senderUsername = described.senderUsername;
        isBot = described.isBot;
    } catch (error) {
        console.error("Не удалось получить информацию об отправителе:", error);
    }

    if (isBot) {
        messageStore.removeMessage(String(chatId), message.id);
        devLog(`Пропускаем сообщение от бота: ${senderName}`);
        markChatAsBot(String(chatId));
        return;
    }

    const storedMessage = buildIncomingStoredMessage(
        message,
        senderId,
        senderName,
        senderUsername,
        false
    );

    messageStore.addMessage(String(chatId), storedMessage);

    if (storedMessage.text) {
        queueForReflection(String(chatId), senderName, storedMessage.text, storedMessage.date);
    }

    devLog(`Новое сообщение от ${senderName}: ${storedMessage.text}`);

    const messageTracker = MessageTracker.getInstance();
    const contactIdNum = senderId;

    const tryNegotiation = async (
        originalChatId: number,
        contactId: number,
        trackedMessageId: number
    ): Promise<boolean> => {
        const session = NegotiationStore.get(originalChatId, contactId);
        if (!session) return false;
        session.history.push({ role: "contact", text: storedMessage.text, at: new Date() });
        const handled = await tryGenerateReplyOrAskUser(
            originalChatId,
            contactId,
            session,
            storedMessage.text,
            senderName
        );
        if (handled && !session.waitingForUserReply) {
            messageTracker.stopTracking(trackedMessageId);
        }
        return handled;
    };

    if (message.replyTo && message.replyTo.replyToMsgId) {
        const replyToMessageId = message.replyTo.replyToMsgId;
        const trackedInfo = messageTracker.getTrackedMessageInfo(replyToMessageId);
        if (trackedInfo) {
            devLog(`Получен ответ на отслеживаемое сообщение ${replyToMessageId}`);
            const handled = await tryNegotiation(
                trackedInfo.originalChatId,
                trackedInfo.contactId,
                replyToMessageId
            );
            if (!handled) {
                await forwardReplyToOwner(
                    trackedInfo.originalChatId,
                    senderName,
                    senderUsername,
                    storedMessage.text,
                    message
                );
                messageTracker.stopTracking(replyToMessageId);
            }

            return;
        }
    }

    const latestTrackedInfo = messageTracker.getLatestTrackedMessageForContact(contactIdNum);
    if (latestTrackedInfo) {
        const messageAge = Date.now() - latestTrackedInfo.timestamp.getTime();
        const isRecentEnough = messageAge < 24 * 60 * 60 * 1000;
        if (isRecentEnough) {
            devLog(`Получено сообщение от контакта ${senderId}, которому было отправлено отслеживаемое сообщение`);
            const handled = await tryNegotiation(
                latestTrackedInfo.originalChatId,
                contactIdNum,
                latestTrackedInfo.messageId
            );
            if (!handled) {
                await forwardReplyToOwner(
                    latestTrackedInfo.originalChatId,
                    senderName,
                    senderUsername,
                    storedMessage.text,
                    message
                );
                messageTracker.stopTracking(latestTrackedInfo.messageId);
            }
        }
    }
}

/**
 * Пересылает ответ пользователя владельцу бота
 * @param originalChatId ID чата, куда нужно переслать ответ
 * @param senderName Имя отправителя
 * @param senderUsername Username отправителя (если есть)
 * @param text Текст сообщения
 * @param originalMessage Оригинальное сообщение из Telegram
 */
async function forwardReplyToOwner(
    originalChatId: number,
    senderName: string,
    senderUsername: string | undefined,
    text: string,
    originalMessage: any
): Promise<void> {
    try {
        // Инициализируем клиент Telegram, если он не инициализирован
        const client = await initTelegramClient();
        if (!client) {
            console.error("Не удалось инициализировать клиент Telegram для пересылки ответа");
            return;
        }

        // Формируем заголовок сообщения
        const header = `📬 Получен ответ от ${senderName}${senderUsername ? ` (@${senderUsername})` : ''}:\n\n`;

        // Отправляем уведомление
        await client.sendMessage(originalChatId, {
            message: header + text
        });

        // Если в сообщении есть медиа-контент, пробуем его переслать
        if (originalMessage.media) {
            try {
                await client.forwardMessages(originalChatId, {
                    messages: [originalMessage.id],
                    fromPeer: originalMessage.peerId
                });
                devLog("Медиа-контент успешно переслан");
            } catch (mediaError) {
                console.error("Ошибка при пересылке медиа-контента:", mediaError);
                // Отправляем уведомление о медиа-контенте, если не удалось переслать
                await client.sendMessage(originalChatId, {
                    message: "⚠️ Сообщение содержит медиа-контент, который не удалось переслать."
                });
            }
        }

        devLog(`Ответ успешно переслан владельцу бота (chatId: ${originalChatId})`);
    } catch (error) {
        console.error("Ошибка при пересылке ответа владельцу:", error);
    }
}

/**
 * Обрабатывает исходящие сообщения владельца бота в личных чатах.
 * Сохраняет их в MessageStore (isOwn=true) и добавляет в очередь рефлексии
 * как "Я: text" — чтобы LLM видел обе стороны диалога.
 */
function handleOutgoingMessage(event: { message?: TelegramMessageLike; isPrivate?: boolean }): void {
    try {
        const message = event.message;
        if (!event.isPrivate || !message || !message.chatId) return;

        const text: string = message.message?.trim() || "";
        if (!text) return;

        const chatId = message.chatId;
        const date = new Date(message.date * 1000);
        const ownerName = config.ownerName || 'Я';

        const storedMessage: StoredMessage = {
            id: message.id,
            senderId: config.allowedUserId,
            senderName: ownerName,
            text,
            date,
            isRead: true,
            isBot: false,
            isOwn: true,
        };

        messageStore.addMessage(String(chatId), storedMessage);

        // Добавляем в буфер рефлексии — isOwn=true сигнализирует что это наш текст
        queueForReflection(String(chatId), ownerName, text, date, true);

        devLog(`[outgoing] Сохранено исходящее сообщение в чат ${chatId}: ${text.slice(0, 60)}`);
    } catch (e) {
        devLog('[outgoing] Ошибка обработки исходящего сообщения:', e);
    }
}

async function subscribeToNewMessages(): Promise<void> {
    const telegramClient = await initTelegramClient({ preloadContacts: false });

    if (!telegramClient) {
        console.error("Не удалось инициализировать клиент Telegram");
        return;
    }

    // Предзагружаем контакты
    await preloadContactsList({ client: telegramClient });

    telegramClient.addEventHandler(
        (event) => {
            if (event.isPrivate) {
                handleIncomingMessageEvent(event);
            }
        },
        new NewMessage({ incoming: true })
    );

    // Исходящие сообщения — нужны для полного контекста в режиме рефлексии.
    // Сохраняем в MessageStore (isOwn=true) и очередь рефлексии как "Я: text".
    telegramClient.addEventHandler(
        (event) => {
            if (event.isPrivate) {
                handleOutgoingMessage(event);
            }
        },
        new NewMessage({ outgoing: true })
    );

    isListening = true;
    devLog("Телеграм-клиент успешно подключен и слушает новые сообщения");

    // Настраиваем периодическую очистку старых сообщений
    setInterval(() => {
        messageStore.cleanupOldMessages(7);
    }, 24 * 60 * 60 * 1000); // Каждые 24 часа

}

export function markAllMessagesAsRead(): boolean {
    try {
        // Получаем все непрочитанные сообщения
        const unreadChats = messageStore.getUnreadMessages();

        // Если нет непрочитанных, просто возвращаем true
        if (unreadChats.length === 0) {
            return true;
        }

        // Отмечаем все сообщения как прочитанные
        unreadChats.forEach(chat => {
            messageStore.markAsRead(chat.chatId);
        });

        return true;
    } catch (error) {
        console.error("Ошибка при отметке сообщений как прочитанных:", error);
        return false;
    }
}

export function resetAllMessages(): boolean {
    try {
        // Первым шагом отмечаем все сообщения как прочитанные
        markAllMessagesAsRead();

        // Затем полностью очищаем хранилище сообщений
        messageStore.clear();

        devLog("All Telegram messages have been reset and cleared from memory");
        return true;
    } catch (error) {
        console.error("Error resetting Telegram messages:", error);
        return false;
    }
}

export async function getAnswerFromMessages(
    contactName: string,
    analysisQuery: string,
    memoryContext: string = "",
    voiceReplyRequested: boolean = false
): Promise<string | null> {
    try {
        devLog(`Analyzing conversation with contact "${contactName}" for query: "${analysisQuery}"`);

        // Get the ContactsStore instance
        const contactsStore = ContactsStore.getInstance();

        // Search for the contact by name
        const contacts = contactsStore.searchContactsByName(contactName);

        if (contacts.length === 0) {
            devLog(`No contacts found matching "${contactName}"`);
            return `Не удалось найти контакт "${contactName}" в списке контактов. Пожалуйста, проверьте имя контакта и попробуйте снова.`;
        }

        // If multiple contacts found, use the first one
        // In a production environment, you might want to handle this differently
        const contact = contacts[0];
        devLog(`Found contact: ${contact.firstName} ${contact.lastName || ''} (ID: ${contact.id})`);

        // Initialize Telegram client
        const telegramClient = await initTelegramClient();
        if (!telegramClient) {
            console.error("Failed to initialize Telegram client");
            return "Не удалось подключиться к Telegram. Пожалуйста, проверьте статус подключения и попробуйте снова.";
        }

        // Get conversation history with the contact
        try {
            // Get messages from the contact's chat
            // Using the Telegram API to get messages from a specific chat
            const messages = await telegramClient.getMessages(contact.id, {
                limit: 50  // Get the latest 50 messages
            });

            if (!messages || messages.length === 0) {
                return `Не найдено сообщений в переписке с контактом ${contact.firstName} ${contact.lastName || ''}. Возможно, у вас нет истории сообщений с этим контактом.`;
            }

            devLog(`Retrieved ${messages.length} messages from the conversation`);

            // Format the conversation for analysis
            let conversationContext = `Переписка с ${contact.firstName} ${contact.lastName || ''} (последние ${messages.length} сообщений):\n\n`;

            // Sort messages by date (oldest first)
            const sortedMessages = Array.from(messages).sort((a, b) =>
                new Date(a.date).getTime() - new Date(b.date).getTime()
            );

            sortedMessages.forEach((msg, index) => {
                const messageDate = new Date(msg.date * 1000); // Convert Unix timestamp to Date
                const formattedDate = messageDate.toLocaleString('ru-RU', {
                    day: 'numeric',
                    month: 'numeric',
                    year: 'numeric',
                    hour: 'numeric',
                    minute: 'numeric'
                });

                // Determine the sender (from the message's fromId)
                // Determine if message is from contact
                let isFromContact = false;

                // Check if fromId exists and is an instance of PeerUser
                if (msg.fromId) {
                    isFromContact = false;
                } else {
                    // If fromId is not a PeerUser, it might be a bot or a group message
                    isFromContact = true;
                }

                const sender = isFromContact ? contact.firstName : "Я";

                // Format the message text
                let messageText = msg.message || "";

                // If there's media content, add a description
                if (msg.media) {
                    const mediaType = msg.media.className.replace('MessageMedia', '');
                    messageText += messageText ? ` [${mediaType}]` : `[${mediaType}]`;
                }

                conversationContext += `${index + 1}. [${formattedDate}] ${sender}: ${messageText}\n`;
            });

            // Use OpenAI to analyze the conversation

            const voiceInstruction = voiceReplyRequested ? `\n${getVoiceChatAnalysisInstruction()}\n` : '';
            const prompt = `
            Ниже представлена переписка с контактом ${contact.firstName} ${contact.lastName || ''}:
            
            ${conversationContext}
            
            Запрос пользователя: "${analysisQuery}"
            ${memoryContext ? `Контекст из долговременной памяти (факты о пользователе и его контактах):\n${memoryContext}` : ''}
            ${voiceInstruction}

            Проанализируй эту переписку и дай точный, информативный ответ на запрос пользователя.
            Основывай свой ответ только на информации из представленной переписки.
            Если в переписке нет информации, необходимой для ответа на запрос, честно укажи это.
            `;

            const completionOptions: any = {
                messages: [
                    {
                        role: "system",
                        content: `${getBotPersona()}\nСтиль общения: ${getCommunicationStyle()}\nТы - аналитический помощник, который умеет глубоко анализировать переписки в мессенджерах.
                        Ты внимательно изучаешь историю сообщений и отвечаешь на конкретные вопросы о содержании переписки.
                        Твои ответы основаны только на фактической информации из предоставленных сообщений.
                        Ты умеешь определять контекст разговора, настроение участников, ключевые темы и детали.
                        Твои ответы структурированы, информативны и точны.`
                    },
                    {
                        role: "user",
                        content: prompt
                    }
                ],
                temperature: 0.3,
            };
            if (voiceReplyRequested) completionOptions.max_completion_tokens = 450;

            const response = await createChatCompletionForTask('messageAnalysis', completionOptions);

            const analysisResult = response.choices[0]?.message?.content;

            if (!analysisResult) {
                return "Не удалось проанализировать переписку. Пожалуйста, попробуйте сформулировать запрос иначе.";
            }

            return analysisResult;

        } catch (messageError) {
            console.error("Error retrieving messages:", messageError);
            return "Произошла ошибка при получении сообщений из Telegram. Пожалуйста, попробуйте позже.";
        }

    } catch (error) {
        console.error("Error in getAnswerFromMessages:", error);
        return "Произошла ошибка при анализе переписки. Пожалуйста, попробуйте позже.";
    }
}

/**
 * Формирует список непрочитанных сообщений без обращения к OpenAI
 * @param hours Количество часов для проверки
 * @returns Строку с краткой информацией о сообщениях
 */
export function getUnreadMessagesPreview(hours: number = 24): string | null {
    // Получаем непрочитанные сообщения
    const unreadChats = messageStore.getUnreadMessages();

    const cutoffDate = new Date();
    cutoffDate.setHours(cutoffDate.getHours() - hours);

    // Фильтруем сообщения по времени
    const recentUnreadChats = unreadChats
        .map(chat => ({
            chatId: chat.chatId,
            messages: chat.messages.filter(msg => msg.date >= cutoffDate)
        }))
        .filter(chat => chat.messages.length > 0);

    if (recentUnreadChats.length === 0) {
        return null;
    }

    let preview = `Непрочитанные сообщения за последние ${hours} часов:\n\n`;

    recentUnreadChats.forEach(chat => {
        chat.messages.forEach(msg => {
            const formattedDate = msg.date.toLocaleString('ru-RU');
            const username = msg.senderUsername ? `(@${msg.senderUsername})` : '';
            let text = msg.text;
            if (text.length > 100) {
                text = text.substring(0, 100) + '...';
            }
            preview += `${msg.senderName} ${username} [${formattedDate}]: ${text}\n\n`;
        });
    });

    return preview.trim();
}

/**
 * Получает сводку о новых сообщениях
 * @param hours Количество часов для проверки
 * @returns Сводка о новых сообщениях на естественном языке
 */
export async function getMessagesSummary(hours: number = 24, memoryContext: string = ""): Promise<string | null> {
    try {
        // Получаем сообщения за указанный период
        const recentChats = messageStore.getRecentMessages(hours);

        if (recentChats.length === 0) {
            return null;
        }

        // Формируем контекст для OpenAI
        let messagesContext = `За последние ${hours} часов получены сообщения от ${recentChats.length} пользователей:\n\n`;

        recentChats.forEach(chat => {
            const { messages } = chat;
            if (messages.length > 0) {
                const senderName = messages[0].senderName;
                // Добавляем username только если он существует
                const username = messages[0].senderUsername ? `@${messages[0].senderUsername}` : "";
                // Если username существует, добавляем его в скобках после имени
                messagesContext += `От ${senderName}${username ? ` (${username})` : ""}:\n`;

                messages.forEach(msg => {
                    const formattedDate = msg.date.toLocaleString('ru-RU');
                    messagesContext += `[${formattedDate}] ${msg.text}\n`;
                });

                messagesContext += "\n";
            }
        });

        // Используем OpenAI для суммаризации сообщений
        const prompt = `
        Ниже представлены недавние сообщения от пользователей в мессенджере Telegram:
        
        ${messagesContext}
        ${memoryContext ? `Контекст из долговременной памяти (факты о пользователе и его контактах):\n${memoryContext}` : ''}

        Пожалуйста, суммаризируй эти сообщения в естественной форме.
        Опиши кто и о чем писал, какие темы обсуждались, есть ли важные вопросы или просьбы.
        Сделай акцент на ключевых моментах каждого разговора и выдели самое важное.
        ВАЖНО: Включай в ответ username пользователя в формате @username ТОЛЬКО если он доступен.
        НЕ ДОБАВЛЯЙ @username если его нет в исходных данных! 
        Ответ должен быть лаконичным, структурированным и легко читаемым."
        `;

        const response = await createChatCompletionForTask('messageAnalysis', {
            messages: [
                {
                    role: "system",
                    content: `${getBotPersona()} Стиль общения: ${getCommunicationStyle()} Ты - помощник, который суммаризирует сообщения из Telegram для пользователя.
                    Тебе нужно выделить основную суть сообщений от каждого отправителя.
                    Ты структурируешь информацию по отправителям и выделяешь важные моменты из их сообщений.
                    ВАЖНО: Включай username пользователя в формате @username ТОЛЬКО если он доступен.
                    Никогда не добавляй @username, если его нет в исходных данных!
                    Твоя задача - дать пользователю ясное представление о том, кто и что от него хотел.`
                },
                {
                    role: "user",
                    content: prompt
                }
            ],
            temperature: 0.5,
        });

        // Получаем текст ответа
        const summary = response.choices[0]?.message?.content || "";

        return summary;
    } catch (error) {
        console.error("Ошибка при создании сводки о сообщениях:", error);
        return "Произошла ошибка при создании сводки о сообщениях. Пожалуйста, попробуйте позже.";
    }
}

/**
 * Инициализирует и подключает клиент Telegram к аккаунту автоматически при старте
 */



// Автоматически инициализируем клиент при загрузке модуля
initTelegramClient();

/** Проверяет, просит ли пользователь изучить переписку и сохранить факты (решение принимает LLM-классификатор). */
function isStudyChatSaveFactsRequest(classification?: MessageClassification): boolean {
    if (!classification || classification.details.messagesCheckType !== "ANALYZE_CONVERSATION") return false;
    return classification.details.saveFactsAboutUser === true;
}

/**
 * Клавиатура выбора периода для сценария «изучить переписку и сохранить факты».
 */
export function buildStudyChatPeriodKeyboard(requestId?: string): InlineKeyboard {
    const callback = (period: StudyChatPeriod) =>
        requestId ? `study_chat:${requestId}:${period}` : `study_chat:${period}`;

    return new InlineKeyboard()
        .text("Неделя", callback("week"))
        .text("Месяц", callback("month")).row()
        .text("Квартал", callback("3months"))
        .text("Год", callback("year"));
}

/**
 * Клавиатура выбора периода для анализа групповых чатов.
 */
export function buildChatAnalysisPeriodKeyboard(requestId: string): InlineKeyboard {
    const callback = (period: StudyChatPeriod) => `chat_analysis:${requestId}:${period}`;

    return new InlineKeyboard()
        .text("Неделя", callback("week"))
        .text("Месяц", callback("month")).row()
        .text("Квартал", callback("3months"))
        .text("Год", callback("year"));
}

/**
 * Форматирует сообщения из группового чата в читаемый текст для анализа.
 * Для сообщений владельца ставит "Я:", для остальных — "Участник_<id>:".
 */
function formatGroupMessages(messages: Api.Message[]): string {
    const ownerId = String(config.allowedUserId || '');
    const sorted = Array.from(messages).sort((a, b) => (a.date || 0) - (b.date || 0));
    const lines: string[] = [];
    for (const msg of sorted) {
        const text = msg.message || (msg.media ? '[медиа]' : '');
        if (!text.trim()) continue;
        const fromId = msg.fromId && 'userId' in msg.fromId ? String(msg.fromId.userId) : '';
        const sender = fromId === ownerId ? 'Я' : (fromId ? `Участник_${fromId}` : 'Неизвестный');
        const date = new Date((msg.date || 0) * 1000).toLocaleString('ru-RU');
        lines.push(`[${date}] ${sender}: ${text}`);
    }
    return lines.join('\n');
}

/**
 * Загружает сообщения из группового чата и анализирует их по запросу пользователя.
 */
/**
 * Анализирует групповой чат, возвращает текстовый ответ И сохраняет факты в долговременную память.
 */
async function studyGroupChatAndSaveFacts(
    ctx: BotContext,
    groupName: string,
    analysisQuery: string,
    memoryContext: string,
    period: StudyChatPeriod,
    voiceReplyRequested: boolean = false
): Promise<string> {
    const client = await initTelegramClient();
    if (!client) return "Не удалось подключиться к Telegram. Проверь статус подключения.";

    const group = await searchGroupByTitle(client, groupName);
    if (!group) {
        return `Не нашла групповой чат с названием «${groupName}». Проверь название — оно должно совпадать с тем, что в списке диалогов.`;
    }

    const { startDate, endDate } = getChatAnalysisDateRange(period);
    const messages = await getMessagesInDateRange(group.id, startDate, endDate);
    if (!messages || messages.length === 0) return `В чате «${group.title}» за ${CHAT_ANALYSIS_PERIOD_LABELS[period]} не найдено сообщений.`;

    const conversationText = formatGroupMessages(messages as Api.Message[]);
    if (!conversationText.trim()) return `В чате «${group.title}» нет текстовых сообщений для анализа.`;

    const persona = getBotPersona();
    const style = getCommunicationStyle();
    const memoryBlock = memoryContext ? `\nКонтекст из долговременной памяти (факты о пользователе и его контактах):\n${memoryContext}` : '';
    const voiceInstruction = voiceReplyRequested ? `\n\n${getVoiceChatAnalysisInstruction()}` : '';
    const systemPrompt = `${persona}\n\n${style}${memoryBlock}${voiceInstruction}`.trim();
    const userPrompt = `Ниже — сообщения из группового чата «${group.title}» за ${CHAT_ANALYSIS_PERIOD_LABELS[period]} (${messages.length} сообщений).\n\nЗадача: ${analysisQuery}\n\nСообщения чата:\n${conversationText}`;

    // Параллельно: текстовый анализ + извлечение структурированных фактов
    const analysisCompletionOptions: any = {
        messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
        ],
        temperature: 0.4,
    };
    if (voiceReplyRequested) analysisCompletionOptions.max_completion_tokens = 450;

    const [analysisResult, factsResult] = await Promise.allSettled([
        createChatCompletionForTask('messageAnalysis', analysisCompletionOptions),
        extractFactsAboutUserFromConversation(conversationText, group.title as string, startDate, endDate),
    ]);

    const analysisText = analysisResult.status === 'fulfilled'
        ? (analysisResult.value.choices[0]?.message?.content?.trim() || 'Не удалось проанализировать.')
        : 'Не удалось проанализировать сообщения чата.';

    if (factsResult.status === 'fulfilled' && factsResult.value.length > 0) {
        try {
            const savedCount = await runUpdateLongTermMemoryAgent(ctx, factsResult.value);
            if (savedCount > 0) {
                if (voiceReplyRequested) {
                    const factLabel = savedCount === 1
                        ? 'важный факт'
                        : savedCount < 5
                            ? 'важных факта'
                            : 'важных фактов';
                    return `${analysisText} Я ещё сохранила ${savedCount} ${factLabel} в память.`;
                }
                return `${analysisText}\n\n💾 Сохранила ${savedCount} факт(ов) в долговременную память.`;
            }
        } catch (e) {
            console.error('[studyGroupChatAndSaveFacts] save facts error:', e);
        }
    } else if (factsResult.status === 'rejected') {
        console.error('[studyGroupChatAndSaveFacts] fact extraction failed:', factsResult.reason);
    }

    return analysisText;
}

async function analyzeGroupChatMessages(
    groupName: string,
    analysisQuery: string,
    memoryContext: string,
    period: StudyChatPeriod,
    voiceReplyRequested: boolean = false
): Promise<string> {
    const client = await initTelegramClient();
    if (!client) {
        return "Не удалось подключиться к Telegram. Проверь статус подключения.";
    }

    const group = await searchGroupByTitle(client, groupName);
    if (!group) {
        return `Не нашла групповой чат с названием «${groupName}». Проверь название — оно должно совпадать с тем, что в списке диалогов.`;
    }

    const { startDate, endDate } = getChatAnalysisDateRange(period);
    const messages = await getMessagesInDateRange(group.id, startDate, endDate);
    if (!messages || messages.length === 0) {
        return `В чате «${group.title}» за ${CHAT_ANALYSIS_PERIOD_LABELS[period]} не найдено сообщений.`;
    }

    const conversationText = formatGroupMessages(messages as Api.Message[]);
    if (!conversationText.trim()) {
        return `В чате «${group.title}» нет текстовых сообщений для анализа.`;
    }

    const persona = getBotPersona();
    const style = getCommunicationStyle();
    const memoryBlock2 = memoryContext ? `\nКонтекст из долговременной памяти (факты о пользователе и его контактах):\n${memoryContext}` : '';

    const voiceInstruction = voiceReplyRequested ? `\n\n${getVoiceChatAnalysisInstruction()}` : '';
    const systemPrompt = `${persona}\n\n${style}${memoryBlock2}${voiceInstruction}`.trim();

    const userPrompt = `Ниже — сообщения из группового чата «${group.title}» за ${CHAT_ANALYSIS_PERIOD_LABELS[period]} (${messages.length} сообщений).

Задача: ${analysisQuery}

Сообщения чата:
${conversationText}`;

    const completionOptions: any = {
        messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
        ],
        temperature: 0.4,
    };
    if (voiceReplyRequested) completionOptions.max_completion_tokens = 450;

    const response = await createChatCompletionForTask('messageAnalysis', completionOptions);

    return response.choices[0]?.message?.content?.trim() || "Не удалось проанализировать сообщения чата.";
}

async function analyzeMultipleGroupChats(
    groupNames: string[],
    analysisQuery: string,
    memoryContext: string,
    period: StudyChatPeriod,
    voiceReplyRequested: boolean = false
): Promise<string> {
    const client = await initTelegramClient();
    if (!client) {
        return "Не удалось подключиться к Telegram. Проверь статус подключения.";
    }

    const results = await Promise.all(
        groupNames.map(async (groupName) => {
            const group = await searchGroupByTitle(client, groupName);
            if (!group) {
                return { name: groupName, error: `Чат «${groupName}» не найден` };
            }
            const { startDate, endDate } = getChatAnalysisDateRange(period);
            const messages = await getMessagesInDateRange(group.id, startDate, endDate);
            if (!messages || messages.length === 0) {
                return { name: group.title, error: `В чате «${group.title}» за ${CHAT_ANALYSIS_PERIOD_LABELS[period]} нет сообщений` };
            }
            const conversationText = formatGroupMessages(messages as Api.Message[]);
            if (!conversationText.trim()) {
                return { name: group.title, error: `В чате «${group.title}» нет текстовых сообщений` };
            }
            return { name: group.title, text: conversationText, count: messages.length };
        })
    );

    const errors = results.filter(r => r.error);
    const chats = results.filter(r => r.text);

    if (chats.length === 0) {
        return errors.map(e => e.error).join('\n');
    }

    const persona = getBotPersona();
    const style = getCommunicationStyle();
    const memoryBlock = memoryContext ? `\nКонтекст из долговременной памяти:\n${memoryContext}` : '';
    const voiceInstruction = voiceReplyRequested ? `\n\n${getVoiceChatAnalysisInstruction()}` : '';
    const systemPrompt = `${persona}\n\n${style}${memoryBlock}${voiceInstruction}`.trim();

    const chatSections = chats.map(c =>
        `=== Чат «${c.name}» за ${CHAT_ANALYSIS_PERIOD_LABELS[period]} (${c.count} сообщений) ===\n${c.text}`
    ).join('\n\n');

    const notFoundNote = errors.length > 0
        ? `\n\nПримечание: ${errors.map(e => e.error).join('; ')}.`
        : '';

    const userPrompt = `Ниже — сообщения из ${chats.length} групповых чатов за ${CHAT_ANALYSIS_PERIOD_LABELS[period]}.

Задача: ${analysisQuery}

${chatSections}${notFoundNote}`;

    const completionOptions: any = {
        messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
        ],
        temperature: 0.4,
    };
    if (voiceReplyRequested) completionOptions.max_completion_tokens = 500;

    const response = await createChatCompletionForTask('messageAnalysis', completionOptions);

    return response.choices[0]?.message?.content?.trim() || "Не удалось проанализировать сообщения чатов.";
}

interface ChatAnalysisPeriodRequest {
    requestId: string;
    groupNames: string[];
    displayName: string;
    analysisQuery: string;
    step: 'period';
    saveFactsAboutUser?: boolean;
    offerSaveGroup?: boolean;
    voiceReplyRequested?: boolean;
    memoryContext?: string;
    createdAt: number;
    expiresAt: number;
}

async function runChatAnalysisPeriodRequest(
    ctx: BotContext,
    req: ChatAnalysisPeriodRequest,
    period: StudyChatPeriod
): Promise<ProcessingResult> {
    let answer: string;

    if (req.saveFactsAboutUser && req.groupNames.length === 1) {
        answer = await studyGroupChatAndSaveFacts(
            ctx,
            req.groupNames[0],
            req.analysisQuery,
            req.memoryContext || "",
            period,
            req.voiceReplyRequested === true
        );
    } else if (req.groupNames.length === 1) {
        answer = await analyzeGroupChatMessages(
            req.groupNames[0],
            req.analysisQuery,
            req.memoryContext || "",
            period,
            req.voiceReplyRequested === true
        );
    } else {
        answer = await analyzeMultipleGroupChats(
            req.groupNames,
            req.analysisQuery,
            req.memoryContext || "",
            period,
            req.voiceReplyRequested === true
        );
    }

    const result: ProcessingResult = {
        responseText: withChatAnalysisPeriodHeader(answer, period, req.voiceReplyRequested === true),
        voiceReplyRequested: req.voiceReplyRequested === true,
    };

    if (req.offerSaveGroup && ctx.session) {
        ctx.session.chatGroupState = { step: 'awaiting_name', pendingChatNames: req.groupNames };
        await persistSessionNow(ctx);
        result.keyboard = new InlineKeyboard().text('💾 Сохранить как группу', 'cg:quicksave');
    }

    return result;
}

async function askChatAnalysisPeriod(
    ctx: BotContext,
    req: ChatAnalysisPeriodRequest
): Promise<ProcessingResult> {
    if (ctx.session) {
        ctx.session.chatAnalysisPeriodRequest = req;
        await persistSessionNow(ctx);
    }

    return {
        responseText: `За какой период проанализировать ${req.displayName}?`,
        keyboard: buildChatAnalysisPeriodKeyboard(req.requestId),
    };
}

async function runOrAskChatAnalysisPeriod(
    ctx: BotContext,
    req: ChatAnalysisPeriodRequest,
    message: string
): Promise<ProcessingResult> {
    const explicitPeriod = detectExplicitChatAnalysisPeriod(message);
    if (explicitPeriod) {
        await notifyUser(ctx, `📨 Анализирую ${req.displayName} за ${CHAT_ANALYSIS_PERIOD_LABELS[explicitPeriod]}…`);
        return runChatAnalysisPeriodRequest(ctx, req, explicitPeriod);
    }

    return askChatAnalysisPeriod(ctx, req);
}

/**
 * Агент для интеграции с аккаунтом Telegram
 * @param ctx Контекст бота (для сессии и сценария «изучить переписку»)
 * @param message Текст сообщения
 * @param isForwarded Является ли сообщение пересланным
 * @param forwardFrom Имя отправителя пересланного сообщения
 * @param messageHistory История сообщений для контекста
 * @returns Результат обработки запроса
 */
export async function readMessagesAgent(
    ctx: BotContext,
    message: string,
    isForwarded: boolean = false,
    forwardFrom: string = "",
    messageHistory: MessageHistory[] = [],
    classification?: MessageClassification,
    memoryContext: string = "",
    voiceReplyRequested: boolean = false
): Promise<ProcessingResult> {
    try {
        if (classification && classification.details.messagesCheckType === "ALL_MESSAGES") {
            const summary = await getMessagesSummary(24, memoryContext);

            if (!summary) {
                return {
                    responseText: "Нет новых сообщений за последние 24 часа."
                };
            }
            return {
                responseText: summary
            };
        }

        if (classification && classification.details.messagesCheckType === "ANALYZE_CONVERSATION") {
            // Несколько групповых чатов
            if (classification.details.groupChatQueries?.length) {
                const groupQueries = classification.details.groupChatQueries.map(q => q.trim()).filter(Boolean);
                const analysisQuery = classification.details.analysisQuery || message;
                const names = groupQueries.map(q => `«${q}»`).join(', ');
                const now = Date.now();
                return runOrAskChatAnalysisPeriod(ctx, {
                    requestId: createStudyChatRequestId(),
                    groupNames: groupQueries,
                    displayName: `чаты ${names}`,
                    analysisQuery,
                    step: 'period',
                    offerSaveGroup: true,
                    voiceReplyRequested,
                    memoryContext,
                    createdAt: now,
                    expiresAt: now + STUDY_CHAT_PERIOD_SELECTION_TTL_MS,
                }, message);
            }

            // Один групповой чат (или название сохранённой группы чатов)
            if (classification.details.groupChatQuery) {
                const groupQuery = classification.details.groupChatQuery.trim();
                const analysisQuery = classification.details.analysisQuery || message;

                // Проверяем, не является ли groupChatQuery именем сохранённой группы
                const ownerChatId = ctx.chat?.id;
                if (ownerChatId) {
                    const savedGroup = await ChatGroupRepository.findBestMatch(ownerChatId, groupQuery);
                    if (savedGroup && savedGroup.chatNames.length > 0) {
                        const names = savedGroup.chatNames.map(n => `«${n}»`).join(', ');
                        const now = Date.now();
                        return runOrAskChatAnalysisPeriod(ctx, {
                            requestId: createStudyChatRequestId(),
                            groupNames: savedGroup.chatNames,
                            displayName: `группу «${savedGroup.name}» (${names})`,
                            analysisQuery,
                            step: 'period',
                            voiceReplyRequested,
                            memoryContext,
                            createdAt: now,
                            expiresAt: now + STUDY_CHAT_PERIOD_SELECTION_TTL_MS,
                        }, message);
                    }
                }

                if (classification.details.saveFactsAboutUser) {
                    const now = Date.now();
                    return runOrAskChatAnalysisPeriod(ctx, {
                        requestId: createStudyChatRequestId(),
                        groupNames: [groupQuery],
                        displayName: `чат «${groupQuery}»`,
                        analysisQuery,
                        step: 'period',
                        saveFactsAboutUser: true,
                        voiceReplyRequested,
                        memoryContext,
                        createdAt: now,
                        expiresAt: now + STUDY_CHAT_PERIOD_SELECTION_TTL_MS,
                    }, message);
                }
                const now = Date.now();
                return runOrAskChatAnalysisPeriod(ctx, {
                    requestId: createStudyChatRequestId(),
                    groupNames: [groupQuery],
                    displayName: `чат «${groupQuery}»`,
                    analysisQuery,
                    step: 'period',
                    voiceReplyRequested,
                    memoryContext,
                    createdAt: now,
                    expiresAt: now + STUDY_CHAT_PERIOD_SELECTION_TTL_MS,
                }, message);
            }

            if (!classification.details.contactQuery) {
                return {
                    responseText: "Пожалуйста, укажи имя контакта для анализа переписки."
                };
            }

            const contactQuery = classification.details.contactQuery.trim();
            const contactsStore = ContactsStore.getInstance();

            const isRelationshipQuery = /^(жена|муж|мама|папа)$/i.test(contactQuery);
            let nameToSearch: string = "";

            if (isRelationshipQuery) {
                const resolvedName = await resolveRelationshipFromMemory(ctx, contactQuery, message);
                if (resolvedName) nameToSearch = resolvedName;
            } else {
                const words = contactQuery.split(/\s+/).filter(Boolean);
                if (words.length >= 1 && words.length <= 3) {
                    const resolvedName = await resolveRelationshipFromMemory(ctx, contactQuery, message);
                    nameToSearch = resolvedName || contactQuery;
                } else {
                    nameToSearch = contactQuery;
                }
            }

            if (isRelationshipQuery && !nameToSearch) {
                return {
                    responseText: `Сначала нужно сохранить в память, кто твоя ${contactQuery}. Скажи, например: «Запомни, моя ${contactQuery} — [имя]». После этого я смогу найти переписку с этим человеком.`,
                };
            }

            const contacts = contactsStore.searchContactsByName(nameToSearch);

            if (contacts.length === 0) {
                const hint = isRelationshipQuery
                    ? " Проверь, что в памяти сохранён факт (например: «Запомни, моя жена — Юля») и что это имя есть в контактах."
                    : " Можно сохранить в память, кто это (например: «Запомни, моя жена — Юля»), или указать имя из контактов.";
                return {
                    responseText: `Не нашла контакт «${nameToSearch}» в списке контактов.${hint}`
                };
            }
            const contact = contacts[0];
            const displayName = `${contact.firstName} ${contact.lastName || ""}`.trim() || nameToSearch;

            // Сценарий: изучить переписку и сохранить найденные факты — предлагаем выбор периода
            if (isStudyChatSaveFactsRequest(classification)) {
                const requestId = createStudyChatRequestId();
                if (ctx.session) {
                    const now = Date.now();
                    ctx.session.studyChatRequest = {
                        requestId,
                        contactName: displayName,
                        contactId: contact.id,
                        step: "period",
                        createdAt: now,
                        expiresAt: now + STUDY_CHAT_PERIOD_SELECTION_TTL_MS,
                    };
                    await persistSessionNow(ctx);
                }
                return {
                    responseText: `Хорошо, изучу переписку с ${displayName} и сохраню найденные факты в долговременную память. За какой период прочитать переписку?`,
                    keyboard: buildStudyChatPeriodKeyboard(requestId),
                };
            }

            if (!classification.details.analysisQuery) {
                return {
                    responseText: "Пожалуйста, укажи запрос для анализа переписки."
                };
            }

            await notifyUser(ctx, '🔍 Анализирую переписку с ' + displayName + '…');
            const answer = await getAnswerFromMessages(
                nameToSearch,
                classification.details.analysisQuery,
                memoryContext,
                voiceReplyRequested
            );

            if (answer) {
                return { responseText: answer, voiceReplyRequested };
            }
            return {
                responseText: "Не удалось найти информацию по твоему запросу."
            };
        }

        return {
            responseText: "Пожалуйста, уточни, что именно ты хочешь сделать с сообщениями Telegram. Например, «показать новые сообщения» или «изучи переписку с женой и узнай больше про меня»."
        };

    } catch (error) {
        console.error("Ошибка в агенте для Telegram-аккаунта:", error);
        return {
            responseText: "Произошла ошибка при обработке запроса к Telegram. Проверь статус подключения командой «статус телеграм»."
        };
    }
}

/**
 * Обрабатывает выбор периода для сценария «изучить переписку и сохранить факты».
 * Вызывается из обработчика callback_query (study_chat:week | month | 3months | year).
 */
export async function handleStudyChatPeriodCallback(
    ctx: BotContext,
    period: StudyChatPeriod,
    requestId?: string
): Promise<{ responseText: string }> {
    const req = ctx.session?.studyChatRequest;
    if (!req && requestId && processingStudyChatRequests.has(requestId)) {
        return { responseText: "Анализ этой переписки уже запущен. Дождись результата." };
    }
    if (!req || req.step !== "period") {
        return { responseText: "Сессия сценария истекла. Напиши снова: «изучи переписку с [имя] и запомни факты»." };
    }
    if (req.requestId && req.requestId !== requestId) {
        return { responseText: "Это старая кнопка выбора периода. Нажми период в последнем сообщении со сценарием." };
    }
    if (req.expiresAt && req.expiresAt <= Date.now()) {
        if (ctx.session) {
            ctx.session.studyChatRequest = undefined;
            await persistSessionNow(ctx);
        }
        return { responseText: "Сессия выбора периода истекла. Напиши снова: «изучи переписку с [имя] и запомни факты»." };
    }
    const processingKey = req.requestId || `${ctx.chat?.id ?? "chat"}:${req.contactId}`;
    if (processingStudyChatRequests.has(processingKey)) {
        return { responseText: "Анализ этой переписки уже запущен. Дождись результата." };
    }
    processingStudyChatRequests.add(processingKey);
    if (ctx.session) {
        ctx.session.studyChatRequest = undefined;
        await persistSessionNow(ctx);
    }

    try {
        const { responseText } = await studyChatAndSaveFacts(ctx, req.contactName, req.contactId, period);
        return { responseText };
    } finally {
        processingStudyChatRequests.delete(processingKey);
    }
}

/**
 * Обрабатывает выбор периода для анализа группового чата или сохранённой группы чатов.
 */
export async function handleChatAnalysisPeriodCallback(
    ctx: BotContext,
    period: StudyChatPeriod,
    requestId: string
): Promise<ProcessingResult> {
    const req = ctx.session?.chatAnalysisPeriodRequest;
    if (!req && requestId && processingChatAnalysisRequests.has(requestId)) {
        return { responseText: "Анализ этих чатов уже запущен. Дождись результата." };
    }
    if (!req || req.step !== "period") {
        return { responseText: "Сессия выбора периода истекла. Напиши запрос на анализ чатов заново." };
    }
    if (req.requestId !== requestId) {
        return { responseText: "Это старая кнопка выбора периода. Нажми период в последнем сообщении со сценарием." };
    }
    if (req.expiresAt <= Date.now()) {
        if (ctx.session) {
            ctx.session.chatAnalysisPeriodRequest = undefined;
            await persistSessionNow(ctx);
        }
        return { responseText: "Сессия выбора периода истекла. Напиши запрос на анализ чатов заново." };
    }

    const processingKey = req.requestId;
    if (processingChatAnalysisRequests.has(processingKey)) {
        return { responseText: "Анализ этих чатов уже запущен. Дождись результата." };
    }

    processingChatAnalysisRequests.add(processingKey);
    if (ctx.session) {
        ctx.session.chatAnalysisPeriodRequest = undefined;
        await persistSessionNow(ctx);
    }

    try {
        return await runChatAnalysisPeriodRequest(ctx, req, period);
    } finally {
        processingChatAnalysisRequests.delete(processingKey);
    }
}

// Запускаем подписку на новые сообщения
subscribeToNewMessages();
