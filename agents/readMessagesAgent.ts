import { Api, TelegramClient } from "telegram";
import { NewMessage } from "telegram/events";
import { MessageHistory } from "../types";
import { BotContext } from "../types";
import { MessageClassification, ProcessingResult } from "../orchestrator";
import { initTelegramClient, preloadContactsList, searchGroupByTitle } from "../services/telegram";
import { MessageStore, StoredMessage } from "../stores/MessageStore";
import { devLog, isLikelyBot } from "../utils";
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
import openai from "../openai";
import { sendMessage as sendTelegramMessage } from "../services/telegram";
import { InlineKeyboard } from "grammy";
import { studyChatAndSaveFacts } from "../utils/studyChatPipeline";
import { StudyChatPeriod, extractFactsAboutUserFromConversation } from "../utils/studyChatFlow";
import { resolveRelationshipFromMemory } from "../utils/resolveRelationshipFromMemory";
import { runUpdateLongTermMemoryAgent } from "./updateLongTermMemoryAgent";
import { queueMessage as queueForReflection, markChatAsBot } from "../services/reflectionModeService";


// Глобальное хранилище сообщений
const messageStore = MessageStore.getInstance();

let isListening: boolean = false;

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
    const prompt = `
Задача переговоров: ${session.taskDescription}

История переписки (последние сообщения):
${historyLines}

Контакт только что написал: «${contactText}»

Можешь ли ты составить короткий ответ от имени пользователя (естественный, по делу)?
- Если для ответа нужны данные от пользователя (сумма, дата, выбор, личное предпочтение) — ответь в формате: {"needUserInput": true, "questionForUser": "краткий вопрос пользователю"}
- Если можешь ответить сам — ответь в формате: {"replyText": "текст ответа контакту"}
Ответь только JSON, без markdown.`;

    try {
        const resp = await openai.chat.completions.create({
            model: "gpt-4.1",
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

/**
 * Обработчик новых сообщений
 * @param event Событие нового сообщения
 */
async function handleNewMessage(event: any): Promise<void> {
    try {
        const message = event.message;

        // Проверяем, что это личное сообщение (не группа, не канал)
        if (message.isPrivate) {
            // Получаем информацию об отправителе
            const senderId = message.fromId ? message.fromId.userId : message.peerId.userId;
            const chatId = message.chatId;

            // Проверяем, является ли сообщение отправленным самому себе в "Избранное"
            // В Telegram, когда пользователь отправляет сообщение себе, 
            // ID отправителя совпадает с ID получателя (ID чата)
            if (senderId.toString() === String(config.allowedUserId)) {
                devLog(`Пропускаем сообщение из "Избранного" (self-chat): ${message.message || "[Медиа]"}`);
                return; // Пропускаем обработку сообщений из "Избранного"
            }

            let senderName = "Неизвестный пользователь";
            let senderUsername = undefined;
            let isBot = false;

            try {
                const sender = await message.getSender();
                senderName = sender.firstName || "Неизвестный пользователь";
                if (sender.lastName) {
                    senderName += " " + sender.lastName;
                }

                if (sender.username) {
                    senderUsername = sender.username;
                    isBot = isLikelyBot(sender.username) || !!sender.bot;

                    if (isBot) {
                        devLog(`Обнаружен бот: ${senderName} (@${senderUsername})`);
                    }
                }
            } catch (error) {
                console.error("Не удалось получить информацию об отправителе:", error);
            }

            // Пропускаем сообщения от ботов
            if (isBot) {
                devLog(`Пропускаем сообщение от бота: ${senderName}`);
                markChatAsBot(String(chatId));
                return;
            }

            // Сохраняем сообщение
            const storedMessage: StoredMessage = {
                id: message.id,
                senderId,
                senderName,
                senderUsername,
                text: message.message || "",
                date: new Date(message.date * 1000), // Конвертируем Unix timestamp в Date
                isRead: false,
                isBot
            };

            // Если есть медиа-контент, добавляем информацию о нем
            if (message.media) {
                storedMessage.text += ` [${message.media.className.replace('MessageMedia', '')}]`;
            }

            messageStore.addMessage(chatId, storedMessage);

            // Добавляем в буфер режима рефлексии (синхронно, не блокирует обработку)
            if (storedMessage.text) {
                queueForReflection(String(chatId), senderName, storedMessage.text, storedMessage.date);
            }

            devLog(`Новое сообщение от ${senderName}: ${storedMessage.text}`);

            // Получаем экземпляр трекера сообщений
            const messageTracker = MessageTracker.getInstance();
            const contactIdNum = typeof senderId === "number" ? senderId : Number(senderId);

            // Обработка ответа в рамках активной сессии переговоров (бот ведёт переписку от имени пользователя)
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

            // Проверяем, является ли сообщение ответом на отслеживаемое сообщение
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
                }
            }

            // Также проверяем случай, когда сообщение отправлено после нашего, но без явного ответа
            if (senderId) {
                const latestTrackedInfo = messageTracker.getLatestTrackedMessageForContact(contactIdNum);
                if (latestTrackedInfo) {
                    const messageAge = Date.now() - latestTrackedInfo.timestamp.getTime();
                    const isRecentEnough = messageAge < 24 * 60 * 60 * 1000; // 24 часа
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
        }
    } catch (error) {
        console.error("Ошибка при обработке нового сообщения:", error);
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
async function handleOutgoingMessage(event: any): Promise<void> {
    try {
        const message = event.message;
        if (!message.isPrivate) return;

        const text: string = message.message?.trim();
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
    const telegramClient = await initTelegramClient();

    if (!telegramClient) {
        console.error("Не удалось инициализировать клиент Telegram");
        return;
    }

    // Предзагружаем контакты
    await preloadContactsList();

    telegramClient.addEventHandler(
        async (event) => {
            if (event.isPrivate) {
                await handleNewMessage(event);
            }
        },
        new NewMessage({ incoming: true })
    );

    // Исходящие сообщения — нужны для полного контекста в режиме рефлексии.
    // Сохраняем в MessageStore (isOwn=true) и очередь рефлексии как "Я: text".
    telegramClient.addEventHandler(
        async (event) => {
            if (event.isPrivate) {
                await handleOutgoingMessage(event);
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
    memoryContext: string = ""
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

            const prompt = `
            Ниже представлена переписка с контактом ${contact.firstName} ${contact.lastName || ''}:
            
            ${conversationContext}
            
            Запрос пользователя: "${analysisQuery}"
            ${memoryContext}

            Проанализируй эту переписку и дай точный, информативный ответ на запрос пользователя.
            Основывай свой ответ только на информации из представленной переписки.
            Если в переписке нет информации, необходимой для ответа на запрос, честно укажи это.
            `;

            const response = await openai.chat.completions.create({
                model: "gpt-4.1",
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
            });

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
        ${memoryContext}

        Пожалуйста, суммаризируй эти сообщения в естественной форме.
        Опиши кто и о чем писал, какие темы обсуждались, есть ли важные вопросы или просьбы.
        Сделай акцент на ключевых моментах каждого разговора и выдели самое важное.
        ВАЖНО: Включай в ответ username пользователя в формате @username ТОЛЬКО если он доступен.
        НЕ ДОБАВЛЯЙ @username если его нет в исходных данных! 
        Ответ должен быть лаконичным, структурированным и легко читаемым."
        `;

        const response = await openai.chat.completions.create({
            model: "gpt-4.1",
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

/** Проверяет, просит ли пользователь изучить переписку и сохранить факты о себе. */
function isStudyChatSaveFactsRequest(classification?: MessageClassification): boolean {
    if (!classification || classification.details.messagesCheckType !== "ANALYZE_CONVERSATION") return false;
    if (classification.details.saveFactsAboutUser === true) return true;
    const q = (classification.details.analysisQuery || "").toLowerCase();
    return /узнай\s*(больше\s*)?(обо?\s*мне|про\s*меня)|сохрани\s*(в\s*память|факты)|запомни\s*(что\s*узнаешь|факты)|изучи\s*и\s*запомни|прочитай\s*и\s*запомни/i.test(q);
}

/**
 * Клавиатура выбора периода для сценария «изучить переписку и сохранить факты».
 */
export function buildStudyChatPeriodKeyboard(): InlineKeyboard {
    return new InlineKeyboard()
        .text("Неделя", "study_chat:week")
        .text("Месяц", "study_chat:month").row()
        .text("3 месяца", "study_chat:3months")
        .text("Год", "study_chat:year");
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
    memoryContext: string = ""
): Promise<string> {
    const client = await initTelegramClient();
    if (!client) return "Не удалось подключиться к Telegram. Проверь статус подключения.";

    const group = await searchGroupByTitle(client, groupName);
    if (!group) {
        return `Не нашла групповой чат с названием «${groupName}». Проверь название — оно должно совпадать с тем, что в списке диалогов.`;
    }

    const messages = await client.getMessages(group.id, { limit: 200 });
    if (!messages || messages.length === 0) return `В чате «${group.title}» не найдено сообщений.`;

    const conversationText = formatGroupMessages(messages as Api.Message[]);
    if (!conversationText.trim()) return `В чате «${group.title}» нет текстовых сообщений для анализа.`;

    const persona = getBotPersona();
    const style = getCommunicationStyle();
    const systemPrompt = `${persona}\n\n${style}\n\n${memoryContext}`.trim();
    const userPrompt = `Ниже — сообщения из группового чата «${group.title}» (последние ${messages.length} сообщений).\n\nЗадача: ${analysisQuery}\n\nСообщения чата:\n${conversationText}`;

    // Параллельно: текстовый анализ + извлечение структурированных фактов
    const [analysisResult, factsResult] = await Promise.allSettled([
        openai.chat.completions.create({
            model: "gpt-4.1",
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userPrompt },
            ],
            temperature: 0.4,
        }),
        extractFactsAboutUserFromConversation(conversationText, group.title as string),
    ]);

    const analysisText = analysisResult.status === 'fulfilled'
        ? (analysisResult.value.choices[0]?.message?.content?.trim() || 'Не удалось проанализировать.')
        : 'Не удалось проанализировать сообщения чата.';

    if (factsResult.status === 'fulfilled' && factsResult.value.length > 0) {
        try {
            const savedCount = await runUpdateLongTermMemoryAgent(ctx, factsResult.value);
            if (savedCount > 0) {
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
    memoryContext: string = ""
): Promise<string> {
    const client = await initTelegramClient();
    if (!client) {
        return "Не удалось подключиться к Telegram. Проверь статус подключения.";
    }

    const group = await searchGroupByTitle(client, groupName);
    if (!group) {
        return `Не нашла групповой чат с названием «${groupName}». Проверь название — оно должно совпадать с тем, что в списке диалогов.`;
    }

    const messages = await client.getMessages(group.id, { limit: 200 });
    if (!messages || messages.length === 0) {
        return `В чате «${group.title}» не найдено сообщений.`;
    }

    const conversationText = formatGroupMessages(messages as Api.Message[]);
    if (!conversationText.trim()) {
        return `В чате «${group.title}» нет текстовых сообщений для анализа.`;
    }

    const persona = getBotPersona();
    const style = getCommunicationStyle();

    const systemPrompt = `${persona}\n\n${style}\n\n${memoryContext}`.trim();

    const userPrompt = `Ниже — сообщения из группового чата «${group.title}» (последние ${messages.length} сообщений).

Задача: ${analysisQuery}

Сообщения чата:
${conversationText}`;

    const response = await openai.chat.completions.create({
        model: "gpt-4.1",
        messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
        ],
        temperature: 0.4,
    });

    return response.choices[0]?.message?.content?.trim() || "Не удалось проанализировать сообщения чата.";
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
    memoryContext: string = ""
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
            // Трек группового чата: анализ сообщений из группы/канала по названию
            if (classification.details.groupChatQuery) {
                const groupQuery = classification.details.groupChatQuery.trim();
                const analysisQuery = classification.details.analysisQuery || message;
                if (classification.details.saveFactsAboutUser) {
                    const answer = await studyGroupChatAndSaveFacts(ctx, groupQuery, analysisQuery, memoryContext);
                    return { responseText: answer };
                }
                const answer = await analyzeGroupChatMessages(groupQuery, analysisQuery, memoryContext);
                return { responseText: answer };
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

            // Сценарий: изучить переписку и сохранить факты обо мне — предлагаем выбор периода
            if (isStudyChatSaveFactsRequest(classification)) {
                if (ctx.session) {
                    ctx.session.studyChatRequest = {
                        contactName: displayName,
                        contactId: contact.id,
                        step: "period",
                    };
                }
                return {
                    responseText: `Хорошо, изучу переписку с ${displayName} и сохраню факты о тебе в долговременную память. За какой период прочитать переписку?`,
                    keyboard: buildStudyChatPeriodKeyboard(),
                };
            }

            if (!classification.details.analysisQuery) {
                return {
                    responseText: "Пожалуйста, укажи запрос для анализа переписки."
                };
            }

            const answer = await getAnswerFromMessages(
                nameToSearch,
                classification.details.analysisQuery,
                memoryContext
            );

            if (answer) {
                return { responseText: answer };
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
    period: StudyChatPeriod
): Promise<{ responseText: string }> {
    const req = ctx.session?.studyChatRequest;
    if (!req || req.step !== "period") {
        return { responseText: "Сессия сценария истекла. Напиши снова: «изучи переписку с [имя] и узнай больше про меня»." };
    }
    if (ctx.session) ctx.session.studyChatRequest = undefined;

    const { responseText } = await studyChatAndSaveFacts(ctx, req.contactName, req.contactId, period);
    return { responseText };
}

// Запускаем подписку на новые сообщения
subscribeToNewMessages();
