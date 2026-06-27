import assert from "node:assert/strict";
import {
    contactNamesLikelyMatch,
    extractContactReferenceFromText,
    isMemoryEntryAllowedForContactScope,
    type ContactIdentityScope,
} from "../utils/contactMemory";
import type { Contact } from "../stores/ContactsStore";

assert.equal(
    extractContactReferenceFromText("Лира Примерова опять пропала и не отвечает"),
    "Лира Примерова"
);

assert.equal(
    extractContactReferenceFromText("Павел молчит уже неделю"),
    "Павел"
);

assert.equal(
    extractContactReferenceFromText("Мне с утра очень надо поговорить с Лирой Примеровой"),
    "Лирой Примеровой"
);

assert.equal(
    extractContactReferenceFromText("Напомни мне с утра поговорить с Лирой Примеровой"),
    "Лирой Примеровой"
);

assert.equal(
    extractContactReferenceFromText("Если получится, напомни мне завтра"),
    null
);

assert.equal(
    extractContactReferenceFromText("Напоминай мне про это завтра"),
    null
);

assert.equal(
    extractContactReferenceFromText("Хочу завтра поговорить об этом"),
    null
);

assert.equal(contactNamesLikelyMatch("Лира Примерова", "Лира Туманова"), false);
assert.equal(contactNamesLikelyMatch("Лира Туманова", "Лира Примерова"), false);
assert.equal(contactNamesLikelyMatch("Павел Тестов", "Лира Примерова"), false);
assert.equal(contactNamesLikelyMatch("Лира Примерова", "Лира Дымова"), false);
assert.equal(contactNamesLikelyMatch("Павел Тестов", "Павел Марков"), false);
assert.equal(contactNamesLikelyMatch("Павел", "Павел Тестов"), false);

const obliqueScope: ContactIdentityScope = {
    status: "resolved",
    queryName: "Лирой Примеровой",
    displayName: "Лира Примерова",
};

const usernameScopedContact: Contact = {
    id: 42,
    firstName: "Леди",
    lastName: "Тестория",
    username: "contact_alpha",
};

const usernameScope: ContactIdentityScope = {
    status: "resolved",
    queryName: "Леди Тестория",
    displayName: "Леди Тестория",
    contact: usernameScopedContact,
};

assert.equal(
    isMemoryEntryAllowedForContactScope(
        {
            content: "[Лира Примерова] ждёт отчёт по итогам Q2.",
            tags: ["contact_name:Лира Примерова", "contact_alias:Лира Примерова"],
        },
        obliqueScope
    ),
    true
);

assert.equal(
    isMemoryEntryAllowedForContactScope(
        {
            content: "[Павел Тестов] вылет в 01:50.",
            tags: ["contact_name:Павел Тестов"],
        },
        obliqueScope
    ),
    false
);

assert.equal(
    isMemoryEntryAllowedForContactScope(
        {
            content: "[Павел Тестов] просил вернуться к обсуждению позже.",
            tags: ["contact_name:Павел Тестов"],
        },
        {
            status: "resolved",
            queryName: "Павел",
            displayName: "Павел",
        }
    ),
    false
);

assert.equal(
    isMemoryEntryAllowedForContactScope(
        {
            content: "[Леди Тестория] прислала новые договорённости.",
            tags: ["contact_username:@contact_alpha"],
        },
        usernameScope
    ),
    true
);

assert.equal(
    isMemoryEntryAllowedForContactScope(
        {
            content: "[Леди Тестория] прислала новые договорённости.",
            tags: ["contact_id:42"],
        },
        usernameScope
    ),
    true
);

console.log("contactMemory matching checks passed");
