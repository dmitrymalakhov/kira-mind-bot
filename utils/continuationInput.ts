/** Intake guard shared by parameter questions and paused workflows. */
export function looksLikeIndependentRequest(message: string): boolean {
    return /^(?:привет|спасибо|пока|(?:что|как|какой|какая|какое|какие|кто|где|когда|сколько|почему|зачем)(?=\s|$)|подскажи|узнай|найди|напомни|напиши|отправь|создай|покажи|расскажи|проанализируй|открой|сгенерируй|нарисуй|изучи|запиши|удали|убери|отмени\s+|включи|выключи|отключи|приостанови|возобнови|останови|запусти|обнови|перенеси|поменяй|измени|скачай|выгрузи|экспортируй)/iu.test(message.trim());
}

export function isBrowserContinuationAnswer(message: string, sessionId?: string): boolean {
    if (!sessionId || !message.trim()) return false;
    if (/^Продолжи задачу в браузере через Playwright\.|browserSessionId:/i.test(message)) {
        return message.match(/browserSessionId:\s*(\S+)/i)?.[1] === sessionId;
    }
    return !looksLikeIndependentRequest(message);
}
