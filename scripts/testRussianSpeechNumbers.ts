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
    normalizeNumbersForVoiceMessage("Код 007 и сумма 1250"),
    "Код ноль ноль семь и сумма одна тысяча двести пятьдесят"
);

console.log("russianSpeechNumbers checks passed");
