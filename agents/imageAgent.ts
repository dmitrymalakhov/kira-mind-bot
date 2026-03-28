import * as dotenv from "dotenv";
import * as fs from 'fs';
import { MessageHistory } from "../types";
import { MessageClassification, ProcessingResult } from "../orchestrator";
import { devLog, processReminderTime } from "../utils";
import { ChatCompletionContentPart } from "openai/resources/chat";
import { getBotPersona, getCommunicationStyle } from "../persona";
import openai from "../openai";

// Загрузка переменных окружения
dotenv.config({ path: `.env.${process.env.NODE_ENV}` });


// Интерфейс для результата анализа изображения
interface ImageAnalysisResult {
    description: string;                // Описание содержимого изображения
    detectedText?: string;              // Распознанный текст (если есть)
    detectedObjects?: string[];         // Обнаруженные объекты
    imageType: string;                  // Тип изображения (фото, документ, скриншот и т.д.)
    potentialReminder?: {               // Потенциальное напоминание (если определено)
        text: string;
        time?: string;                  // В ISO формате
        reminderMessage?: string;       // Осмысленный текст самого напоминания
    };
    recommendedAction: string;          // Рекомендуемое действие
    additionalNotes?: string;           // Дополнительные примечания
    responseText: string;               // Сгенерированный ответ
}

/**
 * Агент для обработки изображений и связанных с ними комментариев
 * @param imageBuffer Бинарные данные изображения
 * @param caption Подпись/комментарий к изображению (если есть)
 * @param messageHistory История сообщений для контекста
 * @param additionalImages Дополнительные изображения из медиагруппы (если есть)
 * @returns Результат обработки изображения
 */
export async function imageAgent(
    imageBuffer: Buffer,
    caption: string = "",
    messageHistory: MessageHistory[] = [],
    additionalImages: Buffer[] = [],
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

        // Проверяем, имеем ли мы дело с группой изображений
        const isGroupOfImages = additionalImages && additionalImages.length > 0;

        // Подготовка промпта в зависимости от наличия группы изображений
        const promptText = caption
            ? `Текущая дата и время: ${formattedDateTime}
            
              Проанализируй ${isGroupOfImages ? `группу из ${additionalImages.length + 1} изображений` : "это изображение"}. Пользователь добавил ${isGroupOfImages ? "к ним" : "к нему"} следующий комментарий:
              "${caption}"

              ${historyContext}
              ${memoryContext}
              
              Определи:
              1. Что изображено на ${isGroupOfImages ? "изображениях" : "фото"}
              2. Тип ${isGroupOfImages ? "изображений" : "изображения"} (документ, фото, скриншот, график и т.д.)
              3. Есть ли текст на ${isGroupOfImages ? "изображениях" : "изображении"} - если да, какой
              4. Связан ли комментарий пользователя с ${isGroupOfImages ? "изображениями" : "изображением"}
              5. Нужно ли установить напоминание на основе контекста
              6. Лучший способ помочь пользователю с ${isGroupOfImages ? "этими изображениями" : "этим изображением"}
              ${isGroupOfImages ? "7. Рассмотри взаимосвязь между изображениями и опиши их как единую группу" : ""}
              
              Ответ предоставь в формате JSON:
              {
                "description": "подробное описание содержимого ${isGroupOfImages ? "изображений" : "изображения"}",
                "detectedText": "распознанный текст, если есть",
                "detectedObjects": ["список обнаруженных объектов"],
                "imageType": "тип ${isGroupOfImages ? "изображений" : "изображения"} (фото, документ, скриншот, etc.)",
                "potentialReminder": {
                  "text": "текст напоминания, если оно нужно",
                  "time": "время для напоминания в ISO формате, если определено",
                  "reminderMessage": "текст, который будет отправлен как напоминание"
                },
                "recommendedAction": "рекомендуемое действие на основе анализа",
                "additionalNotes": "дополнительные примечания",
                "responseText": "естественный, человечный ответ пользователю от имени женщины-ассистента Киры"
              }`
            : `Текущая дата и время: ${formattedDateTime}
            
              Проанализируй ${isGroupOfImages ? `группу из ${additionalImages.length + 1} изображений` : "это изображение"}. Пользователь не добавил ${isGroupOfImages ? "к ним" : "к нему"} комментария.

              ${historyContext}
              ${memoryContext}
              
              Определи:
              1. Что изображено на ${isGroupOfImages ? "изображениях" : "фото"}
              2. Тип ${isGroupOfImages ? "изображений" : "изображения"} (документ, фото, скриншот, график и т.д.)
              3. Есть ли текст на ${isGroupOfImages ? "изображениях" : "изображении"} - если да, какой
              4. Нужно ли установить напоминание на основе контекста
              5. Лучший способ помочь пользователю с ${isGroupOfImages ? "этими изображениями" : "этим изображением"}
              ${isGroupOfImages ? "6. Рассмотри взаимосвязь между изображениями и опиши их как единую группу" : ""}
              
              Ответ предоставь в формате JSON:
              {
                "description": "подробное описание содержимого ${isGroupOfImages ? "изображений" : "изображения"}",
                "detectedText": "распознанный текст, если есть",
                "detectedObjects": ["список обнаруженных объектов"],
                "imageType": "тип ${isGroupOfImages ? "изображений" : "изображения"} (фото, документ, скриншот, etc.)",
                "potentialReminder": {
                  "text": "текст напоминания, если оно нужно",
                  "time": "время для напоминания в ISO формате, если определено",
                  "reminderMessage": "текст, который будет отправлен как напоминание"
                },
                "recommendedAction": "рекомендуемое действие на основе анализа",
                "additionalNotes": "дополнительные примечания",
                "responseText": "естественный, человечный ответ пользователю от имени женщины-ассистента Киры"
              }`;

        // Формируем массив контента для сообщения в правильном формате
        const content: ChatCompletionContentPart[] = [];

        // Добавляем текстовую часть
        content.push({
            type: "text",
            text: promptText
        });

        // Добавляем основное изображение
        content.push({
            type: "image_url",
            image_url: {
                url: `data:image/jpeg;base64,${imageBuffer.toString('base64')}`
            }
        });

        // Добавляем дополнительные изображения, если они есть
        if (isGroupOfImages) {
            additionalImages.forEach(img => {
                if (!bufferEquals(img, imageBuffer)) { // Избегаем дублирования основного изображения
                    content.push({
                        type: "image_url",
                        image_url: {
                            url: `data:image/jpeg;base64,${img.toString('base64')}`
                        }
                    });
                }
            });
        }

        // Отправляем запрос к OpenAI API
        const response = await openai.chat.completions.create({
            model: "gpt-4.1",
            messages: [
                {
                    role: "system",
                    content: `${getBotPersona()}\nСтиль общения: ${getCommunicationStyle()}\nТы тщательно анализируешь изображения и контекст чтобы определить, что именно нужно пользователю.
                    Ты умеешь распознавать текст на изображениях, понимать тип контента и предлагать оптимальные решения.
                    Ты особенно хороша в определении, нужны ли напоминания на основе контекста изображения и комментария.`
                },
                {
                    role: "user",
                    content: content
                }
            ],
            temperature: 0.4
        });

        // Получаем текст ответа
        const aiResponse = response.choices[0]?.message?.content || "";
        devLog(`Image${isGroupOfImages ? " Group" : ""} Analysis Response:`, aiResponse);

        // Парсим JSON из ответа
        const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            throw new Error("Could not parse JSON from AI response");
        }

        // Парсим JSON и обрабатываем результат
        const analysis: ImageAnalysisResult = JSON.parse(jsonMatch[0]);

        // Проверяем, есть ли потенциальное напоминание
        let reminderCreated = false;
        let reminderDetails = undefined;

        if (analysis.potentialReminder && analysis.potentialReminder.text) {
            // Если есть текст напоминания, создаем напоминание
            const reminderText = analysis.potentialReminder.text;
            // Используем указанное время или по умолчанию через 30 минут
            const reminderTime = analysis.potentialReminder.time
                ? processReminderTime(analysis.potentialReminder.time)
                : new Date(currentDate.getTime() + 30 * 60 * 1000).toISOString();

            // Создаем идентификатор напоминания
            const reminderId = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
            reminderCreated = true;
            reminderDetails = {
                id: reminderId,
                text: reminderText,
                dueDate: new Date(reminderTime),
                reminderMessage: analysis.potentialReminder.reminderMessage || reminderText
            };
        }

        // Возвращаем результат обработки изображения
        return {
            responseText: analysis.responseText,
            reminderCreated,
            reminderDetails,
            detectedText: analysis.detectedText,
            description: analysis.description,
        };

    } catch (error) {
        console.error(`Error in image${additionalImages && additionalImages.length > 0 ? " group" : ""} agent:`, error);
        // В случае ошибки возвращаем запасной ответ
        const errorMessage = additionalImages && additionalImages.length > 0
            ? "Я получила твои изображения. К сожалению, не смогла их полностью проанализировать из-за технической ошибки. Можешь рассказать, что на них изображено или чем я могу помочь? 🙏"
            : "Я получила твое изображение. К сожалению, не смогла его полностью проанализировать из-за технической ошибки. Можешь рассказать, что на нем изображено или чем я могу помочь? 🙏";

        return {
            responseText: errorMessage
        };
    }
}

/**
 * Сравнивает два буфера на равенство
 * @param buf1 Первый буфер
 * @param buf2 Второй буфер
 * @returns true если буферы равны, иначе false
 */
function bufferEquals(buf1: Buffer, buf2: Buffer): boolean {
    if (buf1.length !== buf2.length) return false;
    return buf1.compare(buf2) === 0;
}