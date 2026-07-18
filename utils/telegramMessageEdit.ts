import type { InlineKeyboardMarkup } from "grammy/types";

export interface TelegramCallbackMessageLike {
    message_id: number;
    chat: { id: number | string };
    reply_markup?: InlineKeyboardMarkup;
}

interface TelegramMarkupApiLike {
    editMessageReplyMarkup(
        chatId: number | string,
        messageId: number,
        options: { reply_markup: InlineKeyboardMarkup }
    ): Promise<unknown>;
}

interface TelegramTextApiLike {
    editMessageText(
        chatId: number | string,
        messageId: number,
        text: string,
        options?: Record<string, unknown>,
    ): Promise<unknown>;
}

interface PendingMarkupEdit {
    pending: number;
    currentFingerprint: string;
    appliedTransitions: Set<string>;
}

interface KnownMarkupState {
    currentFingerprint: string;
    appliedTransitions: Set<string>;
    expiresAt: number;
}

interface PendingMessageEdit {
    pending: number;
    currentFingerprint?: string;
}

interface MessageEditQueue {
    tail: Promise<void>;
    pending: number;
}

interface KnownMessageEditState {
    currentFingerprint: string;
    expiresAt: number;
}

const pendingMarkupEdits = new Map<string, PendingMarkupEdit>();
const knownMarkupStates = new Map<string, KnownMarkupState>();
const pendingMessageEdits = new Map<string, PendingMessageEdit>();
const knownMessageEditStates = new Map<string, KnownMessageEditState>();
const messageEditQueues = new Map<string, MessageEditQueue>();
const KNOWN_MARKUP_STATE_TTL_MS = 5 * 60_000;

function markupFingerprint(markup: InlineKeyboardMarkup | undefined): string {
    return JSON.stringify(canonicalize(markup?.inline_keyboard ?? []));
}

function canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(canonicalize);
    }
    if (value && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
                .filter(([, entryValue]) => entryValue !== undefined)
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([key, entryValue]) => [key, canonicalize(entryValue)]),
        );
    }
    return value;
}

export function stableTelegramStateFingerprint(value: unknown): string {
    return JSON.stringify(canonicalize(value));
}

function messageKey(chatId: number | string, messageId: number): string {
    return `${chatId}:${messageId}`;
}

/** Фиксирует клавиатуру после успешного editMessageText/editStructured. */
export function recordReplyMarkupState(
    chatId: number | string,
    messageId: number,
    replyMarkup: InlineKeyboardMarkup,
    previousReplyMarkup?: InlineKeyboardMarkup,
): void {
    const key = messageKey(chatId, messageId);
    const currentFingerprint = markupFingerprint(replyMarkup);
    const previous = knownMarkupStates.get(key);
    const pending = pendingMarkupEdits.get(key);
    const appliedTransitions = new Set(pending?.appliedTransitions ?? previous?.appliedTransitions ?? []);
    const previousFingerprint = previousReplyMarkup !== undefined
        ? markupFingerprint(previousReplyMarkup)
        : pending?.currentFingerprint ?? previous?.currentFingerprint;
    if (previousFingerprint !== undefined && previousFingerprint !== currentFingerprint) {
        appliedTransitions.add(transitionKey(previousFingerprint, currentFingerprint));
    }
    storeKnownMarkupState(key, currentFingerprint, appliedTransitions);
    if (pending) {
        pending.currentFingerprint = currentFingerprint;
        pending.appliedTransitions = new Set(appliedTransitions);
    }
    invalidateMessageEditState(chatId, messageId);
}

async function runSerializedMessageEdit<T>(key: string, operation: () => Promise<T>): Promise<T> {
    let queue = messageEditQueues.get(key);
    if (!queue) {
        queue = { tail: Promise.resolve(), pending: 0 };
        messageEditQueues.set(key, queue);
    }

    queue.pending += 1;
    let result!: T;
    const scheduled = queue.tail.then(async () => {
        result = await operation();
    });
    queue.tail = scheduled.then(() => undefined, () => undefined);

    try {
        await scheduled;
        return result;
    } finally {
        queue.pending -= 1;
        if (queue.pending === 0 && messageEditQueues.get(key) === queue) {
            messageEditQueues.delete(key);
        }
    }
}

function storeKnownMarkupState(
    key: string,
    currentFingerprint: string,
    appliedTransitions: Set<string>,
): void {
    const state: KnownMarkupState = {
        currentFingerprint,
        appliedTransitions: new Set(appliedTransitions),
        expiresAt: Date.now() + KNOWN_MARKUP_STATE_TTL_MS,
    };
    knownMarkupStates.set(key, state);
    const cleanupTimer = setTimeout(() => {
        if (knownMarkupStates.get(key) === state) {
            knownMarkupStates.delete(key);
        }
    }, KNOWN_MARKUP_STATE_TTL_MS);
    cleanupTimer.unref?.();
}

function transitionKey(sourceFingerprint: string, targetFingerprint: string): string {
    return `${sourceFingerprint}\u0000${targetFingerprint}`;
}

/**
 * Идемпотентно обновляет inline-клавиатуру callback-сообщения.
 *
 * Одинаковое состояние не отправляется в Telegram, а конкурентные изменения
 * одного сообщения выполняются последовательно. Ошибки API намеренно не
 * перехватываются: вызывающий код должен увидеть реальный сбой.
 */
export async function editReplyMarkupIfChanged(
    api: TelegramMarkupApiLike,
    message: TelegramCallbackMessageLike,
    replyMarkup: InlineKeyboardMarkup,
): Promise<boolean> {
    const key = messageKey(message.chat.id, message.message_id);
    const desiredFingerprint = markupFingerprint(replyMarkup);
    const observedFingerprint = markupFingerprint(message.reply_markup);
    let entry = pendingMarkupEdits.get(key);

    if (!entry) {
        const known = knownMarkupStates.get(key);
        if (known && known.expiresAt <= Date.now()) {
            knownMarkupStates.delete(key);
        }
        const activeKnown = known && known.expiresAt > Date.now() ? known : undefined;
        entry = {
            pending: 0,
            currentFingerprint: activeKnown?.currentFingerprint ?? observedFingerprint,
            appliedTransitions: new Set(activeKnown?.appliedTransitions ?? []),
        };
        pendingMarkupEdits.set(key, entry);
    }

    entry.pending += 1;
    const operation = runSerializedMessageEdit(key, async () => {
        if (entry!.currentFingerprint === desiredFingerprint) {
            return false;
        }

        const requestedTransition = transitionKey(observedFingerprint, desiredFingerprint);
        if (observedFingerprint !== entry!.currentFingerprint && entry!.appliedTransitions.has(requestedTransition)) {
            return false;
        }

        if (observedFingerprint !== entry!.currentFingerprint && !entry!.appliedTransitions.has(requestedTransition)) {
            entry!.currentFingerprint = observedFingerprint;
            entry!.appliedTransitions.clear();
        }

        const previousFingerprint = entry!.currentFingerprint;
        await api.editMessageReplyMarkup(message.chat.id, message.message_id, {
            reply_markup: replyMarkup,
        });
        entry!.appliedTransitions.add(transitionKey(previousFingerprint, desiredFingerprint));
        storeKnownMarkupState(key, desiredFingerprint, entry!.appliedTransitions);
        invalidateMessageEditState(message.chat.id, message.message_id);
        entry!.currentFingerprint = desiredFingerprint;
        return true;
    });

    try {
        return await operation;
    } finally {
        entry.pending -= 1;
        if (entry.pending === 0 && pendingMarkupEdits.get(key) === entry) {
            pendingMarkupEdits.delete(key);
        }
    }
}


/**
 * Сериализует полное редактирование сообщения и пропускает уже применённое
 * состояние содержимого + клавиатуры.
 */
export async function runMessageEditIfChanged(
    chatId: number | string,
    messageId: number,
    desiredFingerprint: string,
    edit: () => Promise<unknown>,
): Promise<unknown> {
    const key = messageKey(chatId, messageId);
    let entry = pendingMessageEdits.get(key);
    if (!entry) {
        const known = knownMessageEditStates.get(key);
        if (known && known.expiresAt <= Date.now()) {
            knownMessageEditStates.delete(key);
        }
        entry = {
            pending: 0,
            currentFingerprint: known && known.expiresAt > Date.now() ? known.currentFingerprint : undefined,
        };
        pendingMessageEdits.set(key, entry);
    }

    entry.pending += 1;
    const operation = runSerializedMessageEdit(key, async () => {
        if (entry!.currentFingerprint === desiredFingerprint) {
            return;
        }
        const result = await edit();
        entry!.currentFingerprint = desiredFingerprint;
        storeKnownMessageEditState(key, desiredFingerprint);
        return result;
    });

    try {
        return await operation;
    } finally {
        entry.pending -= 1;
        if (entry.pending === 0 && pendingMessageEdits.get(key) === entry) {
            pendingMessageEdits.delete(key);
        }
    }
}

function storeKnownMessageEditState(key: string, currentFingerprint: string): void {
    const state: KnownMessageEditState = {
        currentFingerprint,
        expiresAt: Date.now() + KNOWN_MARKUP_STATE_TTL_MS,
    };
    knownMessageEditStates.set(key, state);
    const cleanupTimer = setTimeout(() => {
        if (knownMessageEditStates.get(key) === state) {
            knownMessageEditStates.delete(key);
        }
    }, KNOWN_MARKUP_STATE_TTL_MS);
    cleanupTimer.unref?.();
}

export function invalidateMessageEditState(chatId: number | string, messageId: number): void {
    const key = messageKey(chatId, messageId);
    knownMessageEditStates.delete(key);
    const pending = pendingMessageEdits.get(key);
    if (pending) pending.currentFingerprint = undefined;
}

/** Атомарно и идемпотентно меняет plain-text и клавиатуру сообщения. */
export async function editMessageTextIfChanged(
    api: TelegramTextApiLike,
    chatId: number | string,
    messageId: number,
    text: string,
    options: Record<string, unknown> = {},
    previousReplyMarkup?: InlineKeyboardMarkup,
): Promise<unknown> {
    const desiredFingerprint = stableTelegramStateFingerprint({
        kind: "plain-text",
        text,
        options,
    });
    return runMessageEditIfChanged(chatId, messageId, desiredFingerprint, async () => {
        const result = await api.editMessageText(chatId, messageId, text, options);
        const replyMarkup = options.reply_markup;
        if (replyMarkup && typeof replyMarkup === "object" && "inline_keyboard" in replyMarkup) {
            recordReplyMarkupState(
                chatId,
                messageId,
                replyMarkup as InlineKeyboardMarkup,
                previousReplyMarkup,
            );
        } else {
            invalidateMessageEditState(chatId, messageId);
        }
        return result;
    });
}

/**
 * Выполняет необязательное обновление Telegram UI, явно логируя реальную
 * ошибку и не прерывая уже принятое бизнес-действие.
 */
export async function runNonCriticalTelegramEdit(
    operation: string,
    edit: () => Promise<unknown>,
): Promise<boolean> {
    try {
        await edit();
        return true;
    } catch (error) {
        console.error(`[telegram-edit] ${operation} failed:`, error);
        return false;
    }
}
