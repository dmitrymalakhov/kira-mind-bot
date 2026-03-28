import { MessageHistory, SessionData, DomainMemory } from "../types";
import { devLog } from "../utils";
import { getBotPersona } from "../persona";
import { config } from "../config";
import openai from "../openai";


// Расширенный интерфейс для хранения истории сообщений с суммаризацией
// Наследуется от SessionData, чтобы включить все необходимые поля
export interface EnhancedSessionData extends SessionData {
    // Все поля уже наследуются от SessionData, включая domains
    // Можно добавить дополнительные поля, если нужно
}

/**
 * Суммаризирует историю сообщений и формирует контекст для дальнейшего взаимодействия
 * @param messages Массив сообщений для суммаризации
 * @param existingSummary Существующая суммаризация (если есть)
 * @returns Строка с суммаризацией ключевой информации из диалога
 */
export async function summarizeDialogue(
    messages: MessageHistory[],
    existingSummary: string = ""
): Promise<string> {
    try {
        // Если нет сообщений для суммаризации, возвращаем существующую суммаризацию
        if (messages.length === 0) {
            return existingSummary;
        }

        // Подготовка контекста сообщений
        let messagesContext = "";
        messages.forEach((item, index) => {
            messagesContext += `${index + 1}. ${item.role === 'user' ? 'Пользователь' : config.characterName}: ${item.content}\n`;
        });

        // Подготовка промпта для суммаризации
        const prompt = `
        ${existingSummary ? "Предыдущая суммаризация диалога:\n" + existingSummary + "\n\n" : ""}
        
        Ниже представлены ${existingSummary ? "новые " : ""}сообщения из диалога между пользователем и ботом:
        
        ${messagesContext}
        
        Пожалуйста, ${existingSummary ? "обнови суммаризацию, интегрируя новую информацию с предыдущей" : "создай суммаризацию"} диалога.
        
        Выдели и сохрани:
        1. Ключевые факты о пользователе (предпочтения, контекстная информация)
        2. Важные темы разговора
        3. Договоренности и планы
        4. Эмоциональный контекст (настроение пользователя, отношение к темам)
        5. Выраженные потребности и запросы
        
        Суммаризация должна:
        - Быть краткой и структурированной (до 100 слов)
        - Сохранять только действительно важную информацию
        - Фокусироваться на фактах, которые потенциально важны для будущих взаимодействий
        - Не содержать малозначимых деталей
        - Быть написана простым, информативным языком
        
        Представь результат как сжатый, но информативный контекст для бота.
        `;

        // Отправка запроса к API OpenAI
        const response = await openai.chat.completions.create({
            model: "gpt-5-nano",
            messages: [
                {
                    role: "system",
                    content: `${getBotPersona()} Ты - специализированный агент по суммаризации диалогов.
                    Твоя задача - извлечь ключевую информацию из переписки,
                    создавая компактную, но информативную суммаризацию, которая сохранит важные факты и
                    эмоциональный контекст. Твоя суммаризация будет использоваться ботом как часть контекста
                    для будущих взаимодействий, поэтому важно выделить существенные детали и игнорировать малозначимые.`
                },
                {
                    role: "user",
                    content: prompt
                }
            ],
            temperature: 0.3, // Низкая температура для более стабильной суммаризации
        });

        // Получаем текст ответа
        const summaryResult = response.choices[0]?.message?.content || "";

        // Если существует предыдущая суммаризация и новая суммаризация получена
        if (existingSummary && summaryResult) {
            return summaryResult; // Возвращаем обновленную суммаризацию
        }

        return summaryResult || existingSummary;

    } catch (error) {
        console.error("Error in dialogue summarization:", error);
        // В случае ошибки возвращаем существующую суммаризацию или пустую строку
        return existingSummary || "";
    }
}

/**
 * Проверяет необходимость суммаризации и при необходимости обновляет контекст
 * @param sessionData Данные сессии с историей сообщений
 * @returns Обновленные данные сессии с суммаризацией
 */
export async function updateDialogueContext(
    sessionData: EnhancedSessionData
): Promise<EnhancedSessionData> {
    try {
        // Проверяем, нужна ли суммаризация (когда достигли порога в 10 сообщений)
        if (sessionData.messageHistory.length >= 10) {
            devLog("Performing dialogue summarization...");

            // Берем все сообщения для суммаризации
            const messagesToSummarize = [...sessionData.messageHistory];

            // Обновляем суммаризацию
            const updatedSummary = await summarizeDialogue(
                messagesToSummarize,
                sessionData.dialogueSummary || ""
            );

            // Обновляем данные сессии, сохраняя первые 5 сообщений (самые новые)
            return {
                ...sessionData,
                dialogueSummary: updatedSummary,
                lastSummarizedIndex: sessionData.messageHistory.length - 1,
                messageHistory: sessionData.messageHistory.slice(0, 5)
            };
        }

        // Если суммаризация не требуется, возвращаем данные без изменений
        return sessionData;
    } catch (error) {
        console.error("Error updating dialogue context:", error);
        // В случае ошибки возвращаем исходные данные
        return sessionData;
    }
}

/**
 * Добавляет суммаризацию к промпту для обеспечения долговременного контекста
 * @param prompt Исходный промпт
 * @param sessionData Данные сессии с суммаризацией
 * @returns Обновленный промпт с долговременным контекстом
 */
export function enhancePromptWithSummary(
    prompt: string,
    sessionData: EnhancedSessionData
): string {
    // Если нет суммаризации, возвращаем исходный промпт
    if (!sessionData.dialogueSummary) {
        return prompt;
    }

    // Определяем маркер начала истории сообщений в промпте
    const historyMarker = "История переписки (от старых к новым):";

    if (prompt.includes(historyMarker)) {
        // Добавляем суммаризацию перед историей сообщений
        const parts = prompt.split(historyMarker);

        // Форматируем суммаризацию для вставки
        const summarySection = `\nДолговременный контекст диалога:\n${sessionData.dialogueSummary}\n\n`;

        // Собираем промпт с добавленной суммаризацией
        return parts[0] + summarySection + historyMarker + parts[1];
    }

    // Если маркер не найден, добавляем суммаризацию в конец промпта
    return prompt + `\n\nДолговременный контекст диалога:\n${sessionData.dialogueSummary}`;
}