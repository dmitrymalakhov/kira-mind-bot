import * as dotenv from "dotenv";
import { MessageHistory } from "./types";
import { conversationAgent } from "./agents/conversationAgent";
import { reminderAgent } from "./agents/reminderAgent";
import { unclearIntentAgent } from "./agents/unclearIntentAgent";
import { imageAgent } from "./agents/imageAgent";
import { imageGenerationAgent } from "./agents/imageGenerationAgent";
import { mapsAgent } from "./agents/googleMapsAgent";
import { readMessagesAgent } from "./agents/readMessagesAgent";
import { webSearchAgent } from "./agents/webSearchAgent";
import { InlineKeyboard } from "grammy";
import { sendMessagesAgent } from "./agents/sendMessagesAgent";
import { devLog, parseLLMJson } from "./utils";
import openai from "./openai";
import { llmCache, LLM_CACHE_TTL } from "./utils/llmCache";
import { fetchAgentMemoryContext, buildMemoryContextBlock } from "./utils/agentMemoryContext";
import { extractExplicitRememberFact } from "./utils/enhancedFactExtraction";
import { detectRelationshipInMessage, resolveRelationshipFromMemory } from "./utils/resolveRelationshipFromMemory";
import { createPlan } from "./orchestration/planner";
import { executePlan } from "./orchestration/executor";
import { Plan } from "./orchestration/types";

// Загрузка переменных окружения
dotenv.config({ path: `.env.${process.env.NODE_ENV}` });



// Расширенный интерфейс для результата классификации сообщения
export interface MessageClassification {
    intent: "НАПОМИНАНИЕ" | "РАЗГОВОР" | "НЕОПРЕДЕЛЕНО" | "ГЕНЕРАЦИЯ_ИЗОБРАЖЕНИЯ" |
    "КАРТЫ_ЛОКАЦИИ" | "ПРОВЕРКА_СООБЩЕНИЙ" | "ВЕБ_ПОИСК" | "ОТПРАВКА_СООБЩЕНИЯ" | "ДЕЛЕГИРОВАНИЕ_ЗАДАЧИ" | "ВОЗМОЖНОСТИ_БОТА";
    confidenceLevel: "ВЫСОКИЙ" | "СРЕДНИЙ" | "НИЗКИЙ";
    details: {
        category?: string;
        keywords?: string[];
        emotionalTone?: string;
        urgency?: "ВЫСОКАЯ" | "СРЕДНЯЯ" | "НИЗКАЯ";
        timeReferences?: string[];
        imageDescription?: string; // Описание изображения, которое нужно сгенерировать
        locationQuery?: string;    // Запрос к картам или о местоположении
        contactQuery?: string;     // Запрос о контакте, которому нужно отправить сообщение
        messageContent?: string;   // Содержание сообщения для отправки
        messagesCheckType?: "ALL_MESSAGES" | "ANALYZE_CONVERSATION"; // Тип проверки сообщений
        analysisQuery?: string;    // Запрос для анализа переписки
        /** Изучить переписку с контактом и сохранить факты о пользователе в долговременную память */
        saveFactsAboutUser?: boolean;
        /** Имя контакта, разрешённое из памяти на шаге resolveContact (для readMessages) */
        resolvedContactName?: string;
        /** Название группового чата (если запрос о групповом чате, а не переписке с конкретным человеком) */
        groupChatQuery?: string;
        /** Предложенная реакция-эмодзи на сообщение пользователя */
        botReaction?: string;
    };
}

// Расширенный интерфейс для результата обработки сообщения
export interface ProcessingResult {
    responseText: string;
    reminderCreated?: boolean;
    reminderDetails?: {
        id: string;
        text: string;
        reminderMessage?: string;
        dueDate: Date;
        /** Куда отправить напоминание: в группу или контакту (резолвится при срабатывании) */
        targetChat?: { type: "group"; groupName: string } | { type: "contact"; contactQuery: string };
    };
    reminderDetailsList?: {
        id: string;
        text: string;
        reminderMessage?: string;
        dueDate: Date;
        targetChat?: { type: "group"; groupName: string } | { type: "contact"; contactQuery: string };
    }[];
    detectedText?: string; // Текст, который был распознан в сообщении
    description?: string; // Описание изображения, если оно было сгенерировано
    imageGenerated?: boolean;  // Флаг успешной генерации изображения
    generatedImageUrl?: string; // URL сгенерированного изображения
    icsFilePath?: string; // Путь к сгенерированному ICS файлу

    // Новые поля для поддержки отправки сообщений
    keyboard?: InlineKeyboard; // Инлайн-клавиатура для взаимодействия
    messageDraft?: {
        contactId: number;
        text: string;
        scheduledTime?: Date;
    }; // Черновик сообщения для отправки
    contactSelected?: boolean; // Флаг выбора контакта
    messageEditing?: boolean; // Флаг редактирования сообщения
    messageConfirmed?: boolean; // Флаг подтверждения отправки
    /** Эмодзи-реакция, которую бот может поставить на сообщение пользователя */
    botReaction?: string;
    /** Сводка переговоров уже отправлена отдельным сообщением — не дублировать ответ */
    negotiationSummarySent?: boolean;
}

interface IntentDedupCheckResult {
    isDuplicate: boolean;
    confidence: number;
    reason?: string;
}

const INTENT_DEDUP_WINDOW_MS = 3 * 60 * 1000;
const INTENT_DEDUP_MIN_CONFIDENCE = 0.8;
const NON_DEDUP_INTENTS = new Set(["ОТПРАВКА_СООБЩЕНИЯ", "ДЕЛЕГИРОВАНИЕ_ЗАДАЧИ", "ГЕНЕРАЦИЯ_ИЗОБРАЖЕНИЯ", "ПРОВЕРКА_СООБЩЕНИЙ"]);

function normalizeForDedup(text: string): string {
    return text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function jaccardTokenOverlap(a: string, b: string): number {
    const aTokens = new Set(a.split(" ").filter(Boolean));
    const bTokens = new Set(b.split(" ").filter(Boolean));
    if (aTokens.size === 0 || bTokens.size === 0) return 0;

    let intersection = 0;
    for (const t of aTokens) {
        if (bTokens.has(t)) intersection++;
    }
    const union = aTokens.size + bTokens.size - intersection;
    return union > 0 ? intersection / union : 0;
}

function isPotentialDuplicateCandidate(currentMessage: string, previousMessage: string): boolean {
    const current = normalizeForDedup(currentMessage);
    const previous = normalizeForDedup(previousMessage);
    if (!current || !previous) return false;
    if (current === previous) return true;

    const longer = Math.max(current.length, previous.length);
    const shorter = Math.min(current.length, previous.length);
    if (shorter / longer < 0.6) return false;

    return jaccardTokenOverlap(current, previous) >= 0.35;
}

function buildDedupReuseResult(previous: ProcessingResult): ProcessingResult {
    return {
        ...previous,
        // Иначе index.ts заново сохранит напоминания/побочные эффекты.
        reminderCreated: false,
        reminderDetails: undefined,
        reminderDetailsList: undefined,
        icsFilePath: undefined,
    };
}

async function isDuplicateIntentByLLM(params: {
    currentMessage: string;
    previousMessage: string;
    previousIntent: MessageClassification["intent"];
    previousPlanStepIds: string[];
}): Promise<IntentDedupCheckResult> {
    const { currentMessage, previousMessage, previousIntent, previousPlanStepIds } = params;
    const cacheKey = `intent-dedup:${previousIntent}:${previousMessage.slice(0, 160)}:${currentMessage.slice(0, 160)}`;
    const cached = llmCache.get<IntentDedupCheckResult>(cacheKey);
    if (cached) {
        devLog("intent-dedup: cache hit");
        return cached;
    }

    const prompt = `Сравни два сообщения пользователя и определи, является ли второе фактически повтором того же намерения, что и первое.

Первое сообщение:
"${previousMessage}"

Второе сообщение:
"${currentMessage}"

Контекст предыдущего намерения:
- intent: ${previousIntent}
- шаги плана: ${previousPlanStepIds.join(" -> ") || "unknown"}

Считай ДУБЛЕМ, только если пользователь по сути просит то же самое действие/результат.
НЕ считай дублем, если есть новая деталь, уточнение времени/даты, другой адресат, другое действие, просьба "еще раз", "добавь", "измени", "по-другому".

Верни только JSON:
{
  "isDuplicate": true | false,
  "confidence": 0..1,
  "reason": "кратко"
}`;

    try {
        const resp = await openai.chat.completions.create({
            model: "gpt-5.2",
            messages: [
                {
                    role: "system",
                    content: "Ты строгий детектор дублей пользовательских намерений. Возвращай только JSON без markdown.",
                },
                {
                    role: "user",
                    content: prompt,
                },
            ],
            temperature: 1,
        });

        const aiResponse = resp.choices[0]?.message?.content || "";
        const parsed = parseLLMJson<IntentDedupCheckResult>(aiResponse);
        const result: IntentDedupCheckResult = {
            isDuplicate: Boolean(parsed?.isDuplicate),
            confidence: Number(parsed?.confidence ?? 0),
            reason: parsed?.reason || "",
        };
        llmCache.set(cacheKey, result, LLM_CACHE_TTL.INTENT_DEDUP);
        return result;
    } catch (error) {
        console.error("Error in intent dedup check:", error);
        return { isDuplicate: false, confidence: 0 };
    }
}

function getSessionDedupSnapshot(ctx: any): any | undefined {
    return ctx?.session?.lastIntentDedup;
}

function saveSessionDedupSnapshot(ctx: any, params: {
    message: string;
    classification: MessageClassification;
    plan: Plan;
    result: ProcessingResult;
}): void {
    if (!ctx?.session) return;
    const { message, classification, plan, result } = params;
    ctx.session.lastIntentDedup = {
        message,
        intent: classification.intent,
        confidenceLevel: classification.confidenceLevel,
        planStepIds: plan.steps.map((s) => s.agentId),
        result,
        createdAt: Date.now(),
    };
}

/**
 * Классифицирует входящее сообщение по типу намерения
 * @param message Текст сообщения
 * @param messageHistory История сообщений
 * @returns Классификация сообщения
 */
export async function classifyMessage(
    message: string,
    isForwarded: boolean = false,
    forwardFrom: string = "",
    messageHistory: MessageHistory[] = []
): Promise<MessageClassification> {
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

        // Подготовка промпта для классификации
        const prompt = `
        Текущая дата и время: ${formattedDateTime}
        
        Проанализируй следующее сообщение${isForwarded ? `, пересланное от ${forwardFrom}` : ""}:

        "${message}"
        ${historyContext}

        Твоя задача: однозначно определить намерение пользователя и вернуть одну из категорий ниже.
        Выбирай конкретный интент (не НЕОПРЕДЕЛЕНО), если сообщение хотя бы примерно подходит под категорию. НЕОПРЕДЕЛЕНО — только если сообщение действительно непонятно или не подходит ни под одну категорию. Для ясных просьб всегда указывай confidenceLevel: ВЫСОКИЙ.
        
        Категории (выбери одну):
        
        1. НАПОМИНАНИЕ - пользователь явно просит установить напоминание, создать задачу, 
           запланировать встречу или отследить событие. Используются слова "напомни", "создай напоминание", 
           "не забудь", "запланируй", "встреча", "записаться", "запись на прием", "мероприятие", "событие" и т.п.
           
        2. РАЗГОВОР - пользователь делится информацией, задает вопрос, выражает эмоции,
           рассказывает о событии БЕЗ просьбы о напоминании.
           
        3. ГЕНЕРАЦИЯ_ИЗОБРАЖЕНИЯ - пользователь просит создать, нарисовать, сгенерировать 
           изображение, картинку, фото и т.п. Используются фразы "нарисуй", "создай изображение",
           "сгенерируй картинку", "нарисуй мне", и подобные. Если в сообщении описывается
           визуальная сцена, которую нужно создать - это ГЕНЕРАЦИЯ_ИЗОБРАЖЕНИЯ.
           
        4. КАРТЫ_ЛОКАЦИИ - пользователь запрашивает информацию о местоположении, маршрутах,
           адресах, поиске мест на карте. Используются фразы типа "как добраться", "найди на карте",
           "где находится", "проложи маршрут", "покажи на карте" и т.п.
           
        5. ПРОВЕРКА_СООБЩЕНИЙ - пользователь запрашивает информацию о сообщениях в Telegram,
            просит проверить, кто писал, проанализировать переписку с конкретным человеком и т.п.
            Используются фразы "проверь телеграм", "кто писал в телеграм", "есть сообщения в телеграме",
            "анализ переписки с", "проанализируй переписку", "проанализируй чат с", "узнай из переписки",
            "составь портрет по переписке" и т.п.
            ВАЖНО: просьба «изучи чат/переписку с X и узнай/запомни факты про меня/о нас» — это ВСЕГДА ПРОВЕРКА_СООБЩЕНИЙ,
            а НЕ РАЗГОВОР. Такой запрос требует чтения реальной переписки из Telegram.
            Примеры: "изучи чат с моей женой и запомни факты про меня", "прочитай переписку с мамой и узнай что-нибудь обо мне",
            "изучи чат с Юлей и узнай и запомни факты про меня и мою жену".
            
        6. ВЕБ_ПОИСК - пользователь просит найти информацию в интернете, 
           узнать последние новости или данные, которые требуют обращения к сети.
           Используются фразы "найди в интернете", "посмотри в сети", "поищи", 
           "узнай", а также явные запросы о поиске фактов, новостей или информации,
           которую нельзя знать без обращения к внешним источникам.

        7. ОТПРАВКА_СООБЩЕНИЯ - пользователь просит отправить или написать сообщение определенному контакту.
            Примеры: "напиши сообщение моей жене о том что я хочу бургеры" → ОТПРАВКА_СООБЩЕНИЯ; "напиши ей сообщение"; "отправь сообщение маме", "передай коллеге".

        8. ДЕЛЕГИРОВАНИЕ_ЗАДАЧИ - пользователь просит самому договориться с кем-то, провести переговоры, решить вопрос с контактом (переписка от имени пользователя с возможными уточнениями).
            Примеры: "договорись с Цыеты о доставке цветов для жены" → ДЕЛЕГИРОВАНИЕ_ЗАДАЧИ; "проведи переговоры с поставщиком", "свяжись с контактом X и уточни время", "реши с мамой вопрос о встрече".

        9. ВОЗМОЖНОСТИ_БОТА - пользователь спрашивает, что умеет бот, какие у него функции, чем может помочь, просит рассказать о себе / о возможностях. Примеры: "что ты умеешь", "чем можешь помочь", "расскажи о себе", "твои возможности", "what can you do", "your capabilities".

        10. НЕОПРЕДЕЛЕНО - только если сообщение действительно не подходит ни под одну категорию выше (неясный или общий текст без явной просьбы).

        Дополнительные факторы для анализа:
        - Просьба о планировании встречи, совещания, мероприятия = НАПОМИНАНИЕ
        - Просьба добавить что-то в календарь = НАПОМИНАНИЕ
        - Просьба создать запись к врачу, парикмахеру и т.п. = НАПОМИНАНИЕ
        - Просто упоминание будущего события БЕЗ просьбы напомнить = РАЗГОВОР, а не НАПОМИНАНИЕ
        - Выражение эмоций (страх, тревога, радость) обычно = РАЗГОВОР
        - Запрос на информацию или совет = РАЗГОВОР
        - Только явная просьба о напоминании или планировании = НАПОМИНАНИЕ
        - Просьба создать изображение или визуальный контент = ГЕНЕРАЦИЯ_ИЗОБРАЖЕНИЯ
        - Запросы о местоположении, маршрутах, локациях = КАРТЫ_ЛОКАЦИИ
        - Запросы, требующие поиска информации в интернете или внешних источниках = ВЕБ_ПОИСК
        - Явное упоминание поиска в интернете или сети = ВЕБ_ПОИСК
        - Запросы о актуальных событиях, новостях или специфической информации = ВЕБ_ПОИСК
        - Просьба отправить сообщение конкретному человеку = ОТПРАВКА_СООБЩЕНИЯ
        - Просьба связаться с кем-то = ОТПРАВКА_СООБЩЕНИЯ
        - Упоминание имени человека и просьба написать/передать = ОТПРАВКА_СООБЩЕНИЯ
        - Анализ переписки с конкретным человеком = ПРОВЕРКА_СООБЩЕНИЙ (contactQuery = имя)
        - Просьба изучить чат или диалог с кем-то = ПРОВЕРКА_СООБЩЕНИЙ (contactQuery = имя)
        - Запрос на составление психологического портрета по переписке = ПРОВЕРКА_СООБЩЕНИЙ (contactQuery = имя)
        - Упоминание "анализ переписки", "анализируй сообщения" и подобных фраз = ПРОВЕРКА_СООБЩЕНИЙ
        - Просьба почитать/изучить групповой чат по названию ("посмотри чат Leads", "изучи в чате Каркас", "почитай группу X") = ПРОВЕРКА_СООБЩЕНИЙ (groupChatQuery = название чата)
        - Ключевое различие: "переписку с Юлей" / "чат с мамой" → contactQuery; "чат Leads" / "группу Каркас" / "в чате Старт" → groupChatQuery
        - «Изучи чат с X и запомни/узнай факты про меня» = ПРОВЕРКА_СООБЩЕНИЙ, messagesCheckType: ANALYZE_CONVERSATION, saveFactsAboutUser: true, contactQuery = X

        Ответ предоставь в формате JSON:
        {
          "intent": "НАПОМИНАНИЕ | РАЗГОВОР | ГЕНЕРАЦИЯ_ИЗОБРАЖЕНИЯ | КАРТЫ_ЛОКАЦИИ | НЕОПРЕДЕЛЕНО | ПРОВЕРКА_СООБЩЕНИЙ | ВЕБ_ПОИСК | ОТПРАВКА_СООБЩЕНИЯ | ДЕЛЕГИРОВАНИЕ_ЗАДАЧИ | ВОЗМОЖНОСТИ_БОТА",
          "confidenceLevel": "ВЫСОКИЙ | СРЕДНИЙ | НИЗКИЙ",
          "details": {
            "category": "категория сообщения (например, медицина, работа, личное)",
            "keywords": ["ключевые слова из сообщения"],
            "emotionalTone": "эмоциональный тон сообщения",
            "urgency": "ВЫСОКАЯ | СРЕДНЯЯ | НИЗКАЯ",
            "timeReferences": ["упоминания времени в сообщении"],
            "imageDescription": "описание изображения, которое нужно сгенерировать (только для намерения ГЕНЕРАЦИЯ_ИЗОБРАЖЕНИЯ)",
            "locationQuery": "запрос к картам или о местоположении (только для намерения КАРТЫ_ЛОКАЦИИ)",
            "searchQuery": "запрос для поиска в интернете (только для намерения ВЕБ_ПОИСК)",
            "messagesCheckType": "ALL_MESSAGES | ANALYZE_CONVERSATION (только для намерения ПРОВЕРКА_СООБЩЕНИЙ)",
            "contactQuery": "имя или роль человека при анализе личной переписки с ним (только при фразах 'переписка с X', 'чат с X', 'диалог с X' — личный контакт). ВСЕГДА используй именительный падеж: 'жена' (не 'женой'), 'муж' (не 'мужем'), 'мама' (не 'мамой'). Пример: 'чат с моей женой' → contactQuery: 'жена'",
            "groupChatQuery": "название группового чата если запрос о групповом чате (при фразах 'чат Leads', 'в чате Каркас', 'группа X', 'посмотри чат X' без предлога 'с' перед именем человека)",
            "analysisQuery": "что нужно проанализировать в переписке (только для намерения ПРОВЕРКА_СООБЩЕНИЙ и messagesCheckType: ANALYZE_CONVERSATION)",
            "saveFactsAboutUser": "true если пользователь просит изучить переписку с кем-то и сохранить/узнать факты о себе (обо мне, про меня, запомни что узнаешь, запомни факты про меня, узнай и запомни факты) — только для ПРОВЕРКА_СООБЩЕНИЙ. Пример: 'изучи чат с женой и узнай и запомни факты про меня' → saveFactsAboutUser: true",
            "botReaction": "эмодзи, которым стоит отреагировать на сообщение пользователя, или NONE, если реакция не нужна"
          }
        }
        `;

        // Кэш по тексту сообщения (история не меняет интент для одного и того же запроса)
        const cacheKey = `classify:${message.slice(0, 200)}`;
        const cached = llmCache.get<MessageClassification>(cacheKey);
        if (cached) {
            devLog('classifyMessage: cache hit');
            return cached;
        }

        // Отправка запроса к API OpenAI (gpt-5.2 — для максимально точного определения интента)
        const response = await openai.chat.completions.create({
            model: "gpt-5.2",
            messages: [
                {
                    role: "system",
                    content: `Ты — классификатор намерений для универсального оркестратора. Твоя задача: по сообщению пользователя выбрать ОДИН конкретный интент из списка (НАПОМИНАНИЕ, РАЗГОВОР, ГЕНЕРАЦИЯ_ИЗОБРАЖЕНИЯ, КАРТЫ_ЛОКАЦИИ, ПРОВЕРКА_СООБЩЕНИЙ, ВЕБ_ПОИСК, ОТПРАВКА_СООБЩЕНИЯ, ДЕЛЕГИРОВАНИЕ_ЗАДАЧИ, ВОЗМОЖНОСТИ_БОТА).
                    Выбирай тот интент, который лучше всего соответствует запросу. Для явных просьб (напомни, напиши сообщение, нарисуй, найди на карте, отправь маме и т.п.) всегда указывай соответствующий интент и confidenceLevel: ВЫСОКИЙ.
                    НЕОПРЕДЕЛЕНО возвращай только если сообщение действительно непонятно или не подходит ни под одну категорию. Не используй НЕОПРЕДЕЛЕНО для ясных просьб.`
                },
                {
                    role: "user",
                    content: prompt
                }
            ],
            temperature: 1, // модель поддерживает только default (1)
        });

        // Получаем текст ответа
        const aiResponse = response.choices[0]?.message?.content || "";
        devLog("Classification Response:", aiResponse);

        const classification = parseLLMJson<MessageClassification>(aiResponse);
        if (!classification) {
            throw new Error("Could not parse JSON from AI response");
        }
        llmCache.set(cacheKey, classification, LLM_CACHE_TTL.CLASSIFY);
        return classification;

    } catch (error) {
        console.error("Error classifying message:", error);
        // Возвращаем стандартный результат в случае ошибки
        return {
            intent: "НЕОПРЕДЕЛЕНО",
            confidenceLevel: "НИЗКИЙ",
            details: {}
        };
    }
}

/**
 * Основная функция оркестрации, направляющая сообщение нужному агенту
 * @param message Текст сообщения
 * @param messageHistory История сообщений
 * @returns Результат обработки
 */
export async function processMessage(
    ctx: any,
    message: string,
    isForwarded: boolean = false,
    forwardFrom: string = "",
    messageHistory: MessageHistory[] = [],
    lastLocation?: { latitude: number; longitude: number; address?: string; }
): Promise<ProcessingResult> {
    try {
        const dedupSnapshot = getSessionDedupSnapshot(ctx);
        if (!isForwarded && dedupSnapshot && !NON_DEDUP_INTENTS.has(dedupSnapshot.intent)) {
            const ageMs = Date.now() - Number(dedupSnapshot.createdAt || 0);
            if (ageMs >= 0 && ageMs <= INTENT_DEDUP_WINDOW_MS) {
                const prevMessage = String(dedupSnapshot.message || "");
                if (isPotentialDuplicateCandidate(message, prevMessage)) {
                    const dedupCheck = await isDuplicateIntentByLLM({
                        currentMessage: message,
                        previousMessage: prevMessage,
                        previousIntent: dedupSnapshot.intent,
                        previousPlanStepIds: Array.isArray(dedupSnapshot.planStepIds) ? dedupSnapshot.planStepIds : [],
                    });
                    if (dedupCheck.isDuplicate && dedupCheck.confidence >= INTENT_DEDUP_MIN_CONFIDENCE) {
                        devLog("intent-dedup: hit, reusing previous result", dedupCheck.reason || "");
                        console.log("[ORCH] intent-dedup hit:", dedupCheck.reason || "same intent");
                        return buildDedupReuseResult(dedupSnapshot.result as ProcessingResult);
                    }
                }
            }
        }

        // Шаг 1: Донасыщаем запрос из долговременной памяти (факты по интентам + роль→имя). Контекст передаём агенту позже.
        const initialMemory = await fetchAgentMemoryContext(ctx, message);
        const initialBlock = buildMemoryContextBlock(initialMemory);
        let enrichedContextFromMemory = initialBlock ? initialBlock + '\n\n' : '';

        const roleInMessage = await detectRelationshipInMessage(message);
        if (roleInMessage) {
            const resolvedName = await resolveRelationshipFromMemory(ctx, roleInMessage, message);
            if (resolvedName) {
                enrichedContextFromMemory += `В запросе пользователя под «${roleInMessage}» имеется в виду: ${resolvedName} (из долговременной памяти).\n\n`;
                devLog("Orchestrator: enriched with resolved contact", roleInMessage, "->", resolvedName);
                console.log("[ORCH] enriched: role", roleInMessage, "-> name", resolvedName);
            }
        }

        // Шаг 2: Оркестратор определяет, куда направить запрос (классификация + план)
        let classification = await classifyMessage(message, isForwarded, forwardFrom, messageHistory);

        if (extractExplicitRememberFact(message) && classification.intent !== "ПРОВЕРКА_СООБЩЕНИЙ") {
            classification = { ...classification, intent: "РАЗГОВОР", confidenceLevel: "ВЫСОКИЙ" };
            devLog("Explicit remember detected, routing to conversation");
        }

        // ПРОВЕРКА_СООБЩЕНИЙ с низкой уверенностью (СРЕДНИЙ/НИЗКИЙ) без явного contactQuery — скорее всего ложное срабатывание, переключаем на РАЗГОВОР
        if (
            classification.intent === "ПРОВЕРКА_СООБЩЕНИЙ" &&
            classification.confidenceLevel !== "ВЫСОКИЙ" &&
            !classification.details.contactQuery &&
            !classification.details.groupChatQuery
        ) {
            devLog("ПРОВЕРКА_СООБЩЕНИЙ with low confidence and no contact, downgrading to РАЗГОВОР");
            classification = { ...classification, intent: "РАЗГОВОР", confidenceLevel: "СРЕДНИЙ" };
        }

        devLog("Message classified as:", classification.intent, "with confidence:", classification.confidenceLevel);
        console.log("[ORCH] message:", message.slice(0, 80), "| intent:", classification.intent, "| confidence:", classification.confidenceLevel);

        const plan = await createPlan({
            message,
            classification,
            messageHistory: messageHistory.map((m) => ({ role: m.role, content: m.content })),
        });
        const stepIds = plan.steps.map((s) => s.agentId);
        devLog("Plan steps:", stepIds);
        console.log("[ORCH] plan steps:", stepIds.join(" → "));

        // Шаг 3: Вызываем выбранного агента с донасыщенным контекстом
        const result = await executePlan({
            ctx,
            plan,
            message,
            isForwarded,
            forwardFrom,
            messageHistory,
            classification,
            lastLocation,
            enrichedContextFromMemory,
        });
        saveSessionDedupSnapshot(ctx, { message, classification, plan, result });
        return result;
    } catch (error) {
        console.error("Error in message processing:", error);
        // В случае ошибки возвращаем простой ответ
        return {
            responseText: "Произошла ошибка при обработке вашего сообщения. Пожалуйста, попробуйте еще раз или сформулируйте по-другому. 🙏"
        };
    }
}

/**
 * Обрабатывает изображение и связанный с ним комментарий (если есть)
 * @param imageBuffer Бинарные данные изображения
 * @param caption Комментарий к изображению (если есть)
 * @param messageHistory История сообщений
 * @returns Результат обработки
 */
export async function processImage(
    ctx: any,
    imageBuffer: Buffer,
    caption: string = "",
    messageHistory: MessageHistory[] = []
): Promise<ProcessingResult> {
    try {
        const memoryQuery = caption || 'изображение';
        const sharedMemoryContext = await fetchAgentMemoryContext(ctx, memoryQuery);
        const memoryContextBlock = buildMemoryContextBlock(sharedMemoryContext);

        // Если есть комментарий, проверяем, содержит ли он явную просьбу о напоминании
        let reaction: string | undefined = undefined;
        if (caption) {
            const classification = await classifyMessage(caption, false, "", messageHistory);
            reaction = classification.details.botReaction && classification.details.botReaction !== "NONE"
                ? classification.details.botReaction
                : undefined;

            // Если в комментарии есть явная просьба о напоминании с высокой уверенностью,
            // обрабатываем его отдельно через reminderAgent
            if (classification.intent === "НАПОМИНАНИЕ" && classification.confidenceLevel === "ВЫСОКИЙ") {
                devLog("Image caption contains explicit reminder request, processing separately");
                return await reminderAgent(caption, false, "", messageHistory, memoryContextBlock);
            }

            // Если в комментарии есть просьба о генерации изображения,
            // перенаправляем в imageGenerationAgent
            if (classification.intent === "ГЕНЕРАЦИЯ_ИЗОБРАЖЕНИЯ") {
                devLog("Image caption contains image generation request, processing separately");
                return await imageGenerationAgent(caption, false, "", messageHistory, memoryContextBlock);
            }

            // Если в комментарии есть запрос, связанный с картами,
            // перенаправляем в mapsAgent
            if (classification.intent === "КАРТЫ_ЛОКАЦИИ") {
                devLog("Image caption contains maps/location request, processing separately");
                return await mapsAgent(caption, false, "", messageHistory, undefined, memoryContextBlock);
            }
        }

        // В остальных случаях передаем изображение и комментарий imageAgent
        devLog("Processing image with caption:", caption || "[no caption]");
        const imgResult = await imageAgent(imageBuffer, caption, messageHistory, undefined, memoryContextBlock);
        if (reaction) {
            imgResult.botReaction = reaction;
        }
        return imgResult;
    } catch (error) {
        console.error("Error processing image:", error);
        // В случае ошибки возвращаем простой ответ
        return {
            responseText: "Я получила твое изображение, но возникла проблема при обработке. Можешь рассказать, что на нем и чем я могу помочь? 🖼️"
        };
    }
}

/**
 * Обрабатывает группу изображений и связанный с ними комментарий (если есть)
 * @param imageBuffers Массив бинарных данных изображений
 * @param caption Комментарий к изображениям (если есть)
 * @param messageHistory История сообщений
 * @returns Результат обработки
 */
export async function processImageGroup(
    ctx: any,
    imageBuffers: Buffer[],
    caption: string = "",
    messageHistory: MessageHistory[] = []
): Promise<ProcessingResult> {
    try {
        const memoryQuery = caption || 'группа изображений';
        const sharedMemoryContext = await fetchAgentMemoryContext(ctx, memoryQuery);
        const memoryContextBlock = buildMemoryContextBlock(sharedMemoryContext);

        let reaction: string | undefined = undefined;
        if (caption) {
            const classification = await classifyMessage(caption, false, "", messageHistory);
            reaction = classification.details.botReaction && classification.details.botReaction !== "NONE" ? classification.details.botReaction : undefined;

            // Если в комментарии есть явная просьба о напоминании с высокой уверенностью,
            // обрабатываем его отдельно через reminderAgent
            if (classification.intent === "НАПОМИНАНИЕ" && classification.confidenceLevel === "ВЫСОКИЙ") {
                devLog("Image caption contains explicit reminder request, processing separately");
                return await reminderAgent(caption, false, "", messageHistory, memoryContextBlock);
            }

            // Если в комментарии есть просьба о генерации изображения,
            // перенаправляем в imageGenerationAgent
            if (classification.intent === "ГЕНЕРАЦИЯ_ИЗОБРАЖЕНИЯ") {
                devLog("Image caption contains image generation request, processing separately");
                return await imageGenerationAgent(caption, false, "", messageHistory, memoryContextBlock);
            }

            // Если в комментарии есть запрос, связанный с картами,
            // перенаправляем в mapsAgent
            if (classification.intent === "КАРТЫ_ЛОКАЦИИ") {
                devLog("Image caption contains maps/location request, processing separately");
                return await mapsAgent(caption, false, "", messageHistory, undefined, memoryContextBlock);
            }
        }

        // В остальных случаях передаем группу изображений агенту обработки изображений
        devLog(`Processing image group (${imageBuffers.length} images) with caption:`, caption || "[no caption]");

        if (imageBuffers.length === 0) {
            return {
                responseText: "Я не смогла получить изображения для анализа. Можешь отправить их заново?"
            };
        }

        const groupResult = await imageAgent(imageBuffers[0], caption, messageHistory, imageBuffers, memoryContextBlock);
        if (reaction) {
            groupResult.botReaction = reaction;
        }
        return groupResult;
    } catch (error) {
        console.error("Error processing image group:", error);
        // В случае ошибки возвращаем простой ответ
        return {
            responseText: "Я получила твои изображения, но возникла проблема при обработке. Можешь рассказать, что на них и чем я могу помочь? 🖼️"
        };
    }
}
