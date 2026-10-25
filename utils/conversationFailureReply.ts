const CONTEXT_WINDOW_ERROR_RE = /exceed_context_size_error|context_length_exceeded|exceeds the available context size|maximum context length|context window (?:is |was )?exceeded/iu;

export function isConversationContextOverflow(error: unknown): boolean {
    if (typeof error === 'string') return CONTEXT_WINDOW_ERROR_RE.test(error);
    if (!error || typeof error !== 'object') return false;

    const record = error as Record<string, unknown>;
    return [record.message, record.code, record.type, record.error]
        .some(value => typeof value === 'string'
            ? CONTEXT_WINDOW_ERROR_RE.test(value)
            : value && typeof value === 'object' && ['message', 'code', 'type'].some(key => {
                const field = (value as Record<string, unknown>)[key];
                return typeof field === 'string' && CONTEXT_WINDOW_ERROR_RE.test(field);
            }));
}

export function buildConversationFailureReply(error: unknown): string {
    if (isConversationContextOverflow(error)) {
        return 'Не удалось ответить: контекст диалога не помещается в окно модели. Увеличь окно контекста в настройках модели и повтори запрос.';
    }
    return 'Сейчас не удалось сформировать ответ из-за технической ошибки. Попробуй повторить запрос чуть позже.';
}
