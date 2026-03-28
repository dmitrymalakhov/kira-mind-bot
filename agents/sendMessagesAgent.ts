import { MessageHistory } from "../types";
import { ProcessingResult } from "../orchestrator";
import { InlineKeyboard } from "grammy";
import { initTelegramClient, scheduleMessageSend, sendMessage, sendMessageToChat, searchGroupByTitle } from "../services/telegram";
import { Contact, ContactsStore } from "../stores/ContactsStore";
import { devLog } from "../utils";
import { getBotPersona, getCommunicationStyle } from "../persona";
import { config } from "../config";
import openai from "../openai";


// Интерфейс для временного хранения информации о подготовленном сообщении
export interface MessageDraft {
    contactId: number; // ID контакта (ЛС) или ID чата (группа)
    text: string;
    scheduledTime: Date | null; // null для немедленной отправки
    notifyOnReply: boolean; // Флаг для уведомления о получении ответа (только для ЛС)
    expiresAt: Date; // Время истечения срока действия черновика
    originalChatId: number; // ID чата, куда нужно пересылать ответ
    /** true — отправка в группу/чат по contactId */
    isGroup?: boolean;
    /** Название группы (для отображения) */
    groupTitle?: string;
}

// Хранилище черновиков сообщений по ID чата
const messageDrafts = new Map<number, MessageDraft>();

/**
 * Анализирует запрос пользователя и одновременно генерирует текст сообщения
 * @param message Текст сообщения с запросом
 * @param contactsStore Хранилище контактов
 * @param messageHistory История сообщений
 * @returns Результат анализа запроса и готовый текст сообщения
 */
async function analyzeAndGenerateMessage(
    message: string,
    contactsStore: ContactsStore,
    messageHistory: MessageHistory[] = [],
    memoryContext: string = ""
): Promise<{
    contactIdentified: boolean;
    contactQuery?: string;
    contactName?: string;
    /** "contact" — личное сообщение контакту, "group" — в группу/чат по названию */
    targetType?: "contact" | "group";
    /** Название группы для поиска (например, "Каркас: Leads") */
    groupName?: string;
    messageText?: string;
    scheduledTime?: Date | null;
    notifyOnReply?: boolean;
    errorMessage?: string;
}> {
    try {
        // Подготовка контекста
        let historyContext = "";
        if (messageHistory.length > 0) {
            historyContext = "\nИстория переписки пользователя с ботом (последние сообщения):\n";
            messageHistory.slice(-3).forEach((item, index) => {
                historyContext += `${index + 1}. ${item.role === 'user' ? 'Пользователь' : 'Бот'}: ${item.content}\n`;
            });
        }

        const currentDate = new Date();




        const prompt = `
        Текущая дата и время: ${currentDate.toLocaleString('ru-RU')}
        
        Запрос пользователя: "${message}"
        ${historyContext}
        Контекст из долговременной памяти (используй для определения контакта и персонализации; там могут быть имена, роли, предпочтения и др.):
        ${memoryContext}

        Требуется:
        1. Определить, куда отправлять: в личку контакту (targetType: "contact") или в группу/чат (targetType: "group").
           Если пользователь просит "напиши в группу X", "отправь в чат X", "напиши в группу «Название»" — ставь targetType: "group" и в groupName укажи точное или наиболее подходящее название группы из запроса (например, "Каркас: Leads").
           Иначе — targetType: "contact" и определяй contactName для поиска контакта.
        2. Сразу составить готовый текст сообщения для отправки
        3. Определить время отправки (если указано в запросе)
        4. Определить, требуется ли уведомление о получении ответа (только для ЛС; для групп не используется)
        
        Текст сообщения должен быть:
        1. Персонализированным и учитывающим информацию о контакте
        2. Соответствующим запросу пользователя
        3. Естественным и вежливым
        4. Не слишком длинным (оптимально 2-4 предложения)
        
        Для определения необходимости уведомления о получении ответа:
        - Ищи фразы вроде "сообщи когда ответит", "перешли ответ", "дай знать о реакции", "скажи что ответит"
        - Также обрати внимание на индикаторы неотложности/важности запроса
        
        Ответ предоставь в формате JSON:
        {
          "contactIdentified": true/false,
          "contactQuery": "строка для поиска контакта (для targetType contact)",
          "contactName": "полное имя контакта для поиска в контактах",
          "targetType": "contact" или "group",
          "groupName": "название группы для поиска в чатах (только для targetType group, например «Каркас: Leads»)",
          "messageText": "полностью готовый текст сообщения для отправки",
          "scheduledTime": "время отправки в ISO формате (если указано)",
          "notifyOnReply": true/false,
          "errorMessage": "сообщение об ошибке, если получатель не найден или есть другие проблемы"
        }
        `;

        const response = await openai.chat.completions.create({
            model: "gpt-4.1",
            messages: [
                {
                    role: "system",
                    content: `${getBotPersona()} Стиль общения: ${getCommunicationStyle()} Твой руководитель - ${config.ownerName}.
                    Ты в одном запросе анализируешь запрос пользователя
                    на отправку сообщения и сразу составляешь готовый текст сообщения, уточняя детали. Ты умеешь находить
                    упоминания контактов в запросе и генерировать персонализированные сообщения для них (от лица твоего руководителя).
                    Также ты определяешь, нужно ли отправить в личку контакту (targetType: "contact") или в группу/чат по названию (targetType: "group") — например: "напиши в группу Каркас: Leads", "отправь в чат команды сообщение".
                    Определяешь планируемое время отправки, если оно указано в запросе.

                    Ты также умеешь определять, запрашивает ли пользователь уведомление о получении ответа (только для личных сообщений).
                    Обрати особое внимание на фразы вроде "сообщи мне когда ответит", "перешли ответ",
                    "дай знать о реакции" и подобные, которые указывают на необходимость уведомления.`
                },
                {
                    role: "user",
                    content: prompt
                }
            ],
            temperature: 1, // модель поддерживает только default (1)
        });

        const aiResponse = response.choices[0]?.message?.content || "";

        // Парсим JSON из ответа
        const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            throw new Error("Could not parse JSON from AI response");
        }

        const result = JSON.parse(jsonMatch[0]);

        // Преобразуем строку времени в объект Date, если время указано
        if (result.scheduledTime) {
            result.scheduledTime = new Date(result.scheduledTime);
        }

        return result;

    } catch (error) {
        console.error("Ошибка при анализе запроса и генерации сообщения:", error);
        return {
            contactIdentified: false,
            errorMessage: "Произошла ошибка при анализе запроса. Пожалуйста, попробуйте еще раз."
        };
    }
}

/**
 * Сохраняет черновик сообщения
 * @param chatId ID чата (с ботом)
 * @param contactId ID контакта (ЛС) или ID чата (группа)
 * @param text Текст сообщения
 * @param scheduledTime Время отправки (null для немедленной отправки)
 * @param notifyOnReply Флаг для уведомления о получении ответа (только для ЛС)
 * @param isGroup true — получатель группа/чат
 * @param groupTitle Название группы (для отображения)
 */
export function saveMessageDraft(
    chatId: number,
    contactId: number,
    text: string,
    scheduledTime: Date | null = null,
    notifyOnReply: boolean = false,
    isGroup: boolean = false,
    groupTitle?: string
): boolean {
    try {
        const expiresAt = new Date();
        expiresAt.setMinutes(expiresAt.getMinutes() + 30);

        const draft: MessageDraft = {
            contactId,
            text,
            scheduledTime,
            notifyOnReply,
            expiresAt,
            originalChatId: chatId,
            isGroup,
            groupTitle
        };

        messageDrafts.set(chatId, draft);
        return true;
    } catch (error) {
        console.error("Ошибка при сохранении черновика:", error);
        return false;
    }
}

/**
 * Получает черновик сообщения
 * @param chatId ID чата
 * @returns Черновик сообщения или undefined
 */
export function getMessageDraft(chatId: number): MessageDraft | undefined {
    const draft = messageDrafts.get(chatId);

    // Если черновик найден и срок его действия не истек
    if (draft && draft.expiresAt > new Date()) {
        return draft;
    }

    // Удаляем просроченный черновик
    if (draft) {
        messageDrafts.delete(chatId);
    }

    return undefined;
}

/**
 * Удаляет черновик сообщения
 * @param chatId ID чата
 * @returns true при успешном удалении
 */
export function deleteMessageDraft(chatId: number): boolean {
    return messageDrafts.delete(chatId);
}

/**
 * Отправляет сообщение из черновика
 * @param chatId ID чата
 * @returns Promise<boolean> - успешность операции
 */
export async function sendMessageFromDraft(chatId: number): Promise<boolean> {
    try {
        const draft = getMessageDraft(chatId);

        if (!draft) {
            return false;
        }

        const client = await initTelegramClient();
        if (!client) {
            throw new Error("Не удалось инициализировать клиент Telegram");
        }

        let success: boolean;

        if (draft.isGroup) {
            const sendResult = await sendMessageToChat(client, draft.contactId, draft.text);
            success = sendResult.success;
        } else if (draft.scheduledTime && draft.scheduledTime > new Date()) {
            const scheduledId = scheduleMessageSend(
                draft.contactId,
                draft.text,
                draft.scheduledTime,
                draft.notifyOnReply,
                draft.originalChatId
            );
            success = scheduledId !== null;
        } else {
            const sendResult = await sendMessage(
                client,
                draft.contactId,
                draft.text,
                draft.notifyOnReply,
                draft.originalChatId
            );
            success = sendResult.success;
        }

        messageDrafts.delete(chatId);
        return success;
    } catch (error) {
        console.error("Ошибка при отправке сообщения из черновика:", error);
        return false;
    }
}

/**
 * Агент для обработки запросов на отправку сообщений контактам.
 * Получает единый параметр enrichedContextFromMemory — произвольная полезная информация из долговременной памяти (факты, имена, предпочтения и т.д.); использует её в промпте для определения контакта и текста сообщения.
 */
export async function sendMessagesAgent(
    ctx: any,
    message: string,
    isForwarded: boolean = false,
    forwardFrom: string = "",
    messageHistory: MessageHistory[] = [],
    enrichedContextFromMemory: string = ""
): Promise<ProcessingResult> {
    try {
        const contactsStore = ContactsStore.getInstance();

        const result = await analyzeAndGenerateMessage(message, contactsStore, messageHistory, enrichedContextFromMemory);

        devLog("sendMessagesAgent", "Анализ запроса:", result);

        const targetType = result.targetType || "contact";

        // Отправка в группу/чат
        if (targetType === "group" && result.groupName) {
            const client = await initTelegramClient();
            if (!client) {
                return { responseText: "Не удалось подключиться к Telegram. Попробуй позже." };
            }
            const group = await searchGroupByTitle(client, result.groupName);
            if (!group) {
                return {
                    responseText: `Группу или чат с названием «${result.groupName}» не удалось найти. Проверь название или убедись, что этот чат есть в списке диалогов.`
                };
            }

            if (ctx.chat) {
                saveMessageDraft(
                    ctx.chat.id,
                    group.id,
                    result.messageText || "",
                    null,
                    false,
                    true,
                    group.title
                );
            }

            const confirmKeyboard = new InlineKeyboard()
                .text("✅ Отправить", "send_message")
                .text("✏️ Изменить текст", "edit_message")
                .row()
                .text("❌ Отмена", "cancel_message");

            const responseText = `📤 Подготовлено сообщение для группы «${group.title}»:\n\n` +
                `"${result.messageText}"\n\n` +
                `Подтверди отправку или внеси изменения:`;

            return { responseText, keyboard: confirmKeyboard };
        }

        // Отправка в личку контакту
        const contactSearchQuery = result.contactName ?? result.contactQuery ?? "";
        const contact = await contactsStore.searchContactByName(contactSearchQuery);

        devLog("sendMessagesAgent", "Контакт:", contact);

        if (!contact) {
            devLog("sendMessagesAgent", "Контакт не найден");
            return {
                responseText: `Не удалось найти контакт "${result.contactQuery || contactSearchQuery}" в списке контактов. Пожалуйста, укажи имя, фамилию или username контакта более конкретно. Например: "Напиши Ивану о встрече завтра" или "Отправь сообщение @username о проекте".`
            };
        }

        if (!result.contactIdentified || !contact.id) {
            return {
                responseText: result.errorMessage ||
                    `Я не смогла определить, кому нужно отправить сообщение. Пожалуйста, укажи имя, фамилию или username контакта более конкретно. Например: "Напиши Ивану о встрече завтра" или "Отправь сообщение @username о проекте".`
            };
        }

        let scheduledTime = result.scheduledTime;
        let scheduledTimeDisplay = "сейчас";

        if (scheduledTime) {
            scheduledTimeDisplay = scheduledTime.toLocaleString('ru-RU', {
                day: 'numeric',
                month: 'long',
                hour: 'numeric',
                minute: 'numeric'
            });
        }

        const notifyOnReply = result.notifyOnReply || false;

        if (ctx.chat) {
            saveMessageDraft(
                ctx.chat.id,
                contact.id,
                result.messageText || "",
                scheduledTime,
                notifyOnReply
            );
        }

        const confirmKeyboard = new InlineKeyboard()
            .text("✅ Отправить", "send_message")
            .text("✏️ Изменить текст", "edit_message")
            .row()
            .text("🕒 Изменить время", "change_time")
            .text(notifyOnReply ? "🔔 Выкл. уведомления" : "🔕 Вкл. уведомления", "toggle_notify")
            .row()
            .text("❌ Отмена", "cancel_message");

        let notifyIndicator = notifyOnReply ?
            "✅ С уведомлением о получении ответа" :
            "❌ Без уведомления о получении ответа";

        const responseText = `📤 Подготовлено сообщение для ${contact.firstName} ${contact.lastName || ''} ${contact.username ? '(@' + contact.username + ')' : ''}:\n\n` +
            `"${result.messageText}"\n\n` +
            `Время отправки: ${scheduledTimeDisplay}\n` +
            `${notifyIndicator}\n\n` +
            `Подтверди отправку или внеси изменения:`;

        return {
            responseText,
            keyboard: confirmKeyboard
        };

    } catch (error) {
        console.error("Ошибка в sendMessagesAgent:", error);
        return {
            responseText: "Произошла ошибка при подготовке сообщения. Пожалуйста, попробуй еще раз или сформулируй запрос по-другому."
        };
    }
}