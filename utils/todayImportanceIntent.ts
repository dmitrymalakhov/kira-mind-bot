const WORD_START = String.raw`(?:^|[^\p{L}\p{N}_])`;
const WORD_END = String.raw`(?=$|[^\p{L}\p{N}_])`;
const TODAY_RE = new RegExp(`${WORD_START}(?:сегодня|сегодняшн\\p{L}*|на\\s+сегодня|today)${WORD_END}`, 'iu');
const IMPORTANT_RE = /(?:важн|план|дел[ао]?|задач|событ|встреч|созвон|звон|дедлайн|срок|напомин|расписан|календар|предстоит|надо|нужно|обязател|есть\s+ли\s+(?:что|что-то|что-нибудь)|что\s+у\s+меня|что\s+.*на\s+сегодня|anything\s+important|agenda|schedule|plans?)/iu;
const LIVE_CHAT_CHECK_RE = /(?:проверь|прочитай|изучи|проанализируй|посмотри)(?:\s+\S+){0,5}\s+(?:переписк|сообщен|чат|чаты|групп)/iu;

export function isTodayImportanceRequest(message: string): boolean {
    const normalized = message.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!normalized) return false;
    if (!TODAY_RE.test(normalized)) return false;
    if (LIVE_CHAT_CHECK_RE.test(normalized)) return false;
    return IMPORTANT_RE.test(normalized);
}

export const TODAY_IMPORTANCE_WORD_BOUNDARY = {
    start: WORD_START,
    end: WORD_END,
};
