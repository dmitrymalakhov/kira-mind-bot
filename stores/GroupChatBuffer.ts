const MAX_BUFFER = 30;

export interface GroupChatMessage {
    senderName: string;
    text: string;
    date: Date;
}

const buffer = new Map<number, GroupChatMessage[]>();

export function pushGroupChatMessage(chatId: number, msg: GroupChatMessage): void {
    const msgs = buffer.get(chatId) ?? [];
    msgs.push(msg);
    if (msgs.length > MAX_BUFFER) msgs.shift();
    buffer.set(chatId, msgs);
}

/** Возвращает N последних сообщений, исключая текущее (по тексту) */
export function getRecentGroupMessages(chatId: number, excludeText?: string, limit = 15): GroupChatMessage[] {
    const msgs = buffer.get(chatId) ?? [];
    return msgs
        .filter(m => m.text !== excludeText)
        .slice(-limit);
}
