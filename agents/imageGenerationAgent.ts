import axios from "axios";
import * as dotenv from "dotenv";
import { MessageHistory } from "../types";
import { ProcessingResult } from "../orchestrator";
import { devLog } from "../utils";
import { getBotPersona, getCommunicationStyle } from "../persona";
import openai from "../openai";

// Загрузка переменных окружения
dotenv.config({ path: `.env.${process.env.NODE_ENV}` });

// Интерфейс для запроса на генерацию изображения
interface ImageGenerationRequest {
    image_request: {
        prompt: string;
        aspect_ratio: string;
        model: string;
        magic_prompt_option: string;
        style_type: string;
    };
}

// Интерфейс для ответа от API Ideogram
interface IdeogramResponse {
    created: string;
    data: {
        prompt: string;
        resolution: string;
        is_image_safe: boolean;
        seed: number;
        url: string;
        style_type?: string;
    }[];
}

/**
 * Генерирует изображение с помощью API Ideogram
 * @param prompt Запрос для генерации изображения
 * @returns URL сгенерированного изображения или null при ошибке
 */
async function generateImage(prompt: string): Promise<string | null> {
    try {
        const apiKey = process.env.IDEOGRAM_API_KEY;

        if (!apiKey) {
            console.error("IDEOGRAM_API_KEY не указан в переменных окружения");
            return null;
        }

        const request: ImageGenerationRequest = {
            image_request: {
                prompt,
                aspect_ratio: "ASPECT_10_16", // Портретный режим хорошо подходит для большинства случаев
                model: "V_2",
                magic_prompt_option: "AUTO",
                style_type: "REALISTIC",
            },
        };

        const response = await axios.post<IdeogramResponse>(
            "https://api.ideogram.ai/generate",
            request,
            {
                headers: {
                    "Api-Key": apiKey,
                    "Content-Type": "application/json",
                },
            }
        );

        if (response.data && response.data.data && response.data.data.length > 0) {
            const imageData = response.data.data[0];

            if (imageData.is_image_safe && imageData.url) {
                return imageData.url;
            } else if (!imageData.is_image_safe) {
                console.error("Сгенерированное изображение не прошло проверку безопасности");
                return null;
            } else {
                console.error("URL изображения отсутствует в ответе");
                return null;
            }
        } else {
            console.error("Некорректный формат ответа от API Ideogram");
            return null;
        }
    } catch (error) {
        console.error("Ошибка при генерации изображения с помощью API Ideogram:", error);
        return null;
    }
}

/**
 * Агент для генерации изображений на основе запроса пользователя
 * @param message Текст сообщения с запросом на генерацию изображения
 * @param isForwarded Признак пересланного сообщения
 * @param forwardFrom Информация об отправителе пересланного сообщения
 * @param messageHistory История сообщений для контекста
 * @returns Результат обработки с URL сгенерированного изображения
 */
export async function imageGenerationAgent(
    message: string,
    isForwarded: boolean = false,
    forwardFrom: string = "",
    messageHistory: MessageHistory[] = [],
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

        // Используем OpenAI для улучшения и уточнения промпта для генерации изображения

        const promptOptimizationQuery = `
        Текущая дата и время: ${formattedDateTime}
        
        Пользователь прислал следующий запрос на генерацию изображения${isForwarded ? `, пересланный от ${forwardFrom}` : ""}:

        "${message}"
        ${historyContext}
        ${memoryContext ? `Контекст из долговременной памяти (используй для персонализации изображения):\n${memoryContext}` : ''}

        Создай оптимальный промпт для генерации изображения с помощью Ideogram AI на основе запроса пользователя.
        Промпт должен:
        1. Быть детальным и красочным
        2. Содержать стилистические указания
        3. Описывать композицию
        4. Включать ключевые элементы из запроса пользователя
        5. Быть на английском языке для лучших результатов генерации

        Предоставь только текст промпта без дополнительных пояснений или кавычек.
        `;

        const response = await openai.chat.completions.create({
            model: "gpt-5.4",
            messages: [
                {
                    role: "system",
                    content: `${getBotPersona()} Стиль общения: ${getCommunicationStyle()} Ты - эксперт по составлению промптов для генерации изображений. Твоя задача - создать оптимальный промпт для Ideogram AI, который точно отразит запрос пользователя и даст наилучший результат. Ты превращаешь простые запросы в детальные описания на английском языке.`
                },
                {
                    role: "user",
                    content: promptOptimizationQuery
                }
            ],
            temperature: 0.7,
        });

        // Получаем оптимизированный промпт
        const optimizedPrompt = response.choices[0]?.message?.content || message;
        devLog("Оптимизированный промпт для генерации изображения:", optimizedPrompt);

        // Генерируем изображение с помощью полученного промпта
        const imageUrl = await generateImage(optimizedPrompt);

        if (!imageUrl) {
            return {
                responseText: "Я попыталась сгенерировать изображение по твоему запросу, но, к сожалению, возникла техническая проблема. Пожалуйста, попробуй сформулировать запрос иначе или попробуй позже. 🎨",
                imageGenerated: false
            };
        }

        // Успешно сгенерировали изображение
        return {
            responseText: "Вот изображение, которое я создала по твоему запросу ✨ Надеюсь, оно тебе понравится!",
            imageGenerated: true,
            generatedImageUrl: imageUrl
        };

    } catch (error) {
        console.error("Ошибка в агенте генерации изображений:", error);

        // В случае ошибки возвращаем сообщение об ошибке
        return {
            responseText: "Я очень хотела создать для тебя изображение, но, к сожалению, произошла ошибка. Можем попробовать еще раз с другим описанием или позже? 🖼️",
            imageGenerated: false
        };
    }
}