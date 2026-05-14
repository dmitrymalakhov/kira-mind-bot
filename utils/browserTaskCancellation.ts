const BOOKING_ACTION_WORD = String.raw`(?:запис\p{L}*|регист\p{L}*|зарегистр\p{L}*|брон\p{L}*|бронир\p{L}*|заявк\p{L}*)`;
const BOOKING_ACTION_RE = new RegExp(BOOKING_ACTION_WORD, 'iu');

function cleanWhitespace(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
}

export function isDirectBrowserCancellationCommand(text: string): boolean {
    return /^(?:отмена|отмени(?:ть)?|cancel|stop|стоп|(?:просто\s+)?останови\p{L}*(?:\s+вс[её].*)?|остановить(?:\s+вс[её].*)?|прекрати|хватит|не\s+продолжай|ничего\s+не\s+делай|просто\s+остановить.*)\s*[.!?…]*$/iu
        .test(cleanWhitespace(text));
}

export function looksLikeNegatedBookingRequest(text: string): boolean {
    const normalized = cleanWhitespace(text).toLowerCase();
    if (!BOOKING_ACTION_RE.test(normalized)) return false;

    const patterns = [
        new RegExp(String.raw`(?:^|[\s,.;:!?])(?:я\s+|мы\s+)?(?:больше\s+)?не\s+(?:хочу|хотим|буду|будем|надо|нужно|планирую|планируем|собираюсь|собираемся)\s+[\s\S]{0,70}${BOOKING_ACTION_WORD}`, 'iu'),
        new RegExp(String.raw`(?:передумал\p{L}*|отбой|не\s+актуальн\p{L}*)[\s\S]{0,90}${BOOKING_ACTION_WORD}`, 'iu'),
        /(?:^|[\s,.;:!?])не\s+(?:записывай|регистрируй|зарегистрируй|бронируй|оформляй)(?:\s+(?:меня|нас))?/iu,
    ];

    return patterns.some((pattern) => pattern.test(normalized));
}

export function looksLikeBrowserTaskCancellation(text: string): boolean {
    const normalized = cleanWhitespace(text).toLowerCase();
    if (!normalized) return false;
    if (isDirectBrowserCancellationCommand(normalized)) return true;
    if (looksLikeNegatedBookingRequest(normalized)) return true;

    const explicitCancelBeforeAction = new RegExp(String.raw`(?:отмен\p{L}*|останов\p{L}*|прекрат\p{L}*)[\s\S]{0,80}${BOOKING_ACTION_WORD}`, 'iu');
    const explicitCancelAfterAction = new RegExp(String.raw`${BOOKING_ACTION_WORD}[\s\S]{0,80}(?:отмен\p{L}*|останов\p{L}*|прекрат\p{L}*)`, 'iu');
    return explicitCancelBeforeAction.test(normalized) || explicitCancelAfterAction.test(normalized);
}

export function isBrowserTaskCancellationChoice(text: string): boolean {
    const normalized = cleanWhitespace(text).toLowerCase();
    return looksLikeNegatedBookingRequest(normalized) ||
        (/(?:отмен|останов|прекрат)/iu.test(normalized) && /(?:запис|регист|брон|заявк|браузерн|задач|уже\s+начат)/iu.test(normalized));
}
