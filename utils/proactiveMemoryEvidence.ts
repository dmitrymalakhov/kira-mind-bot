type ProactiveMemoryCandidateInput = {
    content: string;
    timestamp?: Date;
    tags?: string[];
    sourceContext?: string;
    sourceMessageIds?: string[];
};

type FormatProactiveMemoryEvidenceOptions = {
    /**
     * Технические Telegram/message identifiers полезны для диагностики, но по умолчанию не должны попадать
     * в LLM prompt: дешёвые модели могут процитировать их пользователю.
     */
    includeMessageIds?: boolean;
    /** Детерминированный default убирает зависимость форматирования от TZ Docker/host. */
    timeZone?: string;
};

const DEFAULT_EVIDENCE_TIME_ZONE = 'UTC';

function normalizeDate(value: Date | string | undefined): Date | undefined {
    if (!value) return undefined;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isFinite(date.getTime()) ? date : undefined;
}

function formatMemoryDate(date: Date | string | undefined, timeZone = DEFAULT_EVIDENCE_TIME_ZONE): string | undefined {
    const normalized = normalizeDate(date);
    if (!normalized) return undefined;
    return normalized.toLocaleString('ru-RU', {
        timeZone,
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    });
}

function extractSourceContact(tags?: string[]): string | undefined {
    const tag = tags?.find((value) => value.startsWith('source_contact:'));
    return tag?.slice('source_contact:'.length).trim() || undefined;
}

function extractContentLine(content: string, label: string): string | undefined {
    const prefix = `${label}:`;
    const line = content
        .split(/\r?\n/)
        .find((value) => value.trim().toLowerCase().startsWith(prefix.toLowerCase()));
    return line?.trim().slice(prefix.length).trim() || undefined;
}

export function formatProactiveMemoryEvidence(
    memory: ProactiveMemoryCandidateInput,
    options: FormatProactiveMemoryEvidenceOptions = {},
): string {
    const sourceContext = memory.sourceContext?.replace(/\s+/g, ' ').trim();
    const explicitSource = extractContentLine(memory.content, 'Источник') || sourceContext || extractSourceContact(memory.tags);
    const explicitWhen = extractContentLine(memory.content, 'Когда') || formatMemoryDate(memory.timestamp, options.timeZone);
    const openLoops = extractContentLine(memory.content, 'Открытые линии');
    const sourceMessages = options.includeMessageIds && memory.sourceMessageIds?.length
        ? `messageIds: ${memory.sourceMessageIds.slice(-3).join(', ')}`
        : undefined;

    return [
        explicitSource ? `откуда: ${explicitSource}` : 'откуда: источник не указан',
        explicitWhen ? `когда: ${explicitWhen}` : undefined,
        openLoops ? `незакрыто: ${openLoops}` : undefined,
        sourceMessages,
    ].filter(Boolean).join('; ');
}
