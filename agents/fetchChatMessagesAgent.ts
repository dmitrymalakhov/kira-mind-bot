import { getMessagesInDateRange, formatConversation, StudyChatPeriod } from '../utils/studyChatFlow';
import { devLog } from '../utils';

const PERIOD_DAYS: Record<StudyChatPeriod, number> = {
    week: 7,
    month: 30,
    '3months': 90,
    year: 365,
};

export interface FetchChatMessagesResult {
    messageCount: number;
    formattedText: string;
}

export interface FetchChatMessagesError {
    error: string;
}

/**
 * Агент 1: получает сообщения из переписки с контактом за указанный период.
 * Единственная ответственность — достать сообщения из Telegram и вернуть их в виде текста переписки.
 */
export async function runFetchChatMessagesAgent(
    contactId: number,
    period: StudyChatPeriod,
    contactDisplayName: string
): Promise<FetchChatMessagesResult | FetchChatMessagesError> {
    const days = PERIOD_DAYS[period];
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const messages = await getMessagesInDateRange(contactId, startDate, endDate);
    devLog('FetchChatMessagesAgent: messages in range', { count: messages.length, period, contactId });

    if (messages.length === 0) {
        return {
            error: `В переписке с ${contactDisplayName} за выбранный период не найдено сообщений (или они не загрузились). Попробуй другой период или проверь подключение Telegram.`,
        };
    }

    const formattedText = formatConversation(messages, contactId, contactDisplayName);
    return {
        messageCount: messages.length,
        formattedText,
    };
}
