const WORD_START = String.raw`(?:^|[^\p{L}\p{N}_])`;
const WORD_END = String.raw`(?=$|[^\p{L}\p{N}_])`;
const TODAY_RE = new RegExp(`${WORD_START}(?:сегодня|сегодняшн\\p{L}*|на\\s+сегодня|today)${WORD_END}`, 'iu');
const IMPORTANT_RE = /(?:важн|план|дел[ао]?|задач|событ|встреч|созвон|звон|дедлайн|срок|напомин|расписан|календар|предстоит|надо|нужно|обязател|есть\s+ли\s+(?:что|что-то|что-нибудь)|что\s+у\s+меня|что\s+.*на\s+сегодня|anything\s+important|agenda|schedule|plans?)/iu;
// Agenda is a fallback for the owner's day, never a source selector for chats.
// Questions about history need no imperative verb such as «прочитай».
const CHAT_SOURCE_RE = new RegExp(`${WORD_START}(?:переписк\\p{L}*|сообщен\\p{L}*|чат\\p{L}*|групп(?:а|е|у|ы|ой|ам|ами|ах)?|телеграм\\p{L}*|telegram|chats?|messages?)${WORD_END}`, 'iu');

export function isTodayImportanceRequest(message: string, classification?: { intent: string; details?: { messagesCheckType?: unknown; memoryTask?: unknown }; subIntents?: unknown[] }): boolean {
    if (classification && (classification.intent !== 'РАЗГОВОР' || classification.subIntents?.length || classification.details?.messagesCheckType || classification.details?.memoryTask === 'lookup')) return false;
    const normalized = message.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!normalized) return false;
    if (!TODAY_RE.test(normalized)) return false;
    if (CHAT_SOURCE_RE.test(normalized)) return false;
    return IMPORTANT_RE.test(normalized);
}

export const TODAY_IMPORTANCE_WORD_BOUNDARY = {
    start: WORD_START,
    end: WORD_END,
};
