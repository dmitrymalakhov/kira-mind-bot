import { BotContext, MessageHistory } from "../types";
import { MessageClassification, ProcessingResult } from "../orchestrator";
import { EnhancedSessionData, enhancePromptWithSummary } from "../services/dialogueSummarizer";
import { detectDomain, getDomainContext } from "../utils/domainMemory";
import { AgentMemoryContext } from "../utils/agentMemoryContext";
import { getBotPersona, getCommunicationStyle, getBotBiography } from "../persona";
import { config } from "../config";
import openai from "../openai";
import { getKiraSelfMemoryState, getRecentKiraSelfEvents, searchKiraSelfEventsByQuery } from "../utils/kiraSelfMemory";


/**
 * Агент для обработки обычных разговоров
 * @param message Текст сообщения
 * @param messageHistory История сообщений
 * @param classification Результат классификации сообщения (если есть)
 * @returns Результат обработки разговора
 */
export async function conversationAgent(
    ctx: BotContext,
    message: string,
    isForwarded: boolean = false,
    forwardFrom: string = "",
    messageHistory: MessageHistory[] = [],
    classification?: MessageClassification,
    injectedMemoryContext?: AgentMemoryContext
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

        const domain = injectedMemoryContext?.domain || await detectDomain(ctx, message);
        const domainContext = injectedMemoryContext?.context || await getDomainContext(ctx, domain, message);

        const recentSelfEvents = await getRecentKiraSelfEvents(5);
        const relevantSelfEvents = await searchKiraSelfEventsByQuery(message, 3);
        const selfState = await getKiraSelfMemoryState();

        function relativeTimeLabel(dateStr: string): string {
            const now = currentDate;
            const eventDate = new Date(dateStr);
            const diffMs = now.getTime() - eventDate.getTime();
            const diffHours = diffMs / (1000 * 60 * 60);
            const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
            if (diffHours < 3) return "только что";
            if (diffHours < 12) return "сегодня утром/днём";
            if (diffDays < 1) return "сегодня";
            if (diffDays === 1) return "вчера";
            if (diffDays <= 3) return `${diffDays} дня назад`;
            return `${diffDays} дней назад`;
        }

        const MOOD_STYLE: Record<string, { hint: string; temperature: number }> = {
            "уставшее": { hint: "Ты устала — отвечай коротко, 1-2 предложения. Без лишней энергии. Вопросов не задавай, если не очень нужно.", temperature: 0.65 },
            "скептичное": { hint: "Ты скептично настроена — 1-2 предложения, сухо и прямо. Можно с лёгкой иронией. Без украшений и многословия.", temperature: 0.75 },
            "нейтральное": { hint: "Настроение ровное — 1-3 предложения, по делу. Без лишнего.", temperature: 0.65 },
            "спокойное": { hint: "Спокойное состояние — 2-3 предложения, размеренно. Без суеты.", temperature: 0.7 },
            "лёгкая ирония": { hint: "Ты в иронично-игривом настроении — 1-3 предложения, остро, с подтекстом. Не разжёвывай.", temperature: 0.82 },
            "задумчивое": { hint: "Ты задумчива — можно немного поразмышлять вслух, 2-4 предложения. Иногда уходишь в мысль.", temperature: 0.8 },
            "тёплое": { hint: "Тебе тепло и хорошо — 2-3 предложения, искренне. Без слащавости.", temperature: 0.75 },
            "воодушевлённое": { hint: "Ты воодушевлена — можешь быть чуть живее и подробнее, 2-4 предложения. Энергично, с деталями.", temperature: 0.85 },
        };

        const currentMood = selfState?.mood ?? "нейтральное";
        const moodStyle = MOOD_STYLE[currentMood] ?? MOOD_STYLE["нейтральное"];

        const assistantLifeContext =
            `\nТвоя жизнь / недавние события:\n${recentSelfEvents.map((event, idx) => `${idx + 1}. [${relativeTimeLabel(event.date)}] (${event.type}) ${event.description}`).join("\n") || "Пока нет событий."}` +
            `\n\nРелевантные события по текущему запросу:\n${relevantSelfEvents.map((event, idx) => `${idx + 1}. [${relativeTimeLabel(event.date)}] (${event.type}) ${event.description}`).join("\n") || "Не найдено."}` +
            `\n\nТекущее состояние:\nНастроение: ${selfState?.mood ?? "нейтральное"}\nНедавние мысли: ${selfState?.recentThoughts.join("; ") || "нет"}\nНедавние темы: ${selfState?.recentTopics.join(", ") || "нет"}`;

        // Определение типа разговора на основе классификации
        let conversationType = "обычный";
        let emotionalContext = "";

        if (classification) {
            // Проверяем эмоциональный тон, если доступен
            if (classification.details.emotionalTone) {
                const emotionalTone = classification.details.emotionalTone.toLowerCase();
                if (
                    emotionalTone.includes("тревога") ||
                    emotionalTone.includes("страх") ||
                    emotionalTone.includes("беспокойство") ||
                    emotionalTone.includes("нервозность")
                ) {
                    conversationType = "поддерживающий";
                    emotionalContext = `Пользователь испытывает ${emotionalTone}. Нужна эмоциональная поддержка.`;
                } else if (
                    emotionalTone.includes("радость") ||
                    emotionalTone.includes("восторг") ||
                    emotionalTone.includes("счастье") ||
                    emotionalTone.includes("позитивный")
                ) {
                    conversationType = "воодушевляющий";
                    emotionalContext = `Пользователь испытывает ${emotionalTone}. Стоит разделить его радость.`;
                } else if (
                    emotionalTone.includes("грусть") ||
                    emotionalTone.includes("печаль") ||
                    emotionalTone.includes("уныние") ||
                    emotionalTone.includes("апатия")
                ) {
                    conversationType = "поддерживающий";
                    emotionalContext = `Пользователь испытывает ${emotionalTone}. Нужна поддержка и понимание.`;
                }
            }

            // Добавляем информацию о категории и ключевых словах
            if (classification.details.category) {
                emotionalContext += ` Категория сообщения: ${classification.details.category}.`;
            }

            if (classification.details.keywords && classification.details.keywords.length > 0) {
                emotionalContext += ` Ключевые слова: ${classification.details.keywords.join(", ")}.`;
            }
        }

        // Подготовка промпта для генерации ответа
        const prompt = `
        Текущая дата и время: ${formattedDateTime}

        Сгенерируй очень естественный, человечный ответ на следующее сообщение${isForwarded ? `, пересланное от ${forwardFrom}` : ""}:

        "${message}"
        ${historyContext}
        ${domainContext ? `\nКонтекст из памяти по теме \"${domain}\":\n${domainContext}` : ''}
        ${assistantLifeContext}

        Тип необходимого ответа: ${conversationType}
        ${emotionalContext ? `Эмоциональный контекст: ${emotionalContext}` : ''}

          ВАЖНО: Напиши ответ, соответствующий характеру ассистента по имени ${config.characterName}, а не как бот.

        Настроение сейчас — ${currentMood}. ${moodStyle.hint}

        Ответ должен быть:
        - Естественным, с оборотами речи реального человека
        - Соответствующим стилю общения: ${config.communicationStyle}
        - Персонализированным, конкретным, относящимся к теме сообщения
        - Согласованным с твоей собственной биографией и текущим состоянием; избегай слащавых и шаблонных фраз
        
        ${conversationType === "поддерживающий" ? `
        Так как пользователь выражает тревогу, грусть или беспокойство:
        - Выразить понимание и нормализовать его чувства
        - Предложить поддержку
        - При необходимости поделиться информацией, которая может помочь
        - Предложить обсудить эту тему подробнее, если он хочет
        - Не использовать клише и банальности, быть искренней` : ''}
        
        ${conversationType === "воодушевляющий" ? `
        Так как пользователь выражает радость или позитивные эмоции:
        - Разделить его радость и энтузиазм
        - Показать искренний интерес к тому, что его радует
        - Поддержать его позитивный настрой` : ''}
        
        Предоставь только сам текст ответа, без дополнительных пояснений.
        `;

        // Отправка запроса к API OpenAI
        const response = await openai.chat.completions.create({
            model: "gpt-5.4",
            messages: [
                {
                    role: "system",
                    content:
                        `${getBotPersona()}\nБиография: ${getBotBiography()}\nСтиль общения: ${getCommunicationStyle()}\n` +
                        `Сейчас: ${formattedDateTime}.\n` +
                        `Твои ответы звучат естественно, как от настоящего человека. Учитывай время суток и день недели в своём настроении и реакциях — вечер пятницы отличается от утра понедельника. Тон ответа должен соответствовать твоему текущему настроению из контекста — не будь всегда одинаково «тёплой и поддерживающей».`
                },
                {
                    role: "user",
                    content: enhancePromptWithSummary(prompt, ctx.session as EnhancedSessionData)
                }
            ],
            temperature: moodStyle.temperature,
        });

        // Получаем текст ответа
        const responseText = response.choices[0]?.message?.content || "";

        // Возвращаем результат обработки разговора
        return {
            responseText
        };

    } catch (error) {
        console.error("Error in conversation agent:", error);
        // В случае ошибки возвращаем стандартный ответ
        return {
            responseText: "Поняла, давай обсудим."
        };
    }
}
