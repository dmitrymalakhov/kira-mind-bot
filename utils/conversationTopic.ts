export function detectCurrentConversationTopic(message: string, fallback?: string): string | undefined {
    const match = message.match(/(?:чемпионат\s+мира|чм)(?:\s+по\s+([\p{L}-]+))?/iu);
    if (!match) return fallback;

    const sport = match[1];
    const year = message.match(/\b(20\d{2})\b/u)?.[1];
    if (!sport && fallback && /чемпионат\s+мира/iu.test(fallback)) {
        return year && !fallback.includes(year) ? `${fallback} ${year}` : fallback;
    }
    return `Чемпионат мира${sport ? ` по ${sport}` : ''}${year ? ` ${year}` : ''}`;
}
