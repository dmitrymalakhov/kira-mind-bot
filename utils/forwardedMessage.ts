export interface ForwardedMessageInfo {
    isForwarded: boolean;
    source: string;
}

/**
 * Возвращает доступное GramJS-имя исходного автора пересланного сообщения.
 * `fromName` может отсутствовать у скрытых/старых forwards, поэтому в таком
 * случае оставляем явную неизвестную атрибуцию, а не подставляем переносчика.
 */
export function getGramJsForwardSource(forwardHeader: unknown): string {
    const value = (forwardHeader ?? {}) as Record<string, any>;
    const namedSource = value.fromName || value.savedFromName || value.postAuthor;
    if (typeof namedSource === 'string' && namedSource.trim()) return namedSource.trim();

    const peer = value.fromId || value.savedFromPeer || value.savedFromId;
    if (peer && typeof peer === 'object') {
        if (peer.userId !== undefined) return `пользователь #${String(peer.userId)}`;
        if (peer.channelId !== undefined) return `канал #${String(peer.channelId)}`;
        if (peer.chatId !== undefined) return `чат #${String(peer.chatId)}`;
    }

    return 'неизвестный автор';
}

/**
 * Telegram Bot API сначала использовал forward_from*, а в новых версиях
 * передаёт единый forward_origin. Поддерживаем оба формата в одном месте.
 */
export function getForwardedMessageInfo(message: unknown): ForwardedMessageInfo {
    const value = (message ?? {}) as Record<string, any>;
    const origin = value.forward_origin;

    if (origin) {
        if (origin.type === 'user') {
            return {
                isForwarded: true,
                source: origin.sender_user?.username || origin.sender_user?.first_name || 'пользователя',
            };
        }
        if (origin.type === 'chat') {
            return {
                isForwarded: true,
                source: origin.sender_chat?.title || 'чата',
            };
        }
        if (origin.type === 'channel') {
            return {
                isForwarded: true,
                source: origin.chat?.title || 'канала',
            };
        }
        if (origin.type === 'hidden_user') {
            return {
                isForwarded: true,
                source: origin.sender_user_name || 'скрытого отправителя',
            };
        }
        return { isForwarded: true, source: 'скрытого отправителя' };
    }

    if (value.forward_from) {
        return {
            isForwarded: true,
            source: value.forward_from.username || value.forward_from.first_name || 'пользователя',
        };
    }
    if (value.forward_from_chat) {
        return {
            isForwarded: true,
            source: value.forward_from_chat.title || 'чата',
        };
    }
    if (value.forward_sender_name) {
        return { isForwarded: true, source: value.forward_sender_name };
    }

    return { isForwarded: false, source: '' };
}
