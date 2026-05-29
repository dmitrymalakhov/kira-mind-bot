import assert from "node:assert/strict";
import { prepareTextForSpeech } from "../utils/speechText";

assert.equal(
    prepareTextForSpeech("Смотри [док](https://example.com), бюджет 1 500 ₽ и телефон +7 (999) 123-45-67"),
    "Смотри док, бюджет одна тысяча пятьсот рублей и телефон плюс семь девять девять девять один два три четыре пять шесть семь"
);

assert.equal(
    prepareTextForSpeech("URL https://example.com/a?b=1 и *важно*: т.к. дедлайн №5"),
    "URL ссылка и важно: так как дедлайн номер пять"
);

assert.equal(
    prepareTextForSpeech("A & B\n\n\nверсия 3.5"),
    "A и B версия три точка пять"
);

console.log("speechText checks passed");
