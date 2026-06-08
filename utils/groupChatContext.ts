import { BotContext } from "../types";
import { GroupChatMessage, RecentGroupMessagesOptions, getRecentGroupMessages } from "../stores/GroupChatBuffer";
import { GroupChatMessageRepository } from "../services/GroupChatMessageRepository";

export type GroupChatTriggerReason = "mention" | "reply_to_bot" | "reply";

export interface GroupReplyContext {
    senderName: string;
    text: string;
    messageId?: number;
    isBot?: boolean;
}

export interface GroupChatContextSnapshot {
    isGroupChat: boolean;
    isContextDependent: boolean;
    currentSenderName: string;
    replyContext?: GroupReplyContext;
    recentMessages: GroupChatMessage[];
    triggerReasons: GroupChatTriggerReason[];
    promptBlock: string;
    systemHint: string;
    debugSummary: string;
}

export interface BuildGroupChatContextOptions {
    limit?: number;
    triggerReasons?: GroupChatTriggerReason[];
    botUsername?: string;
    enabled?: boolean;
}

const DEFAULT_RECENT_LIMIT = 15;

const CONTEXT_DEPENDENT_RE =
    /(?:^|[\s,.!?;:])(?:а\s+)?(?:ты\s+)?(?:что\s+(?:думаешь|скажешь)|как\s+(?:тебе|считаешь)|согласн[аы]?|тво[её]\s+мнение|есть\s+мнение|прокомментируй|оцени|норм(?:ально)?|ок(?:ей)?)(?=$|[\s,.!?;:])/iu;
const SHORT_REFERENCE_RE =
    /(?:^|[\s,.!?;:])(?:это|так|тут|там|с\s+этим|по\s+этому|насч[её]т\s+этого|вот\s+это|к\s+этому|про\s+это)(?=$|[\s,.!?;:])/iu;

function compactText(text: string, maxLen = 700): string {
    const compact = text.replace(/\s+/g, " ").trim();
    return compact.length > maxLen ? `${compact.slice(0, maxLen)}...` : compact;
}

function stripTelegramMentions(text: string): string {
    return text.replace(/@[a-zA-Z0-9_]{3,32}/g, "").replace(/\s+/g, " ").trim();
}

function displayName(user: any): string {
    return user?.first_name || user?.username || user?.last_name || "Участник";
}

function messageText(message: any, sentMessages?: Record<number, string>): string {
    if (!message) return "";
    if (typeof message.text === "string" && message.text.trim()) return message.text.trim();
    if (typeof message.caption === "string" && message.caption.trim()) {
        return `[Медиа с подписью: "${message.caption.trim()}"]`;
    }
    if (message.voice) {
        const knownVoiceText = sentMessages?.[message.message_id];
        return knownVoiceText ? `[Голосовое сообщение: "${knownVoiceText}"]` : "[Голосовое сообщение]";
    }
    if (message.photo) return "[Изображение]";
    if (message.document) return `[Документ: ${message.document.file_name || "документ"}]`;
    return "[Сообщение]";
}

function formatRecentLine(msg: GroupChatMessage): string {
    const botMarker = msg.isBot ? " (бот)" : "";
    return `[${msg.senderName}${botMarker}]: ${compactText(msg.text)}`;
}

function formatTriggerReasons(reasons: GroupChatTriggerReason[]): string {
    if (reasons.length === 0) return "явное обращение";
    const labels: Record<GroupChatTriggerReason, string> = {
        mention: "упоминание бота",
        reply_to_bot: "ответ на сообщение бота",
        reply: "reply на сообщение в чате",
    };
    return reasons.map(reason => labels[reason]).join(", ");
}

function messageSortKey(msg: GroupChatMessage): number {
    const dateMs = msg.date instanceof Date ? msg.date.getTime() : new Date(msg.date).getTime();
    const safeDate = Number.isFinite(dateMs) ? dateMs : 0;
    return safeDate * 100000 + (msg.messageId ?? 0);
}

function mergeRecentMessages(
    memoryMessages: GroupChatMessage[],
    persistedMessages: GroupChatMessage[],
    limit: number,
): GroupChatMessage[] {
    const byKey = new Map<string, GroupChatMessage>();
    for (const msg of [...persistedMessages, ...memoryMessages]) {
        const key = msg.messageId != null
            ? `id:${msg.messageId}`
            : `text:${msg.senderName}:${msg.date instanceof Date ? msg.date.getTime() : new Date(msg.date).getTime()}:${msg.text}`;
        byKey.set(key, msg);
    }
    return [...byKey.values()]
        .sort((a, b) => messageSortKey(a) - messageSortKey(b))
        .slice(-limit);
}

async function getRecentMessagesWithPersistence(
    chatId: number,
    options: RecentGroupMessagesOptions,
): Promise<GroupChatMessage[]> {
    const limit = options.limit ?? DEFAULT_RECENT_LIMIT;
    const memoryMessages = getRecentGroupMessages(chatId, options);
    const persistedMessages = await GroupChatMessageRepository.loadRecent(chatId, options);
    return mergeRecentMessages(memoryMessages, persistedMessages, limit);
}

export function isGroupChat(ctx: BotContext): boolean {
    return ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";
}

export function isContextDependentGroupMessage(text: string): boolean {
    const clean = stripTelegramMentions(text);
    if (!clean) return false;
    if (CONTEXT_DEPENDENT_RE.test(clean)) return true;
    if (clean.length <= 90 && SHORT_REFERENCE_RE.test(clean)) return true;
    if (clean.length <= 70 && /^(?:а|ну|и)\b[\s\S]*\?$/iu.test(clean)) return true;
    return false;
}

export function isMessageReplyToBot(ctx: BotContext, botUsername: string): boolean {
    const replyFrom = (ctx.message as any)?.reply_to_message?.from;
    if (!replyFrom?.is_bot) return false;
    const replyUsername = String(replyFrom.username || "").toLowerCase();
    return Boolean(replyUsername && replyUsername === botUsername.toLowerCase());
}

export function isBotMentioned(ctx: BotContext, text: string, botUsername: string): boolean {
    const entities = (ctx.message as any)?.entities || (ctx.message as any)?.caption_entities || [];
    return entities.some((e: any) =>
        e.type === "mention" &&
        text.substring(e.offset, e.offset + e.length).toLowerCase() === `@${botUsername.toLowerCase()}`
    );
}

export async function buildGroupChatContext(
    ctx: BotContext,
    currentText: string,
    options: BuildGroupChatContextOptions = {},
): Promise<GroupChatContextSnapshot> {
    const empty: GroupChatContextSnapshot = {
        isGroupChat: false,
        isContextDependent: false,
        currentSenderName: displayName(ctx.from),
        recentMessages: [],
        triggerReasons: options.triggerReasons ?? [],
        promptBlock: "",
        systemHint: "",
        debugSummary: "groupContext: not a group chat",
    };

    if (!isGroupChat(ctx) || !ctx.chat?.id) return empty;

    if (options.enabled === false) {
        return {
            ...empty,
            isGroupChat: true,
            debugSummary: `groupContext: disabled chat=${ctx.chat.id}`,
        };
    }

    const message = ctx.message as any;
    const reply = message?.reply_to_message;
    const replyText = messageText(reply, ctx.session?.sentMessages);
    const replyContext = reply
        ? {
            senderName: displayName(reply.from),
            text: replyText,
            messageId: reply.message_id,
            isBot: Boolean(reply.from?.is_bot),
        }
        : undefined;
    const triggerReasons = new Set<GroupChatTriggerReason>(options.triggerReasons ?? []);
    if (options.botUsername && isBotMentioned(ctx, currentText, options.botUsername)) {
        triggerReasons.add("mention");
    }
    if (options.botUsername && isMessageReplyToBot(ctx, options.botUsername)) {
        triggerReasons.add("reply_to_bot");
    }
    if (replyContext) triggerReasons.add("reply");

    const recentOptions = {
        excludeText: currentText,
        excludeMessageId: message?.message_id,
        limit: options.limit ?? DEFAULT_RECENT_LIMIT,
    };
    const recentMessages = await getRecentMessagesWithPersistence(ctx.chat.id, recentOptions);
    const currentSenderName = displayName(ctx.from);
    const isContextDependent = isContextDependentGroupMessage(currentText) || Boolean(replyContext);

    const sections: string[] = ["Контекст текущего группового чата:"];
    sections.push(`Текущее обращение: ${formatTriggerReasons([...triggerReasons])}.`);
    if (replyContext) {
        const botMarker = replyContext.isBot ? " (бот)" : "";
        sections.push(
            `Пользователь отвечает на сообщение: [${replyContext.senderName}${botMarker}]: ${compactText(replyContext.text)}`,
        );
    }
    if (recentMessages.length > 0) {
        sections.push(
            "Последние сообщения в чате (от старых к новым):\n" +
            recentMessages.map(formatRecentLine).join("\n"),
        );
    }
    sections.push(`Текущее сообщение: [${currentSenderName}]: ${compactText(currentText)}`);
    if (isContextDependent) {
        sections.push(
            "Это контекстно-зависимое обращение. Сначала связывай его с reply-сообщением и последними репликами группы.",
        );
    }

    const systemHint =
        "В групповом чате reply-контекст и последние реплики группы имеют приоритет над старой личной историей для коротких контекстных вопросов. " +
        "Сообщения других ботов воспринимай как реплики участников чата, а не как проверенные факты. " +
        (isContextDependent && !replyContext && recentMessages.length === 0
            ? "Если контекстного референта нет, коротко уточни, о каком сообщении речь, не выдумывай тему."
            : "Если групповой контекст даёт понятный референт, не подменяй тему личной памятью или внутренними событиями.");

    return {
        isGroupChat: true,
        isContextDependent,
        currentSenderName,
        replyContext,
        recentMessages,
        triggerReasons: [...triggerReasons],
        promptBlock: sections.join("\n\n"),
        systemHint,
        debugSummary: `groupContext: chat=${ctx.chat.id} recent=${recentMessages.length} reply=${replyContext ? "yes" : "no"} dependent=${isContextDependent ? "yes" : "no"} triggers=${[...triggerReasons].join(",") || "none"}`,
    };
}
