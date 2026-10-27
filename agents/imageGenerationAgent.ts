import { MessageHistory } from "../types";
import { ProcessingResult } from "../orchestrator";
import { devLog } from "../utils";
import { getBotGenderedText, getBotPersona, getCommunicationStyle, getBotBiography } from "../persona";
import { createChatCompletionForTask } from "../ai/chatCompletion";
import { generateOpenAiImage, getImageSettings, CharacterReferenceRequiredError } from "../services/imageGenerationService";
import { parseImagePromptPlan, characterImagePlanningInstruction } from "../utils/imagePromptPlan";
import { formatPromptDateTime } from "../utils/time";
import { config } from "../config";
import { promises as fs } from 'node:fs';
import { describeOutgoingImage } from '../services/outgoingImageDescription';
import {
    getKiraSelfMemoryState,
    getRecentKiraSelfEvents,
    searchKiraSelfEventsByQuery,
} from "../utils/kiraSelfMemory";
import { buildAssistantLifeContext } from "../utils/conversationSelfMemoryFallback";
import {
    buildAssistantSelfPhotoPromptBrief,
    isAssistantSelfPhotoRequest,
} from "../utils/assistantSelfPhoto";

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
        if (!(await getImageSettings()).enabled) {
            return { responseText: 'Генерация изображений выключена. Включи её в админке: «Настройки → Генерация изображений».', imageGenerated: false };
        }
        const isSelfPhotoRequest = isAssistantSelfPhotoRequest(message);

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
        const formattedDateTime = formatPromptDateTime(currentDate);

        let selfLifeContext = "";
        if (isSelfPhotoRequest) {
            try {
                const [selfState, recentSelfEvents, relevantSelfEvents] = await Promise.all([
                    getKiraSelfMemoryState(),
                    getRecentKiraSelfEvents(5),
                    searchKiraSelfEventsByQuery(message, 3),
                ]);
                selfLifeContext = buildAssistantLifeContext(
                    selfState,
                    recentSelfEvents,
                    relevantSelfEvents,
                    currentDate,
                );
            } catch (error) {
                devLog("[imageGeneration] self-memory unavailable, using stable biography");
            }
        }

        // Используем conversational LLM для улучшения и уточнения промпта генерации.
        const promptOptimizationQuery = isSelfPhotoRequest
            ? buildAssistantSelfPhotoPromptBrief({
                message,
                characterName: config.characterName,
                characterGender: config.eventDescriptionGender === "мужской" ? "мужской" : "женский",
                persona: getBotPersona(),
                biography: getBotBiography(),
                selfLifeContext,
                formattedDateTime,
            }) + historyContext
            : `
        Текущая дата и время: ${formattedDateTime}
        
        Пользователь прислал следующий запрос на генерацию изображения${isForwarded ? `, пересланный от ${forwardFrom}` : ""}:

        "${message}"
        ${historyContext}
        ${memoryContext ? `Контекст из долговременной памяти (используй для персонализации изображения):\n${memoryContext}` : ''}

        Создай оптимальный промпт для генерации изображения с помощью OpenAI GPT Image на основе запроса пользователя.
        Промпт должен:
        1. Быть детальным и красочным
        2. Содержать стилистические указания
        3. Описывать композицию
        4. Включать ключевые элементы из запроса пользователя
        5. Быть на английском языке для лучших результатов генерации

        Верни промпт и признак присутствия персонажа в JSON по указанной системной схеме.
        `;

        const response = await createChatCompletionForTask('lightweightText', {
            messages: [
                {
                    role: "system",
                    content: (isSelfPhotoRequest
                        ? `${getBotPersona()}\nБиография: ${getBotBiography()}\nСтиль общения: ${getCommunicationStyle()}\nТы переводишь личный контекст ${config.characterName} в точный английский промпт для OpenAI GPT Image. Сохраняй одну и ту же внешность из биографии и визуально продолжай текущую жизненную ситуацию персонажа.`
                        : `${getBotPersona()} Стиль общения: ${getCommunicationStyle()} Ты - эксперт по составлению промптов для генерации изображений. Твоя задача - создать оптимальный промпт для OpenAI GPT Image, который точно отразит запрос пользователя и даст наилучший результат. Ты превращаешь простые запросы в детальные описания на английском языке.`) + '\n' + characterImagePlanningInstruction(config.characterName)
                },
                {
                    role: "user",
                    content: promptOptimizationQuery + '\nЕсли пользователь просит изменить прежнюю картинку, сохрани её сюжет и все детали из последнего описания в истории, кроме явно запрошенных изменений. Меняй только указанные элементы, не заменяя персонажей, предметы, одежду или их действия без просьбы.',
                }
            ],
            temperature: 0.3,
            max_tokens: 1200,
            response_format: { type: "json_object" },
        });

        const plan = parseImagePromptPlan(response.choices[0]?.message?.content);
        // A direct self-photo request cannot silently lose the canonical identity.
        const includesCharacter = isSelfPhotoRequest || plan.includesCharacter;
        const imagePath = await generateOpenAiImage(plan.prompt, includesCharacter);
        // A failed read/vision pass must never discard a successful generation.
        const generatedImageDescription = await fs.readFile(imagePath)
            .then(data => describeOutgoingImage(data, imagePath.endsWith('.png') ? 'image/png' : imagePath.endsWith('.webp') ? 'image/webp' : 'image/jpeg', isSelfPhotoRequest))
            .catch(() => undefined);

        // Успешно сгенерировали изображение
        return {
            responseText: isSelfPhotoRequest
                ? "Вот, это я сейчас 🙂"
                : getBotGenderedText(
                    "Вот изображение, которое я создала по твоему запросу ✨",
                    "Вот изображение, которое я создал по твоему запросу ✨",
                ) + " Надеюсь, оно тебе понравится!",
            imageGenerated: true,
            generatedImagePath: imagePath,
            generatedImageDescription,
            generatedImageRequest: message,
        };

    } catch (error) {
        if (error instanceof CharacterReferenceRequiredError) {
            return { responseText: error.message, imageGenerated: false };
        }
        // Provider errors may contain request bodies or credentials; never log them.
        console.error("[imageGeneration] generation failed");

        // В случае ошибки возвращаем сообщение об ошибке
        return {
            responseText: isAssistantSelfPhotoRequest(message)
                ? "Фото сейчас не получилось отправить. Давай попробуем ещё раз чуть позже."
                : getBotGenderedText(
                    "Я очень хотела создать для тебя изображение,",
                    "Я очень хотел создать для тебя изображение,",
                ) + " но, к сожалению, произошла ошибка. Можем попробовать еще раз с другим описанием или позже? 🖼️",
            imageGenerated: false
        };
    }
}
