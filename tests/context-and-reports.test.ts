import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Reminder } from "../reminder";
import { ReminderStatus } from "../types/reminderTypes";
import { enhancePromptWithSummary } from "../services/dialogueSummarizer";
import { formatSelfStudyReport } from "../services/selfStudyService";
import { portraitTag } from "../services/PsychologicalPortraitService";
import { formatTodayImportanceContext, type TodayImportanceSnapshot } from "../utils/todayImportance";
import { addToHistory } from "../utils/history";

const day = {
    key: "2026-07-21",
    label: "вторник, 21 июля 2026 г.",
    shortDate: "21.07.2026",
    day: 21,
    month: 7,
    year: 2026,
};

function snapshot(overrides: Partial<TodayImportanceSnapshot> = {}): TodayImportanceSnapshot {
    return {
        day,
        timeZone: "Europe/Moscow",
        now: new Date("2026-07-21T07:00:00.000Z"),
        todayReminders: [],
        earlierUnresolvedReminders: [],
        memoryItems: [],
        memoryLookupFailed: false,
        ...overrides,
    };
}

function reminder(overrides: Partial<Reminder> = {}): Reminder {
    return {
        id: "r1",
        text: "Исходный текст",
        dueDate: new Date("2026-07-21T08:05:00.000Z"),
        chatId: 1,
        status: ReminderStatus.Pending,
        createdAt: new Date("2026-07-20T08:00:00.000Z"),
        ...overrides,
    };
}

describe("forward-only history isolation", () => {
    test("does not persist a pure forwarded message in owner history", async () => {
        const ctx = {
            session: {
                messageHistory: [],
                recentlySavedFacts: [],
            },
        } as any;

        await addToHistory(ctx, "user", "Пересланное сообщение", {
            turn: { userText: "Пересланное сообщение", isForwardOnly: true },
        });

        assert.deepEqual(ctx.session.messageHistory, []);
    });
});

describe("today importance context formatting", () => {
    test("formats the heading and all empty-state messages", () => {
        const text = formatTodayImportanceContext(snapshot());
        assert.match(text, /Сводка важного на сегодня \(вторник, 21 июля 2026 г\., часовой пояс Europe\/Moscow\)/);
        assert.match(text, /Активных напоминаний на сегодня нет/);
        assert.match(text, /Незавершённых более ранних напоминаний нет/);
        assert.match(text, /нет конкретных планов, дедлайнов или событий/);
        assert.match(text, /Не придумывай календарь/);
    });

    test("uses display text and includes chat, recurrence, and a group target", () => {
        const text = formatTodayImportanceContext(snapshot({
            todayReminders: [reminder({
                displayText: "Позвонить Анне",
                chatTitle: "Работа",
                recurrence: { type: "weekly", interval: 1, daysOfWeek: [2] },
                targetChat: { type: "group", groupName: "Команда" },
            })],
        }));
        assert.match(text, /11:05/);
        assert.match(text, /\[Работа\]: Позвонить Анне/);
        assert.doesNotMatch(text, /Исходный текст/);
        assert.match(text, /\[повторяется\]/);
        assert.match(text, /\[адресат: группа Команда\]/);
    });

    test("formats a contact target", () => {
        const text = formatTodayImportanceContext(snapshot({
            todayReminders: [reminder({ targetChat: { type: "contact", contactQuery: "Иван Петров" } })],
        }));
        assert.match(text, /\[адресат: Иван Петров\]/);
    });

    test("labels sent, expired, and overdue pending reminders", () => {
        const text = formatTodayImportanceContext(snapshot({
            todayReminders: [
                reminder({ id: "sent", status: ReminderStatus.Sent }),
                reminder({ id: "expired", status: ReminderStatus.Expired }),
                reminder({ id: "overdue", dueDate: new Date("2026-07-21T06:00:00Z") }),
            ],
        }));
        assert.match(text, /уже сработало/);
        assert.match(text, /просрочено/);
        assert.match(text, /уже наступило/);
    });

    test("includes the date for earlier unresolved reminders", () => {
        const text = formatTodayImportanceContext(snapshot({
            earlierUnresolvedReminders: [reminder({ dueDate: new Date("2026-07-20T06:30:00Z") })],
        }));
        assert.match(text, /20\.07/);
        assert.match(text, /09:30/);
    });

    test("formats memory metadata and flattens line breaks", () => {
        const text = formatTodayImportanceContext(snapshot({
            memoryItems: [{
                memory: {
                    id: "m1",
                    content: "Подготовить\n  документы",
                    domain: "work",
                    timestamp: new Date("2026-07-20T00:00:00Z"),
                    importance: 0.83,
                    confidence: 0.755,
                    memoryKind: "open_loop",
                    status: "planned",
                    tags: [],
                },
                score: 1.2,
                reason: "срок сегодня",
            }],
        }));
        assert.match(text, /Подготовить документы/);
        assert.match(text, /work; срок сегодня; importance 0\.83/);
        assert.match(text, /confidence 0\.76/);
        assert.match(text, /тип open_loop/);
        assert.match(text, /статус planned/);
    });

    test("uses default importance and omits optional active metadata", () => {
        const text = formatTodayImportanceContext(snapshot({
            memoryItems: [{
                memory: {
                    id: "m2",
                    content: "Встреча",
                    domain: "social",
                    timestamp: new Date(),
                    importance: undefined,
                    tags: [],
                } as any,
                score: 1,
                reason: "упомянута дата",
            }],
        }));
        assert.match(text, /importance 0\.50/);
        assert.doesNotMatch(text, /confidence/);
        assert.doesNotMatch(text, /тип /);
        assert.doesNotMatch(text, /статус active/);
    });

    test("reports memory lookup failure instead of misleading empty state", () => {
        const text = formatTodayImportanceContext(snapshot({ memoryLookupFailed: true }));
        assert.match(text, /Не удалось надёжно прочитать долговременную память/);
        assert.doesNotMatch(text, /нет конкретных планов/);
    });

    test("truncates very long memory content", () => {
        const text = formatTodayImportanceContext(snapshot({
            memoryItems: [{
                memory: {
                    id: "m3",
                    content: "я".repeat(400),
                    domain: "general",
                    timestamp: new Date(),
                    importance: 0.5,
                    tags: [],
                },
                score: 1,
                reason: "сегодня",
            }],
        }));
        const line = text.split("\n").find((value) => value.startsWith("- я"));
        assert.ok(line);
        assert.match(line, /\.\.\. \[general;/);
        assert.ok(line.indexOf(" [general;") <= 362);
    });
});

describe("dialogue summary prompt enhancement", () => {
    test("leaves a prompt unchanged when the summary is empty", () => {
        const prompt = "Ответь кратко";
        assert.equal(enhancePromptWithSummary(prompt, { dialogueSummary: "" } as any), prompt);
    });

    test("treats a whitespace-only summary as empty", () => {
        const prompt = "Ответь кратко";
        assert.equal(enhancePromptWithSummary(prompt, { dialogueSummary: "   \n " } as any), prompt);
    });

    test("inserts the summary immediately before conversation history", () => {
        const prompt = "Правила\nИстория переписки (от старых к новым):\nuser: привет";
        const result = enhancePromptWithSummary(prompt, { dialogueSummary: "Пользователь любит чай" } as any);
        assert.ok(result.indexOf("Пользователь любит чай") < result.indexOf("История переписки"));
        assert.match(result, /^Правила/);
        assert.match(result, /user: привет$/);
    });

    test("appends the summary when the history marker is absent", () => {
        assert.equal(
            enhancePromptWithSummary("Исходный промпт", { dialogueSummary: "Важный контекст" } as any),
            "Исходный промпт\n\nДолговременный контекст диалога:\nВажный контекст",
        );
    });

    test("preserves the entire prompt when the history marker occurs more than once", () => {
        const marker = "История переписки (от старых к новым):";
        const prompt = `Вводная\n${marker}\nпервая часть\n${marker}\nвторая часть`;
        const result = enhancePromptWithSummary(prompt, { dialogueSummary: "Контекст" } as any);
        assert.match(result, /первая часть/);
        assert.match(result, /вторая часть$/);
        assert.equal(result.split(marker).length - 1, 2);
    });

    test("trims surrounding whitespace from the injected summary", () => {
        const result = enhancePromptWithSummary("Промпт", { dialogueSummary: "  Контекст  \n" } as any);
        assert.equal(result, "Промпт\n\nДолговременный контекст диалога:\nКонтекст");
    });
});

describe("report and portrait formatting", () => {
    test("formats all non-empty self-study sections", () => {
        const text = formatSelfStudyReport({
            id: "study-1",
            date: "2026-07-21T09:15:00.000Z",
            trigger: "manual",
            summary: "Краткий итог",
            strengths: ["Внимательность"],
            limitations: ["Мало данных"],
            needs: ["Обратная связь"],
            experiments: ["Задать уточнение"],
            questionsForOwner: ["Что улучшить?"],
            capabilityFocus: ["Память"],
        });
        assert.match(text, /^🧭 Самоизучение/);
        assert.match(text, /Краткий итог/);
        for (const section of ["Сильные стороны", "Ограничения", "Что мне нужно", "Что попробовать", "Вопросы к", "Фокус возможностей"]) {
            assert.match(text, new RegExp(section));
        }
        assert.match(text, /• Внимательность/);
    });

    test("omits empty self-study sections", () => {
        const text = formatSelfStudyReport({
            id: "study-2",
            date: "2026-07-21T09:15:00.000Z",
            trigger: "manual",
            summary: "Только итог",
            strengths: [],
            limitations: [],
            needs: [],
            experiments: [],
            questionsForOwner: [],
            capabilityFocus: [],
        });
        assert.match(text, /Только итог/);
        assert.doesNotMatch(text, /Сильные стороны:/);
        assert.doesNotMatch(text, /Фокус возможностей:/);
    });

    test("builds a stable portrait identity tag", () => {
        assert.equal(portraitTag("Анна Петрова"), "portrait:Анна Петрова");
        assert.equal(portraitTag("@anna"), "portrait:@anna");
    });
});
