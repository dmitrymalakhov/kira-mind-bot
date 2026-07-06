import type { Api } from "grammy";
import { randomUUID } from "crypto";
import { createJsonChatCompletionForTask } from "../ai/chatCompletion";
import { config } from "../config";
import { getSetting, setSetting } from "./botSettingsService";
import { initTelegramClient } from "./telegram";
import { getProactiveChatId } from "../utils/allowedUserChatStore";

const SETTING_KEY = "CHAT_PROMPT_WATCHERS";
const DEFAULT_COOLDOWN_MS = 15 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 60 * 1000;
const DEFAULT_FETCH_LIMIT = 100;
const MAX_BATCH_MESSAGES = 12;
const RECENT_CONTEXT_MESSAGES = 18;
const MIN_MATCH_CONFIDENCE = 0.55;
const MAX_IMAGE_ANALYSES_PER_POLL = 4;
const MAX_IMAGE_DOWNLOAD_BYTES = 8 * 1024 * 1024;
// Жёсткий лимит времени одного poll: если MTProto-вызов зависнет без таймаута,
// watchdog сбросит pollRunning, чтобы polling не остановился навсегда.
const POLL_STUCK_TIMEOUT_MS = 5 * 60 * 1000;

export interface ChatPromptWatcher {
    id: string;
    sourceChatId: string;
    sourceChatTitle?: string;
    targetChatId: string;
    targetChatTitle?: string;
    prompt: string;
    enabled: boolean;
    createdAt: string;
    updatedAt: string;
    lastMatchedAt?: string;
    lastNotificationSummary?: string;
    lastReadMessageId?: number;
}

export interface AddChatPromptWatcherInput {
    sourceChatId: string | number;
    sourceChatTitle?: string;
    targetChatId: string | number;
    targetChatTitle?: string;
    prompt: string;
}

export interface WatchedChatMessage {
    chatId: number;
    chatTitle: string;
    chatType: string;
    senderName: string;
    text: string;
    date: Date;
    messageId?: number;
    senderId?: number;
    isBot?: boolean;
}

interface WatchAnalysisResult {
    match?: boolean;
    shouldNotify?: boolean;
    confidence?: number;
    title?: string;
    summary?: string;
    facts?: string[];
    recommendedAction?: string;
    severity?: "low" | "medium" | "high";
    reason?: string;
}

interface WatchImageAnalysisResult {
    description?: string;
    detectedText?: string;
    relevantFacts?: string[];
}

let parsedCache: { raw: string; watchers: ChatPromptWatcher[] } | undefined;
const pollWatermarks = new Map<string, number>();
let pollTimer: NodeJS.Timeout | undefined;
let pollRunning = false;
let pollStartedAt = 0;

function readMsEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    const parsed = raw ? Number(raw) : NaN;
    return Number.isFinite(parsed) && parsed >= 1000 ? parsed : fallback;
}

function readNumberEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    const parsed = raw ? Number(raw) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function cooldownMs(): number {
    return readMsEnv("CHAT_PROMPT_WATCHER_COOLDOWN_MS", DEFAULT_COOLDOWN_MS);
}

function pollIntervalMs(): number {
    return readMsEnv("CHAT_PROMPT_WATCHER_POLL_INTERVAL_MS", DEFAULT_POLL_INTERVAL_MS);
}

function fetchLimit(): number {
    const parsed = readNumberEnv("CHAT_PROMPT_WATCHER_FETCH_LIMIT", DEFAULT_FETCH_LIMIT);
    return Math.max(10, Math.min(500, parsed));
}

function normalizeChatId(chatId: string | number): string {
    return String(chatId).trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeWatcher(value: unknown): ChatPromptWatcher | null {
    if (!isRecord(value)) return null;
    if (typeof value.id !== "string" || !value.id.trim()) return null;
    if (typeof value.sourceChatId !== "string" || !value.sourceChatId.trim()) return null;
    if (typeof value.targetChatId !== "string" || !value.targetChatId.trim()) return null;
    if (typeof value.prompt !== "string" || !value.prompt.trim()) return null;

    const now = new Date().toISOString();
    return {
        id: value.id.trim(),
        sourceChatId: value.sourceChatId.trim(),
        sourceChatTitle: typeof value.sourceChatTitle === "string" ? value.sourceChatTitle : undefined,
        targetChatId: value.targetChatId.trim(),
        targetChatTitle: typeof value.targetChatTitle === "string" ? value.targetChatTitle : undefined,
        prompt: value.prompt.trim(),
        enabled: typeof value.enabled === "boolean" ? value.enabled : true,
        createdAt: typeof value.createdAt === "string" ? value.createdAt : now,
        updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : now,
        lastMatchedAt: typeof value.lastMatchedAt === "string" ? value.lastMatchedAt : undefined,
        lastNotificationSummary: typeof value.lastNotificationSummary === "string" ? value.lastNotificationSummary : undefined,
        lastReadMessageId: typeof value.lastReadMessageId === "number" && Number.isFinite(value.lastReadMessageId)
            ? value.lastReadMessageId
            : undefined,
    };
}

async function loadWatchers(): Promise<ChatPromptWatcher[]> {
    const raw = await getSetting(SETTING_KEY, "[]");
    if (parsedCache?.raw === raw) return parsedCache.watchers;

    try {
        const parsed = JSON.parse(raw);
        const watchers = Array.isArray(parsed)
            ? parsed.map(normalizeWatcher).filter((item): item is ChatPromptWatcher => Boolean(item))
            : [];
        parsedCache = { raw, watchers };
        return watchers;
    } catch (error) {
        console.error("[chatPromptWatchers] failed to parse watcher settings:", error);
        parsedCache = { raw, watchers: [] };
        return [];
    }
}

async function saveWatchers(watchers: ChatPromptWatcher[]): Promise<void> {
    const raw = JSON.stringify(watchers);
    parsedCache = { raw, watchers };
    await setSetting(SETTING_KEY, raw);
}

function createWatcherId(existing: ChatPromptWatcher[]): string {
    for (let attempt = 0; attempt < 10; attempt += 1) {
        const id = randomUUID().replace(/-/g, "").slice(0, 8);
        if (!existing.some((watcher) => watcher.id === id)) return id;
    }
    return Date.now().toString(36);
}

function compactText(text: string, maxLength: number): string {
    const compact = text.replace(/\s+/g, " ").trim();
    if (compact.length <= maxLength) return compact;
    return `${compact.slice(0, Math.max(0, maxLength - 3))}...`;
}

function limitText(text: string, maxLength: number): string {
    const normalized = text
        .replace(/\r\n/g, "\n")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    if (normalized.length <= maxLength) return normalized;
    return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

export function errorToMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    try {
        return JSON.stringify(error);
    } catch {
        return String(error);
    }
}

/**
 * Временная ли ошибка отправки уведомления в целевой чат.
 * Временные → ретрай на следующем poll (watermark не двигаем).
 * Постоянные (Forbidden/chat not found/blocked) → продвигаем watermark и пишем lastMatchedAt,
 * иначе watcher зациклится на одной пачке с повторными LLM-вызовами и спамом.
 */
function isTransientDeliveryError(error: unknown): boolean {
    const text = errorToMessage(error).toLowerCase();
    if (text.includes("flood")) return true;
    if (text.includes("timeout") || text.includes("timed out")) return true;
    if (text.includes("etimedout") || text.includes("enotfound") || text.includes("econnreset")) return true;
    if (text.includes("network") || text.includes("temporarily") || text.includes("retry")) return true;
    if (text.includes("429") || text.includes("500") || text.includes("502") || text.includes("503") || text.includes("504")) return true;
    return false;
}

function messageSortKey(msg: WatchedChatMessage): number {
    const dateMs = msg.date instanceof Date ? msg.date.getTime() : new Date(msg.date).getTime();
    const safeDate = Number.isFinite(dateMs) ? dateMs : 0;
    return safeDate * 100000 + (msg.messageId ?? 0);
}

function formatMessageLine(message: WatchedChatMessage): string {
    const time = message.date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
    const botMarker = message.isBot ? " (бот)" : "";
    return `${time} [${message.senderName}${botMarker}]: ${compactText(message.text, 900)}`;
}

function formatMessages(messages: WatchedChatMessage[]): string {
    if (!messages.length) return "Нет сообщений.";
    return messages.map(formatMessageLine).join("\n");
}

function mediaClassName(message: any): string {
    return String(message.media?.className || message.media?._ || "");
}

function mediaDocumentMime(message: any): string {
    return String(message.media?.document?.mimeType || message.media?.document?.mime_type || message.document?.mimeType || "");
}

function imageMimeForDataUrl(message: any): string {
    const mime = mediaDocumentMime(message).toLowerCase();
    return mime.startsWith("image/") ? mime : "image/jpeg";
}

function mediaDocumentSize(message: any): number | undefined {
    const raw = message.media?.document?.size ?? message.document?.size;
    if (raw == null) return undefined;
    const size = typeof raw === "bigint" ? Number(raw) : Number(raw);
    return Number.isFinite(size) && size >= 0 ? size : undefined;
}

function isImageMessage(message: any): boolean {
    const className = mediaClassName(message);
    const mime = mediaDocumentMime(message);
    return className === "MessageMediaPhoto" ||
        Boolean(message.photo || message.media?.photo) ||
        mime.startsWith("image/");
}

function mediaTextPlaceholder(message: any): string {
    if (isImageMessage(message)) return "[Изображение]";
    const className = mediaClassName(message);
    if (!className) return "[Медиа]";
    return `[Медиа: ${className.replace(/^MessageMedia/, "")}]`;
}

function appendImageContext(text: string, analysis: WatchImageAnalysisResult | null): string {
    if (!analysis) return text;

    const parts: string[] = [];
    if (analysis.description?.trim()) {
        parts.push(`описание: ${compactText(analysis.description, 700)}`);
    }
    if (analysis.detectedText?.trim()) {
        parts.push(`текст на изображении: ${compactText(analysis.detectedText, 700)}`);
    }
    if (Array.isArray(analysis.relevantFacts) && analysis.relevantFacts.length) {
        const facts = analysis.relevantFacts
            .map((fact) => compactText(String(fact), 220))
            .filter(Boolean)
            .slice(0, 5)
            .join("; ");
        if (facts) parts.push(`факты: ${facts}`);
    }

    if (!parts.length) return text;
    const base = text.trim() || "[Изображение]";
    return `${base}\n[Анализ изображения: ${parts.join(" | ")}]`;
}

function isInCooldown(watcher: ChatPromptWatcher): boolean {
    if (!watcher.lastMatchedAt) return false;
    const last = new Date(watcher.lastMatchedAt).getTime();
    return Number.isFinite(last) && Date.now() - last < cooldownMs();
}

function severityLabel(severity: WatchAnalysisResult["severity"]): string {
    if (severity === "high") return "высокая";
    if (severity === "medium") return "средняя";
    if (severity === "low") return "низкая";
    return "не указана";
}

export function toTelegramChatId(chatId: string): number | string {
    const parsed = Number(chatId);
    return Number.isSafeInteger(parsed) ? parsed : chatId;
}

function buildNotificationText(
    watcher: ChatPromptWatcher,
    sourceTitle: string,
    result: WatchAnalysisResult,
): string {
    const title = compactText(result.title || "Есть совпадение с условием наблюдения", 180);
    const summary = compactText(result.summary || result.reason || "Модель обнаружила событие, которое соответствует заданному промпту.", 1500);
    const facts = Array.isArray(result.facts)
        ? result.facts.map((fact) => compactText(String(fact), 350)).filter(Boolean).slice(0, 8)
        : [];

    const lines = [
        "📡 Сработало наблюдение",
        "",
        `Источник: ${sourceTitle || watcher.sourceChatTitle || watcher.sourceChatId}`,
        `Запрос: ${compactText(watcher.prompt, 220)}`,
        `Важность: ${severityLabel(result.severity)}`,
        "",
        title,
        "",
        summary,
    ];

    if (facts.length) {
        lines.push("", "Фактура:");
        for (const fact of facts) {
            lines.push(`• ${fact}`);
        }
    }

    if (result.recommendedAction?.trim()) {
        lines.push("", "Что можно сделать:", compactText(result.recommendedAction, 450));
    }

    if (result.reason?.trim() && result.reason.trim() !== summary) {
        lines.push("", "Почему сработало:", compactText(result.reason, 450));
    }

    return limitText(lines.join("\n"), 3900);
}

async function deliverWatchNotification(api: Api, watcher: ChatPromptWatcher, notificationText: string): Promise<void> {
    const targetChatId = toTelegramChatId(watcher.targetChatId);

    try {
        await api.sendMessage(targetChatId, notificationText);
        return;
    } catch (targetError) {
        console.error(`[chatPromptWatchers] failed to send watcher ${watcher.id} notification to target:`, targetError);

        const ownerChatId = await getProactiveChatId();
        if (String(ownerChatId) === String(targetChatId)) {
            throw targetError;
        }

        const fallbackText = limitText([
            "📡 Сработало наблюдение, но целевой чат недоступен.",
            `Наблюдение: ${watcher.id}`,
            `Куда пыталась писать: ${watcher.targetChatTitle || watcher.targetChatId}`,
            `Ошибка отправки: ${compactText(errorToMessage(targetError), 450)}`,
            "",
            notificationText,
        ].join("\n"), 3900);

        await api.sendMessage(ownerChatId, fallbackText);
    }
}

async function analyzeWatcher(
    watcher: ChatPromptWatcher,
    batch: WatchedChatMessage[],
    recentContext: WatchedChatMessage[],
    sourceTitle: string,
): Promise<WatchAnalysisResult | null> {
    const lastNotification = watcher.lastMatchedAt
        ? `Последнее уведомление: ${watcher.lastMatchedAt}\n${watcher.lastNotificationSummary || ""}`
        : "Ранее уведомлений по этому наблюдателю не было.";

    return createJsonChatCompletionForTask<WatchAnalysisResult>("messageAnalysis", {
        messages: [
            {
                role: "system",
                content:
                    `${config.characterName} анализирует сообщения выбранного Telegram-чата по пользовательскому промпту.\n` +
                    `Твоя задача — решить, нужно ли отправить уведомление владельцу или в целевой чат.\n\n` +
                    `Срабатывай только когда новые сообщения явно соответствуют пользовательскому промпту. ` +
                    `Не срабатывай на общие разговоры, фоновые обсуждения, мемы, технические уведомления и слабые догадки. ` +
                    `Если ситуация похожа на уже отправленное уведомление и нет новых существенных фактов, верни match=false.\n\n` +
                    `Отвечай строго JSON без markdown:\n` +
                    `{"match":true|false,"confidence":0..1,"severity":"low|medium|high","title":"короткий заголовок","summary":"что происходит, 2-5 предложений","facts":["конкретный факт"],"recommendedAction":"что разумно сделать","reason":"почему это соответствует промпту"}\n\n` +
                    `facts должны быть фактурой из сообщений: кто что сказал, какие сроки/объекты/риски/проблемы названы. ` +
                    `Если совпадения нет, верни match=false и коротко объясни reason.`,
            },
            {
                role: "user",
                content: [
                    `Владелец: ${config.ownerName}`,
                    `Источник: ${sourceTitle} (${watcher.sourceChatId})`,
                    `Пользовательский промпт наблюдения: ${watcher.prompt}`,
                    "",
                    lastNotification,
                    "",
                    "Недавний контекст до новой пачки:",
                    formatMessages(recentContext),
                    "",
                    "Новые сообщения для проверки:",
                    formatMessages(batch),
                ].join("\n"),
            },
        ],
        temperature: 0.1,
        max_tokens: 900,
    });
}

async function updateWatcherAfterNotification(watcherId: string, summary: string): Promise<void> {
    const watchers = await loadWatchers();
    const now = new Date().toISOString();
    const updated = watchers.map((watcher) => {
        if (watcher.id !== watcherId) return watcher;
        return {
            ...watcher,
            updatedAt: now,
            lastMatchedAt: now,
            lastNotificationSummary: compactText(summary, 700),
        };
    });
    await saveWatchers(updated);
}

async function updateWatcherReadWatermark(watcherId: string, messageId: number): Promise<void> {
    if (!Number.isFinite(messageId) || messageId <= 0) return;

    const watchers = await loadWatchers();
    const now = new Date().toISOString();
    const updated = watchers.map((watcher) => {
        if (watcher.id !== watcherId) return watcher;
        return {
            ...watcher,
            updatedAt: now,
            lastReadMessageId: Math.max(watcher.lastReadMessageId ?? 0, messageId),
        };
    });
    await saveWatchers(updated);
}

async function processChatPromptWatchBatch(
    api: Api,
    watcher: ChatPromptWatcher,
    batch: WatchedChatMessage[],
    recentContext: WatchedChatMessage[],
    sourceTitle: string,
): Promise<boolean> {
    if (!watcher.enabled || isInCooldown(watcher)) return true;

    const checkedBatch = batch
        .slice()
        .sort((a, b) => messageSortKey(a) - messageSortKey(b))
        .slice(-MAX_BATCH_MESSAGES);
    if (!checkedBatch.length) return true;

    try {
        const result = await analyzeWatcher(watcher, checkedBatch, recentContext, sourceTitle);
        const isMatch = Boolean(result?.match ?? result?.shouldNotify);
        const confidence = typeof result?.confidence === "number" ? result.confidence : (isMatch ? 1 : 0);
        if (!result || !isMatch || confidence < MIN_MATCH_CONFIDENCE) return true;

        const notificationText = buildNotificationText(watcher, sourceTitle, result);
        try {
            await deliverWatchNotification(api, watcher, notificationText);
        } catch (deliveryError) {
            // Постоянная ошибка доставки (чат удалён/заблокирован/бот кикнут) —
            // не зацикливаемся на этой пачке: продвигаем watermark и ставим cooldown,
            // чтобы не дёргать LLM повторно и не плодить спам при восстановлении.
            if (isTransientDeliveryError(deliveryError)) throw deliveryError;
            console.warn(
                `[chatPromptWatchers] watcher ${watcher.id} target chat permanently unavailable, advancing watermark:`,
                deliveryError,
            );
            await updateWatcherAfterNotification(watcher.id, notificationText);
            return true;
        }
        await updateWatcherAfterNotification(watcher.id, notificationText);
        return true;
    } catch (error) {
        console.error(`[chatPromptWatchers] watcher ${watcher.id} failed:`, error);
        return false;
    }
}

async function analyzeWatchImage(
    imageBuffer: Buffer,
    mimeType: string,
    caption: string,
    sourceTitle: string,
): Promise<WatchImageAnalysisResult | null> {
    try {
        return await createJsonChatCompletionForTask<WatchImageAnalysisResult>("browserVision", {
            messages: [
                {
                    role: "system",
                    content:
                        "Ты анализируешь изображение из Telegram-чата для системы мониторинга по пользовательскому промпту. " +
                        "Нужно извлечь только фактический визуальный контекст: что изображено, какой текст виден, какие детали могут быть важны для понимания проблем, рисков, сроков, договорённостей или предмета обсуждения. " +
                        "Не делай выводов о срабатывании наблюдения, только опиши изображение. " +
                        "Отвечай строго JSON без markdown: " +
                        "{\"description\":\"краткое описание\",\"detectedText\":\"видимый текст, если есть\",\"relevantFacts\":[\"факт\"]}",
                },
                {
                    role: "user",
                    content: [
                        {
                            type: "text",
                            text: [
                                `Источник: ${sourceTitle}`,
                                caption ? `Подпись/текст сообщения: ${caption}` : "Подписи/текста у сообщения нет.",
                                "Проанализируй изображение для дальнейшего текстового анализа переписки.",
                            ].join("\n"),
                        },
                        {
                            type: "image_url",
                            image_url: {
                                url: `data:${mimeType};base64,${imageBuffer.toString("base64")}`,
                            },
                        },
                    ],
                } as any,
            ],
            temperature: 0.1,
            max_tokens: 550,
        });
    } catch (error) {
        console.error("[chatPromptWatchers] image analysis failed:", error);
        return null;
    }
}

async function downloadWatchImage(client: any, message: any): Promise<Buffer | null> {
    if (!isImageMessage(message)) return null;

    const declaredSize = mediaDocumentSize(message);
    if (declaredSize !== undefined && declaredSize > MAX_IMAGE_DOWNLOAD_BYTES) {
        console.warn("[chatPromptWatchers] skipped oversized image before download", {
            messageId: message.id,
            bytes: declaredSize,
        });
        return null;
    }

    try {
        const downloaded = await client.downloadMedia(message, {});
        if (!Buffer.isBuffer(downloaded)) return null;
        if (downloaded.length > MAX_IMAGE_DOWNLOAD_BYTES) {
            console.warn("[chatPromptWatchers] skipped oversized image", {
                messageId: message.id,
                bytes: downloaded.length,
            });
            return null;
        }
        return downloaded;
    } catch (error) {
        console.error("[chatPromptWatchers] image download failed:", error);
        return null;
    }
}

async function enrichNewMessagesWithImageContext(
    client: any,
    sourceTitle: string,
    newMessages: WatchedChatMessage[],
    rawMessagesById: Map<number, any>,
): Promise<WatchedChatMessage[]> {
    let analyzedCount = 0;
    const enriched: WatchedChatMessage[] = [];

    for (const message of newMessages) {
        const raw = message.messageId != null ? rawMessagesById.get(message.messageId) : undefined;
        if (!raw || !isImageMessage(raw) || analyzedCount >= MAX_IMAGE_ANALYSES_PER_POLL) {
            enriched.push(message);
            continue;
        }

        analyzedCount += 1;
        const image = await downloadWatchImage(client, raw);
        if (!image) {
            enriched.push(message);
            continue;
        }

        const analysis = await analyzeWatchImage(image, imageMimeForDataUrl(raw), message.text, sourceTitle);
        enriched.push({
            ...message,
            text: appendImageContext(message.text, analysis),
        });
    }

    return enriched;
}

function telegramMessageDate(message: any): Date {
    if (message.date instanceof Date) return message.date;
    if (typeof message.date === "number") return new Date(message.date * 1000);
    const parsed = new Date(message.date);
    return Number.isFinite(parsed.getTime()) ? parsed : new Date();
}

function telegramSenderName(message: any): string {
    const sender = message.sender || {};
    const parts = [sender.firstName || sender.first_name, sender.lastName || sender.last_name]
        .map((part) => String(part || "").trim())
        .filter(Boolean);
    return parts.join(" ") || sender.title || sender.username || "Неизвестный";
}

function toWatchedMessage(sourceChatId: string, sourceTitle: string, sourceType: string | undefined, message: any): WatchedChatMessage | null {
    const rawText = typeof message.message === "string" ? message.message.trim() : "";
    const text = rawText || (message.media ? mediaTextPlaceholder(message) : "");
    if (!text || message.id == null) return null;

    const chatId = Number(sourceChatId);
    if (!Number.isSafeInteger(chatId)) return null;

    return {
        chatId,
        chatTitle: sourceTitle,
        chatType: sourceType || "telegram",
        senderName: telegramSenderName(message),
        text,
        date: telegramMessageDate(message),
        messageId: Number(message.id),
        senderId: message.senderId != null ? Number(message.senderId) : undefined,
        isBot: Boolean(message.sender?.bot),
    };
}

async function fetchSourceMessages(client: any, sourceChatId: string, sinceMessageId?: number): Promise<any[]> {
    const peer = Number(sourceChatId);
    if (!Number.isSafeInteger(peer)) return [];

    const params = sinceMessageId && sinceMessageId > 0
        ? { limit: fetchLimit(), minId: sinceMessageId, reverse: true }
        : { limit: Math.min(30, fetchLimit()) };
    const messages = await (client as any).getMessages(peer, params);
    return Array.isArray(messages) ? messages : [];
}

function initialMessagesSinceWatcherCreation(watcher: ChatPromptWatcher, messages: WatchedChatMessage[]): WatchedChatMessage[] {
    const createdAt = new Date(watcher.createdAt).getTime();
    if (!Number.isFinite(createdAt)) return [];
    return messages.filter((message) => message.date.getTime() >= createdAt);
}

async function pollChatPromptWatchersOnce(api: Api): Promise<void> {
    const watchers = (await loadWatchers()).filter((watcher) => watcher.enabled);
    if (!watchers.length) return;

    // preloadContacts: false — лишний MTProto-вызов на каждом poll не нужен.
    // Тот же паттерн используют chatGroupTracker и personalChatMemoryIndexer.
    const client = await initTelegramClient({ preloadContacts: false });
    if (!client) return;

    const messagesBySource = new Map<string, WatchedChatMessage[]>();
    const rawMessagesBySource = new Map<string, Map<number, any>>();
    const sourceSinceMessageId = new Map<string, number | undefined>();
    for (const watcher of watchers) {
        const prevId = watcher.lastReadMessageId ?? pollWatermarks.get(watcher.id);
        if (prevId == null) {
            sourceSinceMessageId.set(watcher.sourceChatId, undefined);
            continue;
        }
        const current = sourceSinceMessageId.get(watcher.sourceChatId);
        if (current !== undefined) {
            sourceSinceMessageId.set(watcher.sourceChatId, Math.min(current, prevId));
        } else if (!sourceSinceMessageId.has(watcher.sourceChatId)) {
            sourceSinceMessageId.set(watcher.sourceChatId, prevId);
        }
    }

    for (const watcher of watchers) {
        const sourceTitle = watcher.sourceChatTitle || watcher.sourceChatId;
        const prevId = watcher.lastReadMessageId ?? pollWatermarks.get(watcher.id);
        if (!messagesBySource.has(watcher.sourceChatId)) {
            try {
                const rawMessages = await fetchSourceMessages(
                    client,
                    watcher.sourceChatId,
                    sourceSinceMessageId.get(watcher.sourceChatId),
                );
                rawMessagesBySource.set(
                    watcher.sourceChatId,
                    new Map(rawMessages
                        .filter((message) => message.id != null)
                        .map((message) => [Number(message.id), message])),
                );
                const parsedMessages = rawMessages
                    .map((message) => toWatchedMessage(watcher.sourceChatId, sourceTitle, undefined, message))
                    .filter((message): message is WatchedChatMessage => Boolean(message))
                    .sort((a, b) => (a.messageId ?? 0) - (b.messageId ?? 0));
                messagesBySource.set(watcher.sourceChatId, parsedMessages);
            } catch (error) {
                console.error(`[chatPromptWatchers] failed to fetch source ${watcher.sourceChatId}:`, error);
                messagesBySource.set(watcher.sourceChatId, []);
            }
        }

        const messages = messagesBySource.get(watcher.sourceChatId) ?? [];
        if (!messages.length) continue;

        const latestId = messages[messages.length - 1].messageId ?? 0;
        const newMessages = prevId == null
            ? initialMessagesSinceWatcherCreation(watcher, messages)
            : messages.filter((message) => (message.messageId ?? 0) > prevId);

        if (!newMessages.length) {
            pollWatermarks.set(watcher.id, latestId);
            await updateWatcherReadWatermark(watcher.id, latestId);
            continue;
        }

        const enrichedNewMessages = await enrichNewMessagesWithImageContext(
            client,
            watcher.sourceChatTitle || watcher.sourceChatId,
            newMessages,
            rawMessagesBySource.get(watcher.sourceChatId) ?? new Map(),
        );

        const firstNewId = enrichedNewMessages[0].messageId ?? latestId;
        const recentContext = messages
            .filter((message) => (message.messageId ?? 0) < firstNewId)
            .slice(-RECENT_CONTEXT_MESSAGES);

        const shouldAdvanceWatermark = await processChatPromptWatchBatch(
            api,
            watcher,
            enrichedNewMessages,
            recentContext,
            watcher.sourceChatTitle || watcher.sourceChatId,
        );
        if (!shouldAdvanceWatermark) continue;

        pollWatermarks.set(watcher.id, latestId);
        await updateWatcherReadWatermark(watcher.id, latestId);
    }
}

function scheduleNextPoll(api: Api): void {
    pollTimer = setTimeout(async () => {
        if (pollRunning) {
            // Watchdog: если предыдущий poll идёт дольше POLL_STUCK_TIMEOUT_MS
            // (например, MTProto-вызов завис без таймаута), принудительно сбрасываем
            // флаг, чтобы polling продолжился, а не остановился навсегда.
            const stuckFor = Date.now() - pollStartedAt;
            if (pollStartedAt && stuckFor > POLL_STUCK_TIMEOUT_MS) {
                console.error(
                    `[chatPromptWatchers] poll stuck for ${Math.round(stuckFor / 1000)}s, force-resetting pollRunning`,
                );
                pollRunning = false;
            }
        }
        if (!pollRunning) {
            pollRunning = true;
            pollStartedAt = Date.now();
            try {
                await pollChatPromptWatchersOnce(api);
            } catch (error) {
                console.error("[chatPromptWatchers] poll error:", error);
            } finally {
                pollRunning = false;
                pollStartedAt = 0;
            }
        }
        scheduleNextPoll(api);
    }, pollIntervalMs());
}

export function startChatPromptWatchPolling(api: Api): void {
    if (pollTimer) clearTimeout(pollTimer);
    scheduleNextPoll(api);
    console.info("[chatPromptWatchers] started, polling Telegram sources");
}

export async function listChatPromptWatchers(): Promise<ChatPromptWatcher[]> {
    return loadWatchers();
}

export async function addChatPromptWatcher(input: AddChatPromptWatcherInput): Promise<ChatPromptWatcher> {
    const watchers = await loadWatchers();
    const now = new Date().toISOString();
    const watcher: ChatPromptWatcher = {
        id: createWatcherId(watchers),
        sourceChatId: normalizeChatId(input.sourceChatId),
        sourceChatTitle: input.sourceChatTitle?.trim() || undefined,
        targetChatId: normalizeChatId(input.targetChatId),
        targetChatTitle: input.targetChatTitle?.trim() || undefined,
        prompt: input.prompt.trim(),
        enabled: true,
        createdAt: now,
        updatedAt: now,
        lastReadMessageId: undefined,
    };

    await saveWatchers([...watchers, watcher]);
    return watcher;
}

export async function removeChatPromptWatcher(id: string): Promise<boolean> {
    const normalizedId = id.trim();
    const watchers = await loadWatchers();
    const updated = watchers.filter((watcher) => watcher.id !== normalizedId);
    if (updated.length === watchers.length) return false;
    pollWatermarks.delete(normalizedId);
    await saveWatchers(updated);
    return true;
}

export async function setChatPromptWatcherEnabled(id: string, enabled: boolean): Promise<ChatPromptWatcher | null> {
    const normalizedId = id.trim();
    const watchers = await loadWatchers();
    let changed: ChatPromptWatcher | null = null;
    const now = new Date().toISOString();
    const updated = watchers.map((watcher) => {
        if (watcher.id !== normalizedId) return watcher;
        changed = { ...watcher, enabled, updatedAt: now };
        return changed;
    });
    if (!changed) return null;
    await saveWatchers(updated);
    return changed;
}
