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
    lastFactAnalysisIndex?: number; // Индекс последнего анализа фактов
    /** Ошибка сохранения факта в векторную БД — показываем пользователю после ответа */
    lastFactSaveError?: string;
    /** Unix-timestamp последней проактивной подсказки из памяти (для cooldown) */
    lastProactiveHintAt?: number;
    /** Unix-timestamp последнего вопроса о пробеле в памяти (для cooldown) */
    lastMemoryGapAt?: number;
    /** chatId группового чата, напоминания которого просматриваются из приватного чата */
    viewingRemindersInChat?: number;
    /** Состояние сценария «изучить переписку и сохранить факты обо мне»: выбор периода */
    studyChatRequest?: {
        contactName: string;
        contactId: number;
        step: 'period';
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
                dueDate: Date;
                targetChat?: { type: "group"; groupName: string } | { type: "contact"; contactQuery: string };
            };
            reminderDetailsList?: {
                id: string;
                text: string;
                reminderMessage?: string;
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
    relatedIds?: Array<{ id: string; domain: string }>;
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
    previousVersions?: Array<{
        content: string;
        timestamp: Date;
        confidence: number;
    }>;
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

