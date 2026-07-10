import assert from "node:assert/strict";
import { isEligibleForUserSynthesis } from "../utils/userSynthesisFilter";
import type { UserSynthesisSourceLike } from "../utils/userSynthesisFilter";

// 1. Эпизод фоновой рефлексии про чужой чат: subject захардкожен 'user', но
//    тег source_chat указывает на контакт → должен исключаться.
const reflectionEpisodeAboutContact: UserSynthesisSourceLike = {
    subject: "user",
    tags: ["memory-episode", "source:reflection", "source_chat:Тестовый Контакт"],
};
assert.equal(
    isEligibleForUserSynthesis(reflectionEpisodeAboutContact),
    false,
    "эпизод рефлексии про чужой чат не должен быть источником user-синтеза",
);

// 2. personal-chat-эпизод про контакт (тег source_contact) → исключается.
const personalChatEpisodeAboutContact: UserSynthesisSourceLike = {
    subject: "user",
    tags: ["personal-chat-episode", "memory-episode", "source:personal_chat_background", "source_contact:Тестовый Контакт"],
};
assert.equal(
    isEligibleForUserSynthesis(personalChatEpisodeAboutContact),
    false,
    "personal-chat-эпизод про контакт не должен быть источником user-синтеза",
);

// 3. Контактный факт (корректно размеченный) → исключается.
const contactFact: UserSynthesisSourceLike = {
    subject: "contact",
    tags: ["subject:contact", "contact:Тестовый Контакт", "contact_name:Тестовый Контакт"],
};
assert.equal(
    isEligibleForUserSynthesis(contactFact),
    false,
    "контактный факт не должен быть источником user-синтеза",
);

// 4. Обычный user-факт без contact-маркеров → проходит.
const userFact: UserSynthesisSourceLike = {
    subject: "user",
    tags: ["subject:user", "inference:direct"],
};
assert.equal(
    isEligibleForUserSynthesis(userFact),
    true,
    "обычный user-факт должен быть источником user-синтеза",
);

// 5. Эпизод MemoryEpisodeService (личная переписка с ботом, без source_chat/contact) → проходит.
const ownEpisode: UserSynthesisSourceLike = {
    subject: "user",
    tags: ["memory-episode", "autobiographical"],
};
assert.equal(
    isEligibleForUserSynthesis(ownEpisode),
    true,
    "собственный эпизод владельца (без source_chat/contact) должен проходить",
);

// 6. Legacy-факт без поля subject → проходит (backward-compat).
const legacyFact: UserSynthesisSourceLike = {
    tags: ["inference:direct"],
};
assert.equal(
    isEligibleForUserSynthesis(legacyFact),
    true,
    "legacy-факт без subject должен проходить",
);

// 7. subject:bot / system — helper сам их не отсекает (это делают вызывающие
//    сервисы), но проверим, что не падает и не ложно исключает user-контент.
const botFact: UserSynthesisSourceLike = {
    subject: "bot",
    tags: ["subject:bot"],
};
// helper исключает только contact и source_chat/contact; bot-записи сервисы
// фильтруют сами. Проверяем просто, что функция корректно отрабатывает.
assert.equal(
    typeof isEligibleForUserSynthesis(botFact),
    "boolean",
    "helper должен корректно обрабатывать subject:bot",
);

console.log("userSynthesisFilter checks passed");
