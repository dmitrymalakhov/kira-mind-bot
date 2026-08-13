import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { InlineKeyboard } from "grammy";
import type { Reminder } from "../reminder";
import { ReminderRegistry } from "../stores/ReminderRegistry";
import { ReminderStatus } from "../types/reminderTypes";
import {
    addTargetNotificationButtons,
    appendTargetNotificationPrompt,
    buildDefaultTargetReminderMessage,
    buildTargetNotificationCallback,
    parseTargetNotificationCallback,
    removeTargetNotificationButtons,
    targetChatHumanLabel,
} from "../utils/reminderTargetNotification";
import {
    REMINDERS_PAGE_SIZE,
    buildChatPicker,
    buildPostponeKeyboard,
    buildReminderCard,
    buildReminderOpenCommand,
    buildRemindersList,
    filterReminders,
    getActiveReminders,
    getReminderCommandCode,
    getReminderListStats,
    parseReminderOpenCommand,
    parseReminderPanelOrigin,
    resolveReminderCallbackRef,
    resolveReminderCommandCode,
} from "../utils/reminderCard";
import { renderFallbackHtml } from "../utils/richMessage";
import { selectPersonalityGenderText } from "../utils/personalityGender";

const registry = ReminderRegistry.getInstance();
const addedIds: string[] = [];
let sequence = 0;

function reminder(overrides: Partial<Reminder> = {}): Reminder {
    sequence += 1;
    const value: Reminder = {
        id: `test-reminder-${process.pid}-${sequence}`,
        text: `Тест ${sequence}`,
        dueDate: new Date(Date.now() + 3_600_000),
        chatId: 900_000 + sequence,
        status: ReminderStatus.Pending,
        createdAt: new Date(),
        ...overrides,
    };
    return value;
}

function add(value: Reminder): Reminder {
    registry.add(value);
    addedIds.push(value.id);
    return value;
}

function rows(keyboard: InlineKeyboard): any[][] {
    return (keyboard as any).inline_keyboard;
}

afterEach(() => {
    for (const id of addedIds.splice(0)) registry.remove(id);
});

describe("ReminderRegistry", () => {
    test("returns future pending reminders ordered by due date", () => {
        const chatId = 910_001;
        const later = add(reminder({ chatId, dueDate: new Date(Date.now() + 20_000) }));
        const sooner = add(reminder({ chatId, dueDate: new Date(Date.now() + 10_000) }));
        assert.deepEqual(registry.getActiveByChatId(chatId).map((r) => r.id), [sooner.id, later.id]);
    });

    test("keeps sent and expired reminders actionable", () => {
        const chatId = 910_002;
        const sent = add(reminder({ chatId, dueDate: new Date(0), status: ReminderStatus.Sent }));
        const expired = add(reminder({ chatId, dueDate: new Date(0), status: ReminderStatus.Expired }));
        assert.deepEqual(new Set(registry.getActiveByChatId(chatId).map((r) => r.id)), new Set([sent.id, expired.id]));
    });

    test("excludes completed and overdue pending reminders", () => {
        const chatId = 910_003;
        add(reminder({ chatId, status: ReminderStatus.Completed }));
        add(reminder({ chatId, dueDate: new Date(Date.now() - 1000), status: ReminderStatus.Pending }));
        assert.deepEqual(registry.getActiveByChatId(chatId), []);
    });

    test("moves the chat index when an existing reminder changes chat", () => {
        const value = add(reminder({ chatId: 910_004 }));
        registry.add({ ...value, chatId: 910_005 });
        assert.deepEqual(registry.getActiveByChatId(910_004), []);
        assert.deepEqual(registry.getActiveByChatId(910_005).map((r) => r.id), [value.id]);
    });

    test("removes reminders from both indexes", () => {
        const value = add(reminder({ chatId: 910_006 }));
        registry.remove(value.id);
        assert.equal(registry.get(value.id), undefined);
        assert.deepEqual(registry.getActiveByChatId(value.chatId), []);
    });

    test("summarizes active chats and puts personal chat first", () => {
        add(reminder({ chatId: -1001, chatTitle: "Рабочая группа" }));
        add(reminder({ chatId: 12345, chatTitle: "Личный чат" }));
        add(reminder({ chatId: -1001, chatTitle: "Рабочая группа" }));
        const chats = registry.getChatsWithActive().filter((c) => c.chatId === -1001 || c.chatId === 12345);
        assert.deepEqual(chats, [
            { chatId: 12345, title: "Личный чат", count: 1 },
            { chatId: -1001, title: "Рабочая группа", count: 2 },
        ]);
    });

    test("uses fallback labels when chat titles are missing", () => {
        add(reminder({ chatId: 77777, chatTitle: undefined }));
        add(reminder({ chatId: -77777, chatTitle: undefined }));
        const labels = new Map(registry.getChatsWithActive().map((c) => [c.chatId, c.title]));
        assert.equal(labels.get(77777), "🏠 Личный чат");
        assert.equal(labels.get(-77777), "Группа");
    });
});

describe("target reminder notifications", () => {
    test("builds human labels for groups and contacts", () => {
        assert.equal(targetChatHumanLabel({ type: "group", groupName: "Команда" }), "чат «Команда»");
        assert.equal(targetChatHumanLabel({ type: "contact", contactQuery: "Анна" }), "контакт «Анна»");
    });

    test("builds a default message without losing reminder text", () => {
        const result = buildDefaultTargetReminderMessage("проверить документы");
        assert.match(result, /^Напоминаю по поручению .+: проверить документы$/);
    });

    test("round-trips valid callback data", () => {
        for (const action of ["enable", "disable"] as const) {
            const callback = buildTargetNotificationCallback(action, "id:with:colons");
            assert.deepEqual(parseTargetNotificationCallback(callback), { action, reminderId: "id:with:colons" });
        }
    });

    test("rejects malformed callback data", () => {
        for (const value of ["", "reminder_notify", "reminder_notify:maybe:id", "reminder_notify:enable:", "other:enable:id"]) {
            assert.equal(parseTargetNotificationCallback(value), null, value);
        }
    });

    test("does not append a prompt without targets", () => {
        assert.equal(appendTargetNotificationPrompt("Готово", [{ id: "1" }]), "Готово");
    });

    test("appends a specific prompt for one target", () => {
        const reminders = [
            { id: "1", targetChat: { type: "group" as const, groupName: "Команда" } },
        ];
        const femaleResult = appendTargetNotificationPrompt(
            "Готово",
            reminders,
            (feminine, masculine) => selectPersonalityGenderText("женский", feminine, masculine),
        );
        const maleResult = appendTargetNotificationPrompt(
            "Готово",
            reminders,
            (feminine, masculine) => selectPersonalityGenderText("мужской", feminine, masculine),
        );
        assert.match(femaleResult, /Я нашла адресата: чат «Команда»/);
        assert.match(maleResult, /Я нашёл адресата: чат «Команда»/);
        assert.match(maleResult, /Оповестить адресата/);
    });

    test("appends a plural prompt for several targets", () => {
        const result = appendTargetNotificationPrompt("Готово", [
            { id: "1", targetChat: { type: "group", groupName: "Команда" } },
            { id: "2", targetChat: { type: "contact", contactQuery: "Анна" } },
        ]);
        assert.match(result, /адресатов в нескольких напоминаниях/);
    });

    test("adds two buttons per targeted reminder and truncates long labels", () => {
        const keyboard = addTargetNotificationButtons(new InlineKeyboard(), [
            { id: "1", targetChat: { type: "group", groupName: "Очень длинное название рабочего чата команды" } },
            { id: "2" },
            { id: "3", targetChat: { type: "contact", contactQuery: "Анна" } },
        ]);
        assert.equal(rows(keyboard).length, 2);
        assert.equal(rows(keyboard)[0].length, 2);
        assert.equal(rows(keyboard)[0][0].callback_data, "reminder_notify:enable:1");
        assert.equal(rows(keyboard)[0][0].text.endsWith("..."), true);
        assert.equal(rows(keyboard)[1][1].callback_data, "reminder_notify:disable:3");
    });

    test("removes only notification buttons for the selected reminder", () => {
        const source = [
            [
                { text: "Enable 1", callback_data: "reminder_notify:enable:1" },
                { text: "Disable 1", callback_data: "reminder_notify:disable:1" },
            ],
            [
                { text: "Enable 2", callback_data: "reminder_notify:enable:2" },
                { text: "Site", url: "https://example.com" },
            ],
        ];
        assert.deepEqual(removeTargetNotificationButtons(source as any, "1"), [source[1]]);
        assert.deepEqual(removeTargetNotificationButtons(undefined, "1"), []);
    });
});

describe("reminder cards and keyboards", () => {
    test("reads reminders from the current chat", () => {
        const value = add(reminder({ chatId: 920_001 }));
        const ctx = { chat: { id: 920_001 }, session: {} } as any;
        assert.deepEqual(getActiveReminders(ctx).map((r) => r.id), [value.id]);
    });

    test("uses persisted cross-chat selection only in a private chat", () => {
        const group = add(reminder({ chatId: -920_002 }));
        const personal = add(reminder({ chatId: 920_002 }));
        const privateCtx = { chat: { id: 920_002, type: "private" }, session: { viewingRemindersInChat: -920_002 } } as any;
        const groupCtx = { chat: { id: 920_002, type: "group" }, session: { viewingRemindersInChat: -920_002 } } as any;
        assert.deepEqual(getActiveReminders(privateCtx).map((r) => r.id), [group.id]);
        assert.deepEqual(getActiveReminders(groupCtx).map((r) => r.id), [personal.id]);
    });

    test("keeps the legacy chat picker callbacks available", () => {
        const picker = buildChatPicker([
            { chatId: 1, title: "Личный чат", count: 2 },
            { chatId: -2, title: "Группа", count: 1 },
        ]);
        assert.deepEqual(rows(picker.keyboard).flat().map(button => button.callback_data), [
            "reminder_chat_1",
            "reminder_chat_-2",
        ]);
    });

    test("uses displayText, status, recurrence, and target details in a card", () => {
        const value = reminder({
            text: "raw",
            displayText: "Проверить отчёт",
            dueDate: new Date("2026-01-02T12:30:00Z"),
            status: ReminderStatus.Postponed,
            recurrence: { type: "weekly", interval: 1, daysOfWeek: [1, 5] },
            targetChat: { type: "group", groupName: "Команда" },
            targetChatNotifyStatus: "enabled",
        });
        const card = buildReminderCard([value], 0, true);
        const text = renderFallbackHtml(card.blocks);
        assert.match(text, /Проверить отчёт/);
        assert.doesNotMatch(text, /\braw\b/);
        assert.match(text, /Отложено/);
        assert.match(text, /Каждую неделю \(пн, пт\)/);
        assert.match(text, /чат «Команда» \(оповестить\)/);
        assert.equal(rows(card.keyboard).flat().some((button) => button.callback_data === "reminder_chat_back"), true);
    });

    test("builds navigation callbacks for first, middle, and last cards", () => {
        const reminders = [reminder(), reminder(), reminder()];
        const first = rows(buildReminderCard(reminders, 0).keyboard).flat();
        const middle = rows(buildReminderCard(reminders, 1).keyboard).flat();
        const last = rows(buildReminderCard(reminders, 2).keyboard).flat();
        assert.equal(first.filter((b) => b.text === "·")[0].callback_data, "reminders_nav_noop");
        assert.equal(middle.find((b) => b.text === "◀️").callback_data, "reminders_card_0");
        assert.equal(middle.find((b) => b.text === "▶️").callback_data, "reminders_card_2");
        assert.equal(last.find((b) => b.text === "·").callback_data, "reminders_nav_noop");
    });

    test("builds all postpone choices for the correct reminder", () => {
        const value = reminder({ id: "abc" });
        const buttons = rows(buildPostponeKeyboard(value)).flat();
        assert.equal(buttons.length, 9);
        assert.equal(buttons.every((b) => /^postpone_~[a-f0-9]{20}_(15|30|60|180|evening|tomorrow|week|custom|back)$/.test(b.callback_data)), true);
    });

    test("keeps filter and page in card actions without exceeding callback limits", () => {
        const value = reminder({ id: "1770000000000-health-followup-12345678-24" });
        const origin = { filter: "recurring" as const, page: 12345 };
        const callbacks = [
            ...rows(buildReminderCard([value], 0, false, origin).keyboard).flat(),
            ...rows(buildPostponeKeyboard(value, origin)).flat(),
        ].map(button => button.callback_data);
        assert.equal(callbacks.every(value => Buffer.byteLength(value, "utf8") <= 64), true);
        assert.equal(callbacks.includes("reminders_page_recurring_12345"), true);
        assert.equal(callbacks.some(value => value.endsWith(":p:r:9ix")), true);
        assert.deepEqual(parseReminderPanelOrigin("~0123456789abcdef0123:p:r:9ix"), {
            value: "~0123456789abcdef0123",
            origin: { filter: "recurring", page: 12345 },
        });
        const callbackRef = callbacks.find(callback => callback.startsWith("reminder_complete_"))!
            .match(/^reminder_complete_([^:]+)/)?.[1];
        assert.equal(resolveReminderCallbackRef([value], callbackRef!)?.id, value.id);
    });

    test("builds a compact reminder list and clamps the page", () => {
        const values = [
            reminder({ text: "Первое", recurrence: { type: "daily", interval: 2 } }),
            reminder({ text: "Второе", status: ReminderStatus.Sent, targetChat: { type: "contact", contactQuery: "Иван" } }),
        ];
        const list = buildRemindersList(values, { page: 99, botUsername: "kira_bot" });
        const text = renderFallbackHtml(list.blocks);
        assert.match(text, /Напоминания · 2/);
        assert.match(text, /Ожидает ответа/);
        assert.match(text, /\/r_[a-f0-9]{10}_a_0@kira_bot/);
        assert.equal(list.page, 0);
        assert.equal(list.totalPages, 1);
    });

    test("splits reminders into deterministic timezone filters", () => {
        const now = new Date("2026-08-11T09:00:00Z"); // 12:00 Europe/Moscow
        const values = [
            reminder({ dueDate: new Date("2026-08-11T18:00:00Z") }),
            reminder({ dueDate: new Date("2026-08-12T08:00:00Z") }),
            reminder({ dueDate: new Date("2026-08-18T08:00:00Z") }),
            reminder({ dueDate: new Date("2026-08-19T08:00:00Z") }),
            reminder({ dueDate: new Date("2026-08-20T08:00:00Z"), recurrence: { type: "daily", interval: 1 } }),
            reminder({ dueDate: new Date("2026-08-10T08:00:00Z"), status: ReminderStatus.Expired }),
        ];
        const stats = getReminderListStats(values, now);
        assert.deepEqual(stats, { total: 6, attention: 1, today: 1, week: 2, later: 2, recurring: 1 });
        assert.equal(filterReminders(values, "today", now).length, 1);
        assert.equal(filterReminders(values, "week", now).length, 2);
        assert.equal(filterReminders(values, "later", now).length, 2);
        assert.equal(filterReminders(values, "attention", now)[0].status, ReminderStatus.Expired);
    });

    test("paginates eight reminders and offers first, neighbor, and last pages", () => {
        const values = Array.from({ length: REMINDERS_PAGE_SIZE * 4 + 1 }, (_, index) => reminder({
            dueDate: new Date(Date.now() + (index + 1) * 60_000),
        }));
        const view = buildRemindersList(values, { page: 2 });
        assert.equal(view.filteredReminders.length, values.length);
        assert.equal(view.page, 2);
        assert.equal(view.totalPages, 5);
        const callbacks = rows(view.keyboard).flat().map(button => button.callback_data);
        assert.equal(callbacks.includes("reminders_page_all_0"), true);
        assert.equal(callbacks.includes("reminders_page_all_1"), true);
        assert.equal(callbacks.includes("reminders_page_all_3"), true);
        assert.equal(callbacks.includes("reminders_page_all_4"), true);

        assert.equal(buildRemindersList(values.slice(0, 8)).totalPages, 1);
        assert.equal(buildRemindersList(values.slice(0, 9)).totalPages, 2);
    });

    test("round-trips a short clickable command and keeps panel origin", () => {
        const values = [reminder({ id: "long-arbitrary-reminder-id-one" }), reminder({ id: "other-id" })];
        const command = buildReminderOpenCommand(values[0], values, { filter: "today", page: 35 }, "kira_bot");
        const parsed = parseReminderOpenCommand(command);
        assert.ok(parsed);
        assert.match(command, /^\/r_[a-f0-9]{10,20}_t_z@kira_bot$/);
        assert.ok(command.slice(1).split("@")[0].length <= 32);
        assert.equal(resolveReminderCommandCode(values, parsed!.code)?.id, values[0].id);
        assert.equal(getReminderCommandCode(values[0], values), parsed!.code);
        assert.deepEqual(parseReminderPanelOrigin("123:p:today:35"), {
            value: "123",
            origin: { filter: "today", page: 35 },
        });
    });

    test("does not resolve missing or ambiguous short codes", () => {
        const duplicate = reminder({ id: "same" });
        assert.equal(resolveReminderCommandCode([duplicate], "deadbeef00"), undefined);
        assert.equal(resolveReminderCommandCode([duplicate, { ...duplicate, chatId: duplicate.chatId + 1 }], getReminderCommandCode(duplicate, [duplicate])), undefined);
    });
});
