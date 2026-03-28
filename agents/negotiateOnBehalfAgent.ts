import { MessageHistory } from "../types";
import { BotContext } from "../types";
import { ProcessingResult } from "../orchestrator";
import { ContactsStore } from "../stores/ContactsStore";
import {
    NegotiationStore,
    buildNegotiationSummaryText,
    buildNegotiationStopKeyboard,
    buildNegotiationStartKeyboard,
} from "../stores/NegotiationStore";
import { devLog } from "../utils";
import { getBotPersona, getCommunicationStyle } from "../persona";
import { config } from "../config";
import openai from "../openai";

/**
 * Анализирует запрос на переговоры: контакт, задача, первое сообщение.
 */
async function parseNegotiationRequest(
    message: string,
    memoryContext: string
): Promise<{
    contactQuery?: string;
    contactName?: string;
    taskDescription: string;
    firstMessageText: string;
    errorMessage?: string;
}> {
    const prompt = `
Запрос пользователя: "${message}"

Контекст из памяти (имена, роли, предпочтения): ${memoryContext || "—"}

Нужно:
1. Определить, с кем договориться: contactName — имя для поиска в контактах (или роль: жена, мама и т.д., тогда contactQuery будет это слово).
2. Кратко сформулировать задачу переговоров (taskDescription): что именно нужно согласовать/уточнить/договориться.
3. Составить первое сообщение контакту от имени пользователя (естественное, вежливое, по делу). Не длинное.

Ответ в формате JSON:
{
  "contactQuery": "строка для поиска контакта (имя или роль)",
  "contactName": "имя контакта для поиска, если из памяти известно — подставь его",
  "taskDescription": "краткое описание задачи переговоров",
  "firstMessageText": "текст первого сообщения контакту",
  "errorMessage": "если не удалось определить контакт или задачу — опиши проблему"
}
`;

    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4.1",
            messages: [
                {
                    role: "system",
                    content: `${getBotPersona()} Стиль: ${getCommunicationStyle()}. Руководитель — ${config.ownerName}. Ты помогаешь сформулировать первое сообщение для переговоров от его имени. Отвечай только валидным JSON.`,
                },
                { role: "user", content: prompt },
            ],
            temperature: 1,
        });
        const text = response.choices[0]?.message?.content || "";
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error("No JSON in response");
        return JSON.parse(jsonMatch[0]);
    } catch (e) {
        console.error("negotiateOnBehalfAgent parse error", e);
        return {
            taskDescription: "",
            firstMessageText: "",
            errorMessage: "Не удалось разобрать запрос. Уточни, с кем и о чём договориться.",
        };
    }
}

/**
 * Договориться с контактом от имени пользователя: отправить первое сообщение и зарегистрировать сессию.
 * Дальнейшие ответы контакта обрабатываются в readMessagesAgent (handleNewMessage): бот либо отвечает сам, либо спрашивает пользователя.
 */
export async function negotiateOnBehalfAgent(
    ctx: BotContext,
    message: string,
    _isForwarded: boolean,
    _forwardFrom: string,
    messageHistory: MessageHistory[] = [],
    enrichedContextFromMemory: string = ""
): Promise<ProcessingResult> {
    try {
        const contactsStore = ContactsStore.getInstance();
        const parsed = await parseNegotiationRequest(message, enrichedContextFromMemory);

        if (parsed.errorMessage && !parsed.firstMessageText) {
            return { responseText: parsed.errorMessage };
        }

        const contactSearch = parsed.contactName || parsed.contactQuery || "";
        const contact = await contactsStore.searchContactByName(contactSearch);

        if (!contact || !contact.id) {
            return {
                responseText: `Не нашла контакт «${contactSearch}» в списке контактов. Уточни имя или проверь контакты.`,
            };
        }

        const contactName = `${contact.firstName} ${contact.lastName || ""}`.trim() || contactSearch;
        const firstMessageText = parsed.firstMessageText || "Здравствуйте! Нужно уточнить один вопрос.";
        const taskDescription = parsed.taskDescription || "переговоры по запросу пользователя";

        const originalChatId = ctx.chat?.id;
        if (originalChatId == null) {
            return { responseText: "Не удалось определить чат для уведомлений." };
        }

        NegotiationStore.setPendingStart(originalChatId, {
            contactId: contact.id,
            contactName,
            taskDescription,
            firstMessageText,
        });

        const previewText =
            `Хочу начать переговоры с **${contactName}**.\n\n` +
            `Задача: ${taskDescription}\n\n` +
            `Первое сообщение контакту:\n«${firstMessageText}»\n\n` +
            `Нажми кнопку ниже, чтобы начать диалог.`;
        const keyboard = buildNegotiationStartKeyboard();

        return {
            responseText: previewText.replace(/\*\*/g, ""),
            keyboard,
        };
    } catch (e) {
        console.error("negotiateOnBehalfAgent error", e);
        return {
            responseText: "Произошла ошибка при запуске переговоров. Попробуй сформулировать запрос по-другому.",
        };
    }
}
