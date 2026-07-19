import assert from "node:assert/strict";
import {
    contactNamesLikelyMatch,
    extractContactReferenceFromText,
    handlePendingContactMemoryText,
    isMemoryEntryAllowedForContactScope,
    persistPendingContactFacts,
    saveContactMemoryFactOrAsk,
    type PendingContactMemory,
    type ContactIdentityScope,
} from "../utils/contactMemory";
import { ContactsStore, type Contact } from "../stores/ContactsStore";
import type { BotContext } from "../types";

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

async function checkAtomicPendingAssertions(): Promise<void> {
    const contacts = ContactsStore.getInstance();
    contacts.clearAllContacts();
    contacts.saveContact({ id: 900000021, firstName: 'Лира', lastName: 'Примерова' });
    contacts.saveContact({ id: 900000022, firstName: 'Лира', lastName: 'Туманова' });
    const replies: string[] = [];
    const ctx = {
        from: { id: 900000020 },
        session: {},
        reply: async (text: string) => {
            replies.push(text);
            return { message_id: replies.length };
        },
    } as unknown as BotContext;

    const first = await saveContactMemoryFactOrAsk(ctx, {
        contactName: 'Лира',
        content: 'Лира работает с пользователем',
        domain: 'work',
        importance: 0.8,
        memoryMetadata: { predicate: 'works_with', object: 'пользователь' },
    });
    const second = await saveContactMemoryFactOrAsk(ctx, {
        contactName: 'Лира',
        content: 'Лира — близкая подруга пользователя',
        domain: 'social',
        importance: 0.8,
        memoryMetadata: { predicate: 'relationship', object: 'близкая подруга' },
    });

    assert.equal(first.status, 'pending');
    assert.equal(second.status, 'pending');
    assert.equal(replies.length, 1);
    assert.equal(ctx.session.pendingContactMemory?.assertions?.length, 2);
    assert.deepEqual(
        ctx.session.pendingContactMemory?.assertions?.map(assertion => assertion.memoryMetadata?.predicate),
        ['works_with', 'relationship'],
    );
    const clarification = await handlePendingContactMemoryText(ctx, 'Лира');
    assert.equal(clarification, 'Нашла несколько вариантов, выбери нужный контакт кнопкой.');
    assert.equal(ctx.session.pendingContactMemory?.assertions?.length, 2);
    assert.deepEqual(
        ctx.session.pendingContactMemory?.assertions?.map(assertion => assertion.memoryMetadata?.predicate),
        ['works_with', 'relationship'],
    );

    const partialPending: PendingContactMemory = {
        contactName: 'Контакт Бета',
        content: 'Контакт Бета работает с пользователем',
        domain: 'work',
        importance: 0.8,
        tags: [],
        candidateIds: [],
        createdAt: Date.now(),
        resolvedPersonIdentityId: 'synthetic-person-id',
        assertions: [
            {
                content: 'Контакт Бета работает с пользователем',
                domain: 'work', importance: 0.8, tags: [],
                memoryMetadata: { predicate: 'works_with' },
            },
            {
                content: 'Контакт Бета — друг пользователя',
                domain: 'social', importance: 0.8, tags: [],
                memoryMetadata: { predicate: 'relationship' },
            },
        ],
    };
    const partialResult = await persistPendingContactFacts(
        ctx,
        partialPending,
        undefined,
        false,
        async (_ctx, fact) => fact.memoryMetadata?.predicate === 'works_with' ? '[Контакт Бета] работает' : null,
    );
    assert.equal(partialResult.savedContents.length, 1);
    assert.equal(partialResult.failedAssertions.length, 1);
    assert.equal(partialPending.assertions?.length, 1);
    assert.equal(partialPending.assertions?.[0]?.memoryMetadata?.predicate, 'relationship');
    assert.equal(partialPending.resolvedPersonIdentityId, 'synthetic-person-id');
    contacts.clearAllContacts();
}

checkAtomicPendingAssertions()
    .then(() => console.log("contactMemory matching checks passed"))
    .catch(error => {
        console.error(error);
        process.exit(1);
    });
