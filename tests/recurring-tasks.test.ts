import assert from "node:assert/strict";
import test from "node:test";
import {
    computeFollowingRecurringRun,
    computeNextRecurringRun,
    formatRecurringSchedule,
    parseRecurringSchedule,
} from "../utils/recurringTaskSchedule";
import { buildRecurringTaskCard } from "../utils/recurringTaskCard";
import type { RecurringTask } from "../types/recurringTaskTypes";
import {
    findRecurringTaskNaturalMatch,
    isRecurringTaskCreationFollowUp,
    isRecurringTaskListRequest,
    parseInlineRecurringTaskCreation,
    parseRecurringTaskManagement,
    parseRecurringTaskEdit,
} from "../services/recurringTaskService";
import { splitRecurringResultText } from "../utils/recurringTaskResult";
import {
    buildRecurringKnowledgeSourceText,
    guardRecurringTaskClassification,
    guardRecurringTaskPlan,
    normalizeRecurringExecutionPrompt,
} from "../utils/recurringTaskPrompt";
import { esc } from "../utils/richMessage";
import { decideKnowledgeSource } from "../utils/knowledgeSource";

const {
    computeNextRecurringRun: computeNextAdminRecurringRun,
    normalizeRecurringSchedule: normalizeAdminRecurringSchedule,
} = require("../admin-panel/recurringTasks") as {
    computeNextRecurringRun: (schedule: RecurringTask["schedule"], timezone: string, after?: Date) => Date;
    normalizeRecurringSchedule: (
        schedule: RecurringTask["schedule"],
        timezone: string,
        now?: Date,
    ) => RecurringTask["schedule"];
};

const TIMEZONE = "Europe/Moscow";
const NOW = new Date("2026-07-23T05:30:00.000Z"); // четверг, 08:30

function recurringTaskFixture(
    id: string,
    title: string,
    prompt: string,
    status: RecurringTask["status"] = "active",
): RecurringTask {
    return {
        id,
        profile: "KiraMindBot",
        chatId: 42,
        chatType: "private",
        userId: 42,
        title,
        prompt,
        schedule: {
            type: "daily",
            interval: 1,
            hour: 9,
            minute: 0,
            anchorDate: "2026-07-23",
        },
        timezone: TIMEZONE,
        status,
        nextRunAt: new Date("2026-07-24T06:00:00.000Z"),
        consecutiveFailures: 0,
        runCount: 0,
        createdAt: NOW,
        updatedAt: NOW,
    };
}

test("parses a next-message daily morning schedule", () => {
    const parsed = parseRecurringSchedule(
        "Супер, теперь давай каждое утро мне это присылай",
        NOW,
        TIMEZONE,
    );
    assert.ok(parsed);
    assert.equal(parsed.schedule.type, "daily");
    assert.equal(parsed.schedule.hour, 9);
    assert.equal(parsed.schedule.minute, 0);
    assert.equal(parsed.nextRunAt.toISOString(), "2026-07-23T06:00:00.000Z");
});

test("recognizes creation and list phrases from the conversational flow", () => {
    assert.equal(
        isRecurringTaskCreationFollowUp("Супер, теперь давай каждое утро мне это присылай"),
        true,
    );
    assert.equal(isRecurringTaskCreationFollowUp("Каждый день напоминай пить воду"), false);
    assert.equal(isRecurringTaskCreationFollowUp("Запланируй предыдущий запрос по понедельникам"), true);
    assert.equal(isRecurringTaskListRequest("Какие у меня регулярные задачи?"), true);
    assert.equal(isRecurringTaskListRequest("Покажи мои повторяющиеся запуски"), true);
});

test("parses a complete recurring request from one message", () => {
    const direct = parseInlineRecurringTaskCreation(
        "Отправляй мне каждый вечер сводку, сколько денег заработала российская биржа за день 😅",
        TIMEZONE,
        NOW,
    );
    assert.ok(direct);
    assert.equal(direct.parsedSchedule.schedule.type, "daily");
    assert.equal(direct.parsedSchedule.schedule.hour, 19);
    assert.equal(direct.parsedSchedule.schedule.minute, 0);
    assert.equal(
        direct.prompt,
        "Подготовь сводку, сколько денег заработала российская биржа за день 😅",
    );
    assert.equal(
        decideKnowledgeSource(buildRecurringKnowledgeSourceText(direct.prompt)).source,
        "external_current",
    );

    const infinitive = parseInlineRecurringTaskCreation(
        "Я хочу получать каждый вечер сводку по итогам торгов",
        TIMEZONE,
        NOW,
    );
    assert.equal(infinitive?.prompt, "Подготовь сводку по итогам торгов");

    const weekday = parseInlineRecurringTaskCreation(
        "Присылай мне по будням в 18:30 обзор российского рынка",
        TIMEZONE,
        NOW,
    );
    assert.equal(weekday?.prompt, "Подготовь обзор российского рынка");
    assert.deepEqual(weekday?.parsedSchedule.schedule.daysOfWeek, [1, 2, 3, 4, 5]);
    assert.equal(weekday?.parsedSchedule.schedule.hour, 18);
    assert.equal(weekday?.parsedSchedule.schedule.minute, 30);

    const trailingDaily = parseInlineRecurringTaskCreation(
        "Присылай мне анекдот каждый день в 14 часов",
        TIMEZONE,
        NOW,
    );
    assert.equal(trailingDaily?.prompt, "Подготовь анекдот");
    assert.equal(trailingDaily?.parsedSchedule.schedule.type, "daily");
    assert.equal(trailingDaily?.parsedSchedule.schedule.hour, 14);

    const trailingInterval = parseInlineRecurringTaskCreation(
        "Присылай мне анекдот каждые 30 минут",
        TIMEZONE,
        NOW,
    );
    assert.equal(trailingInterval?.prompt, "Подготовь анекдот");
    assert.equal(trailingInterval?.parsedSchedule.schedule.type, "interval");
    assert.equal(trailingInterval?.parsedSchedule.schedule.intervalMinutes, 30);

    assert.equal(
        parseInlineRecurringTaskCreation(
            "Супер, теперь давай каждое утро мне это присылай",
            TIMEZONE,
            NOW,
        ),
        undefined,
    );
    assert.equal(
        parseInlineRecurringTaskCreation("Каждый день напоминай пить воду", TIMEZONE, NOW),
        undefined,
    );
});

test("keeps arbitrary scheduled requests for the ordinary bot pipeline", () => {
    const conversation = parseInlineRecurringTaskCreation(
        "Каждый день в 10 рассказывай мне анекдот",
        TIMEZONE,
        NOW,
    );
    assert.equal(conversation?.prompt, "Расскажи анекдот");
    assert.equal(conversation?.parsedSchedule.schedule.type, "daily");
    assert.equal(conversation?.parsedSchedule.schedule.hour, 10);

    const intervalConversation = parseInlineRecurringTaskCreation(
        "Рассказывай мне анекдот найденный в интернете каждые 10 минут",
        TIMEZONE,
        NOW,
    );
    assert.equal(
        intervalConversation?.prompt,
        "Расскажи анекдот найденный в интернете",
    );
    assert.equal(intervalConversation?.parsedSchedule.schedule.type, "interval");
    assert.equal(intervalConversation?.parsedSchedule.schedule.intervalMinutes, 10);

    const currentQuestion = parseInlineRecurringTaskCreation(
        "Какой курс доллара? Каждый будний день в 18:00",
        TIMEZONE,
        NOW,
    );
    assert.equal(currentQuestion?.prompt, "Какой курс доллара?");
    assert.deepEqual(
        currentQuestion?.parsedSchedule.schedule.daysOfWeek,
        [1, 2, 3, 4, 5],
    );

    const image = parseInlineRecurringTaskCreation(
        "Генерируй картинку с котом по понедельникам в 12",
        TIMEZONE,
        NOW,
    );
    assert.equal(image?.prompt, "Сгенерируй картинку с котом");
    assert.equal(image?.parsedSchedule.schedule.type, "weekly");
    assert.deepEqual(image?.parsedSchedule.schedule.daysOfWeek, [1]);

    const multiStep = parseInlineRecurringTaskCreation(
        "Найди курс доллара и присылай мне краткий вывод каждый день в 10",
        TIMEZONE,
        NOW,
    );
    assert.equal(
        multiStep?.prompt,
        "Найди курс доллара и присылай мне краткий вывод",
    );

    const substantiveReference = parseInlineRecurringTaskCreation(
        "Каждый день в 09:00 объясняй, что это значит на новом примере",
        TIMEZONE,
        NOW,
    );
    assert.equal(
        substantiveReference?.prompt,
        "объясняй, что это значит на новом примере",
    );
});

test("normalizes recurring wording and blocks only implicit nested reminders", () => {
    assert.equal(
        normalizeRecurringExecutionPrompt("Рассказывай мне интересный факт"),
        "Расскажи мне интересный факт",
    );
    assert.equal(
        normalizeRecurringExecutionPrompt("Присылай мне короткую сводку"),
        "Подготовь мне короткую сводку",
    );

    const implicit = guardRecurringTaskClassification({
        intent: "НАПОМИНАНИЕ",
        confidenceLevel: "ВЫСОКИЙ",
        intentScores: [
            { intent: "НАПОМИНАНИЕ", score: 0.82 },
            { intent: "ВЕБ_ПОИСК", score: 0.76 },
        ],
        subIntents: [{ intent: "НАПОМИНАНИЕ" }],
        details: {
            reminderAction: "create",
            knowledgeSource: "external_current",
            requestedFacets: ["facts", "sources"],
        },
    }, "Расскажи найденный в интернете факт", true);
    assert.equal(implicit.adjusted, true);
    assert.equal(implicit.classification.intent, "ВЕБ_ПОИСК");
    assert.equal(implicit.classification.subIntents, undefined);
    assert.equal(implicit.classification.details.reminderAction, undefined);
    assert.equal(
        implicit.classification.intentScores?.some((candidate) => candidate.intent === "НАПОМИНАНИЕ"),
        false,
    );
    assert.deepEqual(
        guardRecurringTaskPlan({
            steps: [{ agentId: "webSearch" }, { agentId: "reminder" }],
        }, "Расскажи найденный в интернете факт", implicit.classification),
        {
            adjusted: true,
            plan: {
                steps: [{ agentId: "webSearch" }, { agentId: "conversation" }],
            },
        },
    );

    const explicit = {
        intent: "НАПОМИНАНИЕ" as const,
        confidenceLevel: "ВЫСОКИЙ" as const,
        details: { reminderAction: "create" as const },
    };
    assert.deepEqual(
        guardRecurringTaskClassification(explicit, "Создай напоминание позвонить врачу", false),
        { classification: explicit, adjusted: false },
    );
    const explicitPlan = { steps: [{ agentId: "reminder" as const }] };
    assert.deepEqual(
        guardRecurringTaskPlan(
            explicitPlan,
            "Создай напоминание позвонить врачу",
            explicit,
        ),
        { plan: explicitPlan, adjusted: false },
    );
});

test("recurring runs resolve close intents and never return an interactive clarification", () => {
    const ambiguous = guardRecurringTaskClassification({
        intent: "ВЕБ_ПОИСК",
        confidenceLevel: "СРЕДНИЙ",
        intentScores: [
            { intent: "ВЕБ_ПОИСК", score: 0.74 },
            { intent: "РАЗГОВОР", score: 0.71 },
        ],
        ambiguityReason: "Можно либо найти анекдот, либо придумать его.",
        clarificationQuestion: "Искать в интернете или просто рассказать?",
        details: {
            knowledgeSource: "external_current",
            requestedFacets: ["facts", "sources"],
        },
    }, "Расскажи анекдот найденный в интернете про Штирлица", true);

    assert.equal(ambiguous.adjusted, true);
    assert.equal(ambiguous.classification.intent, "ВЕБ_ПОИСК");
    assert.equal(ambiguous.classification.confidenceLevel, "ВЫСОКИЙ");
    assert.equal(ambiguous.classification.ambiguityReason, undefined);
    assert.equal(ambiguous.classification.clarificationQuestion, undefined);
    assert.deepEqual(
        guardRecurringTaskPlan({
            steps: [{ agentId: "webSearch" }, { agentId: "unclearIntent" }],
        }, "Расскажи анекдот найденный в интернете про Штирлица", ambiguous.classification),
        {
            adjusted: true,
            plan: {
                steps: [{ agentId: "webSearch" }, { agentId: "conversation" }],
            },
        },
    );

    const unknownImage = guardRecurringTaskClassification({
        intent: "НЕОПРЕДЕЛЕНО",
        confidenceLevel: "НИЗКИЙ",
        intentScores: [
            { intent: "НЕОПРЕДЕЛЕНО", score: 0.7 },
            { intent: "ГЕНЕРАЦИЯ_ИЗОБРАЖЕНИЯ", score: 0.68 },
        ],
        details: {},
    }, "Нарисуй кота", false);
    assert.equal(unknownImage.classification.intent, "ГЕНЕРАЦИЯ_ИЗОБРАЖЕНИЯ");
    assert.deepEqual(
        guardRecurringTaskPlan(
            { steps: [{ agentId: "unclearIntent" }] },
            "Нарисуй кота",
            unknownImage.classification,
        ),
        {
            adjusted: true,
            plan: { steps: [{ agentId: "imageGeneration" }] },
        },
    );
});

test("parses conversational management of recurring tasks", () => {
    assert.deepEqual(
        parseRecurringTaskManagement("Отключи ежедневный анекдот"),
        {
            action: "pause",
            query: "анекдот",
            explicitScope: false,
            strongIntent: false,
        },
    );
    assert.equal(
        parseRecurringTaskManagement("Перестань присылать мне анекдот")?.action,
        "pause",
    );
    assert.equal(
        parseRecurringTaskManagement("Перестань присылать мне анекдот")?.query,
        "анекдот",
    );
    assert.deepEqual(
        parseRecurringTaskManagement("Поставь задачу про биржу на паузу"),
        {
            action: "pause",
            query: "биржу",
            explicitScope: true,
            strongIntent: true,
        },
    );
    assert.equal(
        parseRecurringTaskManagement("Включи задачу про биржу")?.action,
        "resume",
    );
    assert.equal(
        parseRecurringTaskManagement("Удали регулярную задачу про биржу")?.action,
        "delete",
    );
    assert.equal(
        parseRecurringTaskManagement("Каждый день выключи свет"),
        undefined,
    );
});

test("finds a recurring task by natural description and Russian inflection", () => {
    const joke = recurringTaskFixture(
        "11111111-1111-4111-8111-111111111111",
        "Подготовь анекдот",
        "Подготовь анекдот",
    );
    const market = recurringTaskFixture(
        "22222222-2222-4222-8222-222222222222",
        "Сводка по российской бирже",
        "Подготовь сводку по российской бирже",
    );

    assert.equal(
        findRecurringTaskNaturalMatch([joke, market], "анекдотом").task?.id,
        joke.id,
    );
    assert.equal(
        findRecurringTaskNaturalMatch([joke, market], "бирже").task?.id,
        market.id,
    );

    const secondJoke = recurringTaskFixture(
        "33333333-3333-4333-8333-333333333333",
        "Ещё один анекдот",
        "Расскажи анекдот",
    );
    assert.equal(
        findRecurringTaskNaturalMatch([joke, secondJoke], "анекдот").reason,
        "ambiguous",
    );
});

test("parses weekdays and skips an already passed local time", () => {
    const parsed = parseRecurringSchedule("Присылай это по будням в 08:00", NOW, TIMEZONE);
    assert.ok(parsed);
    assert.deepEqual(parsed.schedule.daysOfWeek, [1, 2, 3, 4, 5]);
    assert.equal(parsed.nextRunAt.toISOString(), "2026-07-24T05:00:00.000Z");
    assert.match(parsed.description, /пн, вт, ср, чт, пт/);
});

test("treats a working day as Monday through Friday", () => {
    const parsed = parseRecurringSchedule("Повторяй это каждый будний день в 10", NOW, TIMEZONE);
    assert.ok(parsed);
    assert.equal(parsed.schedule.type, "weekly");
    assert.deepEqual(parsed.schedule.daysOfWeek, [1, 2, 3, 4, 5]);
});

test("parses interval schedules", () => {
    const parsed = parseRecurringSchedule("Запускай это каждые 2 часа", NOW, TIMEZONE);
    assert.ok(parsed);
    assert.deepEqual(parsed.schedule, {
        type: "interval",
        intervalMinutes: 120,
        anchorDate: "2026-07-23",
    });
    assert.equal(parsed.nextRunAt.toISOString(), "2026-07-23T07:30:00.000Z");
    assert.equal(formatRecurringSchedule(parsed.schedule), "каждые 2 ч");
});

test("parses common word-based intervals and weekday phrases", () => {
    const everyTwoHours = parseRecurringSchedule("Повторяй это каждые два часа", NOW, TIMEZONE);
    assert.ok(everyTwoHours);
    assert.equal(everyTwoHours.schedule.type, "interval");
    assert.equal(everyTwoHours.schedule.intervalMinutes, 120);

    const halfHourly = parseRecurringSchedule("Запускай это раз в полчаса", NOW, TIMEZONE);
    assert.ok(halfHourly);
    assert.equal(halfHourly.schedule.type, "interval");
    assert.equal(halfHourly.schedule.intervalMinutes, 30);

    const everyDayInMinutes = parseRecurringSchedule("Запускай это каждые 1440 минут", NOW, TIMEZONE);
    assert.ok(everyDayInMinutes);
    assert.equal(everyDayInMinutes.schedule.intervalMinutes, 1_440);

    const mondays = parseRecurringSchedule("Присылай это по понедельникам в полдень", NOW, TIMEZONE);
    assert.ok(mondays);
    assert.equal(mondays.schedule.type, "weekly");
    assert.deepEqual(mondays.schedule.daysOfWeek, [1]);
    assert.equal(mondays.schedule.hour, 12);
});

test("parses an explicit monthly day", () => {
    const parsed = parseRecurringSchedule("Присылай это каждого 1-го числа в 10:15", NOW, TIMEZONE);
    assert.ok(parsed);
    assert.equal(parsed.schedule.type, "monthly");
    assert.equal(parsed.schedule.dayOfMonth, 1);
    assert.equal(parsed.schedule.hour, 10);
    assert.equal(parsed.schedule.minute, 15);
});

test("does not infer a schedule from the edited prompt body", () => {
    const promptOnly = parseRecurringTaskEdit(
        "запрос: находи передачи, которые выходят каждое утро",
        TIMEZONE,
        NOW,
    );
    assert.equal(promptOnly.prompt, "находи передачи, которые выходят каждое утро");
    assert.equal(promptOnly.parsedSchedule, undefined);
    assert.equal(promptOnly.scheduleError, undefined);

    const withSchedule = parseRecurringTaskEdit(
        "запрос: находи передачи, которые выходят каждое утро\nрасписание: по понедельникам в 08:30",
        TIMEZONE,
        NOW,
    );
    assert.equal(withSchedule.parsedSchedule?.schedule.type, "weekly");
    assert.deepEqual(withSchedule.parsedSchedule?.schedule.daysOfWeek, [1]);

    const invalid = parseRecurringTaskEdit("расписание: когда будет удобно", TIMEZONE, NOW);
    assert.match(invalid.scheduleError ?? "", /Не поняла новое расписание/);
});

test("keeps wall-clock time across a DST boundary", () => {
    const schedule = {
        type: "daily" as const,
        interval: 1,
        hour: 9,
        minute: 0,
        anchorDate: "2026-03-28",
    };
    const next = computeNextRecurringRun(
        schedule,
        new Date("2026-03-28T09:30:00.000Z"),
        "Europe/Berlin",
    );
    assert.equal(next.toISOString(), "2026-03-29T07:00:00.000Z");
});

test("keeps admin and runtime schedule calculations in sync", () => {
    const schedule = {
        type: "weekly" as const,
        interval: 2,
        daysOfWeek: [1, 4],
        hour: 8,
        minute: 45,
        anchorDate: "2026-07-23",
    };
    const runtimeNext = computeNextRecurringRun(schedule, NOW, "Europe/Berlin");
    const adminNext = computeNextAdminRecurringRun(schedule, "Europe/Berlin", NOW);
    assert.equal(adminNext.toISOString(), runtimeNext.toISOString());

    const normalized = normalizeAdminRecurringSchedule({
        ...schedule,
        anchorDate: "2026-99-99",
    }, TIMEZONE, NOW);
    assert.equal(normalized.anchorDate, "2026-07-23");
});

test("keeps interval cadence when a run finishes late", () => {
    const next = computeFollowingRecurringRun(
        {
            type: "interval",
            intervalMinutes: 120,
            anchorDate: "2026-07-23",
        },
        new Date("2026-07-23T06:00:00.000Z"),
        new Date("2026-07-23T08:15:00.000Z"),
        TIMEZONE,
    );
    assert.equal(next.toISOString(), "2026-07-23T10:00:00.000Z");
});

test("splits long scheduled results without truncating escaped chunks", () => {
    const source = `${"&<> Новость ".repeat(900)}🚀`;
    const chunks = splitRecurringResultText(source, 500);
    assert.ok(chunks.length > 10);
    assert.ok(chunks.every((chunk) => esc(chunk).length <= 500));
    assert.equal(chunks.join(" ").replace(/\s+/g, " ").trim(), source.replace(/\s+/g, " ").trim());
});

test("builds a management card with pause, run, edit and delete actions", () => {
    const task: RecurringTask = {
        id: "11111111-1111-4111-8111-111111111111",
        profile: "KiraMindBot",
        chatId: 42,
        chatType: "private",
        userId: 42,
        title: "Новости про космос",
        prompt: "Найди свежие новости про космос",
        schedule: {
            type: "daily",
            interval: 1,
            hour: 9,
            minute: 0,
            anchorDate: "2026-07-23",
        },
        timezone: TIMEZONE,
        status: "active",
        nextRunAt: new Date("2026-07-24T06:00:00.000Z"),
        consecutiveFailures: 0,
        runCount: 0,
        createdAt: NOW,
        updatedAt: NOW,
    };
    const card = buildRecurringTaskCard([task]);
    const callbacks = card.keyboard.inline_keyboard.flat().map((button) =>
        "callback_data" in button ? button.callback_data : undefined
    );
    assert.ok(callbacks.includes(`rt:pause:${task.id}`));
    assert.ok(callbacks.includes(`rt:run:${task.id}`));
    assert.ok(callbacks.includes(`rt:edit:${task.id}`));
    assert.ok(callbacks.includes(`rt:delete:${task.id}`));
});
