const MAX_BUFFER = 30;

export interface GroupChatMessage {
    senderName: string;
    text: string;
    date: Date;
    messageId?: number;
    senderId?: number;
    isBot?: boolean;
}

const buffer = new Map<number, GroupChatMessage[]>();

export function pushGroupChatMessage(chatId: number, msg: GroupChatMessage): void {
    const msgs = buffer.get(chatId) ?? [];
    msgs.push(msg);
    if (msgs.length > MAX_BUFFER) msgs.shift();
    buffer.set(chatId, msgs);
}

export interface RecentGroupMessagesOptions {
    excludeText?: string;
    excludeMessageId?: number;
    limit?: number;
}

function normalizeRecentOptions(
    excludeTextOrOptions?: string | RecentGroupMessagesOptions,
    limit = 15,
): RecentGroupMessagesOptions {
    if (typeof excludeTextOrOptions === 'object' && excludeTextOrOptions !== null) {
        return { limit: 15, ...excludeTextOrOptions };
    }
    return { excludeText: excludeTextOrOptions, limit };
}

/** Возвращает N последних сообщений, исключая текущее по id или по тексту. */
export function getRecentGroupMessages(
    chatId: number,
    excludeTextOrOptions?: string | RecentGroupMessagesOptions,
    limit = 15,
): GroupChatMessage[] {
    const options = normalizeRecentOptions(excludeTextOrOptions, limit);
    const msgs = buffer.get(chatId) ?? [];
    return msgs
        .filter(m => {
            if (options.excludeMessageId != null && m.messageId === options.excludeMessageId) return false;
            if (options.excludeText != null && m.text === options.excludeText) return false;
            return true;
        })
        .slice(-(options.limit ?? 15));
}
