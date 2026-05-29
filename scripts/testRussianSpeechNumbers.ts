import assert from "node:assert/strict";
import { normalizeNumbersForVoiceMessage } from "../utils/russianSpeechNumbers";

assert.equal(
    normalizeNumbersForVoiceMessage("Давай встретимся 25.05 в 10:30"),
    "Давай встретимся двадцать пятое мая в десять часов тридцать минут"
);

assert.equal(
    normalizeNumbersForVoiceMessage("Подготовим 25-е число и 15% скидку"),
    "Подготовим двадцать пятое число и пятнадцать процентов скидку"
);

assert.equal(
    normalizeNumbersForVoiceMessage("Созвон 29.05.2026 в 09:05, проект 2.0"),
    "Созвон двадцать девятое мая две тысячи двадцать шестого года в девять часов пять минут, проект два точка ноль"
);

assert.equal(
    normalizeNumbersForVoiceMessage("Версия 3.5 и диапазон 5-7 дней"),
    "Версия три точка пять и диапазон пять-семь дней"
);

assert.equal(
    normalizeNumbersForVoiceMessage("ISO дата 2026-05-29 и скидка 5-7%"),
    "ISO дата двадцать девятое мая две тысячи двадцать шестого года и скидка пять-семь процентов"
);

assert.equal(
    normalizeNumbersForVoiceMessage("Дата 03.05 и 3.5 часа"),
    "Дата третье мая и три точка пять часа"
);

assert.equal(
    normalizeNumbersForVoiceMessage("Код 007 и сумма 1250"),
    "Код ноль ноль семь и сумма одна тысяча двести пятьдесят"
);

assert.equal(
    normalizeNumbersForVoiceMessage("Телефон +7 (999) 123-45-67"),
    "Телефон плюс семь девять девять девять один два три четыре пять шесть семь"
);

assert.equal(
    normalizeNumbersForVoiceMessage("Бюджет 1 500 ₽, аванс $20 и остаток 12,50 евро"),
    "Бюджет одна тысяча пятьсот рублей, аванс двадцать долларов и остаток двенадцать евро пятьдесят центов"
);

console.log("russianSpeechNumbers checks passed");
