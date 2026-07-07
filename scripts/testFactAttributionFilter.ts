import assert from "node:assert/strict";
import {
    detectThirdPartyEventAttributedToUser,
    filterUserFactsForThirdPartyEvents,
} from "../utils/factAttributionFilter";
import type { FactAttributionInput } from "../utils/factAttributionFilter";

const OWNER = "Владелец";
const CONTACT = "Тестовый Контакт";

// 1. Воспроизведение бага: событие контакта ошибочно приписано владельцу.
const bugFact: FactAttributionInput = {
    content: "У пользователя есть личный праздник на следующей неделе.",
    subject: "user",
    evidence: "Контакт: Ты как на следующей неделе вечером",
    confidence: 0.85,
};
assert.notEqual(
    detectThirdPartyEventAttributedToUser(bugFact, OWNER, CONTACT),
    null,
    "должен детектить чужой ДР как wrong-attribution",
);
const filteredBug = filterUserFactsForThirdPartyEvents([bugFact], OWNER, CONTACT)[0];
assert.ok(
    (filteredBug.confidence ?? 1) <= 0.34,
    `confidence должен упасть ниже 0.35, а не ${(filteredBug.confidence ?? 1)}`,
);
assert.ok(
    filteredBug.qualityWarnings?.includes("wrong-attribution"),
    "должен поставить warning wrong-attribution",
);

// 2. Настоящее событие владельца — не трогаем.
const ownBirthday: FactAttributionInput = {
    content: "У владельца личный праздник в апреле.",
    subject: "user",
    evidence: "Я: это мой праздник в апреле",
    confidence: 0.9,
};
assert.equal(
    detectThirdPartyEventAttributedToUser(ownBirthday, OWNER, CONTACT),
    null,
    "событие владельца с first-person evidence не должно детектиться",
);

// 3. Легитимный личный план как гостя: content нейтральный, но evidence содержит
//    first-person владельца. Фильтр не должен срабатывать только из-за слова
//    «собирается», если нет contact-маркера/приглашения.
const guestPlanNoContact: FactAttributionInput = {
    content: "Собирается на встречу вечером на следующей неделе.",
    subject: "user",
    evidence: "Я: пойду на встречу вечером",
    confidence: 0.7,
};
// evidence содержит «Я:» → FIRST_PERSON_OWNER_RE сматчит «я» → keep.
assert.equal(
    detectThirdPartyEventAttributedToUser(guestPlanNoContact, OWNER, CONTACT),
    null,
    "личный план с first-person evidence не должен детектиться",
);

// 3b. Тот же план, но evidence из приглашения контакта → должен сработать.
const guestPlanFromInvite: FactAttributionInput = {
    content: "Собирается на встречу на следующей неделе в честь праздника.",
    subject: "user",
    evidence: "Контакт: соберёмся на праздник на следующей неделе, ты как?",
    confidence: 0.7,
};
assert.notEqual(
    detectThirdPartyEventAttributedToUser(guestPlanFromInvite, OWNER, CONTACT),
    null,
    "план, вытянутый из приглашения контакта, должен детектиться",
);

// 4. Контактный факт — функция не анализирует.
const contactFact: FactAttributionInput = {
    content: "У контакта личный праздник на следующей неделе.",
    subject: "contact",
    evidence: "Контакт: хочу собрать встречу на свой праздник на следующей неделе",
    confidence: 0.9,
};
assert.equal(
    detectThirdPartyEventAttributedToUser(contactFact, OWNER, CONTACT),
    null,
    "контактные факты не анализируются",
);

// 5. Личный отпуск с first-person — keep.
const ownVacation: FactAttributionInput = {
    content: "Планирует отпуск в Карелию.",
    subject: "user",
    evidence: "Я: хочу в отпуск в Карелию",
    confidence: 0.8,
};
assert.equal(
    detectThirdPartyEventAttributedToUser(ownVacation, OWNER, CONTACT),
    null,
    "личный отпуск с first-person evidence не должен детектиться",
);

// 6. Чужой отпуск, упомянутый контактом, без first-person — должен сработать.
const thirdPartyVacation: FactAttributionInput = {
    content: "У пользователя планируется отпуск в августе.",
    subject: "user",
    evidence: "Контакт: ты как в отпуск в августе?",
    confidence: 0.6,
};
assert.notEqual(
    detectThirdPartyEventAttributedToUser(thirdPartyVacation, OWNER, CONTACT),
    null,
    "чужой отпуск через приглашение должен детектиться",
);

// 7. Имя владельца в content защищает факт даже без местоимения.
const ownerNamed: FactAttributionInput = {
    content: "Владелец отмечает годовщину в сентябре.",
    subject: "user",
    evidence: "Контакт: поздравил заранее",
    confidence: 0.8,
};
assert.equal(
    detectThirdPartyEventAttributedToUser(ownerNamed, OWNER, CONTACT),
    null,
    "явное имя владельца в content защищает факт",
);

// 8. Явное имя владельца в evidence должно защищать факт даже при contact-marker.
const ownerPlanReportedViaContact: FactAttributionInput = {
    content: "Планирует встречу на следующей неделе.",
    subject: "user",
    evidence: "Тестовый Контакт: Владелец писал, что у него встреча на следующей неделе",
    confidence: 0.7,
};
assert.equal(
    detectThirdPartyEventAttributedToUser(ownerPlanReportedViaContact, OWNER, CONTACT),
    null,
    "явное имя владельца в evidence не должно давать wrong-attribution",
);

console.log("factAttributionFilter checks passed");
