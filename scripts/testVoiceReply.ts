import assert from "node:assert/strict";
import { stripVoiceReplyDirective, wantsVoiceReply } from "../utils/voiceReply";

const positiveCases = [
    "Ответь голосом про мои планы на завтра",
    "сделай мне голосовое про здоровье",
    "голосом расскажи, что ты помнишь обо мне",
    "озвучь аудио что ты знаешь про проект",
    "можешь прочитать voice про расписание?",
];

for (const text of positiveCases) {
    assert.equal(wantsVoiceReply(text), true, `Expected voice reply intent for: ${text}`);
}

const negativeCases = [
    "что такое voice leading в музыке",
    "покажи историю голосовых сообщений",
    "запиши мысль в память: я люблю аудиокниги",
    "расскажи про голосовые интерфейсы текстом",
];

for (const text of negativeCases) {
    assert.equal(wantsVoiceReply(text), false, `Did not expect voice reply intent for: ${text}`);
}

assert.equal(
    stripVoiceReplyDirective("сделай мне голосовое про здоровье"),
    "расскажи мне про здоровье"
);
assert.equal(
    stripVoiceReplyDirective("озвучь аудио что ты знаешь про проект"),
    "расскажи что ты знаешь про проект"
);
assert.equal(
    stripVoiceReplyDirective("Ответь голосом про мои планы"),
    "Ответь про мои планы"
);

console.log("voiceReply checks passed");
