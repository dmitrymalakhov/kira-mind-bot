/** Exact social phrases only: a greeting prefix must never hide a real action. */
export function isSimpleSocialMessage(message: string, assistantName = ''): boolean {
    let text = message.toLocaleLowerCase('ru').trim();
    if (text.length > 100) return false;
    text = text.replace(/[!?.,:;…😊🙂👋❤️❤🙏👍]+/gu, ' ').replace(/\s+/g, ' ').trim();
    if (assistantName) {
        const name = assistantName.toLocaleLowerCase('ru').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        text = text.replace(new RegExp(`^(?:${name})\\s+|\\s+(?:${name})$`, 'u'), '').trim();
    }
    return /^(?:(?:привет|здравствуй|здравствуйте|хай|хей|доброе утро|добрый день|добрый вечер|hello|hi|hey)(?: как (?:ты|дела|настроение))?|как (?:ты|дела|настроение)|спасибо|спасибо большое|большое спасибо|благодарю|спокойной ночи|доброй ночи|до завтра|пока)$/u.test(text);
}
