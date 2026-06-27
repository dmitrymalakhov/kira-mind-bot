import assert from "node:assert/strict";
import {
    contactNamesLikelyMatch,
    extractContactReferenceFromText,
    isMemoryEntryAllowedForContactScope,
    type ContactIdentityScope,
} from "../utils/contactMemory";

assert.equal(
    extractContactReferenceFromText("Юра Никишенко опять пропал и не отвечает"),
    "Юра Никишенко"
);

assert.equal(
    extractContactReferenceFromText("Дмитрий молчит уже неделю"),
    "Дмитрий"
);

assert.equal(
    extractContactReferenceFromText("Мне с утра очень надо поговорить с Юрой Никишенко"),
    "Юрой Никишенко"
);

assert.equal(
    extractContactReferenceFromText("Напомни мне с утра поговорить с Юрой Никишенко"),
    "Юрой Никишенко"
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

assert.equal(contactNamesLikelyMatch("Юра Никишенко", "Юрий Никишенко"), true);
assert.equal(contactNamesLikelyMatch("Юрий Никишенко", "Юра Никишенко"), true);
assert.equal(contactNamesLikelyMatch("Дмитрий Малахов", "Юрий Никишенко"), false);
assert.equal(contactNamesLikelyMatch("Юрий Никишенко", "Юрий Никонов"), false);
assert.equal(contactNamesLikelyMatch("Дмитрий Малахов", "Дмитрий Сидоров"), false);
assert.equal(contactNamesLikelyMatch("Дмитрий", "Дмитрий Малахов"), false);

const obliqueScope: ContactIdentityScope = {
    status: "resolved",
    queryName: "Юрой Никишенко",
    displayName: "Юра Никишенко",
};

assert.equal(
    isMemoryEntryAllowedForContactScope(
        {
            content: "[Юрий Никишенко] ждёт отчёт по итогам Q2.",
            tags: ["contact_name:Юрий Никишенко", "contact_alias:Юра Никишенко"],
        },
        obliqueScope
    ),
    true
);

assert.equal(
    isMemoryEntryAllowedForContactScope(
        {
            content: "[Дмитрий Малахов] вылет в 01:50.",
            tags: ["contact_name:Дмитрий Малахов"],
        },
        obliqueScope
    ),
    false
);

assert.equal(
    isMemoryEntryAllowedForContactScope(
        {
            content: "[Дмитрий Малахов] просил вернуться к обсуждению позже.",
            tags: ["contact_name:Дмитрий Малахов"],
        },
        {
            status: "resolved",
            queryName: "Дмитрий",
            displayName: "Дмитрий",
        }
    ),
    false
);

console.log("contactMemory matching checks passed");
