import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { normalizeNumbersForVoiceMessage } from "../utils/russianSpeechNumbers";
import { prepareTextForSpeech } from "../utils/speechText";
import { stripVoiceReplyDirective, wantsVoiceReply } from "../utils/voiceReply";

describe("Russian number speech normalization", () => {
    test("speaks cardinal numbers and preserves leading zeroes as digits", () => {
        assert.equal(normalizeNumbersForVoiceMessage("0, 21, 105, 1001, код 007"),
            "ноль, двадцать один, сто пять, одна тысяча один, код ноль ноль семь");
    });

    test("speaks valid clock times with correct plurals", () => {
        assert.equal(normalizeNumbersForVoiceMessage("В 01:00, 02:01 и 05:22"),
            "В один час ровно, два часа одна минута и пять часов двадцать две минуты");
    });

    test("speaks short, slash, ISO, and full dates", () => {
        assert.equal(normalizeNumbersForVoiceMessage("Даты: 01.05, 2/6/26, 2026-12-31"),
            "Даты: первое мая, второе июня две тысячи двадцать шестого года, тридцать первое декабря две тысячи двадцать шестого года");
    });

    test("speaks decimal separators distinctly", () => {
        assert.equal(normalizeNumbersForVoiceMessage("Версии 3.50 и 2,7"), "Версии три точка пять ноль и два запятая семь");
    });

    test("speaks percentages with Russian plural forms", () => {
        assert.equal(normalizeNumbersForVoiceMessage("1%, 2%, 5%, 11%, 21%"),
            "один процент, два процента, пять процентов, одиннадцать процентов, двадцать один процент");
    });

    test("speaks ordinal suffix forms", () => {
        assert.equal(normalizeNumbersForVoiceMessage("1-й, 2-го, 3-я, 4-ую"),
            "первый, второго, третья, четвертую");
    });

    test("speaks ranges and percentage ranges", () => {
        assert.equal(normalizeNumbersForVoiceMessage("Через 3-5 дней, скидка 10–15%"),
            "Через три-пять дней, скидка десять-пятнадцать процентов");
    });

    test("uses correct currency forms and fractional gender", () => {
        assert.equal(normalizeNumbersForVoiceMessage("1 ₽, 2 рубля, 5 руб., $1.01, €2,02"),
            "один рубль, два рубля, пять рублей, один доллар один цент, два евро два цента");
    });

    test("speaks phone digits individually", () => {
        assert.equal(normalizeNumbersForVoiceMessage("Телефон +1 202 555 0199"),
            "Телефон плюс один два ноль два пять пять пять ноль один девять девять");
    });

    test("does not rewrite digits inside URLs", () => {
        assert.equal(normalizeNumbersForVoiceMessage("Открой https://example.com/v2?id=123 и шаг 2"),
            "Открой https://example.com/v2?id=123 и шаг два");
    });
});

describe("speech text cleanup", () => {
    test("removes Markdown formatting while retaining readable labels", () => {
        assert.equal(prepareTextForSpeech("**Важно:** [отчёт](https://example.com/report) > готов"),
            "Важно: отчёт готов");
    });

    test("replaces bare URLs and common abbreviations", () => {
        assert.equal(prepareTextForSpeech("Ссылка https://example.com, т.к. и т.д. и т.п."),
            "Ссылка ссылка так как и так далее и тому подобное");
    });

    test("normalizes symbols, list markers, whitespace, and numbers", () => {
        assert.equal(prepareTextForSpeech("№ 12 • A & B\n\n\nЦена 5 ₽"),
            "номер двенадцать A и B Цена пять рублей");
    });

    test("returns an empty string for formatting-only input", () => {
        assert.equal(prepareTextForSpeech("*** ###"), "");
    });
});

describe("voice reply intent", () => {
    test("recognizes action-first and voice-first requests", () => {
        const cases = [
            "Ответь голосом про планы",
            "пришли мне аудиосообщение о встрече",
            "VOICE расскажи про проект",
            "войсом объясни почему это важно",
            "можешь рассказать голосовым сообщением про отпуск",
        ];
        for (const value of cases) assert.equal(wantsVoiceReply(value), true, value);
    });

    test("rejects mentions of voice as a topic or stored fact", () => {
        const cases = [
            "что такое voice acting",
            "я люблю голосовые сообщения",
            "запомни что мне нравится аудио",
            "покажи историю голосовых",
        ];
        for (const value of cases) assert.equal(wantsVoiceReply(value), false, value);
    });

    test("strips voice media words without damaging punctuation", () => {
        assert.equal(stripVoiceReplyDirective("Ответь голосом, пожалуйста, про планы!"), "Ответь, пожалуйста, про планы!");
        assert.equal(stripVoiceReplyDirective("озвучь аудио что случилось"), "расскажи что случилось");
    });

    test("returns the original message if the directive is the whole message", () => {
        assert.equal(stripVoiceReplyDirective("голосом"), "голосом");
    });
});
