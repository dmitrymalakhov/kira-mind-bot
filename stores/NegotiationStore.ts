import { InlineKeyboard } from "grammy";
import { devLog } from "../utils";

export interface NegotiationMessage {
    role: "bot" | "contact" | "user";
    text: string;
    at?: Date;
}

export interface NegotiationSession {
    contactId: number;
    contactName: string;
    originalChatId: number;
    taskDescription: string;
    history: NegotiationMessage[];
    createdAt: Date;
    /** Когда контакт написал и бот не смог ответить сам — ждём ответа пользователя в чате с ботом */
    waitingForUserReply?: boolean;
    /** ID последнего отправленного нами сообщения контакту (для трекинга ответов) */
    lastSentMessageId?: number;
    /** Сообщение в чате с пользователем, которое обновляется по ходу переговоров */
    summaryChatId?: number;
    summaryMessageId?: number;
}

const MAX_SUMMARY_LENGTH = 4000;

/** Собирает текст сводки переговоров для отображения в чате с пользователем */
export function buildNegotiationSummaryText(
    session: NegotiationSession,
    options?: { appendWaiting?: string }
): string {
    const lines: string[] = [
        `📩 Переговоры с ${session.contactName}`,
        `Задача: ${session.taskDescription}`,
        "",
    ];
    for (const h of session.history) {
        const label = h.role === "bot" ? "Мы" : h.role === "contact" ? "Контакт" : "Ты";
        lines.push(`**${label}:** ${h.text}`);
        lines.push("");
    }
    if (options?.appendWaiting) {
        lines.push(options.appendWaiting);
    }
    const text = lines.join("\n").replace(/\*\*/g, "");
    return text.length > MAX_SUMMARY_LENGTH ? text.slice(0, MAX_SUMMARY_LENGTH - 3) + "…" : text;
}

/** Клавиатура под сводкой переговоров */
export function buildNegotiationStopKeyboard(): InlineKeyboard {
    return new InlineKeyboard().text("🛑 Завершить переговоры", "negotiation_stop");
}

/** Клавиатура для подтверждения старта переговоров */
export function buildNegotiationStartKeyboard(): InlineKeyboard {
    return new InlineKeyboard().text("▶️ Начать переговоры", "negotiation_start");
}

/** Данные для отложенного старта переговоров (до нажатия кнопки пользователем) */
export interface PendingNegotiationStart {
    contactId: number;
    contactName: string;
    taskDescription: string;
    firstMessageText: string;
}

type SessionKey = string;

/**
 * Хранилище активных сессий переговоров от имени пользователя.
 * Ключ: originalChatId:contactId (чат с ботом + контакт в Telegram).
 */
class NegotiationStoreClass {
    private sessions = new Map<SessionKey, NegotiationSession>();
    /** Ожидающие подтверждения пользователя перед стартом переговоров (ключ: chatId) */
    private pendingStarts = new Map<number, PendingNegotiationStart>();
    /** Колбэк для отправки сообщения пользователю в чат с ботом (чтобы спросить «что ответить?») */
    private notifyInBotChat: ((chatId: number, text: string) => Promise<void>) | null = null;
    /** Колбэк для редактирования сводного сообщения переговоров */
    private editSummaryCb: ((
        chatId: number,
        messageId: number,
        text: string,
        replyMarkup?: InlineKeyboard
    ) => Promise<void>) | null = null;

    static key(originalChatId: number, contactId: number): SessionKey {
        return `${originalChatId}:${contactId}`;
    }

    setNotifyInBotChat(fn: (chatId: number, text: string) => Promise<void>): void {
        this.notifyInBotChat = fn;
    }

    setEditSummaryCallback(
        fn: (
            chatId: number,
            messageId: number,
            text: string,
            replyMarkup?: InlineKeyboard
        ) => Promise<void>
    ): void {
        this.editSummaryCb = fn;
    }

    async editSummary(
        chatId: number,
        messageId: number,
        text: string,
        replyMarkup?: InlineKeyboard
    ): Promise<void> {
        if (this.editSummaryCb) await this.editSummaryCb(chatId, messageId, text, replyMarkup);
    }

    async notifyUser(originalChatId: number, text: string): Promise<void> {
        if (this.notifyInBotChat) {
            await this.notifyInBotChat(originalChatId, text);
        } else {
            devLog("NegotiationStore: notifyInBotChat not set, cannot ask user");
        }
    }

    set(session: NegotiationSession): void {
        const key = NegotiationStoreClass.key(session.originalChatId, session.contactId);
        this.sessions.set(key, session);
        devLog("NegotiationStore: session set", key);
    }

    get(originalChatId: number, contactId: number): NegotiationSession | undefined {
        return this.sessions.get(NegotiationStoreClass.key(originalChatId, contactId));
    }

    /** Сессия, для которой ждём ответ пользователя (написать контакту) */
    getByChatId(originalChatId: number): NegotiationSession | undefined {
        for (const s of this.sessions.values()) {
            if (s.originalChatId === originalChatId && s.waitingForUserReply) return s;
        }
        return undefined;
    }

    /** Любая активная сессия переговоров в этом чате (для кнопки «Завершить») */
    getActiveSessionByChatId(chatId: number): NegotiationSession | undefined {
        for (const s of this.sessions.values()) {
            if (s.originalChatId === chatId) return s;
        }
        return undefined;
    }

    update(originalChatId: number, contactId: number, update: Partial<NegotiationSession>): void {
        const key = NegotiationStoreClass.key(originalChatId, contactId);
        const existing = this.sessions.get(key);
        if (existing) {
            Object.assign(existing, update);
        }
    }

    delete(originalChatId: number, contactId: number): boolean {
        const key = NegotiationStoreClass.key(originalChatId, contactId);
        const ok = this.sessions.delete(key);
        if (ok) devLog("NegotiationStore: session deleted", key);
        return ok;
    }

    closeSessionByChatId(originalChatId: number): boolean {
        const s = this.getByChatId(originalChatId);
        if (s) return this.delete(s.originalChatId, s.contactId);
        return false;
    }

    setPendingStart(chatId: number, data: PendingNegotiationStart): void {
        this.pendingStarts.set(chatId, data);
        devLog("NegotiationStore: pending start set", chatId);
    }

    getPendingStart(chatId: number): PendingNegotiationStart | undefined {
        return this.pendingStarts.get(chatId);
    }

    clearPendingStart(chatId: number): boolean {
        const ok = this.pendingStarts.delete(chatId);
        if (ok) devLog("NegotiationStore: pending start cleared", chatId);
        return ok;
    }
}

export const NegotiationStore = new NegotiationStoreClass();
