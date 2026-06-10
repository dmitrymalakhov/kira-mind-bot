import { Context, SessionFlavor } from "grammy";
import { Reminder } from "./reminder";

// Возможные состояния диалога с неавторизованным пользователем
export enum UnauthorizedChatState {
    Initial = "initial",     // Начальное состояние
    Question1 = "question1", // Задан первый уточняющий вопрос
    Question2 = "question2", // Задан второй уточняющий вопрос
    Closing = "closing",     // Завершение разговора
    Completed = "completed"  // Разговор завершен и информация передана
}

// Интерфейс для хранения информации о чате с неавторизованным пользователем
export interface UnauthorizedChatInfo {
    chatId: number;
    username: string;
    firstName: string;
    lastName: string;
    messages: MessageHistory[];
    state: UnauthorizedChatState;
    lastInteractionTime: Date;
    context?: string;
    questionCount: number; // Счетчик заданных вопросов
    timeoutUntil: Date | null; // Время до которого действует тайм-аут
    timeoutMessageSent?: boolean; // Флаг, был ли пользователь уведомлен о тайм-ауте
    isInContacts?: boolean; // Флаг, находится ли пользователь в контактах
}

export interface SessionData {
    reminders: Reminder[];
    messageEditing?: boolean;
    messageHistory: MessageHistory[]; // Хранение истории сообщений
    dialogueSummary: string; // Суммаризация предыдущих диалогов
    lastSummarizedIndex: number; // Индекс последнего суммаризированного сообщения
    lastLocation?: {  // Поле для хранения последней геолокации
        latitude: number;
        longitude: number;
        address?: string;
        timestamp: Date;
    };
    lastUserMessage?: { // Поле для временного хранения последнего сообщения пользователя
        text: string;
        timestamp: number;
        processed: boolean;
    };
    isAllowedUser?: boolean;
    unauthorizedChat?: UnauthorizedChatInfo;
    mediaGroups?: Map<string, {
        fileIds: string[];
        caption: string;
        timestamp: number;
        processed: boolean;
    }>;
    forwardGroups?: {
        [key: string]: {
            messages: string[]; // Для обратной совместимости
            sources: { // Новое поле для хранения сообщений по источникам
                [source: string]: string[];
            };
            lastTime: number;
            timerId: NodeJS.Timeout | null;
            userMessages?: string[];
        }
    };
    /** Сопоставление идентификаторов отправленных сообщений и их текста */
    sentMessages?: Record<number, string>;
    domains: Record<string, DomainMemory>;
    /**
     * Компактная модель текущей ситуации в разговоре.
     * Это не долговременная память, а "рабочий стол": активные люди, темы,
     * открытые вопросы и краткое состояние последних реплик.
     */
    workingMemory?: WorkingMemoryState;
    lastFactAnalysisIndex?: number; // Индекс последнего анализа фактов
    /** Контент фактов, уже сохранённых quickFactCheck — delayed analysis пропускает похожие */
    quickFactContents?: string[];
    /** Буфер недавно сохранённых фактов — гарантирует что только что сохранённые факты
     *  попадут в контекст без задержки (обход latency vector search) */
    recentlySavedFacts?: Array<{ content: string; savedAt: number }>;
    /** Ошибка сохранения факта в векторную БД — показываем пользователю после ответа */
    lastFactSaveError?: string;
    /** Unix-timestamp последней проактивной подсказки из памяти (для cooldown) */
    lastProactiveHintAt?: number;
    /** Последняя проактивная подсказка и факты памяти, на которых она была основана */
    lastProactiveInsight?: {
        message: string;
        sourceMemories: string[];
        createdAt: number;
        messageId?: number;
        kind: 'memoryInsight' | 'contextHint';
    };
    /** Unix-timestamp последнего вопроса о пробеле в памяти (для cooldown) */
    lastMemoryGapAt?: number;
    /** Unix-timestamp последнего предложения создать implicit reminder (для cooldown) */
    lastImplicitReminderAt?: number;
    /** Ожидание ввода кастомного времени для переноса напоминания */
    pendingPostpone?: {
        reminderId: string;
        messageId: number;
        chatId: number;
        createdAt?: number;
        expiresAt?: number;
    };
    /** Ожидание ввода правки для существующего напоминания */
    pendingReminderEdit?: {
        reminderId: string;
        messageId: number;
        chatId: number;
        createdAt: number;
        expiresAt: number;
    };
    /** Ожидающее подтверждения предложение создать напоминание (TTL 5 минут) */
    pendingImplicitReminder?: {
        originalMessage: string;
        eventSummary: string;
        createdAt: number;
    };
    /** Ожидает уточнения, к какому контакту относится извлечённый факт */
    pendingContactMemory?: {
        contactName: string;
        content: string;
        domain: string;
        importance: number;
        tags: string[];
        isAnchor?: boolean;
        memoryMetadata?: {
            sourceEpisodeId?: string;
            sourceContext?: string;
            sourceMessageIds?: string[];
            extractionMethod?: MemoryExtractionMethod;
            subject?: MemorySubject;
            predicate?: string;
            object?: string;
            validFrom?: Date;
            validTo?: Date;
            status?: MemoryStatus;
        };
        candidateIds: number[];
        createdAt: number;
    };
    /** Ожидает уточнения, о каком контакте спрашивает пользователь при чтении памяти */
    pendingContactLookup?: {
        contactName: string;
        originalMessage: string;
        candidateIds: number[];
        createdAt: number;
    };
    /** Ожидает уточнения пользователя для продолжения браузерной Playwright-задачи */
    pendingBrowserTask?: {
        originalTask: string;
        question: string;
        sessionId?: string;
        userAnswer?: string;
        risk?: 'high_impact';
        choices?: Array<{
            label: string;
            answer: string;
        }>;
        createdAt: number;
        expiresAt: number;
    };
    /** Ожидает текст/голос для записи в дневник здоровья */
    pendingHealthLog?: {
        mode: 'food' | 'drink' | 'symptom' | 'medication' | 'activity' | 'skin' | 'blood_pressure' | 'note';
        prompt: string;
        createdAt: number;
        expiresAt: number;
    };
    /** Ожидает субъективную оценку зуда/дискомфорта для фото-записи здоровья */
    pendingHealthDiscomfort?: {
        recordId: string;
        question: string;
        createdAt: number;
        expiresAt: number;
    };
    /** Сейчас выполняется активная браузерная задача; используется для аварийной отмены */
    activeBrowserTask?: {
        originalTask: string;
        sessionId: string;
        createdAt: number;
        expiresAt: number;
    };
    /** Последняя успешно завершённая браузерная задача — для коротких follow-up вроде «запиши меня туда» */
    lastBrowserTask?: {
        originalTask: string;
        summary: string;
        url?: string;
        title?: string;
        notes?: string[];
        pageText?: string;
        createdAt: number;
        expiresAt: number;
    };
    /** Ожидает выбора одного из быстрых вариантов уточнения через inline-кнопки */
    pendingQuickChoices?: Record<string, {
        originalMessage: string;
        choices: Array<{
            label: string;
            message: string;
            action?: 'cancel_browser_task';
        }>;
        createdAt: number;
        expiresAt: number;
    }>;
    /** chatId группового чата, напоминания которого просматриваются из приватного чата */
    viewingRemindersInChat?: number;
    /** Состояние сценария «изучить переписку и сохранить найденные факты»: выбор периода */
    studyChatRequest?: {
        requestId?: string;
        contactName: string;
        contactId: number;
        step: 'period';
        createdAt?: number;
        expiresAt?: number;
    };
    /** Состояние выбора периода для анализа группового чата или группы чатов */
    chatAnalysisPeriodRequest?: {
        requestId: string;
        groupNames: string[];
        displayName: string;
        analysisQuery: string;
        step: 'period';
        saveFactsAboutUser?: boolean;
        offerSaveGroup?: boolean;
        /** Исходный запрос просил ответить голосом; после выбора периода отправляем краткую voice-сводку. */
        voiceReplyRequested?: boolean;
        memoryContext?: string;
        createdAt: number;
        expiresAt: number;
    };
    /** Состояние мастера создания/редактирования группы чатов через /chatgroups */
    chatGroupState?: {
        step: 'awaiting_name' | 'awaiting_chats' | 'awaiting_remove_chat';
        groupName?: string;
        editGroupId?: number;
        editGroupName?: string;
        /** Чаты ожидающие сохранения в группу (quick-save после inline анализа) */
        pendingChatNames?: string[];
    };
    /** Снимок последней оркестрации для LLM-дедупликации повторных запросов */
    lastIntentDedup?: {
        message: string;
        intent: string;
        confidenceLevel?: string;
        planStepIds: string[];
        result: {
            responseText: string;
            reminderCreated?: boolean;
            reminderDetails?: {
                id: string;
                text: string;
                reminderMessage?: string;
                targetReminderMessage?: string;
                dueDate: Date;
                targetChat?: { type: "group"; groupName: string } | { type: "contact"; contactQuery: string };
            };
            reminderDetailsList?: {
                id: string;
                text: string;
                reminderMessage?: string;
                targetReminderMessage?: string;
                dueDate: Date;
                targetChat?: { type: "group"; groupName: string } | { type: "contact"; contactQuery: string };
            }[];
            detectedText?: string;
            description?: string;
            imageGenerated?: boolean;
            generatedImageUrl?: string;
            icsFilePath?: string;
            messageDraft?: { contactId: number; text: string; scheduledTime?: Date };
            contactSelected?: boolean;
            messageEditing?: boolean;
            messageConfirmed?: boolean;
            botReaction?: string;
            negotiationSummarySent?: boolean;
        };
        createdAt: number;
    };
}

export interface ForwardedMessageGroup {
    messages: string[];
    sender: string;
    timestamp: Date;
    processed: boolean;
}

export type BotContext = Context & SessionFlavor<SessionData>;

// Интерфейс для хранения истории сообщений
export interface MessageHistory {
    role: string;
    content: string;
    timestamp: Date;
}

export interface DomainMemory {
    summary: string;
    facts: string[];
}

export interface WorkingMemoryState {
    summary: string;
    activeTopics: string[];
    activeEntities: string[];
    openLoops: string[];
    userMood?: string;
    lastUserIntent?: string;
    lastUpdatedAt: Date;
}

// Интерфейс для описания наряда (из другого файла agent.ts)
export interface OutfitDescription {
    name: string;
    description: string;
    items: {
        name: string;
        searchQuery: string;
    }[];
}

// Интерфейс для запроса на генерацию изображения
export interface ImageGenerationRequest {
    image_request: {
        prompt: string;
        aspect_ratio: string;
        model: string;
        magic_prompt_option: string;
        style_type: string;
    };
}

/**
 * Эмоциональная маркировка факта.
 * Определяется LLM fire-and-forget после сохранения.
 * Flashbulb-факты (arousal > 0.7 + |valence| > 0.5) автоматически становятся anchor.
 */
export interface EmotionalTag {
    /** Валентность: -1 (негативное) .. +1 (позитивное). 0 = нейтральный факт. */
    valence: number;
    /** Интенсивность: 0 (обыденное) .. 1 (очень эмоционально значимое). */
    arousal: number;
    /** Флэшбалб: высокая интенсивность + выраженная валентность = помнить всегда. */
    isFlashbulb: boolean;
}

export type MemorySubject = 'user' | 'contact' | 'bot' | 'system';
export type MemoryStatus = 'active' | 'planned' | 'done' | 'superseded' | 'expired' | 'unknown';
export type MemoryKind =
    | 'fact'
    | 'episode'
    | 'chapter'
    | 'trait'
    | 'preference'
    | 'goal'
    | 'open_loop'
    | 'relationship'
    | 'routine'
    | 'boundary'
    | 'promise'
    | 'prospective'
    | 'portrait'
    | 'event'
    | 'state'
    | 'unknown';
export type MemoryRelationType =
    | 'semantic'
    | 'same_episode'
    | 'same_entity'
    | 'temporal'
    | 'updates'
    | 'supports'
    | 'contradicts'
    | 'goal_step'
    | 'person_link'
    | 'contextual';
export interface MemoryRelation {
    id: string;
    domain: string;
    type?: MemoryRelationType;
    weight?: number;
    createdAt?: Date;
    cue?: string;
}
export type MemoryExtractionMethod =
    | 'explicit'
    | 'quick'
    | 'delayed'
    | 'study_chat'
    | 'reflection'
    | 'portrait'
    | 'episode'
    | 'consolidation'
    | 'compression'
    | 'manual'
    | 'unknown';

export interface MemorySourceMessage {
    role: string;
    content: string;
    timestamp: Date;
}

export interface MemoryEpisode {
    id: string;
    userId: string;
    botId: string;
    chatId?: string;
    summary: string;
    startTime: Date;
    endTime: Date;
    timestamp: Date;
    participants: string[];
    entities: string[];
    domains: string[];
    emotion?: string;
    salience: number;
    sourceMessages: MemorySourceMessage[];
    derivedFactIds?: string[];
    tags?: string[];
}

export interface MemoryEntry {
    id: string;
    content: string;
    domain: string;
    botId: string;
    timestamp: Date;
    importance: number;
    tags: string[];
    userId: string;
    /** Якорный факт (явное «Запомни») — всегда подмешивается в контекст */
    isAnchor?: boolean;
    expiresAt?: Date;
    /** Эмоциональная маркировка — влияет на ранжирование и flashbulb → anchor */
    emotionalTag?: EmotionalTag;
    /**
     * Достоверность факта [0..1].
     * 0.6 при первом сохранении, +0.1 при каждом подтверждении, -0.2 при частичном противоречии.
     */
    confidence?: number;
    /**
     * Когда факт последний раз участвовал в поиске (retrieval).
     * Используется для кривой забывания Эббингауза: давно не всплывавшие факты
     * получают штраф к эффективной важности при ранжировании.
     */
    lastAccessedAt?: Date;
    /** Сколько раз воспоминание реально попадало в контекст ответа. */
    retrievalCount?: number;
    /** Когда воспоминание последний раз было использовано в контексте ответа. */
    lastRetrievedAt?: Date;
    /** Последние пользовательские cues/запросы, по которым это воспоминание всплывало. */
    retrievalCues?: string[];
    /**
     * История предыдущих версий факта.
     * Заполняется при обнаружении противоречия или обновления (contradicts/updates).
     * Позволяет восстановить хронологию: "жил в Москве → переехал в Питер".
     */
    previousVersions?: Array<{
        content: string;
        timestamp: Date;
        confidence: number;
    }>;
    /**
     * Граф связей: ID соседних фактов с указанием домена.
     * Строится fire-and-forget после каждого сохранения.
     * Используется при retrieval для 1-hop expansion контекста.
     */
    relatedIds?: MemoryRelation[];
    /** Human-like memory category: fact, goal, preference, open loop, etc. */
    memoryKind?: MemoryKind;
    /** How stable/entrenched the memory is. Retrieval and confirmations increase it. */
    strength?: number;
    /** How scene-like or emotionally vivid the memory is. */
    vividness?: number;
    /** How concrete the memory is: names, dates, places, numbers, evidence. */
    specificity?: number;
    /** ID эпизода разговора, из которого получен факт. */
    sourceEpisodeId?: string;
    /** Короткая цитата или фрагмент контекста, откуда извлечён факт. */
    sourceContext?: string;
    /** ID/ключи исходных сообщений, если доступны. */
    sourceMessageIds?: string[];
    /** ID исходных воспоминаний, из которых синтезирована эта запись. */
    sourceMemoryIds?: string[];
    /** Как факт попал в память: явная команда, quick extraction, delayed extraction и т.п. */
    extractionMethod?: MemoryExtractionMethod;
    /** О ком факт: пользователь, контакт, бот или системный объект. */
    subject?: MemorySubject;
    /** Структурированная часть утверждения: отношение/свойство. */
    predicate?: string;
    /** Структурированная часть утверждения: значение/объект. */
    object?: string;
    /** С какого момента утверждение считается актуальным. */
    validFrom?: Date;
    /** До какого момента утверждение считается актуальным. */
    validTo?: Date;
    /** Текущий статус факта во временной линии. */
    status?: MemoryStatus;
    /** Сколько раз факт подтверждался похожими утверждениями. */
    confirmationCount?: number;
    /** Когда факт последний раз подтверждался. */
    lastConfirmedAt?: Date;
}

export interface SearchOptions {
    domain?: string;
    limit?: number;
    minScore?: number;
    tags?: string[];
}

export interface SearchResult {
    id: string;
    content: string;
    score: number;
    timestamp: Date;
    importance: number;
    tags: string[];
    domain: string;
    confidence?: number;
    lastAccessedAt?: Date;
    retrievalCount?: number;
    lastRetrievedAt?: Date;
    retrievalCues?: string[];
    previousVersions?: Array<{
        content: string;
        timestamp: Date;
        confidence: number;
    }>;
    isAnchor?: boolean;
    expiresAt?: Date;
    relatedIds?: MemoryRelation[];
    memoryKind?: MemoryKind;
    strength?: number;
    vividness?: number;
    specificity?: number;
    emotionalTag?: EmotionalTag;
    sourceEpisodeId?: string;
    sourceContext?: string;
    sourceMessageIds?: string[];
    sourceMemoryIds?: string[];
    extractionMethod?: MemoryExtractionMethod;
    subject?: MemorySubject;
    predicate?: string;
    object?: string;
    validFrom?: Date;
    validTo?: Date;
    status?: MemoryStatus;
    confirmationCount?: number;
    lastConfirmedAt?: Date;
}

export interface MemoryStats {
    total: number;
    domains: Record<string, number>;
}

export interface DomainConfig {
    name: string;
    aliases: string[];
    description: string;
    keywords: string[];
    relatedDomains: string[];
    autoArchiveDays: number;
    maxMemories: number;
    importance: {
        userMessage: number;
        botMessage: number;
        emotional: number;
    };
    createdAt: Date;
    lastAccessed: Date;
    memoryCount: number;
    userId?: string;
    botId: string;
}

export interface SearchStrategy {
    primaryDomain: string;
    primaryLimit: number;
    relatedDomains: string[];
    relatedLimit: number;
    globalFallback: boolean;
    globalLimit: number;
    timeRange?: {
        from?: Date;
        to?: Date;
    };
}

export interface DomainStats {
    domain: string;
    count: number;
}

export interface DomainTrend {
    domain: string;
    dailyCounts: { date: string; count: number }[];
}

export interface DomainDetectionResult {
    primaryDomain: string;
    confidence: number;
    suggestedDomains: string[];
    isNewDomain: boolean;
    shouldSplitDomain?: string;
    shouldMergeDomains?: string[];
}
