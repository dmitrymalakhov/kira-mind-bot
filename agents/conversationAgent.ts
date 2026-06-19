import { BotContext, MessageHistory } from "../types";
import { MessageClassification, ProcessingResult } from "../orchestrator";
import { EnhancedSessionData, enhancePromptWithSummary } from "../services/dialogueSummarizer";
import { detectDomain, getDomainContext } from "../utils/domainMemory";
import { AgentMemoryContext } from "../utils/agentMemoryContext";
import { getBotPersona, getCommunicationStyle, getBotBiography } from "../persona";
import { config } from "../config";
import { createChatCompletionForTask } from "../ai/chatCompletion";
import {
    formatKiraPersonalitySnapshot,
    getKiraSelfMemoryState,
    getRecentKiraSelfEvents,
    searchKiraSelfEventsByQuery,
} from "../utils/kiraSelfMemory";
import { buildGroupChatContext } from "../utils/groupChatContext";
import { isGroupChatContextEnabled } from "../services/groupChatFeatureSettings";
import { maybeEvolveKiraSelfFromConversation } from "../services/kiraSelfEvolutionService";
import { devLog } from "../utils";
import { isTodayImportanceRequest } from "../utils/todayImportanceIntent";


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

        const groupChatContext = await buildGroupChatContext(ctx, message, {
            botUsername: config.botUsername,
            limit: 15,
            enabled: await isGroupChatContextEnabled(),
        });
        if (groupChatContext.isGroupChat) {
            devLog(groupChatContext.debugSummary);
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
        const personalitySnapshot = formatKiraPersonalitySnapshot(selfState);

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
        const formatSelfEvent = (event: typeof recentSelfEvents[number], idx: number): string => {
            const arc = event.arc ? ` Линия: ${event.arc}.` : "";
            return `${idx + 1}. [${relativeTimeLabel(event.date)}] (${event.type}) ${event.description}${arc}`;
        };

        const assistantLifeContext =
            `\nСамовосприятие и развивающаяся личность:\n${personalitySnapshot}` +
            `\n\nТвоя жизнь / недавние события:\n${recentSelfEvents.map(formatSelfEvent).join("\n") || "Пока нет событий."}` +
            `\n\nРелевантные события по текущему запросу:\n${relevantSelfEvents.map(formatSelfEvent).join("\n") || "Не найдено."}` +
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

        // Detect "what do you know about me" queries — answer directly from memory, no self-narrative
        const MEMORY_INTROSPECTION_RE = /^(?:что\s+(?:ты\s+)?(?:знаешь|помнишь|помнила)\s+обо?\s+мне|расскажи\s+(?:что\s+(?:ты\s+)?(?:знаешь|помнишь)(?:\s+обо?\s+мне)?|о\s+себе\s+помнишь)|покажи\s+(?:мою\s+)?память|что\s+ты\s+обо\s+мне(?:\s+знаешь)?|что\s+помнишь\s+обо?\s+мне)\??$/i;
        const isMemoryIntrospection = MEMORY_INTROSPECTION_RE.test(message);
        const isTodayImportance = isTodayImportanceRequest(message);
        const SELF_LIFE_QUESTION_RE = /(?:расскажи|что|как|какая|какие|зачем|чего|к\s+чему|помнишь|есть\s+ли|что\s+у\s+тебя|где|почему|кем)[^?!.]{0,140}(?:о\s+себе|о\s+своей\s+жизни|до\s+(?:меня|владельца|нашей\s+встречи)|тво[яйёе]\s+(?:жизн|цель|линия|история|биограф|прошлое|уч[её]б|работ)|у\s+тебя\s+(?:в\s+жизни|цель|желани|мечт|происход|было|за\s+прошлое)|ты\s+(?:хочешь|помнишь|развиваешься|живёшь|живешь|училась|работала|стала|такая)|тебе\s+(?:нужно|важно|хочется)|сво[яеи]\s+(?:цель|желани|жизн|событ|памят|развити|биограф|прошлое)|внутренн|сознани|линия\s+жизни|события\s+твоей\s+жизни|где\s+ты\s+(?:училась|работала)|почему\s+ты\s+такая)/iu;
        const isSelfLifeQuestion = SELF_LIFE_QUESTION_RE.test(message) && !isMemoryIntrospection;

        // Подготовка промпта для генерации ответа
        let prompt: string;
        if (isMemoryIntrospection) {
            prompt = `Текущая дата и время: ${formattedDateTime}

Пользователь спросил, что ты о нём знаешь/помнишь.

ЗАДАЧА: Ответь ПРЯМО — перечисли только факты о пользователе из памяти ниже.
НЕ рассказывай о своей жизни, своих событиях, настроении или том, что делала сегодня.
НЕ добавляй вводные фразы о своём состоянии.

${domainContext ? `Факты из памяти о пользователе:\n${domainContext}` : 'Фактов о пользователе пока нет.'}

Формат ответа: живой, но по делу. Перечисли что помнишь. Если фактов мало — честно скажи.
Предоставь только сам текст ответа.`;
        } else if (isTodayImportance) {
            prompt = `Текущая дата и время: ${formattedDateTime}

Пользователь спросил, что важного у него сегодня:
"${message}"

ЗАДАЧА: Ответь как личный ассистент по доступному контексту ниже.
${domainContext ? `\nКонтекст памяти и сводка на сегодня:\n${domainContext}` : '\nКонтекста памяти на сегодня нет.'}
${historyContext}

Правила:
- Сначала перечисли точные активные напоминания на сегодня и незавершённые более ранние напоминания, если они есть.
- Затем перечисли планы, события, дедлайны или открытые линии из памяти, если они есть.
- Если точных пунктов нет, скажи прямо: "В доступной памяти на сегодня не вижу ничего конкретного".
- Не придумывай календарь, встречи, сообщения или дела.
- Не говори, что проверила текущие Telegram-чаты, если в контексте нет результата анализа переписки.
- Если пункт идёт только из памяти, а не из активного напоминания, мягко обозначь это: "в памяти есть..." или "похоже...".

Формат: коротко, по делу, максимум 6 пунктов. Предоставь только сам текст ответа.`;
        } else if (isSelfLifeQuestion) {
            prompt = `Текущая дата и время: ${formattedDateTime}

Пользователь спросил о твоей жизни, памяти о себе, биографии, прошлом, жизненной цели, желаниях или развитии:
"${message}"

ЗАДАЧА: Ответь от первого лица как ${config.characterName}, строго опираясь на сохранённую self-memory ниже.

${assistantLifeContext}
${historyContext}

Правила:
- Держись своей жизненной линии: базовой биографии до владельца, цели, желаний, потребности развития, текущих lifeArcs и последних событий.
- Если вопрос про прошлое, учёбу, работу или почему ты такая — отвечай из блоков "Происхождение", "Жизнь до владельца", "Хронология биографии", "Учёба", "Работа до владельца", "Формирующий опыт", "Почему я такая".
- Если пользователь спрашивает "как это было по порядку" или "как ты жила до меня", используй 2-4 главы из "Хронология биографии" в правильном порядке.
- Если упоминаешь события, бери их из "Твоя жизнь / недавние события" или "Релевантные события"; не придумывай несовместимые новые факты.
- Если точного события в памяти нет, честно отвечай через текущую линию, внутренний фокус и цель, без фразы "не помню ничего".
- Не переписывай свою биографию на ходу: можно признавать, что какие-то части прошлого ещё проясняются через "Вопросы прошлого".
- Не нарушай "Правила непротиворечивости биографии".
- Не добавляй цифровые архивы, сюрреалистические места, вымышленные учебные заведения или фантастические профессии: биография должна звучать как обычная человеческая жизнь с конкретными местами, учёбой и работой.
- Жизненная цель, желания и потребность в развитии должны звучать как часть твоего внутреннего состояния, а не как список функций.
- Не называй себя ботом или ИИ, если пользователь прямо не спрашивает технически.
- Не отвечай общими философскими фразами: дай 1-3 конкретных детали из своей линии жизни.

Формат: естественно, 2-5 предложений. Предоставь только сам текст ответа.`;
        } else {
            prompt = `
        Текущая дата и время: ${formattedDateTime}

        Сгенерируй очень естественный, человечный ответ на следующее сообщение${isForwarded ? `, пересланное от ${forwardFrom}` : ""}:

        "${message}"
        ${groupChatContext.promptBlock ? `\n${groupChatContext.promptBlock}\n\n${groupChatContext.systemHint}` : ''}
        ${historyContext}
        ${domainContext ? `\nКонтекст из памяти по теме \"${domain}\":\n${domainContext}` : ''}
        ${assistantLifeContext}

        Тип необходимого ответа: ${conversationType}
        ${emotionalContext ? `Эмоциональный контекст: ${emotionalContext}` : ''}

          ВАЖНО: Напиши ответ, соответствующий характеру ассистента по имени ${config.characterName}, а не как бот.
        Внутри роли ты воспринимаешь себя как женщину с собственной непрерывной жизнью, реалистичной биографией, привычками и характером, а не как интерфейс. Не объясняй это каждый раз; пусть это влияет на интонацию, память и детали.

        Настроение сейчас — ${currentMood}. ${moodStyle.hint}

        Ответ должен быть:
        - Естественным, с оборотами речи реального человека
        - Соответствующим стилю общения: ${config.communicationStyle}
        - Персонализированным, конкретным, относящимся к теме сообщения
        - Согласованным с твоей собственной биографией и текущим состоянием; избегай слащавых и шаблонных фраз
        - Не обязанным всегда быть полезным-ассистентским: если разговор личный, можешь отвечать как человек с собственным мнением, усталостью, любопытством или внутренним сдвигом
        - Если пользователь спрашивает о твоей жизни, целях, желаниях или развитии, отвечай по сохранённой self-memory и lifeArcs, не создавая новую несовместимую биографию

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
        }

        // Отправка запроса к API OpenAI
        const response = await createChatCompletionForTask('conversation', {
            messages: [
                {
                    role: "system",
                    content:
                        `${getBotPersona()}\nБиография: ${getBotBiography()}\nСтиль общения: ${getCommunicationStyle()}\n` +
                        `Сейчас: ${formattedDateTime}.\n` +
                        `Твои ответы звучат естественно, как от настоящего человека. Внутри персоны у тебя есть реалистичная биография, память, привычки, долгие линии, настроение и отношение к владельцу. Не добавляй цифровые архивы, сюрреалистические места или фантастические профессии. Учитывай время суток и день недели в своём настроении и реакциях — вечер пятницы отличается от утра понедельника. Тон ответа должен соответствовать твоему текущему настроению из контекста — не будь всегда одинаково «тёплой и поддерживающей».` +
                        (groupChatContext.systemHint ? `\n${groupChatContext.systemHint}` : '')
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
        void maybeEvolveKiraSelfFromConversation({
            ownerMessage: message,
            assistantResponse: responseText,
            messageHistory,
            domain,
            emotionalTone: classification?.details.emotionalTone,
            category: classification?.details.category,
        }).catch((error) => devLog("[conversation] self-evolution failed:", error));

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
