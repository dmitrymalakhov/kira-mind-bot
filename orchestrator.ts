import * as dotenv from "dotenv";
import { ConversationReplyContext, ConversationTurn, KnowledgeSource, KnowledgeSourceDecision, MessageHistory } from "./types";
import { reminderAgent } from "./agents/reminderAgent";
import { imageAgent } from "./agents/imageAgent";
import { imageGenerationAgent } from "./agents/imageGenerationAgent";
import { mapsAgent } from "./agents/googleMapsAgent";
import { healthAgent } from "./agents/healthAgent";
import { InlineKeyboard } from "grammy";
import { devLog } from "./utils";
import { createJsonChatCompletionForTask } from "./ai/chatCompletion";
import { llmCache, LLM_CACHE_TTL } from "./utils/llmCache";
import { fetchAgentMemoryContext, buildMemoryContextBlock } from "./utils/agentMemoryContext";
import type { RecalledMemoryRef } from "./utils/multiQueryMemory";
import { extractExplicitRememberFact } from "./utils/enhancedFactExtraction";
import { buildProactiveSourceExplanation, resolveProactiveSourceQuestion } from './utils/proactiveSourceQuestion';
import { detectRelationshipInMessage, resolveRelationshipFromMemory } from "./utils/resolveRelationshipFromMemory";
import { createPlan } from "./orchestration/planner";
import { executePlan } from "./orchestration/executor";
import { Plan } from "./orchestration/types";
import { ChatGroupRepository } from "./services/ChatGroupRepository";
import { handlePendingContactMemoryText } from "./utils/contactMemory";
import { handlePendingContactLookupText, maybeStartContactMemoryLookup } from "./utils/contactMemoryLookup";
import { hasActiveBrowserRunForContext } from "./agents/browserAgent";
import { looksLikeBrowserTaskCancellation, looksLikeNegatedBookingRequest } from "./utils/browserTaskCancellation";
import { isTodayImportanceRequest } from "./utils/todayImportanceIntent";
import { applyKnowledgeSourceDecision, buildKnowledgeSourcePrompt, decideKnowledgeSource, shouldInterruptPendingContactMemory } from "./utils/knowledgeSource";
import { decideContextualFollowUp } from "./utils/contextualFollowUp";
import { buildClassificationCacheKey } from "./utils/classificationCache";

// Загрузка переменных окружения
dotenv.config({ path: `.env.${process.env.NODE_ENV}` });



// Расширенный интерфейс для результата классификации сообщения
export interface MessageClassification {
    intent: "НАПОМИНАНИЕ" | "РАЗГОВОР" | "НЕОПРЕДЕЛЕНО" | "ГЕНЕРАЦИЯ_ИЗОБРАЖЕНИЯ" |
    "КАРТЫ_ЛОКАЦИИ" | "ПРОВЕРКА_СООБЩЕНИЙ" | "ВЕБ_ПОИСК" | "ОТПРАВКА_СООБЩЕНИЯ" | "ДЕЛЕГИРОВАНИЕ_ЗАДАЧИ" | "ВОЗМОЖНОСТИ_БОТА" | "САМОИЗУЧЕНИЕ" | "БРАУЗЕР_ЗАДАЧА" | "ЗДОРОВЬЕ";
    /**
     * Ранжированные кандидаты интента от классификатора.
     * Используются как "second opinion" перед запуском агента: если лидеры близко,
     * оркестратор спрашивает уточнение вместо рискованного выбора.
     */
    intentScores?: Array<{
        intent: MessageClassification["intent"];
        score: number;
        reason?: string;
    }>;
    /** Краткое объяснение, почему классификатор считает запрос неоднозначным. */
    ambiguityReason?: string;
    /** Вопрос, который можно задать пользователю при близких scores. */
    clarificationQuestion?: string;
    /**
     * Дополнительные намерения, если запрос составной (два явных независимых действия).
     * Пример: «напомни завтра и напиши маме сейчас» →
     *   intent: НАПОМИНАНИЕ, subIntents: [{intent: "ОТПРАВКА_СООБЩЕНИЯ", details: {contactQuery: "мама"}}]
     */
    subIntents?: Array<{
        intent: MessageClassification["intent"];
        details?: Partial<MessageClassification["details"]>;
    }>;
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
        /** Название группового чата (если запрос об одном групповом чате) */
        groupChatQuery?: string;
        /** Названия нескольких групповых чатов (если пользователь перечисляет несколько чатов) */
        groupChatQueries?: string[];
        /** Предложенная реакция-эмодзи на сообщение пользователя */
        botReaction?: string;
        /**
         * Для интента НАПОМИНАНИЕ: тип операции.
         * "create" — создать напоминание (по умолчанию).
         * "cancel" — отменить существующее напоминание по текстовому запросу.
         * "cancelAll" — отменить ВСЕ активные напоминания (или все за период).
         * "update" — изменить время и/или текст существующего напоминания.
         * "updateAll" — перенести ВСЕ активные напоминания (или все за период) на новое время.
         */
        reminderAction?: "create" | "cancel" | "cancelAll" | "update" | "updateAll";
        /** Фильтр периода для cancelAll/updateAll: "today" | "tomorrow" | "week" | undefined (=все) */
        reminderBatchPeriod?: "today" | "tomorrow" | "week";
        /** Поисковый запрос для поиска напоминания при reminderAction = "cancel" */
        reminderCancelQuery?: string;
        /** Поисковый запрос для поиска напоминания при reminderAction = "update" */
        reminderUpdateQuery?: string;
        /** Новое время срабатывания при reminderAction = "update" (человекочитаемое, напр. "завтра в 15:00") */
        reminderUpdateNewTime?: string;
        /** Новый текст напоминания при reminderAction = "update" */
        reminderUpdateNewText?: string;
        /** Выбранный источник знаний до contact-memory и LLM-классификации. */
        knowledgeSource?: KnowledgeSource;
        /** Аспекты внешнего запроса, которые должен покрыть веб-поиск. */
        requestedFacets?: KnowledgeSourceDecision['requestedFacets'];
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
        /** Текст для адресата, если владелец подтвердит отправку в targetChat */
        targetReminderMessage?: string;
        dueDate: Date;
        /** Куда отправить напоминание: в группу или контакту (резолвится при срабатывании) */
        targetChat?: { type: "group"; groupName: string } | { type: "contact"; contactQuery: string };
        recurrence?: import("./types/reminderTypes").RecurrenceRule;
    };
    reminderDetailsList?: {
        id: string;
        text: string;
        reminderMessage?: string;
        targetReminderMessage?: string;
        dueDate: Date;
        targetChat?: { type: "group"; groupName: string } | { type: "contact"; contactQuery: string };
        recurrence?: import("./types/reminderTypes").RecurrenceRule;
    }[];
    detectedText?: string; // Текст, который был распознан в сообщении
    description?: string; // Описание изображения, если оно было сгенерировано
    imageGenerated?: boolean;  // Флаг успешной генерации изображения
    generatedImageUrl?: string; // URL сгенерированного изображения
    icsFilePath?: string; // Путь к сгенерированному ICS файлу
    documentFilePath?: string; // Путь к сгенерированному документу
    documentFilename?: string; // Имя документа для отправки пользователю
    documentCaption?: string; // Подпись к документу

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
    /** Воспоминания, реально подмешанные в контекст ответа. Используется для reconsolidation. */
    recalledMemories?: RecalledMemoryRef[];
    /** Ответ нужно отдать голосовым сообщением, если канал отправки это поддерживает. */
    voiceReplyRequested?: boolean;
}

interface IntentDedupCheckResult {
    isDuplicate: boolean;
    confidence: number;
    reason?: string;
}

const INTENT_DEDUP_WINDOW_MS = 3 * 60 * 1000;
const INTENT_DEDUP_MIN_CONFIDENCE = 0.8;
const NON_DEDUP_INTENTS = new Set(["РАЗГОВОР", "ОТПРАВКА_СООБЩЕНИЯ", "ДЕЛЕГИРОВАНИЕ_ЗАДАЧИ", "ГЕНЕРАЦИЯ_ИЗОБРАЖЕНИЯ", "ПРОВЕРКА_СООБЩЕНИЙ", "ВЕБ_ПОИСК", "САМОИЗУЧЕНИЕ", "БРАУЗЕР_ЗАДАЧА", "ЗДОРОВЬЕ"]);
const BROWSER_CONTINUATION_RE = /^Продолжи задачу в браузере через Playwright\.|browserSessionId:/i;
const CYRILLIC_PHRASE_START = String.raw`(?:^|[\s,.!?;:])`;
const CYRILLIC_PHRASE_END = String.raw`(?=$|[\s,.!?;:])`;
const BROWSER_BOOKING_PHRASE_RE = /запиши\s+(?:меня|нас|нам)?\s*на|записать\s+(?:меня|нас|нам)?\s*на|запишись|зарегистрируй(?:ся)?|зарегистрируй\s+(?:меня|нас|нам)|забронируй|забронь/iu;
const BROWSER_TASK_FORCE_RE = new RegExp(
    `${CYRILLIC_PHRASE_START}(?:открой\\s+браузер|зайди\\s+на\\s+сайт|найди\\s+(?:на\\s+)?сайт|найди\\s+на\\s+(?:lamoda|ламод[аеу]|quizium|квизиум)|на\\s+сайте|через\\s+сайт|заполни\\s+форму|отправь\\s+форму|${BROWSER_BOOKING_PHRASE_RE.source}|купи\\s+(?:билет|билеты)|оформи\\s+заказ|checkout|нажми\\s+(?:кнопку|на))${CYRILLIC_PHRASE_END}`,
    'iu'
);
const BROWSER_FOLLOW_UP_RE = new RegExp(
    `${CYRILLIC_PHRASE_START}(?:${BROWSER_BOOKING_PHRASE_RE.source}|купи\\s+билет|оформи|перейди|нажми|выбери|заполни|отправь\\s+форму|(?:пришли|скинь|дай|найди|добудь)\\s+(?:мне\\s+)?ссылк[ауи]?|ссылк[ауи]?\\s+(?:пришли|скинь|дай)|ссылка\\s+на\\s+эт[ио]|url|link)${CYRILLIC_PHRASE_END}`,
    'iu'
);
const EXPLICIT_REMINDER_RE = /(^|\s)(напомни|напоминай|не\s+дай\s+забыть|не\s+забудь|(?:создай|поставь|добавь)(?:\s+\S+){0,3}\s+напоминание)(?=\s|$|[,.!?;:])/iu;
const SELF_STUDY_TASK_RE = /(?:^|[\s,.!?;:])(?:(?:изучи|исследуй|проанализируй|оцени|проведи|сделай|запусти)[\s\S]{0,100}(?:себя|свои\s+(?:возможности|ограничения|потребности)|самоанализ|самоизучение)|(?:пойми|выясни)[\s\S]{0,80}чего\s+тебе\s+не\s+хватает|самоанализ|самоизучение)(?=$|[\s,.!?;:])/iu;
const ASSISTANT_SELF_LIFE_REQUEST_RE = /^(?:кто\s+ты|расскажи\s+(?:мне\s+)?(?:о|про)\s+себя)\??$|(?:расскажи|расскажешь|скажи|что|кто|какая|какой|как|где|почему|зачем|помнишь)[\s\S]{0,140}(?:о\s+себе|про\s+себя|тво[яйёе]\s+(?:жизн|биограф|истори|цель|прошл|уч[её]б|работ)|где\s+ты\s+(?:училась|работала)|почему\s+ты\s+такая)/iu;
const INTENT_SCORE_CLOSE_DELTA = 0.12;
const INTENT_SCORE_VERY_CLOSE_DELTA = 0.06;
const INTENT_SCORE_CLEAR_WINNER_MIN = 0.82;
const INTENT_SCORE_MIN_RUNNER_UP = 0.35;
const VALID_CLASSIFICATION_INTENTS = new Set<MessageClassification["intent"]>([
    "НАПОМИНАНИЕ",
    "РАЗГОВОР",
    "НЕОПРЕДЕЛЕНО",
    "ГЕНЕРАЦИЯ_ИЗОБРАЖЕНИЯ",
    "КАРТЫ_ЛОКАЦИИ",
    "ПРОВЕРКА_СООБЩЕНИЙ",
    "ВЕБ_ПОИСК",
    "ОТПРАВКА_СООБЩЕНИЯ",
    "ДЕЛЕГИРОВАНИЕ_ЗАДАЧИ",
    "ВОЗМОЖНОСТИ_БОТА",
    "САМОИЗУЧЕНИЕ",
    "БРАУЗЕР_ЗАДАЧА",
    "ЗДОРОВЬЕ",
]);

function buildExplicitReminderClassification(message: string): MessageClassification | null {
    if (!EXPLICIT_REMINDER_RE.test(message)) return null;

    return {
        intent: "НАПОМИНАНИЕ",
        confidenceLevel: "ВЫСОКИЙ",
        intentScores: [
            {
                intent: "НАПОМИНАНИЕ",
                score: 1,
                reason: "В сообщении есть явная просьба создать напоминание.",
            },
        ],
        details: {
            reminderAction: "create",
            keywords: [message.slice(0, 160)],
        },
    };
}

function buildBrowserFollowUpMessage(ctx: any, message: string): string | null {
    if (BROWSER_CONTINUATION_RE.test(message)) return null;
    const lastBrowserTask = ctx?.session?.lastBrowserTask;
    if (!lastBrowserTask || Date.now() > Number(lastBrowserTask.expiresAt || 0)) return null;
    if (!BROWSER_FOLLOW_UP_RE.test(message)) return null;

    const previousContext = [
        lastBrowserTask.summary ? `Итог: ${lastBrowserTask.summary}` : '',
        Array.isArray(lastBrowserTask.notes) && lastBrowserTask.notes.length
            ? `Рабочие заметки:\n${lastBrowserTask.notes.slice(-8).map((note: string, index: number) => `${index + 1}. ${note}`).join('\n')}`
            : '',
        lastBrowserTask.pageText ? `Видимый текст последней страницы:\n${String(lastBrowserTask.pageText).slice(0, 1800)}` : '',
    ].filter(Boolean).join('\n\n');

    return [
        'Продолжи задачу в браузере через Playwright.',
        'browserSessionId: none',
        `Исходная задача пользователя: ${lastBrowserTask.originalTask}`,
        `Контекст предыдущей завершённой браузерной задачи: ${previousContext || lastBrowserTask.summary}`,
        lastBrowserTask.url ? `Последняя страница: ${lastBrowserTask.url}` : '',
        lastBrowserTask.title ? `Заголовок последней страницы: ${lastBrowserTask.title}` : '',
        `Ответ пользователя: ${message}`,
        'Используй ответ как follow-up к найденным вариантам: сначала восстанови последнюю страницу, выбери подходящий вариант на ней и продолжи действие в браузере. Если пользователь просит ссылки на найденные товары, извлеки прямые href карточек или открой карточки на последней странице и верни URL, не задавая вопрос о маршруте. Не придумывай отдельный сайт по названию варианта.',
    ].filter(Boolean).join('\n');
}

function hasActivePendingBrowserTask(ctx: any): boolean {
    const pending = ctx?.session?.pendingBrowserTask;
    return Boolean(pending?.sessionId && Date.now() <= Number(pending.expiresAt || 0));
}

function hasActiveRunningBrowserTask(ctx: any): boolean {
    const active = ctx?.session?.activeBrowserTask;
    return Boolean(active?.sessionId && Date.now() <= Number(active.expiresAt || 0));
}

function looksLikeBrowserTaskText(message: string): boolean {
    return /(?:https?:\/\/|www\.|\b(?:lamoda|ламода|quizium|квизиум)\b|(?:открой|зайди|перейди|найди|посмотри|запиши|забронируй|зарегистрируй|нажми|кликни)[\s\S]{0,90}(?:сайт|браузер|страниц|форм|lamoda|ламода|quizium|квизиум|\.ru|\.com))/iu
        .test(message);
}

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

function normalizeIntentScores(classification: MessageClassification): MessageClassification {
    const seen = new Set<MessageClassification["intent"]>();
    const intentScores = (classification.intentScores ?? [])
        .map((candidate) => ({
            intent: String(candidate?.intent ?? "").trim() as MessageClassification["intent"],
            score: Number(candidate?.score),
            reason: candidate?.reason ? String(candidate.reason).slice(0, 180) : undefined,
        }))
        .filter((candidate) =>
            VALID_CLASSIFICATION_INTENTS.has(candidate.intent) &&
            Number.isFinite(candidate.score)
        )
        .map((candidate) => ({
            ...candidate,
            score: Math.max(0, Math.min(1, candidate.score)),
        }))
        .sort((a, b) => b.score - a.score)
        .filter((candidate) => {
            if (seen.has(candidate.intent)) return false;
            seen.add(candidate.intent);
            return true;
        })
        .slice(0, 5);

    const rawIntent = VALID_CLASSIFICATION_INTENTS.has(classification.intent)
        ? classification.intent
        : "НЕОПРЕДЕЛЕНО";
    const intent = intentScores[0]?.intent && intentScores[0].intent !== "НЕОПРЕДЕЛЕНО"
        ? intentScores[0].intent
        : rawIntent;

    return { ...classification, intent, details: classification.details ?? {}, intentScores };
}

function detectIntentAmbiguity(classification: MessageClassification): {
    top: NonNullable<MessageClassification["intentScores"]>[number];
    runnerUp: NonNullable<MessageClassification["intentScores"]>[number];
    delta: number;
} | null {
    if (classification.intent === "НЕОПРЕДЕЛЕНО") return null;
    if (classification.subIntents?.length) return null;

    const scores = classification.intentScores ?? [];
    if (scores.length < 2) return null;

    const [top, runnerUp] = scores;
    if (runnerUp.score < INTENT_SCORE_MIN_RUNNER_UP) return null;

    const delta = top.score - runnerUp.score;
    const veryClose = delta <= INTENT_SCORE_VERY_CLOSE_DELTA;
    const closeAndUnclear =
        delta <= INTENT_SCORE_CLOSE_DELTA &&
        (top.score < INTENT_SCORE_CLEAR_WINNER_MIN || classification.confidenceLevel !== "ВЫСОКИЙ");

    return veryClose || closeAndUnclear ? { top, runnerUp, delta } : null;
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
        const parsed = await createJsonChatCompletionForTask<IntentDedupCheckResult>('intentDedup', {
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

function buildProactiveInsightExplanation(
    ctx: any,
    message: string,
    replyContext?: ConversationReplyContext,
): ProcessingResult | null {
    const insight = resolveProactiveSourceQuestion({
        message,
        replyContext,
        history: ctx?.session?.messageHistory,
        insight: ctx?.session?.lastProactiveInsight,
    });
    return insight ? { responseText: buildProactiveSourceExplanation(insight) } : null;
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
    messageHistory: MessageHistory[] = [],
    knownChatGroups?: { name: string; chatNames: string[] }[]
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

        // Сохранённые группы чатов пользователя (если есть)
        const chatGroupsContext = knownChatGroups && knownChatGroups.length > 0
            ? `\nСохранённые группы чатов пользователя (важно для распознавания):
${knownChatGroups.map(g => `- «${g.name}» (чаты: ${g.chatNames.join(', ')})`).join('\n')}
Если пользователь упоминает название любой из этих групп (или часть названия) в контексте анализа/проверки — это ПРОВЕРКА_СООБЩЕНИЙ с groupChatQuery = точное название группы и messagesCheckType: ANALYZE_CONVERSATION.\n`
            : '';

        // Подготовка промпта для классификации
        const prompt = `
        Текущая дата и время: ${formattedDateTime}
        ${chatGroupsContext}
        Проанализируй следующее сообщение${isForwarded ? `, пересланное от ${forwardFrom}` : ""}:

        "${message}"
        ${historyContext}

        Коррекции и уточнения: если текущее сообщение начинается с «нет», «не то», «не так», «стоп», «подожди», «я имел в виду», «имею в виду», «точнее», «вернее» — это РАЗГОВОР (пользователь исправляет или уточняет предыдущий ответ). Классифицируй как РАЗГОВОР c confidenceLevel: ВЫСОКИЙ, даже если предыдущий интент был другим.
        Примеры: «нет, я имел в виду жену» → РАЗГОВОР; «стоп, не то» → РАЗГОВОР; «точнее — напомни через час» → НАПОМИНАНИЕ (тут явная просьба, а не просто коррекция).

        Разрешение анафоры: если в ТЕКУЩЕМ сообщении есть местоимения или неполные ссылки («ему», «ей», «его», «её», «им», «них», «туда», «там», «это», «про это», «об этом», «по этому», «они», «тот», «та», «те»), используй историю переписки выше, чтобы понять, к кому или к чему они относятся. Подставляй найденный контекст в поля details:
        - Местоимение человека → contactQuery (всегда именительный падеж: «жена», «муж», «мама»)
        - Ссылка на тему предыдущего сообщения → keywords и category
        - Ссылка на место → locationQuery
        Примеры:
          История: «проверь переписку с женой» / Текущее: «а теперь напиши ей» → intent: ОТПРАВКА_СООБЩЕНИЯ, contactQuery: «жена»
          История: «напиши Артёму про встречу» / Текущее: «напомни мне про это завтра» → intent: НАПОМИНАНИЕ, category: «встреча с Артёмом»
          История: «найди кафе на Арбате» / Текущее: «проложи туда маршрут» → intent: КАРТЫ_ЛОКАЦИИ, locationQuery: «кафе на Арбате»

        Твоя задача: однозначно определить намерение пользователя и вернуть одну из категорий ниже.
        Выбирай конкретный интент (не НЕОПРЕДЕЛЕНО), если сообщение хотя бы примерно подходит под категорию. НЕОПРЕДЕЛЕНО — только если сообщение действительно непонятно или не подходит ни под одну категорию. Для ясных просьб всегда указывай confidenceLevel: ВЫСОКИЙ.
        Кроме основного intent, всегда верни intentScores: 2-4 наиболее вероятных интента с score от 0 до 1.
        score — твоя внутренняя уверенность, не обязан суммироваться до 1. intent должен совпадать с кандидатом с самым высоким score.
        Если два лучших intentScores близки (разница примерно 0.12 или меньше), ставь confidenceLevel: СРЕДНИЙ или НИЗКИЙ, заполни ambiguityReason и clarificationQuestion.
        clarificationQuestion — короткий естественный вопрос пользователю без технических слов, который помогает выбрать между вариантами.
        
        Категории (выбери одну):
        
        1. НАПОМИНАНИЕ - пользователь явно просит установить напоминание, создать задачу,
           запланировать встречу или отследить событие. Используются слова "напомни", "создай напоминание",
           "не забудь", "запланируй", "встреча", "записаться", "запись на прием", "мероприятие", "событие" и т.п.
           ТАКЖЕ относится к НАПОМИНАНИЕ: явная просьба ОТМЕНИТЬ существующее напоминание:
           «отмени напоминание про встречу», «удали напоминание о враче», «убери напоминание на завтра»,
           «сними напоминание о звонке», «не напоминай мне о X», «отмени все напоминания».
           В этом случае: details.reminderAction = "cancel", details.reminderCancelQuery = ключевые слова для поиска напоминания (например "врач", "встреча", "звонок маме").
           ТАКЖЕ относится к НАПОМИНАНИЕ: явная просьба ОТМЕНИТЬ ВСЕ или несколько напоминаний:
           «отмени все напоминания», «удали все напоминания на сегодня», «убери все напоминания на эту неделю».
           В этом случае: details.reminderAction = "cancelAll", details.reminderBatchPeriod = "today" | "tomorrow" | "week" | undefined (если нет периода).
           ТАКЖЕ относится к НАПОМИНАНИЕ: явная просьба ПЕРЕНЕСТИ ВСЕ напоминания:
           «перенеси все напоминания на завтра», «передвинь все напоминания на неделю вперёд».
           В этом случае: details.reminderAction = "updateAll", details.reminderBatchPeriod = "today" | "tomorrow" | "week", details.reminderUpdateNewTime = новое время.
           ТАКЖЕ относится к НАПОМИНАНИЕ: явная просьба ИЗМЕНИТЬ или ПЕРЕНЕСТИ существующее напоминание:
           «перенеси напоминание про встречу на завтра», «передвинь напоминание о враче на 15:00»,
           «поменяй время напоминания про X на Y», «измени текст напоминания о звонке»,
           «сдвинь напоминание на час позже», «напоминание про X — перенеси на пятницу».
           В этом случае: details.reminderAction = "update", details.reminderUpdateQuery = ключевые слова для поиска (например "врач", "встреча"), details.reminderUpdateNewTime = новое время (например "завтра в 15:00"), details.reminderUpdateNewText = новый текст (если меняется текст).
           
        2. РАЗГОВОР - пользователь делится информацией, задает вопрос, выражает эмоции,
           рассказывает о событии БЕЗ просьбы о напоминании.
           ВАЖНО: простые фактические вопросы о людях — это ВСЕГДА РАЗГОВОР, даже если предыдущие
           сообщения в истории были о проверке сообщений. Примеры РАЗГОВОР:
           «когда день рождения моей мамы?», «как зовут мою жену?», «где живёт Артём?»,
           «сколько лет моему сыну?», «кто такой X?», «а когда у неё день рождения?»
           Такие вопросы отвечаются из долговременной памяти, а НЕ из Telegram-переписки.
           
        3. ГЕНЕРАЦИЯ_ИЗОБРАЖЕНИЯ - пользователь просит создать, нарисовать, сгенерировать 
           изображение, картинку, фото и т.п. Используются фразы "нарисуй", "создай изображение",
           "сгенерируй картинку", "нарисуй мне", и подобные. Если в сообщении описывается
           визуальная сцена, которую нужно создать - это ГЕНЕРАЦИЯ_ИЗОБРАЖЕНИЯ.
           
        4. КАРТЫ_ЛОКАЦИИ - пользователь запрашивает информацию о местоположении, маршрутах,
           адресах, поиске физических мест на карте. Используются фразы типа "как добраться", "найди на карте",
           "где находится", "проложи маршрут", "покажи на карте" и т.п.
           ВАЖНО: расписание событий, афиша, ближайшие игры/квизы/концерты/мероприятия в городе — это ВЕБ_ПОИСК, а не карты.
           "Ближайшие игры Квизум в Москве" означает ближайшие по времени события, НЕ заведения рядом.
           
        5. ПРОВЕРКА_СООБЩЕНИЙ - пользователь ЯВНО просит прочитать, проверить, изучить или
            проанализировать СООБЩЕНИЯ или ПЕРЕПИСКУ в Telegram.
            Обязательные маркеры: «проверь», «прочитай», «изучи», «проанализируй», «посмотри чат»,
            «кто писал», «есть сообщения», «анализ переписки», «что пишут в чате» и т.п.
            БЕЗ таких маркеров — это НЕ ПРОВЕРКА_СООБЩЕНИЙ, даже если в вопросе упоминается имя человека.
            КРИТИЧЕСКИ ВАЖНО: простые вопросы о фактах (день рождения, возраст, имя, адрес, место работы
            и т.п.) — это РАЗГОВОР, НЕ ПРОВЕРКА_СООБЩЕНИЙ. Бот отвечает на них из долговременной памяти.
            НЕ поддавайся влиянию предыдущих сообщений в истории: каждое сообщение классифицируй
            по его собственному содержанию, а НЕ по инерции от предыдущего интента.
            ВАЖНО: просьба «изучи чат/переписку с X и узнай/запомни факты/важное» — это ВСЕГДА ПРОВЕРКА_СООБЩЕНИЙ,
            а НЕ РАЗГОВОР. Такой запрос требует чтения реальной переписки из Telegram.
            Это касается фактов как о себе (про меня, обо мне), так и о контакте (о нём, про него, о ней, важное о нём).
            Примеры: "изучи чат с моей женой и запомни факты про меня", "прочитай переписку с мамой и узнай что-нибудь обо мне",
            "изучи чат с Юлей и узнай и запомни факты про меня и мою жену",
            "изучи чат с Артемом и запомни важное о нём", "прочитай переписку с коллегой и сохрани факты о нём".
            
        6. ВЕБ_ПОИСК - пользователь просит найти информацию в интернете, 
           узнать последние новости или данные, которые требуют обращения к сети.
           Используются фразы "найди в интернете", "посмотри в сети", "поищи", 
           "узнай", а также явные запросы о поиске фактов, новостей или информации,
           которую нельзя знать без обращения к внешним источникам.
           Сюда относятся афиша, расписание, ближайшие игры/квизы/мероприятия, билеты и регистрация, если пользователь пока просит найти варианты.

        7. ОТПРАВКА_СООБЩЕНИЯ - пользователь просит отправить или написать сообщение определенному контакту.
            Примеры: "напиши сообщение моей жене о том что я хочу бургеры" → ОТПРАВКА_СООБЩЕНИЯ; "напиши ей сообщение"; "отправь сообщение маме", "передай коллеге".

        8. ДЕЛЕГИРОВАНИЕ_ЗАДАЧИ - пользователь просит самому договориться с кем-то, провести переговоры, решить вопрос с контактом (переписка от имени пользователя с возможными уточнениями).
            Примеры: "договорись с Цыеты о доставке цветов для жены" → ДЕЛЕГИРОВАНИЕ_ЗАДАЧИ; "проведи переговоры с поставщиком", "свяжись с контактом X и уточни время", "реши с мамой вопрос о встрече".

        9. ВОЗМОЖНОСТИ_БОТА - пользователь спрашивает, что умеет бот, какие у него функции, чем может помочь, просит рассказать о возможностях, спрашивает умеет ли бот конкретную вещь или как правильно попросить бота что-то сделать.
           Примеры: "что ты умеешь", "чем можешь помочь", "твои возможности", "what can you do", "your capabilities",
           "ты умеешь анализировать переписки?", "можешь ли ты отправлять сообщения?", "как попросить тебя поставить напоминание?",
           "что мне написать, чтобы ты изучила чат?".
           Важно: если пользователь спрашивает о возможности или формулировке, НЕ выполняй само действие — выбери ВОЗМОЖНОСТИ_БОТА.
           Если пользователь прямо просит выполнить действие сейчас с конкретным содержанием/адресатом/временем — выбирай соответствующий рабочий интент.
           ВАЖНО: "расскажи о себе", "расскажи про себя", "кто ты", "какая у тебя жизнь/биография/цель" — это РАЗГОВОР о личности и биографии ассистента, НЕ ВОЗМОЖНОСТИ_БОТА.

        10. САМОИЗУЧЕНИЕ - пользователь просит бота активно изучить самого себя: проанализировать собственные возможности, ограничения, потребности, состояние, пробелы, что улучшить, чему научиться, чего не хватает для лучшей помощи.
           Примеры: "изучи себя", "проанализируй свои возможности и потребности", "пойми чего тебе не хватает", "сделай самоанализ", "изучи свои ограничения", "сохрани выводы о себе".
           Отличие от ВОЗМОЖНОСТИ_БОТА: ВОЗМОЖНОСТИ_БОТА просто отвечает на вопрос о функциях; САМОИЗУЧЕНИЕ запускает анализ и сохраняет отчёт в самопамять.

        11. ЗДОРОВЬЕ - пользователь хочет вести личный дневник здоровья, зафиксировать самочувствие, симптомы, крапивницу/сыпь/зуд/покраснение/отёк, давление/пульс, что ел или пил, что делал/делает, лекарства, активность, возможные триггеры, фото еды или кожи, проанализировать дневник за день/неделю/месяц, либо выгрузить дневник здоровья за период.
           Примеры: "запусти мониторинг здоровья", "зафиксируй что я съел креветки", "запиши давление 120/80 пульс 72", "я сейчас ем, сохрани фото", "у меня снова крапивница", "запиши зуд на руках 6 из 10", "проанализируй здоровье за неделю", "выпил антигистаминное", "запиши что я был в душе/на тренировке", "выгрузи дневник здоровья за неделю".
           Это не медицинская консультация: интент нужен для записи наблюдений и экспорта, а не для постановки диагноза.

        12. БРАУЗЕР_ЗАДАЧА - пользователь просит выполнить действие в браузере / в интернете в автоматическом режиме: записаться куда-то, заполнить форму, сделать что-то на сайте, забронировать, зарегистрироваться, купить, отправить форму, нажать кнопку, проверить что-то на конкретном сайте — что требует реального браузера (не просто поиска).
           Ключевые маркеры: "запишись", "запиши меня", "заполни форму", "забронируй", "зарегистрируйся", "купи билет", "зайди на сайт и ...", "на сайте X сделай ...", "открой браузер", "используй браузер", "через браузер", "запись к врачу онлайн", "сделай это через браузер".
           ОТЛИЧИЕ от ВЕБ_ПОИСК: ВЕБ_ПОИСК — найти и прочитать информацию. БРАУЗЕР_ЗАДАЧА — совершить действие (клик, заполнение, отправка формы) на конкретном сайте.

        13. НЕОПРЕДЕЛЕНО - только если сообщение действительно не подходит ни под одну категорию выше (неясный или общий текст без явной просьбы).

        Дополнительные факторы для анализа:
        - Просьба о планировании встречи, совещания, мероприятия = НАПОМИНАНИЕ
        - Просьба добавить что-то в календарь = НАПОМИНАНИЕ
        - Просьба создать запись к врачу, парикмахеру и т.п. = НАПОМИНАНИЕ
        - Просьба перенести, сдвинуть, передвинуть, поменять время существующего напоминания = НАПОМИНАНИЕ, reminderAction: update
        - Просьба изменить текст существующего напоминания = НАПОМИНАНИЕ, reminderAction: update
        - Просто упоминание будущего события БЕЗ просьбы напомнить = РАЗГОВОР, а не НАПОМИНАНИЕ
        - Выражение эмоций (страх, тревога, радость) обычно = РАЗГОВОР
        - Запрос на информацию или совет = РАЗГОВОР
        - Только явная просьба о напоминании или планировании = НАПОМИНАНИЕ
        - Просьба создать изображение или визуальный контент = ГЕНЕРАЦИЯ_ИЗОБРАЖЕНИЯ
        - Запросы о местоположении, маршрутах, адресах и физических местах на карте = КАРТЫ_ЛОКАЦИИ
        - Запросы, требующие поиска информации в интернете или внешних источниках = ВЕБ_ПОИСК
        - Явное упоминание поиска в интернете или сети = ВЕБ_ПОИСК
        - Запросы о актуальных событиях, новостях или специфической информации = ВЕБ_ПОИСК
        - Афиша, расписание, ближайшие игры/квизы/концерты/мероприятия в городе = ВЕБ_ПОИСК, НЕ КАРТЫ_ЛОКАЦИИ
        - "найди ближайшие игры Квизум в Москве" = ВЕБ_ПОИСК
        - Вопросы о том, умеет ли бот что-то делать или как правильно попросить бота сделать X = ВОЗМОЖНОСТИ_БОТА
        - "можешь ли ты X?", "ты умеешь X?", "как попросить тебя X?", "что написать, чтобы ты X?" = ВОЗМОЖНОСТИ_БОТА, если пользователь не просит выполнить X прямо сейчас
        - "изучи себя", "проанализируй свои возможности и потребности", "сделай самоанализ", "пойми чего тебе не хватает" = САМОИЗУЧЕНИЕ
        - Если пользователь просто спрашивает "что ты умеешь?" без просьбы анализа/самоизучения — это ВОЗМОЖНОСТИ_БОТА, НЕ САМОИЗУЧЕНИЕ
        - Просьба запустить/вести дневник здоровья, записать еду/симптом/лекарство/самочувствие/давление/активность/что делал/фото кожи или еды, проанализировать дневник за день/неделю/месяц, либо выгрузить дневник здоровья = ЗДОРОВЬЕ
        - Сообщения "я съел...", "я выпил...", "давление 120/80", "у меня зуд/сыпь/крапивница/покраснение", если контекст про здоровье или дневник наблюдений = ЗДОРОВЬЕ
        - Просьба отправить сообщение конкретному человеку = ОТПРАВКА_СООБЩЕНИЯ
        - Просьба связаться с кем-то = ОТПРАВКА_СООБЩЕНИЯ
        - Упоминание имени человека и просьба написать/передать = ОТПРАВКА_СООБЩЕНИЯ
        - Анализ переписки с конкретным человеком (только с ЯВНЫМ глаголом «проанализируй», «изучи», «прочитай», «посмотри чат») = ПРОВЕРКА_СООБЩЕНИЙ (contactQuery = имя)
        - Просьба изучить чат или диалог с кем-то (только ЯВНАЯ просьба) = ПРОВЕРКА_СООБЩЕНИЙ (contactQuery = имя)
        - КРИТИЧЕСКИ ВАЖНО: «когда день рождения X?», «как зовут X?», «что любит X?», «кто такой X?» = РАЗГОВОР (ответ из памяти), НЕ ПРОВЕРКА_СООБЩЕНИЙ
        - Даже если предыдущие сообщения были о ПРОВЕРКЕ_СООБЩЕНИЙ, простой вопрос о факте = РАЗГОВОР
        - Запрос на составление психологического портрета по переписке = ПРОВЕРКА_СООБЩЕНИЙ (contactQuery = имя)
        - Упоминание "анализ переписки", "анализируй сообщения" и подобных фраз = ПРОВЕРКА_СООБЩЕНИЙ
        - Просьба почитать/изучить ОДИН групповой чат по названию ("посмотри чат Leads", "изучи в чате Каркас", "почитай группу X") = ПРОВЕРКА_СООБЩЕНИЙ (groupChatQuery = название чата)
        - Просьба изучить НЕСКОЛЬКО групповых чатов по названиям ("изучи чаты Leads и Каркас", "посмотри чаты «Старт», «Финиш» и «Пуск»") = ПРОВЕРКА_СООБЩЕНИЙ (groupChatQueries = массив названий чатов, groupChatQuery НЕ заполнять)
        - Ключевое различие: "переписку с Юлей" / "чат с мамой" → contactQuery; один "чат Leads" / "группу Каркас" / "в чате Старт" → groupChatQuery; несколько чатов → groupChatQueries
        - «Изучи чат с X и запомни/узнай факты про меня» = ПРОВЕРКА_СООБЩЕНИЙ, messagesCheckType: ANALYZE_CONVERSATION, saveFactsAboutUser: true, contactQuery = X
        - «Изучи чат с X и запомни важное о нём/о ней» = ПРОВЕРКА_СООБЩЕНИЙ, messagesCheckType: ANALYZE_CONVERSATION, saveFactsAboutUser: true, contactQuery = X
        - «Изучи чат с X и запомни» (любая просьба запомнить/сохранить в контексте изучения переписки) = ПРОВЕРКА_СООБЩЕНИЙ, messagesCheckType: ANALYZE_CONVERSATION, saveFactsAboutUser: true, contactQuery = X
        - «Изучи чат [GroupName] и запомни/сохрани факты» ("изучи чат Важный вопрос и запомни", "прочитай группу Leads и сохрани факты") = ПРОВЕРКА_СООБЩЕНИЙ, messagesCheckType: ANALYZE_CONVERSATION, saveFactsAboutUser: true, groupChatQuery = GroupName

        Составные запросы (subIntents):
        Если запрос явно содержит ДВА независимых действия одновременно (разделены «и», «а также», «плюс», «заодно» или явным перечислением),
        укажи основное намерение в "intent", а дополнительное — в "subIntents".
        Добавляй subIntents ТОЛЬКО когда оба намерения явные и НЕЗАВИСИМЫЕ по времени и исполнению.
        НЕ добавляй subIntents, если одно намерение является контекстом другого:
          «напомни написать жене» — это просто НАПОМИНАНИЕ (написать жене — цель напоминания, не отдельное действие);
          «найди рецепт и скажи мне» — это просто ВЕБ_ПОИСК + conversation (один поток).
        Примеры ЯВНЫХ составных запросов (subIntents нужен):
          «напомни мне завтра и прямо сейчас напиши маме что задержусь» → intent: НАПОМИНАНИЕ, subIntents: [{intent: "ОТПРАВКА_СООБЩЕНИЯ", details: {contactQuery: "мама", messageContent: "задержусь"}}]
          «напиши Артёму про встречу и поставь напоминание на 18:00» → intent: ОТПРАВКА_СООБЩЕНИЯ, subIntents: [{intent: "НАПОМИНАНИЕ", details: {timeReferences: ["18:00"]}}]
          «найди адрес клиники и поставь напоминание на завтра в 9» → intent: ВЕБ_ПОИСК, subIntents: [{intent: "НАПОМИНАНИЕ", details: {timeReferences: ["завтра 9:00"]}}]

        Ответ предоставь в формате JSON:
        {
          "intent": "НАПОМИНАНИЕ | РАЗГОВОР | ГЕНЕРАЦИЯ_ИЗОБРАЖЕНИЯ | КАРТЫ_ЛОКАЦИИ | НЕОПРЕДЕЛЕНО | ПРОВЕРКА_СООБЩЕНИЙ | ВЕБ_ПОИСК | ОТПРАВКА_СООБЩЕНИЯ | ДЕЛЕГИРОВАНИЕ_ЗАДАЧИ | ВОЗМОЖНОСТИ_БОТА | САМОИЗУЧЕНИЕ | БРАУЗЕР_ЗАДАЧА | ЗДОРОВЬЕ",
          "confidenceLevel": "ВЫСОКИЙ | СРЕДНИЙ | НИЗКИЙ",
          "intentScores": [
            {
              "intent": "один из допустимых intent",
              "score": 0.0,
              "reason": "почему этот вариант подходит, кратко"
            }
          ],
          "ambiguityReason": "кратко, только если лучшие варианты близки; иначе опустить",
          "clarificationQuestion": "естественный вопрос пользователю, только если лучшие варианты близки; иначе опустить",
          "subIntents": [
            {
              "intent": "второй интент (только если запрос явно составной, иначе опустить поле)",
              "details": { "contactQuery": "...", "timeReferences": ["..."], "messageContent": "..." }
            }
          ],
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
            "groupChatQuery": "название ОДНОГО группового чата (при фразах 'чат Leads', 'в чате Каркас', 'группа X', 'посмотри чат X' без предлога 'с' перед именем человека). Заполнять только если чат один.",
            "groupChatQueries": ["массив названий групповых чатов если пользователь перечисляет НЕСКОЛЬКО чатов. Пример: 'изучи чаты «Leads» и «Каркас»' → [\"Leads\", \"Каркас\"]. Если чат один — НЕ заполнять, использовать groupChatQuery."],
            "analysisQuery": "что нужно проанализировать в переписке (только для намерения ПРОВЕРКА_СООБЩЕНИЙ и messagesCheckType: ANALYZE_CONVERSATION)",
            "saveFactsAboutUser": "true если пользователь просит изучить переписку и сохранить/узнать/запомнить факты — о СЕБЕ (обо мне, про меня) ИЛИ О КОНТАКТЕ (о нём, о ней, про него, важное о нём, запомни что узнаешь, запомни важное, сохрани факты). Любая просьба 'запомни', 'сохрани', 'узнай и сохрани' в контексте изучения переписки = true. Примеры: 'изучи чат с женой и узнай факты про меня' → true; 'изучи чат с Артемом и запомни важное о нём' → true; 'прочитай переписку с мамой и запомни' → true",
            "botReaction": "эмодзи, которым стоит отреагировать на сообщение пользователя, или NONE, если реакция не нужна",
            "reminderAction": "create | cancel | cancelAll | update | updateAll — только для интента НАПОМИНАНИЕ. По умолчанию create. cancel/cancelAll — отменить одно или все, update/updateAll — изменить одно или все.",
            "reminderBatchPeriod": "today | tomorrow | week — фильтр периода для cancelAll/updateAll. Не заполнять если операция применяется ко всем напоминаниям без фильтра.",
            "reminderCancelQuery": "ключевые слова для поиска напоминания при reminderAction=cancel. Например: 'врач', 'встреча с Артёмом', 'звонок маме'",
            "reminderUpdateQuery": "ключевые слова для поиска напоминания при reminderAction=update. Например: 'врач', 'встреча', 'звонок маме'",
            "reminderUpdateNewTime": "новое время при reminderAction=update, человекочитаемое. Например: 'завтра в 15:00', 'в пятницу в 10', 'через 2 часа'",
            "reminderUpdateNewText": "новый текст напоминания при reminderAction=update (только если пользователь меняет именно текст)"
          }
        }
        `;

        // Короткие реплики зависят от предыдущих ходов, поэтому история входит
        // в ключ кэша и не может переиспользовать чужую контекстную классификацию.
        const cacheKey = buildClassificationCacheKey(message, messageHistory, knownChatGroups ?? []);
        const cached = llmCache.get<MessageClassification>(cacheKey);
        if (cached) {
            devLog('classifyMessage: cache hit');
            return normalizeIntentScores(cached);
        }

        // Отправка запроса к API OpenAI (gpt-5.2 — для максимально точного определения интента)
        const parsedResponse = await createJsonChatCompletionForTask<MessageClassification>('intentClassification', {
            messages: [
                {
                    role: "system",
                    content: `Ты — классификатор намерений для универсального оркестратора. Твоя задача: по сообщению пользователя выбрать ОДИН конкретный интент из списка (НАПОМИНАНИЕ, РАЗГОВОР, ГЕНЕРАЦИЯ_ИЗОБРАЖЕНИЯ, КАРТЫ_ЛОКАЦИИ, ПРОВЕРКА_СООБЩЕНИЙ, ВЕБ_ПОИСК, ОТПРАВКА_СООБЩЕНИЯ, ДЕЛЕГИРОВАНИЕ_ЗАДАЧИ, ВОЗМОЖНОСТИ_БОТА, САМОИЗУЧЕНИЕ, БРАУЗЕР_ЗАДАЧА, ЗДОРОВЬЕ).
                    Выбирай тот интент, который лучше всего соответствует запросу. Для явных просьб (напомни, напиши сообщение, нарисуй, найди на карте, отправь маме, запишись на сайте, заполни форму и т.п.) всегда указывай соответствующий интент и confidenceLevel: ВЫСОКИЙ.
                    Всегда возвращай intentScores — ранжированный top-2/top-4 вероятных интентов со score 0..1. Если лучшие варианты близки, понижай confidenceLevel и добавляй короткий clarificationQuestion.
                    Если пользователь спрашивает, умеет ли бот что-то делать, может ли бот выполнить класс задач, или как правильно попросить бота о действии — это ВОЗМОЖНОСТИ_БОТА. Не превращай такие meta-вопросы в выполнение действия.
                    Если пользователь спрашивает "расскажи о себе", "кто ты", о жизни, биографии, цели, учёбе или работе ассистента — это РАЗГОВОР, не ВОЗМОЖНОСТИ_БОТА и не поиск контакта.
                    Если пользователь просит провести самоизучение/самоанализ бота, его возможностей, ограничений или потребностей — это САМОИЗУЧЕНИЕ.
                    ЗДОРОВЬЕ — когда пользователь хочет вести дневник здоровья, сохранить наблюдение о еде/напитке/симптомах/лекарстве/самочувствии/коже/давлении/активности/том, что делал или делает, фото еды/кожи, проанализировать дневник за период или выгрузить дневник за период.
                    БРАУЗЕР_ЗАДАЧА — когда пользователь просит реально что-то сделать в браузере: записаться, заполнить форму, забронировать, нажать кнопку на конкретном сайте, или явно просит "используй браузер".
                    ВЕБ_ПОИСК — для афиши, расписания, ближайших игр/квизов/мероприятий и билетов, если пользователь пока просит найти варианты.
                    КАРТЫ_ЛОКАЦИИ не используй для расписания событий: "ближайшие игры Квизум в Москве" — это ВЕБ_ПОИСК.
                    НЕОПРЕДЕЛЕНО возвращай только если сообщение действительно непонятно или не подходит ни под одну категорию. Не используй НЕОПРЕДЕЛЕНО для ясных просьб.`
                },
                {
                    role: "user",
                    content: prompt
                }
            ],
            temperature: 1, // модель поддерживает только default (1)
        });

        devLog("Classification Response:", parsedResponse);

        if (!parsedResponse) {
            throw new Error("Could not parse JSON from AI response");
        }
        const normalizedClassification = normalizeIntentScores(parsedResponse);
        llmCache.set(cacheKey, normalizedClassification, LLM_CACHE_TTL.CLASSIFY);
        return normalizedClassification;

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
    lastLocation?: { latitude: number; longitude: number; address?: string; },
    options: {
        voiceReplyRequested?: boolean;
        turn?: ConversationTurn;
        /** Отдельный текст только для выбора источника знаний; не считается словами пользователя. */
        knowledgeSourceText?: string;
    } = {}
): Promise<ProcessingResult> {
    try {
        const originalMessage = options.turn?.userText ?? message;
        const replyContext = options.turn?.replyContext;
        const forwardContext = options.turn?.forwardContext;
        const internalBrowserContinuation = BROWSER_CONTINUATION_RE.test(message);
        const routingMessage = internalBrowserContinuation ? message : originalMessage;
        const knowledgeDecision = decideKnowledgeSource(
            options.knowledgeSourceText ?? originalMessage,
            replyContext,
            options.turn?.currentTopic,
        );
        const proactiveExplanation = buildProactiveInsightExplanation(ctx, originalMessage, replyContext);
        if (proactiveExplanation) return proactiveExplanation;

        const pendingHealthDiscomfort = ctx?.session?.pendingHealthDiscomfort;
        if (pendingHealthDiscomfort?.expiresAt && pendingHealthDiscomfort.expiresAt <= Date.now()) {
            ctx.session.pendingHealthDiscomfort = undefined;
        } else if (
            pendingHealthDiscomfort &&
            !BROWSER_CONTINUATION_RE.test(routingMessage) &&
            !looksLikeBrowserTaskText(routingMessage)
        ) {
            devLog("Pending health discomfort input detected, routing to healthAgent");
            console.log("[ORCH] pending health discomfort:", pendingHealthDiscomfort.recordId);
            return healthAgent(ctx, routingMessage, isForwarded, forwardFrom, messageHistory);
        }

        const pendingHealthLog = ctx?.session?.pendingHealthLog;
        if (pendingHealthLog?.expiresAt && pendingHealthLog.expiresAt <= Date.now()) {
            ctx.session.pendingHealthLog = undefined;
        } else if (
            pendingHealthLog &&
            !BROWSER_CONTINUATION_RE.test(routingMessage) &&
            !looksLikeBrowserTaskText(routingMessage)
        ) {
            devLog("Pending health log input detected, routing to healthAgent");
            console.log("[ORCH] pending health log:", pendingHealthLog.mode);
            return healthAgent(ctx, routingMessage, isForwarded, forwardFrom, messageHistory);
        }

        const originalLooksLikeNewBrowserTask =
            !BROWSER_CONTINUATION_RE.test(routingMessage) &&
            looksLikeBrowserTaskText(routingMessage);
        if (originalLooksLikeNewBrowserTask && hasActivePendingBrowserTask(ctx)) {
            devLog("New browser task detected while another browser task is paused; clearing pending browser task");
            console.log("[ORCH] clearing pending browser task for new request:", originalMessage.slice(0, 100));
            ctx.session.pendingBrowserTask = undefined;
        }

        message = routingMessage;
        const browserFollowUpMessage = buildBrowserFollowUpMessage(ctx, message);
        if (browserFollowUpMessage) {
            devLog("Browser follow-up detected, routing to browserTask");
            console.log("[ORCH] browser follow-up detected:", message.slice(0, 80));
            message = browserFollowUpMessage;
        }
        const isBrowserTaskLike = Boolean(browserFollowUpMessage) || looksLikeBrowserTaskText(message);
        if (shouldInterruptPendingContactMemory(knowledgeDecision, isBrowserTaskLike) && ctx.session?.pendingContactMemory) {
            devLog("Clearing pending contact memory before unrelated external routing");
            ctx.session.pendingContactMemory = undefined;
        }

        const explicitRemember = extractExplicitRememberFact(message);
        if (!explicitRemember && !isBrowserTaskLike && !knowledgeDecision.requiresWeb) {
            const contactMemoryResolution = await handlePendingContactMemoryText(ctx, message);
            if (contactMemoryResolution) {
                return { responseText: contactMemoryResolution };
            }
            const pendingContactLookup = await handlePendingContactLookupText(ctx, message);
            if (pendingContactLookup) {
                return pendingContactLookup;
            }
            const contactLookup = await maybeStartContactMemoryLookup(ctx, message);
            if (contactLookup) {
                return contactLookup;
            }
        } else if (explicitRemember?.contactName && ctx.session?.pendingContactMemory) {
            return { responseText: 'Выбери контакт в сообщении выше — сохраню факт после уточнения.' };
        }

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
        const initialMemory = await fetchAgentMemoryContext(ctx, originalMessage);
        const initialBlock = buildMemoryContextBlock(initialMemory);
        let enrichedContextFromMemory = initialBlock ? initialBlock + '\n\n' : '';
        const knowledgeBlock = buildKnowledgeSourcePrompt(knowledgeDecision);
        if (knowledgeBlock) enrichedContextFromMemory += `${knowledgeBlock}\n\n`;
        if (replyContext) {
            enrichedContextFromMemory += [
                'Структурированный контекст сообщения, на которое отвечает пользователь:',
                `- messageId: ${replyContext.messageId}`,
                `- sender: ${replyContext.sender ?? 'неизвестно'}`,
                replyContext.contactId ? `- contactId: ${replyContext.contactId}` : '',
                replyContext.contactName ? `- contactName: ${replyContext.contactName}` : '',
                `- text: ${replyContext.text}`,
                'Это контекст reply, а не слова текущей реплики пользователя.',
                '',
            ].filter(Boolean).join('\n');
        }
        if (forwardContext) {
            enrichedContextFromMemory += [
                'Структурированный контекст пересланного сообщения:',
                `- sender: ${forwardContext.sender ?? 'неизвестно'}`,
                `- text: ${forwardContext.text}`,
                'Это пересланный материал, а не слова текущей реплики пользователя.',
                '',
            ].join('\n');
        }
        if (options.turn?.activePeople?.length) {
            enrichedContextFromMemory += `Активная личность текущего эпизода: ${options.turn.activePeople
                .map(person => `${person.contactName ?? 'контакт'}${person.contactId ? ` (contactId:${person.contactId})` : ''}`)
                .join(', ')}. Используй только как контекст эпизода, не как новый факт.\n`;
        }
        if (options.turn?.currentTopic) {
            enrichedContextFromMemory += `Текущая тема эпизода: ${options.turn.currentTopic}.\n`;
        }

        const roleInMessage = await detectRelationshipInMessage(originalMessage);
        if (roleInMessage) {
            const resolvedName = await resolveRelationshipFromMemory(ctx, roleInMessage, originalMessage);
            if (resolvedName) {
                enrichedContextFromMemory += `В запросе пользователя под «${roleInMessage}» имеется в виду: ${resolvedName} (из долговременной памяти).\n\n`;
                devLog("Orchestrator: enriched with resolved contact", roleInMessage, "->", resolvedName);
                console.log("[ORCH] enriched: role", roleInMessage, "-> name", resolvedName);
            }
        }

        // Загружаем сохранённые группы чатов для инжекта в классификатор и контекст разговора
        let knownChatGroups: { name: string; chatNames: string[] }[] = [];
        const ownerChatId = ctx?.chat?.id;
        if (ownerChatId) {
            try {
                const groups = await ChatGroupRepository.findAll(ownerChatId);
                knownChatGroups = groups.map(g => ({ name: g.name, chatNames: g.chatNames }));
            } catch { /* не критично — продолжаем без групп */ }
        }

        // Инжектируем группы в контекст разговора, чтобы агент знал о них при casual упоминании
        if (knownChatGroups.length > 0) {
            const groupsLine = knownChatGroups
                .map(g => `«${g.name}» (чаты: ${g.chatNames.join(', ')})`)
                .join('; ');
            enrichedContextFromMemory += `Сохранённые группы чатов пользователя: ${groupsLine}.\n\n`;
        }

        // Шаг 2: Оркестратор определяет, куда направить запрос (классификация + план).
        // Явные "напомни..." ведём коротким путём без LLM-классификатора: это дешевле, быстрее и не даёт ambiguity-flow мучить пользователя вопросами.
        const deterministicReminderClassification =
            !BROWSER_CONTINUATION_RE.test(message) && !explicitRemember
                ? buildExplicitReminderClassification(message)
                : null;
        const contextualFollowUp = !deterministicReminderClassification && !explicitRemember
            ? decideContextualFollowUp(originalMessage, messageHistory)
            : null;
        const deterministicContextualClassification: MessageClassification | null = contextualFollowUp
            ? {
                intent: contextualFollowUp.intent,
                confidenceLevel: "ВЫСОКИЙ",
                intentScores: [{
                    intent: contextualFollowUp.intent,
                    score: 1,
                    reason: contextualFollowUp.reason,
                }],
                details: {
                    knowledgeSource: contextualFollowUp.knowledgeSource,
                    requestedFacets: contextualFollowUp.requestedFacets,
                },
            }
            : null;
        let classification = deterministicReminderClassification
            ?? deterministicContextualClassification
            ?? await classifyMessage(originalMessage, isForwarded, forwardFrom, messageHistory, knownChatGroups);
        let deterministicOverrideApplied = Boolean(
            deterministicReminderClassification || deterministicContextualClassification
        );
        if (deterministicReminderClassification) {
            devLog("Explicit reminder fast-path: routing to НАПОМИНАНИЕ");
        }
        if (deterministicContextualClassification) {
            devLog(
                "Contextual follow-up fast-path:",
                deterministicContextualClassification.intent,
                contextualFollowUp?.reason,
            );
        }

        if (knowledgeDecision.requiresWeb && !isBrowserTaskLike && !explicitRemember) {
            const routedKnowledge = applyKnowledgeSourceDecision(classification, knowledgeDecision);
            classification = routedKnowledge.classification;
            if (routedKnowledge.primaryIntentOverridden) deterministicOverrideApplied = true;
            devLog(
                routedKnowledge.primaryIntentOverridden
                    ? 'External current knowledge detected, routing to web search'
                    : 'External current knowledge detected, preserving primary action intent',
                knowledgeDecision,
            );
        }

        if (BROWSER_CONTINUATION_RE.test(message)) {
            classification = { ...classification, intent: "БРАУЗЕР_ЗАДАЧА", confidenceLevel: "ВЫСОКИЙ" };
            deterministicOverrideApplied = true;
            devLog("Browser continuation detected, routing to browserTask");
        }

        if (
            !deterministicOverrideApplied &&
            (hasActiveRunningBrowserTask(ctx) || hasActiveBrowserRunForContext(ctx)) &&
            looksLikeBrowserTaskCancellation(message) &&
            !explicitRemember
        ) {
            classification = { ...classification, intent: "БРАУЗЕР_ЗАДАЧА", confidenceLevel: "ВЫСОКИЙ" };
            deterministicOverrideApplied = true;
            devLog("Active browser task cancellation detected, routing to browserTask");
        }

        if (
            !deterministicOverrideApplied &&
            hasActivePendingBrowserTask(ctx) &&
            !explicitRemember
        ) {
            classification = { ...classification, intent: "БРАУЗЕР_ЗАДАЧА", confidenceLevel: "ВЫСОКИЙ" };
            deterministicOverrideApplied = true;
            devLog("Pending browser task answer detected, routing to browserTask");
        }

        if (
            !deterministicOverrideApplied &&
            looksLikeNegatedBookingRequest(message) &&
            !explicitRemember
        ) {
            classification = {
                ...classification,
                intent: "РАЗГОВОР",
                confidenceLevel: "ВЫСОКИЙ",
                ambiguityReason: undefined,
                clarificationQuestion: undefined,
            };
            deterministicOverrideApplied = true;
            devLog("Negated booking request without active browser task, routing to conversation");
        }

        if (
            !deterministicOverrideApplied &&
            EXPLICIT_REMINDER_RE.test(message)
        ) {
            devLog("Explicit reminder phrase override: forcing НАПОМИНАНИЕ");
            classification = {
                ...classification,
                intent: "НАПОМИНАНИЕ",
                confidenceLevel: "ВЫСОКИЙ",
                ambiguityReason: undefined,
                clarificationQuestion: undefined,
                details: {
                    ...classification.details,
                    reminderAction: classification.details?.reminderAction ?? "create",
                },
            };
            deterministicOverrideApplied = true;
        }

        if (
            !deterministicOverrideApplied &&
            isTodayImportanceRequest(message) &&
            !explicitRemember
        ) {
            classification = {
                ...classification,
                intent: "РАЗГОВОР",
                confidenceLevel: "ВЫСОКИЙ",
                ambiguityReason: undefined,
                clarificationQuestion: undefined,
            };
            deterministicOverrideApplied = true;
            devLog("Today importance request detected, routing to conversation");
        }

        if (
            !deterministicOverrideApplied &&
            ASSISTANT_SELF_LIFE_REQUEST_RE.test(message) &&
            !explicitRemember
        ) {
            classification = {
                ...classification,
                intent: "РАЗГОВОР",
                confidenceLevel: "ВЫСОКИЙ",
                ambiguityReason: undefined,
                clarificationQuestion: undefined,
            };
            deterministicOverrideApplied = true;
            devLog("Assistant self-life request detected, routing to conversation");
        }

        if (
            !deterministicOverrideApplied &&
            classification.intent !== "БРАУЗЕР_ЗАДАЧА" &&
            !explicitRemember &&
            BROWSER_TASK_FORCE_RE.test(message)
        ) {
            classification = { ...classification, intent: "БРАУЗЕР_ЗАДАЧА", confidenceLevel: "ВЫСОКИЙ" };
            deterministicOverrideApplied = true;
            devLog("Browser task keyword override: forcing БРАУЗЕР_ЗАДАЧА");
        }

        if (explicitRemember && classification.intent !== "ПРОВЕРКА_СООБЩЕНИЙ") {
            classification = { ...classification, intent: "РАЗГОВОР", confidenceLevel: "ВЫСОКИЙ" };
            deterministicOverrideApplied = true;
            devLog("Explicit remember detected, routing to conversation");
        }

        if (
            !deterministicOverrideApplied &&
            SELF_STUDY_TASK_RE.test(message) &&
            !explicitRemember
        ) {
            classification = {
                ...classification,
                intent: "САМОИЗУЧЕНИЕ",
                confidenceLevel: "ВЫСОКИЙ",
                ambiguityReason: undefined,
                clarificationQuestion: undefined,
            };
            deterministicOverrideApplied = true;
            devLog("Self-study keyword override: forcing САМОИЗУЧЕНИЕ");
        }

        // ПРОВЕРКА_СООБЩЕНИЙ с низкой уверенностью (СРЕДНИЙ/НИЗКИЙ) без явного contactQuery — скорее всего ложное срабатывание, переключаем на РАЗГОВОР
        if (
            classification.intent === "ПРОВЕРКА_СООБЩЕНИЙ" &&
            classification.confidenceLevel !== "ВЫСОКИЙ" &&
            !classification.details.contactQuery &&
            !classification.details.groupChatQuery &&
            !classification.details.groupChatQueries?.length
        ) {
            devLog("ПРОВЕРКА_СООБЩЕНИЙ with low confidence and no contact, downgrading to РАЗГОВОР");
            classification = { ...classification, intent: "РАЗГОВОР", confidenceLevel: "СРЕДНИЙ" };
        }

        const intentAmbiguity = deterministicOverrideApplied ? null : detectIntentAmbiguity(classification);
        if (intentAmbiguity) {
            const { top, runnerUp, delta } = intentAmbiguity;
            classification = {
                ...classification,
                intent: "НЕОПРЕДЕЛЕНО",
                confidenceLevel: "НИЗКИЙ",
                ambiguityReason: classification.ambiguityReason ||
                    `Близкие варианты: ${top.intent} (${top.score.toFixed(2)}) и ${runnerUp.intent} (${runnerUp.score.toFixed(2)}), delta=${delta.toFixed(2)}.`,
                clarificationQuestion: classification.clarificationQuestion ||
                    "Уточни, пожалуйста: нужно найти информацию, выполнить действие или просто обсудить это?",
            };
            devLog("Intent ambiguity detected, routing to unclearIntent", classification.ambiguityReason);
            console.log("[ORCH] ambiguity:", top.intent, top.score.toFixed(2), "vs", runnerUp.intent, runnerUp.score.toFixed(2));
        }

        devLog("Message classified as:", classification.intent, "with confidence:", classification.confidenceLevel);
        console.log("[ORCH] message:", message.slice(0, 80), "| intent:", classification.intent, "| confidence:", classification.confidenceLevel);

        // Внутренние browser-continuation/follow-up содержат служебный контекст,
        // обычные ходы и web-search всегда получают только новую реплику.
        const executionMessage = isBrowserTaskLike ? message : originalMessage;

        const plan = await createPlan({
            message: executionMessage,
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
            message: executionMessage,
            isForwarded,
            forwardFrom,
            messageHistory,
            classification,
            lastLocation,
            enrichedContextFromMemory,
            voiceReplyRequested: options.voiceReplyRequested === true,
        });
        result.recalledMemories = initialMemory.recalledMemories ?? [];
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
