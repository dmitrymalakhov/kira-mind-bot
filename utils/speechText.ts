import { normalizeNumbersForVoiceMessage } from "./russianSpeechNumbers";

export function prepareTextForSpeech(text: string): string {
    const cleaned = text
        .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, "$1")
        .replace(/https?:\/\/\S+/g, "ссылка")
        .replace(/т\.к\./giu, "так как")
        .replace(/т\.д\./giu, "так далее")
        .replace(/т\.п\./giu, "тому подобное")
        .replace(/№\s*/g, "номер ")
        .replace(/&/g, " и ")
        .replace(/[•·]/g, " ")
        .replace(/[`*_>#]/g, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();

    return normalizeNumbersForVoiceMessage(cleaned)
        .replace(/[ \t]{2,}/g, " ")
        .trim();
}
