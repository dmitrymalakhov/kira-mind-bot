import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { ContactsStore } from "../stores/ContactsStore";
import {
    contactDisplayName,
    contactIdentityTags,
    contactOptionLabel,
    normalizeContactLookupValue,
    resolveContactIdentity,
} from "../utils/contactMemory";
import { countLegacyContactIdentities } from "../utils/contactMemoryRepair";
import { extractExplicitRememberFact } from "../utils/enhancedFactExtraction";
import { formatContactCommunicationContext } from "../utils/contactCommunicationContext";

describe("contact identity helpers", () => {
    const store = ContactsStore.getInstance();

    beforeEach(() => store.clearAllContacts());

    test("normalizes Cyrillic, accents, usernames, casing, and whitespace", () => {
        assert.equal(normalizeContactLookupValue("  @ДмИтрИй   Малáхов  "), "dmitriy malahov");
        assert.equal(normalizeContactLookupValue("@Alice_Smith"), "alice_smith");
    });

    test("builds display and option labels", () => {
        assert.equal(contactDisplayName({ id: 1, firstName: "Анна", lastName: "Петрова", username: "anya" }), "Анна Петрова");
        assert.equal(contactDisplayName({ id: 2, firstName: "", username: "only_user" }), "@only_user");
        assert.equal(contactDisplayName({ id: 3, firstName: "" }), "contact-3");
        assert.equal(contactOptionLabel({ id: 1, firstName: "Анна", lastName: "Петрова", username: "anya" }), "Анна Петрова (@anya)");
    });

    test("creates stable tags for a resolved contact", () => {
        assert.deepEqual(contactIdentityTags("Аня", {
            id: 15,
            firstName: "Анна",
            lastName: "Петрова",
            username: "anya",
        }), [
            "contact:Анна Петрова",
            "contact_name:Анна Петрова",
            "contact_alias:Аня",
            "contact_id:15",
            "contact_username:@anya",
        ]);
    });

    test("creates a normalized stable key for an unresolved full name", () => {
        assert.deepEqual(contactIdentityTags("  Анна   Петрова  "), [
            "contact:Анна Петрова",
            "contact_name:Анна Петрова",
            "contact_alias:Анна Петрова",
            "contact_key:anna_petrova",
        ]);
    });

    test("asks for a fuller name when no contacts exist", () => {
        assert.deepEqual(resolveContactIdentity("Анна"), { status: "needs_name" });
        assert.deepEqual(resolveContactIdentity("Анна Петрова"), { status: "resolved", displayName: "Анна Петрова" });
    });

    test("resolves exact names, reversed full names, and usernames", () => {
        const anna = store.saveContact({ id: 1, firstName: "Анна", lastName: "Петрова", username: "anya" });
        assert.deepEqual(resolveContactIdentity("Анна Петрова"), { status: "resolved", contact: anna, displayName: "Анна Петрова" });
        assert.deepEqual(resolveContactIdentity("Петрова Анна"), { status: "resolved", contact: anna, displayName: "Анна Петрова" });
        assert.deepEqual(resolveContactIdentity("@anya"), { status: "resolved", contact: anna, displayName: "Анна Петрова" });
    });

    test("keeps a fuzzy one-word match ambiguous until confirmed", () => {
        const anna = store.saveContact({ id: 1, firstName: "Анна", lastName: "Петрова" });
        store.saveContact({ id: 2, firstName: "Мария", lastName: "Иванова" });
        assert.deepEqual(resolveContactIdentity("Ана"), { status: "ambiguous", candidates: [anna] });
    });

    test("returns candidates for ambiguous first names", () => {
        store.saveContact({ id: 1, firstName: "Анна", lastName: "Петрова" });
        store.saveContact({ id: 2, firstName: "Анна", lastName: "Сидорова" });
        const result = resolveContactIdentity("Анна");
        assert.equal(result.status, "ambiguous");
        if (result.status === "ambiguous") assert.deepEqual(result.candidates.map((c) => c.id), [1, 2]);
    });

    test("does not guess an unknown one-word contact", () => {
        store.saveContact({ id: 1, firstName: "Анна" });
        assert.deepEqual(resolveContactIdentity("Константин"), { status: "needs_name" });
    });
});

describe("legacy contact identity detection", () => {
    test("counts contact tags and legacy content prefixes without stable identity keys", () => {
        const memories = [
            { content: "[Анна] любит кофе", tags: [] },
            { content: "Любит чай", tags: ["contact_name:Иван"] },
            { content: "Работает в банке", tags: ["contact_username:petr"] },
            { content: "Обычный факт", tags: ["preference"] },
        ];
        assert.equal(countLegacyContactIdentities(memories as any), 2);
    });

    test("does not count identities with a stable contact ID or key", () => {
        const memories = [
            { content: "[Анна] любит кофе", tags: ["contact_id:1", "contact_name:Анна"] },
            { content: "[Неизвестный Контакт] любит чай", tags: ["contact_key:unknown_contact"] },
        ];
        assert.equal(countLegacyContactIdentities(memories as any), 0);
    });
});

describe("explicit remember fact extraction", () => {
    test("supports common Russian request forms", () => {
        const cases = [
            ["Запомни, что я люблю зелёный чай", "я люблю зелёный чай"],
            ["Запомни это: код от двери 1234", "код от двери 1234"],
            ["Сохрани в память, что отпуск в августе", "отпуск в августе"],
            ["Запиши, что встреча по вторникам", "встреча по вторникам"],
            ["Не забывай, что я не ем мясо", "я не ем мясо"],
            ["Важно запомнить мой размер обуви 42", "мой размер обуви 42"],
            ["Запомни пожалуйста, что я предпочитаю текст", "я предпочитаю текст"],
        ];
        for (const [message, expected] of cases) {
            const result = extractExplicitRememberFact(message);
            assert.equal(result?.content, expected, message);
            assert.equal(result?.domain, "personal", message);
            assert.equal(result?.importance, 0.95, message);
        }
    });

    test("supports English request forms", () => {
        const cases = [
            ["Remember that my birthday is May 5", "my birthday is May 5"],
            ["Keep in mind that I prefer email", "I prefer email"],
            ["Don't forget that the code is 99", "the code is 99"],
            ["Save to memory I work remotely", "I work remotely"],
        ];
        for (const [message, expected] of cases) {
            assert.equal(extractExplicitRememberFact(message)?.content, expected, message);
        }
    });

    test("detects facts explicitly about named contacts", () => {
        assert.equal(extractExplicitRememberFact("Запомни, что Юра любит кофе")?.contactName, "Юра");
        assert.equal(extractExplicitRememberFact("Сохрани информацию про Анну Петрову: любит джаз")?.contactName, "Анну Петрову");
        assert.equal(extractExplicitRememberFact("Запомни, что @john_doe работает удалённо")?.contactName, "@john_doe");
    });

    test("does not classify pronouns and relationship words as concrete contact names", () => {
        assert.equal(extractExplicitRememberFact("Запомни, что я люблю кофе")?.contactName, undefined);
        assert.equal(extractExplicitRememberFact("Запомни, что мама любит кофе")?.contactName, undefined);
        assert.equal(extractExplicitRememberFact("Запомни, что она работает удалённо")?.contactName, undefined);
    });

    test("rejects non-requests and empty facts", () => {
        for (const message of ["", "ок", "Я люблю кофе", "Запомни", "Запомни: "]) {
            assert.equal(extractExplicitRememberFact(message), null, message);
        }
    });
});

describe("contact communication context", () => {
    test("cleans prefixes, whitespace, duplicates, and blank facts", () => {
        const result = formatContactCommunicationContext({
            contactName: " Анна ",
            facts: [
                "[Анна]   Любит короткие сообщения ",
                "любит короткие сообщения",
                "",
                "Предпочитает варианты выбора",
            ],
        });
        assert.equal(result.contactName, "Анна");
        assert.deepEqual(result.facts, ["Любит короткие сообщения", "Предпочитает варианты выбора"]);
    });

    test("caps facts at six entries", () => {
        const facts = Array.from({ length: 10 }, (_, index) => `Факт ${index + 1}`);
        assert.equal(formatContactCommunicationContext({ contactName: "Анна", facts }).facts.length, 6);
    });

    test("omits an all-whitespace portrait", () => {
        assert.deepEqual(formatContactCommunicationContext({ contactName: "Анна", portrait: "   " }), {
            contactName: "Анна",
            facts: [],
            promptBlock: "",
        });
    });

    test("includes portrait, facts, and memory safety constraints", () => {
        const result = formatContactCommunicationContext({
            contactName: "Анна",
            portrait: "Ценит конкретику.",
            facts: ["Предпочитает короткие сообщения"],
        });
        assert.match(result.promptBlock, /Ценит конкретику/);
        assert.match(result.promptBlock, /1\. Предпочитает короткие сообщения/);
        assert.match(result.promptBlock, /Не раскрывай/);
        assert.match(result.promptBlock, /Не добавляй новые факты/);
        assert.match(result.promptBlock, /Не используй чувствительные сведения/);
    });
});
