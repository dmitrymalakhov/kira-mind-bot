const DEFAULT_MAX_ESCAPED_CHUNK_LENGTH = 3_200;

/**
 * Делит сырой текст так, чтобы после HTML-экранирования каждый фрагмент
 * гарантированно помещался в отдельный rich/fallback-блок Telegram.
 */
export function splitRecurringResultText(
    text: string,
    maxEscapedLength = DEFAULT_MAX_ESCAPED_CHUNK_LENGTH,
): string[] {
    if (!text) return [""];
    const safeMaxEscapedLength = Math.max(5, Math.floor(maxEscapedLength));
    const characters = Array.from(text);
    const chunks: string[] = [];
    let start = 0;

    while (start < characters.length) {
        let escapedLength = 0;
        let end = start;
        let preferredBreak = -1;
        while (end < characters.length) {
            const character = characters[end];
            const encodedLength = character === "&"
                ? 5
                : character === "<" || character === ">"
                    ? 4
                    : character.length;
            if (escapedLength + encodedLength > safeMaxEscapedLength) break;
            escapedLength += encodedLength;
            end += 1;
            if (character === "\n" || character === " ") preferredBreak = end;
        }

        if (end === characters.length) {
            chunks.push(characters.slice(start).join(""));
            break;
        }
        const minimumUsefulBreak = start + Math.floor((end - start) * 0.55);
        const chunkEnd = preferredBreak >= minimumUsefulBreak ? preferredBreak : Math.max(start + 1, end);
        chunks.push(characters.slice(start, chunkEnd).join("").trimEnd());
        start = chunkEnd;
        while (characters[start] === " " || characters[start] === "\n") start += 1;
    }

    return chunks;
}
