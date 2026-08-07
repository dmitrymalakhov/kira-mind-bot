import assert from "node:assert/strict";
import { describe, test } from "node:test";
import bigInt from "big-integer";
import { Api, TelegramClient } from "telegram";
import { config } from "../config";
import { dmMessageKey, selectAgedUnreadMessages, syncUnreadMessagesFromTelegram } from "../services/dmReportScheduler";
import {
    InboxThreadCandidate,
    normalizeLLMItems,
    selectDaytimeContext,
    sendDaytimeReflection,
    shouldRunDaytimeReflection,
    hasDaytimeSourceOverlap,
    filterDaytimeSourcesFromThreads,
} from "../services/inboxGuardianScheduler";
import { StoredMessage } from "../stores/MessageStore";
import { MessageStore } from "../stores/MessageStore";

function message(id: number, ageMinutes: number, chatId = "chat"): StoredMessage & { chatId: string } {
    return {
        chatId,
        id,
        senderId: chatId,
        senderName: "Тестовый контакт",
        text: `Сообщение ${id}`,
        date: new Date(Date.now() - ageMinutes * 60_000),
        isRead: false,
        isBot: false,
    };
}

describe("DM Report", () => {
    test("waits for unread age and only includes Telegram-confirmed unread", () => {
        const oldUnread = message(1, 31);
        const freshUnread = message(2, 29);
        const staleLocal = message(3, 60);
        const confirmed = new Set([dmMessageKey("chat", 1), dmMessageKey("chat", 2)]);

        const selected = selectAgedUnreadMessages(
            [{ chatId: "chat", messages: [oldUnread, freshUnread, staleLocal] }],
            confirmed,
            {},
            Date.now(),
            30 * 60_000,
        );

        assert.deepEqual(selected.map(item => item.id), [1]);
    });

    test("uses chatId with messageId and suppresses already reported messages after restart", () => {
        const firstChat = message(7, 60, "a");
        const secondChat = message(7, 60, "b");
        const confirmed = new Set([dmMessageKey("a", 7), dmMessageKey("b", 7)]);
        const persisted = { [dmMessageKey("a", 7)]: "2026-07-21T10:00:00.000Z" };

        const selected = selectAgedUnreadMessages(
            [
                { chatId: "a", messages: [firstChat] },
                { chatId: "b", messages: [secondChat] },
            ],
            confirmed,
            persisted,
            Date.now(),
            30 * 60_000,
        );

        assert.deepEqual(selected.map(item => item.chatId), ["b"]);
    });

    test("restores only Telegram unread dialogs and applies reads from another client", async () => {
        const store = MessageStore.getInstance();
        store.clear();
        store.addMessage("42", message(3, 60));
        const user = new Api.User({ id: bigInt(42), firstName: "Контакт Альфа" });
        const peer = new Api.PeerUser({ userId: bigInt(42) });
        const rawDialog = new Api.Dialog({
            peer,
            topMessage: 5,
            readInboxMaxId: 3,
            readOutboxMaxId: 0,
            unreadCount: 2,
            unreadMentionsCount: 0,
            unreadReactionsCount: 0,
            notifySettings: new Api.PeerNotifySettings({}),
        });
        const readUser = new Api.User({ id: bigInt(84), firstName: "Прочитанный" });
        const readPeer = new Api.PeerUser({ userId: bigInt(84) });
        let fetchedUnread = 0;
        let fetchedRead = 0;
        let requestedDialogLimit = 0;
        const client = {
            getDialogs: async (options: { limit: number }) => {
                requestedDialogLimit = options.limit;
                return [
                    { isUser: true, entity: user, id: bigInt(42), dialog: rawDialog, unreadCount: 2, inputEntity: peer, name: "Контакт Альфа" },
                    { isUser: true, entity: readUser, id: bigInt(84), dialog: { readInboxMaxId: 99 }, unreadCount: 0, inputEntity: readPeer, name: "Прочитанный" },
                ];
            },
            getMessages: async (input: unknown, options: { minId: number }) => {
                if (input === readPeer) {
                    fetchedRead += 1;
                    return [];
                }
                assert.equal(input, peer);
                assert.equal(options.minId, 3);
                fetchedUnread += 1;
                return [4, 5].map(id => new Api.Message({ id, peerId: peer, date: Math.floor(Date.now() / 1000), message: `m${id}`, out: false }));
            },
        } as unknown as TelegramClient;

        const confirmed = await syncUnreadMessagesFromTelegram(client, store);
        assert.equal(fetchedUnread, 1);
        assert.equal(fetchedRead, 0);
        assert.equal(requestedDialogLimit, config.dmReportDialogLimit);
        assert.deepEqual([...confirmed], [dmMessageKey("42", 4), dmMessageKey("42", 5)]);
        assert.equal(store.getMessages("42").find(item => item.id === 3)?.isRead, true);
    });
});

describe("Inbox Guardian reflection", () => {
    const thread: InboxThreadCandidate = {
        chatId: "42",
        senderName: "Тестовый контакт",
        lastIncomingAt: new Date(),
        latestAt: new Date(),
        messages: [message(101, 60)],
    };

    test("requires opinion, real sources and limits output to three observations", () => {
        const complete = {
            signalType: "request" as const,
            observation: "Тестовый контакт ждёт срок документа",
            whyImportant: "Без срока работа заблокирована",
            kiraView: "Я бы не отвечала общим «скоро»",
            suggestedAction: "Назвать дату",
            sourceMessageIds: [101],
            confidence: 0.9,
        };
        const result = normalizeLLMItems({
            items: [
                { chatId: "42", ...complete },
                { chatId: "43", ...complete },
                { chatId: "44", ...complete },
                { chatId: "45", ...complete },
            ],
        }, [
            thread,
            { ...thread, chatId: "43" },
            { ...thread, chatId: "44" },
            { ...thread, chatId: "45" },
        ]);

        assert.equal(result.length, 3);
        assert.ok(result.every(item => item.kiraView && item.sourceMessageIds[0] === 101));
    });

    test("suppresses unread-only and ungrounded AI output", () => {
        const base = {
            chatId: "42",
            observation: "Сообщение не прочитано",
            whyImportant: "Оно ждёт",
            kiraView: "Стоит открыть",
            suggestedAction: "Прочитать",
            confidence: 0.95,
        };
        assert.deepEqual(normalizeLLMItems({ items: [
            { ...base, signalType: "unread", sourceMessageIds: [101] },
            { ...base, signalType: "request", sourceMessageIds: [999] },
        ] }, [thread]), []);
    });

    test("daytime mode requires a source from the new fragment and higher confidence", () => {
        const item = {
            chatId: "42",
            signalType: "plan_change" as const,
            observation: "Срок встречи изменился",
            whyImportant: "Старый план больше не действует",
            kiraView: "Я бы сразу перепроверила календарь",
            suggestedAction: "Подтвердить новое время",
            sourceMessageIds: [101],
            confidence: 0.81,
        };
        assert.deepEqual(normalizeLLMItems({ items: [item] }, [thread], {
            maxItems: 1,
            minConfidence: 0.82,
            requiredSourceMessageIds: new Set([202]),
        }), []);

        const newThread = { ...thread, messages: [...thread.messages, message(202, 1)] };
        const result = normalizeLLMItems({ items: [{
            ...item,
            sourceMessageIds: [101, 202],
            confidence: 0.9,
        }] }, [newThread], {
            maxItems: 1,
            minConfidence: 0.82,
            requiredSourceMessageIds: new Set([202]),
        });
        assert.equal(result.length, 1);
        assert.deepEqual(result[0].sourceMessageIds, [101, 202]);
    });

    test("daytime context keeps focus messages outside the newest-message window", () => {
        const messages = Array.from({ length: 14 }, (_, index) => message(200 + index, index + 1));
        const focused = messages[13];
        const selected = selectDaytimeContext(messages, new Set([focused.id]));

        assert.equal(selected.length, 13);
        assert.ok(selected.some(item => item.id === focused.id));
    });

    test("daytime reflection can be disabled independently", async () => {
        const original = config.daytimeReflectionEnabled;
        config.daytimeReflectionEnabled = false;
        try {
            const sent = await sendDaytimeReflection({} as never, { chatId: "42", currentMessageIds: [101] });
            assert.equal(sent, false);
        } finally {
            config.daytimeReflectionEnabled = original;
        }
    });

    test("daytime reflection requires a critical signal and allows only two cards per day", () => {
        assert.equal(shouldRunDaytimeReflection(false, 0), false);
        assert.equal(shouldRunDaytimeReflection(true, 0), true);
        assert.equal(shouldRunDaytimeReflection(true, 1), true);
        assert.equal(shouldRunDaytimeReflection(true, 2), false);
    });

    test("evening guardian suppresses sources already shown during the day", () => {
        const item = { chatId: "42", sourceMessageIds: [101, 102] };
        assert.equal(hasDaytimeSourceOverlap(item, new Set(["42:102"])), true);
        assert.equal(hasDaytimeSourceOverlap(item, new Set(["43:102"])), false);
    });

    test("removes daytime sources before evening Guardian analysis but keeps newer messages", () => {
        const older = message(101, 120, "42");
        const newer = message(102, 30, "42");
        const filtered = filterDaytimeSourcesFromThreads([{
            ...thread,
            messages: [older, newer],
            lastIncomingAt: older.date,
            latestAt: newer.date,
        }], new Set(["42:101"]));

        assert.equal(filtered.length, 1);
        assert.deepEqual(filtered[0].messages.map(item => item.id), [102]);
        assert.equal(filtered[0].lastIncomingAt.getTime(), newer.date.getTime());
    });
});
