/** Exact social phrases only: a greeting prefix must never hide a real action. */
function normalizeSocialMessage(message: string, assistantName = ''): string {
    let text = message.toLocaleLowerCase('ru').trim();
    if (text.length > 100) return '';
    text = text.replace(/[!?.,:;…😊🙂👋❤️❤🙏👍]+/gu, ' ').replace(/\s+/g, ' ').trim();
    if (assistantName) {
        const name = assistantName.toLocaleLowerCase('ru').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        text = text.replace(new RegExp(`^(?:${name})\\s+|\\s+(?:${name})$`, 'u'), '').trim();
    }
    return text;
}

/** A presence check asks for attention, not for biography, memory or a mood report. */
export function simplePresenceReply(message: string, assistantName = ''): string | undefined {
    const text = normalizeSocialMessage(message, assistantName);
    return /^(?:(?:эй |привет )?(?:ты (?:тут|здесь|на связи)|ты меня (?:слышишь|видишь))|есть кто|алло|ау)$/u.test(text)
        ? 'Да, я тут. Что у тебя?'
        : undefined;
}

export function isSimpleSocialMessage(message: string, assistantName = ''): boolean {
    const text = normalizeSocialMessage(message, assistantName);
    return Boolean(simplePresenceReply(message, assistantName) || simpleArrivalReply(message)) || /^(?:(?:привет|здравствуй|здравствуйте|хай|хей|доброе утро|добрый день|добрый вечер|hello|hi|hey)(?: как (?:ты|дела|настроение))?|как (?:ты|дела|настроение)|спасибо|спасибо большое|большое спасибо|благодарю|спокойной ночи|доброй ночи|до завтра|пока)$/u.test(text);
}

function simpleArrivalReply(message: string): string | undefined {
    if (message.includes('?')) return undefined;
    const text = normalizeSocialMessage(message).replace(/ё/g, 'е');
    return /^(?:да )?(?:вот )?(?:я )?(?:(?:с работы|домой) (?:пришел|пришла|вернулся|вернулась)|(?:пришел|пришла|вернулся|вернулась) (?:с работы|домой))$/u.test(text)
        ? 'С возвращением. Как прошёл день?' : undefined;
}

export function simpleSocialFallback(message: string, assistantName = ''): string | undefined {
    if (!isSimpleSocialMessage(message, assistantName)) return undefined;
    const text = normalizeSocialMessage(message, assistantName);
    if (simplePresenceReply(message, assistantName)) return simplePresenceReply(message, assistantName);
    if (simpleArrivalReply(message)) return simpleArrivalReply(message);
    if (/спасибо|благодарю/u.test(text)) return 'Пожалуйста!';
    if (/ночи/u.test(text)) return 'Доброй ночи!';
    if (text === 'пока') return 'Пока!';
    if (text === 'до завтра') return 'До завтра!';
    if (/^как /u.test(text)) return 'Я тут, на связи. А ты как?';
    return 'Привет! Как ты?';
}
