const WORD_START = String.raw`(?:^|[^\p{L}\p{N}_])`;
const WORD_END = String.raw`(?=$|[^\p{L}\p{N}_])`;
const VOICE_WORD = String.raw`(?:голосом|голосов(?:ым|ое|ую|ого)(?:\s+сообщени(?:ем|е|я|ю))?|войсом|войс|аудио(?:сообщени(?:ем|е|я|ю))?|озвучк(?:ой|у|а|е)|voice|audio)`;
const VOICE_ACTION = String.raw`(?:ответь|ответ|скажи|расскажи|объясни|прочитай|озвучь|запиши|сделай|сгенерируй|пришли|отправь|можешь\s+(?:ответить|рассказать|сказать|озвучить|прочитать))`;

const VOICE_ACTION_RE = new RegExp(`${WORD_START}${VOICE_ACTION}${WORD_END}[\\s\\S]{0,80}${WORD_START}${VOICE_WORD}${WORD_END}`, "iu");
const VOICE_PREFACE_RE = new RegExp(`${WORD_START}${VOICE_WORD}${WORD_END}[\\s\\S]{0,80}${WORD_START}(?:про|о|об|на\\s+тему|по\\s+теме|что|как|почему|зачем|помнишь|знаешь|расскажи|объясни)${WORD_END}`, "iu");
const VOICE_WORD_GLOBAL_RE = new RegExp(`(^|[^\\p{L}\\p{N}_])${VOICE_WORD}${WORD_END}`, "giu");
const VOICE_COMMAND_GLOBAL_RE = new RegExp(`(^|[^\\p{L}\\p{N}_])(?:запиши|сделай|сгенерируй|пришли|отправь|озвучь|прочитай)\\s+(?=(?:мне\\s+)?(?:про|о|об|на\\s+тему|по\\s+теме|что|как|почему|зачем))`, "giu");

function normalizeForVoiceIntent(message: string): string {
    return message.toLowerCase().replace(/ё/g, "е");
}

export function wantsVoiceReply(message: string): boolean {
    const text = normalizeForVoiceIntent(message);
    return VOICE_ACTION_RE.test(text) || VOICE_PREFACE_RE.test(text);
}

export function stripVoiceReplyDirective(message: string): string {
    const stripped = message
        .replace(VOICE_WORD_GLOBAL_RE, "$1")
        .replace(VOICE_COMMAND_GLOBAL_RE, "$1расскажи ")
        .replace(/\s{2,}/g, " ")
        .replace(/\s+([,.!?;:])/g, "$1")
        .trim();

    return stripped || message;
}
