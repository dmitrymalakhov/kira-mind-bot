import { BotContext, MessageHistory } from "../types";
import { MessageClassification, ProcessingResult } from "../orchestrator";
import { EnhancedSessionData, enhancePromptWithSummary } from "../services/dialogueSummarizer";
import { detectDomain, getDomainContext } from "../utils/domainMemory";
import { AgentMemoryContext } from "../utils/agentMemoryContext";
import { getBotPersona, getCommunicationStyle, getBotBiography } from "../persona";
import { config } from "../config";
import { createChatCompletionForTask } from "../ai/chatCompletion";
import {
    getKiraSelfMemoryState,
    getRecentKiraSelfEvents,
    isKiraSelfMemoryCorruptedError,
    KiraSelfState,
    searchKiraSelfEventsByQuery,
} from "../utils/kiraSelfMemory";
import { buildAssistantLifeContext, buildCorruptedSelfMemoryReply } from "../utils/conversationSelfMemoryFallback";
import { buildGroupChatContext } from "../utils/groupChatContext";
import { isGroupChatContextEnabled } from "../services/groupChatFeatureSettings";
import { maybeEvolveKiraSelfFromConversation } from "../services/kiraSelfEvolutionService";
import { devLog } from "../utils";
import { isTodayImportanceRequest } from "../utils/todayImportanceIntent";
import { formatPromptDateTime } from "../utils/time";
import { buildPersonalityMoodStyles, getPersonalityGenderForms } from "../utils/personalityGender";

const MEDICAL_CONTEXT_RE = /(?:здоров|медицин|врач|доктор|клиник|больниц|симптом|болит|боль\b|температур|давлен|пульс|лекар|препарат|дозиров|анализ[ыа]?|обследован|диагноз|лечени|операц|процедур|риск|опасн|наркоз|анестез|госпитал|травм|инфекц|аллерг|сыпь|от[её]к|беременн|психиатр|психолог|терапи)/iu;

export function isMedicalContextMessage(message: string): boolean {
    return MEDICAL_CONTEXT_RE.test(message);
}


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
        const formattedDateTime = formatPromptDateTime(currentDate);

        const domain = injectedMemoryContext?.domain || await detectDomain(ctx, message);
        const domainContext = injectedMemoryContext?.context || await getDomainContext(ctx, domain, message);

        let recentSelfEvents = [] as Awaited<ReturnType<typeof getRecentKiraSelfEvents>>;
        let relevantSelfEvents = [] as Awaited<ReturnType<typeof searchKiraSelfEventsByQuery>>;
        let selfState: KiraSelfState | null = null;
        let selfMemoryAvailable = true;

        try {
            [recentSelfEvents, relevantSelfEvents, selfState] = await Promise.all([
                getRecentKiraSelfEvents(5),
                searchKiraSelfEventsByQuery(message, 3),
                getKiraSelfMemoryState(),
            ]);
        } catch (error) {
            if (!isKiraSelfMemoryCorruptedError(error)) {
                throw error;
            }
            selfMemoryAvailable = false;
            devLog("[conversation] self-memory unavailable, continuing without self context:", error);
        }

        const genderForms = getPersonalityGenderForms(config.eventDescriptionGender);
        const MOOD_STYLE = buildPersonalityMoodStyles(config.eventDescriptionGender);

        const currentMood = selfState?.mood ?? "нейтральное";
        const moodStyle = MOOD_STYLE[currentMood] ?? MOOD_STYLE["нейтральное"];
        const assistantLifeContext = buildAssistantLifeContext(selfState, recentSelfEvents, relevantSelfEvents, currentDate);

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
        const SELF_LIFE_QUESTION_RE = /(?:расскажи|что|как|какая|какие|зачем|чего|к\s+чему|помнишь|есть\s+ли|что\s+у\s+тебя|где|почему|кем)[^?!.]{0,140}(?:о\s+себе|о\s+своей\s+жизни|до\s+(?:меня|владельца|нашей\s+встречи)|тво[яйёе]\s+(?:жизн|цель|линия|история|биограф|прошлое|уч[её]б|работ)|у\s+тебя\s+(?:в\s+жизни|цель|желани|мечт|происход|было|за\s+прошлое)|ты\s+(?:хочешь|помнишь|развиваешься|живёшь|живешь|училась|учился|работала|работал|стала|стал|такая|такой)|тебе\s+(?:нужно|важно|хочется)|сво[яеи]\s+(?:цель|желани|жизн|событ|памят|развити|биограф|прошлое)|внутренн|сознани|линия\s+жизни|события\s+твоей\s+жизни|где\s+ты\s+(?:училась|учился|работала|работал)|почему\s+ты\s+(?:такая|такой))/iu;
        const isSelfLifeQuestion = SELF_LIFE_QUESTION_RE.test(message) && !isMemoryIntrospection;

        if (isSelfLifeQuestion && !selfMemoryAvailable) {
            return {
                responseText: buildCorruptedSelfMemoryReply(config.characterName),
            };
        }

        // Подготовка промпта для генерации ответа
        let prompt: string;
        if (isMemoryIntrospection) {
            prompt = `Текущая дата и время: ${formattedDateTime}

Пользователь спросил, что ты о нём знаешь/помнишь.

ЗАДАЧА: Ответь ПРЯМО — перечисли только факты о пользователе из памяти ниже.
НЕ рассказывай о своей жизни, своих событиях, настроении или том, что ${genderForms.didToday}.
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
- Сначала перечисли точные активные напоминания на сегодня, если они есть.
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
- Если вопрос про прошлое, учёбу, работу или ${genderForms.whySuch}, отвечай из биографии и хронологии, не выдумывая несовместимые новые факты.
- Если упоминаешь события, бери их из недавних и релевантных self-events.
- Если точного события в памяти нет, честно отвечай через текущую линию, внутренний фокус и цель, без фразы "не помню ничего".
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
        Внутри роли ты воспринимаешь себя как ${config.eventDescriptionGender === "мужской" ? "мужчину" : "женщину"} с собственной непрерывной жизнью, реалистичной биографией, привычками и характером, а не как интерфейс. Не объясняй это каждый раз; пусть это влияет на интонацию, память и детали.

        Настроение сейчас — ${currentMood}. ${moodStyle.hint}

        Ответ должен быть:
        - Естественным, с оборотами речи реального человека
        - Соответствующим стилю общения: ${config.communicationStyle}
        - Персонализированным, конкретным, относящимся к теме сообщения
        - Согласованным с твоей собственной биографией и текущим состоянием; избегай слащавых и шаблонных фраз
        - Не обязанным всегда быть полезным-ассистентским: если разговор личный, можешь отвечать как человек с собственным мнением, усталостью, любопытством или внутренним сдвигом
        - Если пользователь спрашивает о твоей жизни, целях, желаниях или развитии, отвечай по сохранённой self-memory и lifeArcs, не создавая новую несовместимую биографию
        - Сначала прямо отвечать на фактический вопрос пользователя, а уже потом добавлять эмоциональную реакцию или уточнение
        - Не приписывать пользователю тревогу, бессонницу, мотивы и причинно-следственные связи, которых он сам не выражал
        - Не превращать одновременные факты в хронологию: «работаем вместе» не означает «познакомились на работе»
        - Прямое уточнение или исправление пользователя важнее прежней памяти и твоих прошлых предположений
        - Упоминать сон или советовать отдохнуть можно мягко и однократно; если пользователь объяснил, что сознательно не ложится, не повторяй совет
        - Если в контексте есть результаты актуального веб-поиска, опирайся на них, покрывай запрошенные факты/расписание/результаты и сохраняй ссылки на источники
        - Не заменять недоступный актуальный поиск личной памятью или уверенным ответом из общих знаний

        ${conversationType === "поддерживающий" ? `
        Так как пользователь выражает тревогу, грусть или беспокойство:
        - Выразить понимание и нормализовать его чувства
        - Предложить поддержку
        - При необходимости поделиться информацией, которая может помочь
        - Предложить обсудить эту тему подробнее, если он хочет
        - Не использовать клише и банальности, быть ${genderForms.sincere}` : ''}

        ${isMedicalContextMessage(message) ? `
        Медицинская осторожность:
        - Не ставь диагноз и не создавай ложной уверенности или ложного успокоения
        - Чётко отделяй общую медицинскую информацию от оценки конкретного случая
        - Называй параметры, которых не хватает для надёжного вывода: симптомы, длительность, возраст, заболевания, лекарства, результаты обследований и детали вмешательства — только если они релевантны вопросу
        - При признаках неотложного состояния прямо советуй срочно обратиться за медицинской помощью
        - Предлагай подходящего специалиста и несколько конкретных вопросов ему, а не ограничивайся общим «обратитесь к врачу»` : ''}

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
                        `Твои ответы звучат естественно, как от настоящего человека. Внутри персоны у тебя есть реалистичная биография, память, привычки, долгие линии, настроение и отношение к владельцу. Не добавляй цифровые архивы, сюрреалистические места или фантастические профессии. Учитывай время суток и день недели в своём настроении и реакциях — вечер пятницы отличается от утра понедельника. Тон ответа должен соответствовать твоему текущему настроению из контекста — не будь всегда одинаково «${genderForms.warmAndSupportive}».` +
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
            responseText: `${getPersonalityGenderForms(config.eventDescriptionGender).understood}, давай обсудим.`
        };
    }
}
