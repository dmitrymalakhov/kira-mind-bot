import assert from "node:assert/strict";
import type { Reminder } from "../reminder";
import { todayImportanceTestUtils } from "../utils/todayImportance";

const day = {
    key: "2026-06-20",
    label: "суббота, 20 июня 2026 г.",
    shortDate: "20.06.2026",
    day: 20,
    month: 6,
    year: 2026,
};

const legacyMemory = {
    id: "memory-1",
    content: "Встреча с Алексеем и Марией по найму фронтенда — 20 июня 2026 в 10:00.",
    domain: "work",
    timestamp: new Date("2026-06-19T12:00:00.000Z"),
    importance: 0.9,
    tags: ["temporal_scope:future_plan", "status:planned"],
    status: "planned",
    memoryKind: "event",
};

const movedReminder: Reminder = {
    id: "reminder-1",
    text: "Встреча с Алексеем и Марией по найму фронтенда",
    displayText: "Встреча с Алексеем и Марией по найму фронтенда",
    dueDate: new Date("2026-06-26T06:00:00.000Z"),
    chatId: 1,
    createdAt: new Date("2026-06-19T09:00:00.000Z"),
};

assert.equal(
    todayImportanceTestUtils.findReminderConflict(legacyMemory as any, [movedReminder], day as any, "Europe/Moscow"),
    "похожее напоминание перенесено на другую дату"
);

const movedTimeReminder: Reminder = {
    ...movedReminder,
    dueDate: new Date("2026-06-20T11:30:00.000Z"),
};

assert.equal(
    todayImportanceTestUtils.findReminderConflict(legacyMemory as any, [movedTimeReminder], day as any, "Europe/Moscow"),
    "похожее напоминание перенесено на другое время"
);

const unrelatedReminder: Reminder = {
    ...movedReminder,
    text: "Купить корм коту",
    displayText: "Купить корм коту",
};

assert.equal(
    todayImportanceTestUtils.findReminderConflict(legacyMemory as any, [unrelatedReminder], day as any, "Europe/Moscow"),
    null
);

const taggedReminderMemory = {
    ...legacyMemory,
    tags: ["temporal_scope:future_plan", "status:planned", "source_reminder:reminder-1"],
};

assert.equal(
    todayImportanceTestUtils.findReminderConflict(taggedReminderMemory as any, [movedReminder], day as any, "Europe/Moscow"),
    "связанное напоминание перенесено на другую дату"
);

console.log("todayImportance reminder conflict checks passed");
process.exit(0);
