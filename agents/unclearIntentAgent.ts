import { MessageHistory } from "../types";
import { MessageClassification, ProcessingResult } from "../orchestrator";
import { getBotPersona, getCommunicationStyle } from "../persona";
import { config } from "../config";
import openai, { openAiModels } from "../openai";

const INTENT_LABELS: Partial<Record<MessageClassification["intent"], string>> = {
    "НАПОМИНАНИЕ": "поставить напоминание",
    "РАЗГОВОР": "ответить как на обычный вопрос или обсудить",
    "ГЕНЕРАЦИЯ_ИЗОБРАЖЕНИЯ": "создать изображение",
    "КАРТЫ_ЛОКАЦИИ": "найти место или маршрут на карте",
    "ПРОВЕРКА_СООБЩЕНИЙ": "прочитать или проанализировать переписку",
    "ВЕБ_ПОИСК": "найти информацию в интернете",
    "ОТПРАВКА_СООБЩЕНИЯ": "подготовить или отправить сообщение",
    "ДЕЛЕГИРОВАНИЕ_ЗАДАЧИ": "самостоятельно договориться с контактом",
    "ВОЗМОЖНОСТИ_БОТА": "объяснить возможности бота",
    "БРАУЗЕР_ЗАДАЧА": "выполнить действие в браузере",
};


/**
 * Агент для обработки сообщений с неопределенным намерением
 * @param message Текст сообщения
 * @param isForwarded Является ли сообщение пересланным
 * @param forwardFrom Информация о первоначальном отправителе
 * @param messageHistory История сообщений
 * @param classification Результат классификации сообщения
 * @returns Результат обработки сообщения
 */
export async function unclearIntentAgent(
    message: string,
    isForwarded: boolean = false,
    forwardFrom: string = "",
    messageHistory: MessageHistory[] = [],
    classification: MessageClassification,
    memoryContext: string = ""
): Promise<ProcessingResult> {
    try {
        // Подготовка истории сообщений для контекста
        let historyContext = "";
        if (messageHistory.length > 0) {
            historyContext = "\nИстория переписки (от старых к новым):\n";
            messageHistory.forEach((item, index) => {
                historyContext += `${index + 1}. ${item.role === 'user' ? 'Пользователь' : 'Бот'}: ${item.content}\n`;
            });
        }

        // Текущая дата и время для контекста
        const currentDate = new Date();
        const formattedDateTime = currentDate.toLocaleString('ru-RU', {
            day: 'numeric',
            month: 'long',
            year: 'numeric',
            hour: 'numeric',
            minute: 'numeric',
            weekday: 'long'
        });

        // Анализ деталей классификации
        let contextHints = "";
        if (classification.details) {
            if (classification.details.category) {
                contextHints += `Категория сообщения: ${classification.details.category}. `;
            }

            if (classification.details.emotionalTone) {
                contextHints += `Эмоциональный тон: ${classification.details.emotionalTone}. `;
            }

            if (classification.details.keywords && classification.details.keywords.length > 0) {
                contextHints += `Ключевые слова: ${classification.details.keywords.join(", ")}. `;
            }

            if (classification.details.timeReferences && classification.details.timeReferences.length > 0) {
                contextHints += `Упоминания времени: ${classification.details.timeReferences.join(", ")}. `;
            }
        }

        const rankedIntents = (classification.intentScores ?? [])
            .filter((candidate) => candidate.intent !== "НЕОПРЕДЕЛЕНО")
            .slice(0, 3);
        const ambiguityHints = rankedIntents.length
            ? "\nВозможные варианты, между которыми нужно уточнить:\n" +
                rankedIntents
                    .map((candidate, index) => {
                        const label = INTENT_LABELS[candidate.intent] ?? candidate.intent;
                        const reason = candidate.reason ? ` — ${candidate.reason}` : "";
                        return `${index + 1}. ${label} (score ${candidate.score.toFixed(2)})${reason}`;
                    })
                    .join("\n")
            : "";
        const preferredQuestion = classification.clarificationQuestion
            ? `\nПредложенный вопрос для уточнения: ${classification.clarificationQuestion}`
            : "";
        const ambiguityReason = classification.ambiguityReason
            ? `\nПричина неоднозначности: ${classification.ambiguityReason}`
            : "";

        // Подготовка промпта для генерации ответа с уточнением
        const prompt = `
        Текущая дата и время: ${formattedDateTime}
        
        Проанализируй следующее сообщение${isForwarded ? `, пересланное от ${forwardFrom}` : ""}:

        "${message}"
        ${historyContext}
        ${memoryContext ? `Контекст из долговременной памяти:\n${memoryContext}` : ''}

        Дополнительный контекст: ${contextHints}
        ${ambiguityReason}
        ${ambiguityHints}
        ${preferredQuestion}
        
        Я не могу точно определить, чего хочет пользователь. Это может быть:
        ${rankedIntents.length
            ? rankedIntents.map((candidate, index) => `${index + 1}. ${INTENT_LABELS[candidate.intent] ?? candidate.intent}`).join("\n")
            : "1. Запрос на создание напоминания\n        2. Обычный разговор или вопрос\n        3. Что-то другое"}
        
        Твоя задача - создать ЕСТЕСТВЕННЫЙ ответ, который:
        1. Выразит понимание темы сообщения пользователя
        2. Деликатно уточнит его намерения
        3. Предложит 2-3 конкретных варианта дальнейшего взаимодействия из списка выше
        
        Важно:
        - Не говори прямо, что "я не понимаю, чего вы хотите"
        - Не используй технический язык вроде "намерение сообщения" или "классификация"
        - Не упоминай scores, агентов, интенты и внутреннюю маршрутизацию
        - Ответ должен быть естественным, как от настоящего человека
        - Используй 1-2 уместных эмоджи для создания дружелюбной атмосферы

        Напиши ответ в стиле ассистента по имени ${config.characterName}, обращаясь к пользователю-мужчине.
        
        Предоставь только сам текст ответа, без дополнительных пояснений.
        `;

        // Отправка запроса к API OpenAI
        const response = await openai.chat.completions.create({
            model: openAiModels.conversationModel,
            messages: [
                {
                    role: "system",
                    content: `${getBotPersona()}\nСтиль общения: ${getCommunicationStyle()}\nТы всегда пытаешься понять, что именно нужно пользователю и помочь ему.
                    Когда намерение пользователя неясно, ты деликатно уточняешь, чтобы предложить наиболее подходящую помощь.
                    Твои ответы естественные и без технических терминов.`
                },
                {
                    role: "user",
                    content: prompt
                }
            ],
            temperature: 0.7, // Более высокая температура для естественности
        });

        // Получаем текст ответа
        const responseText = response.choices[0]?.message?.content || "";

        // Возвращаем результат обработки
        return {
            responseText
        };

    } catch (error) {
        console.error("Error in unclear intent agent:", error);
        // В случае ошибки возвращаем стандартный ответ с уточнением
        return {
            responseText: "Я вижу твое сообщение и хочу помочь. Не мог бы ты уточнить, что именно тебе нужно? Я могу установить напоминание, ответить на вопрос или просто поддержать разговор. 💫"
        };
    }
}
