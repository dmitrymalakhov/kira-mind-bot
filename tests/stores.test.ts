import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { MessageStore, StoredMessage } from "../stores/MessageStore";
import { getRecentGroupMessages, pushGroupChatMessage } from "../stores/GroupChatBuffer";
import { ContactsStore } from "../stores/ContactsStore";
import {
    buildNegotiationStartKeyboard,
    buildNegotiationStopKeyboard,
    buildNegotiationSummaryText,
    NegotiationSession,
    NegotiationStore,
} from "../stores/NegotiationStore";

function storedMessage(overrides: Partial<StoredMessage> = {}): StoredMessage {
    return {
        id: 1,
        senderId: 10,
        senderName: "Алиса",
        text: "Привет",
        date: new Date(),
        isRead: false,
        isBot: false,
        ...overrides,
    };
}

describe("MessageStore", () => {
    const store = MessageStore.getInstance();

    beforeEach(() => store.clear());

    test("is a singleton", () => {
        assert.equal(MessageStore.getInstance(), store);
    });

    test("stores messages newest first", () => {
        store.addMessage("chat", storedMessage({ id: 1, date: new Date("2026-01-01T10:00:00Z") }));
        store.addMessage("chat", storedMessage({ id: 2, date: new Date("2026-01-01T12:00:00Z") }));
        assert.deepEqual(store.getMessages("chat").map((message) => message.id), [2, 1]);
    });

    test("ignores incoming bot messages", () => {
        store.addMessage("chat", storedMessage({ isBot: true, isOwn: false }));
        assert.deepEqual(store.getMessages("chat"), []);
        assert.equal(store.hasUnreadMessages(), false);
    });

    test("keeps outgoing owner messages even if marked as bot", () => {
        store.addMessage("chat", storedMessage({ isBot: true, isOwn: true }));
        assert.equal(store.getMessages("chat").length, 1);
    });

    test("updates a duplicate ID without losing its read state", () => {
        store.addMessage("chat", storedMessage({ id: 7, isRead: false, text: "old" }));
        store.markAsRead("chat");
        store.addMessage("chat", storedMessage({ id: 7, isRead: false, text: "edited" }));
        assert.deepEqual(store.getMessages("chat").map(({ text, isRead }) => ({ text, isRead })), [
            { text: "edited", isRead: true },
        ]);
    });

    test("tracks unread messages across chats", () => {
        store.addMessage("a", storedMessage({ id: 1 }));
        store.addMessage("b", storedMessage({ id: 2 }));
        assert.equal(store.hasUnreadMessages(), true);
        assert.equal(store.getUnreadMessages().length, 2);

        store.markAsRead("a");
        assert.equal(store.hasUnreadMessages(), true);
        assert.deepEqual(store.getUnreadMessages().map((item) => item.chatId), ["b"]);

        store.markAsRead("b");
        assert.equal(store.hasUnreadMessages(), false);
    });

    test("marks incoming messages as read through Telegram maxId", () => {
        store.addMessage("chat", storedMessage({ id: 3 }));
        store.addMessage("chat", storedMessage({ id: 4, isOwn: true }));
        store.addMessage("chat", storedMessage({ id: 5 }));

        store.markReadThrough("chat", 4);

        const byId = new Map(store.getMessages("chat").map(({ id, isRead }) => [id, isRead]));
        assert.equal(byId.get(3), true);
        assert.equal(byId.get(4), false);
        assert.equal(byId.get(5), false);
    });

    test("keeps equal Telegram message IDs isolated by chat", () => {
        store.addMessage("a", storedMessage({ id: 7 }));
        store.addMessage("b", storedMessage({ id: 7 }));
        store.markReadThrough("a", 7);

        assert.equal(store.getMessages("a")[0].isRead, true);
        assert.equal(store.getMessages("b")[0].isRead, false);
        assert.equal(store.hasUnreadMessages(), true);
    });

    test("marks every message as read", () => {
        store.addMessage("a", storedMessage({ id: 1 }));
        store.addMessage("b", storedMessage({ id: 2 }));
        store.markAllAsRead();
        assert.equal(store.hasUnreadMessages(), false);
        assert.deepEqual(store.getUnreadMessages(), []);
    });

    test("filters recent messages by age", () => {
        const now = Date.now();
        store.addMessage("chat", storedMessage({ id: 1, date: new Date(now - 30 * 60_000) }));
        store.addMessage("chat", storedMessage({ id: 2, date: new Date(now - 3 * 60 * 60_000) }));
        assert.deepEqual(store.getRecentMessages(1)[0].messages.map((message) => message.id), [1]);
    });

    test("returns thread arrays that can be mutated safely", () => {
        store.addMessage("chat", storedMessage());
        const threads = store.getRecentMessageThreads(1);
        threads[0].messages.length = 0;
        assert.equal(store.getMessages("chat").length, 1);
    });

    test("cleans up old messages and refreshes the unread flag", () => {
        store.addMessage("chat", storedMessage({ id: 1, date: new Date(Date.now() - 10 * 86_400_000) }));
        store.addMessage("chat", storedMessage({ id: 2, date: new Date() }));
        store.markAsRead("chat");
        store.addMessage("old", storedMessage({ id: 3, date: new Date(Date.now() - 10 * 86_400_000) }));

        store.cleanupOldMessages(7);
        assert.deepEqual(store.getMessages("chat").map((message) => message.id), [2]);
        assert.deepEqual(store.getMessages("old"), []);
        assert.equal(store.hasUnreadMessages(), false);
    });
});

describe("GroupChatBuffer", () => {
    let chatId = 700_000;

    beforeEach(() => { chatId += 1; });

    test("returns the last messages in chronological order", () => {
        for (let id = 1; id <= 5; id++) {
            pushGroupChatMessage(chatId, { senderName: "U", text: `m${id}`, date: new Date(), messageId: id });
        }
        assert.deepEqual(getRecentGroupMessages(chatId, { limit: 3 }).map((m) => m.messageId), [3, 4, 5]);
    });

    test("caps a chat buffer at thirty messages", () => {
        for (let id = 1; id <= 35; id++) {
            pushGroupChatMessage(chatId, { senderName: "U", text: `m${id}`, date: new Date(), messageId: id });
        }
        const messages = getRecentGroupMessages(chatId, { limit: 100 });
        assert.equal(messages.length, 30);
        assert.equal(messages[0].messageId, 6);
        assert.equal(messages.at(-1)?.messageId, 35);
    });

    test("excludes the current message by ID without dropping equal text", () => {
        pushGroupChatMessage(chatId, { senderName: "A", text: "same", date: new Date(), messageId: 1 });
        pushGroupChatMessage(chatId, { senderName: "B", text: "same", date: new Date(), messageId: 2 });
        assert.deepEqual(getRecentGroupMessages(chatId, { excludeMessageId: 2 }).map((m) => m.messageId), [1]);
    });

    test("supports the legacy excludeText argument", () => {
        pushGroupChatMessage(chatId, { senderName: "A", text: "old", date: new Date(), messageId: 1 });
        pushGroupChatMessage(chatId, { senderName: "B", text: "current", date: new Date(), messageId: 2 });
        assert.deepEqual(getRecentGroupMessages(chatId, "current", 10).map((m) => m.text), ["old"]);
    });

    test("keeps different chats isolated", () => {
        pushGroupChatMessage(chatId, { senderName: "A", text: "one", date: new Date() });
        pushGroupChatMessage(chatId + 1000, { senderName: "B", text: "two", date: new Date() });
        assert.deepEqual(getRecentGroupMessages(chatId).map((m) => m.text), ["one"]);
        assert.deepEqual(getRecentGroupMessages(chatId + 1000).map((m) => m.text), ["two"]);
    });
});

describe("ContactsStore", () => {
    const store = ContactsStore.getInstance();

    beforeEach(() => {
        assert.equal(store.deserialize(JSON.stringify({
            contacts: [],
            scheduledMessages: [],
            nextMessageId: 1,
            isInitialized: false,
        })), true);
    });

    test("saves, reads, updates, and deletes contacts", () => {
        store.saveContact({ id: 1, firstName: "Анна" });
        assert.equal(store.getContact(1)?.firstName, "Анна");
        store.saveContact({ id: 1, firstName: "Аня" });
        assert.equal(store.getAllContacts().length, 1);
        assert.equal(store.getContact(1)?.firstName, "Аня");
        assert.equal(store.deleteContact(1), true);
        assert.equal(store.deleteContact(1), false);
    });

    test("finds contacts by Cyrillic, transliteration, surname, and username", () => {
        store.saveContact({ id: 1, firstName: "Алексей", lastName: "Смирнов", username: "alex_sm" });
        store.saveContact({ id: 2, firstName: "Мария", lastName: "Петрова", username: "masha" });
        assert.equal(store.searchContactsByName("Алексей", 1)[0].id, 1);
        assert.equal(store.searchContactsByName("Aleksey", 1)[0].id, 1);
        assert.equal(store.searchContactsByName("Петрова", 1)[0].id, 2);
        assert.equal(store.searchContactsByName("masha", 1)[0].id, 2);
        assert.equal(store.searchContactsByName("Мария Петрова", 1)[0].id, 2);
    });

    test("handles tags, favorites, notes, and interaction time", () => {
        store.saveContact({ id: 1, firstName: "Анна" });
        assert.equal(store.addTagToContact(1, "work"), true);
        assert.equal(store.addTagToContact(1, "work"), true);
        assert.deepEqual(store.getContactsByTag("work").map((c) => c.id), [1]);
        assert.deepEqual(store.getContact(1)?.tags, ["work"]);
        assert.deepEqual(store.toggleFavorite(1), { success: true, isFavorite: true });
        assert.deepEqual(store.getFavoriteContacts().map((c) => c.id), [1]);
        assert.equal(store.updateContactNotes(1, "Познакомились на работе"), true);
        const interaction = new Date("2026-04-05T12:00:00Z");
        assert.equal(store.updateLastInteraction(1, interaction), true);
        assert.equal(store.getContact(1)?.lastInteraction, interaction);
        assert.equal(store.removeTagFromContact(1, "work"), true);
        assert.equal(store.removeTagFromContact(1, "work"), false);
    });

    test("returns failures for missing contacts", () => {
        assert.equal(store.addTagToContact(404, "work"), false);
        assert.equal(store.removeTagFromContact(404, "work"), false);
        assert.deepEqual(store.toggleFavorite(404), { success: false });
        assert.equal(store.updateContactNotes(404, "note"), false);
        assert.equal(store.updateLastInteraction(404), false);
    });

    test("schedules and filters outgoing messages", () => {
        const first = store.scheduleMessage(1, "Первое", new Date("2026-05-01T10:00:00Z"), true, 99);
        const second = store.scheduleMessage(2, "Второе", new Date("2026-05-02T10:00:00Z"));
        assert.equal(first.id, 1);
        assert.equal(second.id, 2);
        assert.equal(first.notifyOnReply, true);
        assert.equal(first.originalChatId, 99);
        assert.equal(store.getPendingMessages().length, 2);
        assert.deepEqual(store.getScheduledMessagesForContact(1).map((m) => m.id), [1]);
        assert.equal(store.updateMessageStatus(first.id, "sent"), true);
        assert.equal(store.updateMessageId(first.id, 321), true);
        assert.equal(store.getScheduledMessage(first.id)?.messageId, 321);
        assert.deepEqual(store.getScheduledMessagesForContact(1, "sent").map((m) => m.id), [1]);
        assert.equal(store.cancelScheduledMessage(second.id), true);
        assert.equal(store.getPendingMessages().length, 0);
    });

    test("returns false when updating an unknown scheduled message", () => {
        assert.equal(store.updateMessageStatus(404, "failed"), false);
        assert.equal(store.updateMessageId(404, 12), false);
        assert.equal(store.cancelScheduledMessage(404), false);
    });

    test("round-trips contacts, messages, and Date fields through JSON", () => {
        store.saveContact({ id: 1, firstName: "Анна", lastInteraction: new Date("2026-01-01T00:00:00Z") });
        store.scheduleMessage(1, "Привет", new Date("2026-02-01T12:00:00Z"));
        const serialized = store.serialize();
        store.clearAllContacts();
        assert.equal(store.deserialize(serialized), true);
        assert.equal(store.getContact(1)?.firstName, "Анна");
        assert.ok(store.getScheduledMessage(1)?.scheduledTime instanceof Date);
        assert.ok(store.getScheduledMessage(1)?.createdAt instanceof Date);
    });
});

describe("NegotiationStore and presentation", () => {
    let sequence = 0;

    function session(overrides: Partial<NegotiationSession> = {}): NegotiationSession {
        sequence += 1;
        return {
            contactId: 10_000 + sequence,
            contactName: "Анна",
            originalChatId: 20_000 + sequence,
            taskDescription: "Согласовать встречу",
            history: [],
            createdAt: new Date(),
            ...overrides,
        };
    }

    test("formats roles and strips Markdown markers from summary", () => {
        const value = session({
            history: [
                { role: "bot", text: "Предлагаю вторник" },
                { role: "contact", text: "Лучше среда" },
                { role: "user", text: "Соглашайся" },
            ],
        });
        const summary = buildNegotiationSummaryText(value, { appendWaiting: "Жду решения" });
        assert.match(summary, /Переговоры с Анна/);
        assert.match(summary, /Мы: Предлагаю вторник/);
        assert.match(summary, /Контакт: Лучше среда/);
        assert.match(summary, /Ты: Соглашайся/);
        assert.match(summary, /Жду решения/);
        assert.doesNotMatch(summary, /\*\*/);
    });

    test("caps Telegram summary length", () => {
        const summary = buildNegotiationSummaryText(session({ history: [{ role: "bot", text: "x".repeat(5000) }] }));
        assert.ok(summary.length <= 4000);
        assert.ok(summary.length >= 3990);
        assert.equal(summary.endsWith("…"), true);
    });

    test("builds stable start and stop callbacks", () => {
        const start = (buildNegotiationStartKeyboard() as any).inline_keyboard;
        const stop = (buildNegotiationStopKeyboard() as any).inline_keyboard;
        assert.equal(start[0][0].callback_data, "negotiation_start");
        assert.equal(stop[0][0].callback_data, "negotiation_stop");
    });

    test("stores, updates, looks up, and deletes sessions", () => {
        const value = session({ waitingForUserReply: true });
        NegotiationStore.set(value);
        assert.equal(NegotiationStore.get(value.originalChatId, value.contactId), value);
        assert.equal(NegotiationStore.getByChatId(value.originalChatId), value);
        assert.equal(NegotiationStore.getActiveSessionByChatId(value.originalChatId), value);
        NegotiationStore.update(value.originalChatId, value.contactId, { taskDescription: "Новая задача" });
        assert.equal(NegotiationStore.get(value.originalChatId, value.contactId)?.taskDescription, "Новая задача");
        assert.equal(NegotiationStore.delete(value.originalChatId, value.contactId), true);
        assert.equal(NegotiationStore.delete(value.originalChatId, value.contactId), false);
    });

    test("manages pending negotiation starts", () => {
        const chatId = 80_000 + sequence++;
        const pending = { contactId: 1, contactName: "Иван", taskDescription: "Задача", firstMessageText: "Привет" };
        NegotiationStore.setPendingStart(chatId, pending);
        assert.deepEqual(NegotiationStore.getPendingStart(chatId), pending);
        assert.equal(NegotiationStore.clearPendingStart(chatId), true);
        assert.equal(NegotiationStore.clearPendingStart(chatId), false);
    });

    test("invokes notification and summary callbacks", async () => {
        const notifications: Array<[number, string]> = [];
        const edits: Array<[number, number, string]> = [];
        NegotiationStore.setNotifyInBotChat(async (chatId, text) => { notifications.push([chatId, text]); });
        NegotiationStore.setEditSummaryCallback(async (chatId, messageId, text) => { edits.push([chatId, messageId, text]); });
        await NegotiationStore.notifyUser(5, "Вопрос");
        await NegotiationStore.editSummary(5, 10, "Сводка");
        assert.deepEqual(notifications, [[5, "Вопрос"]]);
        assert.deepEqual(edits, [[5, 10, "Сводка"]]);
    });
});
