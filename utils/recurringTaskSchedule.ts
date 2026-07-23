import { USER_TIMEZONE } from "../constants";
import type { RecurringTaskSchedule } from "../types/recurringTaskTypes";
import {
    getZonedDateKey,
    getZonedDateTimeParts,
    zonedDateTimeToDate,
} from "./time";

const WEEKDAY_PATTERNS: Array<{ day: number; pattern: RegExp }> = [
    { day: 1, pattern: /(?:понедельник(?:ам|и)?|(?:^|\s)пн(?=\s|$))/iu },
    { day: 2, pattern: /(?:вторник(?:ам|и)?|(?:^|\s)вт(?=\s|$))/iu },
    { day: 3, pattern: /(?:сред(?:а|у|ам|ы)|(?:^|\s)ср(?=\s|$))/iu },
    { day: 4, pattern: /(?:четверг(?:ам|и)?|(?:^|\s)чт(?=\s|$))/iu },
    { day: 5, pattern: /(?:пятниц(?:а|у|ам|ы)|(?:^|\s)пт(?=\s|$))/iu },
    { day: 6, pattern: /(?:суббот(?:а|у|ам|ы)|(?:^|\s)сб(?=\s|$))/iu },
    { day: 7, pattern: /(?:воскресень(?:е|ям|я)|(?:^|\s)вс(?=\s|$))/iu },
];

const WEEKDAY_LABELS = ["", "пн", "вт", "ср", "чт", "пт", "сб", "вс"];
const RUSSIAN_INTERVAL_NUMBER_PATTERN = "один|одну|два|две|три|четыре|пять|шесть|семь|восемь|девять|десять|одиннадцать|двенадцать";
const RUSSIAN_INTERVAL_NUMBERS: Record<string, number> = {
    один: 1,
    одну: 1,
    два: 2,
    две: 2,
    три: 3,
    четыре: 4,
    пять: 5,
    шесть: 6,
    семь: 7,
    восемь: 8,
    девять: 9,
    десять: 10,
    одиннадцать: 11,
    двенадцать: 12,
};
const SCHEDULE_SIGNAL_RE = new RegExp(
    [
        "кажд(?:ый|ая|ое|ую|ые|ого)",
        "ежедневно",
        "еженедельно",
        "ежемесячно",
        "регулярно",
        "по\\s+будням",
        "по\\s+выходным",
        "по\\s+(?:понедельникам|вторникам|средам|четвергам|пятницам|субботам|воскресеньям)",
        "будний\\s+день",
        "рабоч(?:ий|ие)\\s+д(?:ень|ни)",
        "по\\s+утрам",
        "по\\s+вечерам",
        "(?:каждые|раз\\s+в)\\s+полчаса",
        `раз\\s+в\\s+(?:(?:\\d+|${RUSSIAN_INTERVAL_NUMBER_PATTERN})\\s+)?(?:минут(?:у|ы)?|час(?:а|ов)?|д(?:ень|ня|ней)|недел(?:ю|и|ь)|месяц(?:а|ев)?)`,
        "на\\s+повтор",
    ].join("|"),
    "iu",
);

export interface ParsedRecurringSchedule {
    schedule: RecurringTaskSchedule;
    nextRunAt: Date;
    description: string;
}

function clampInterval(value: number | undefined, fallback = 1): number {
    if (!Number.isFinite(value) || !value || value < 1) return fallback;
    return Math.min(Math.floor(value), 365);
}

function clampIntervalMinutes(value: number | undefined, fallback = 60): number {
    if (!Number.isFinite(value) || !value || value < 1) return fallback;
    return Math.min(Math.floor(value), 525_600);
}

function parseClock(text: string): { hour: number; minute: number } | undefined {
    if (/(?:^|\s)(?:в\s*)?полдень(?=$|[\s,.!?])/iu.test(text)) return { hour: 12, minute: 0 };
    if (/(?:^|\s)(?:в\s*)?полночь(?=$|[\s,.!?])/iu.test(text)) return { hour: 0, minute: 0 };
    const explicit = text.match(/(?:^|\s)(?:в|к)\s*([01]?\d|2[0-3])(?:[:.]([0-5]\d))?(?:\s*(утра|дня|вечера|ночи))?/iu)
        ?? text.match(/(?:^|\s)([01]?\d|2[0-3])[:.]([0-5]\d)(?:\s*(утра|дня|вечера|ночи))?/iu);
    if (explicit) {
        let hour = Number(explicit[1]);
        const minute = Number(explicit[2] ?? 0);
        const period = explicit[3]?.toLocaleLowerCase("ru-RU");
        if ((period === "дня" || period === "вечера") && hour < 12) hour += 12;
        if (period === "ночи" && hour === 12) hour = 0;
        return { hour, minute };
    }
    if (/(?:утром|по\s+утрам|каждое\s+утро)/iu.test(text)) return { hour: 9, minute: 0 };
    if (/(?:дн[её]м|по\s+дням)/iu.test(text)) return { hour: 13, minute: 0 };
    if (/(?:вечером|по\s+вечерам|каждый\s+вечер)/iu.test(text)) return { hour: 19, minute: 0 };
    if (/(?:ночью|по\s+ночам|каждую\s+ночь)/iu.test(text)) return { hour: 23, minute: 0 };
    return undefined;
}

function parseWeekdays(text: string): number[] {
    if (/(?:по\s+будням|будний\s+день|рабоч(?:ий|ие)\s+д(?:ень|ни))/iu.test(text)) return [1, 2, 3, 4, 5];
    if (/по\s+выходным/iu.test(text)) return [6, 7];
    return WEEKDAY_PATTERNS
        .filter(({ pattern }) => pattern.test(text))
        .map(({ day }) => day);
}

function parseLocalDateKey(value: string): number {
    const [year, month, day] = value.split("-").map(Number);
    return Date.UTC(year, month - 1, day);
}

function localDayDiff(anchorDate: string, candidateDate: string): number {
    return Math.round((parseLocalDateKey(candidateDate) - parseLocalDateKey(anchorDate)) / 86_400_000);
}

function localMonthDiff(anchorDate: string, year: number, month: number): number {
    const [anchorYear, anchorMonth] = anchorDate.split("-").map(Number);
    return (year - anchorYear) * 12 + (month - anchorMonth);
}

export function hasRecurringScheduleSignal(text: string): boolean {
    return SCHEDULE_SIGNAL_RE.test(text);
}

export function parseRecurringSchedule(
    text: string,
    now = new Date(),
    timezone = USER_TIMEZONE,
): ParsedRecurringSchedule | undefined {
    if (!hasRecurringScheduleSignal(text)) return undefined;

    const anchorDate = getZonedDateKey(now, timezone);
    const halfHour = /(?:каждые|раз\s+в)\s+полчаса/iu.test(text);
    const intervalMatch = text.match(new RegExp(
        `(?:кажд(?:ые|ый)|раз\\s+в)\\s*(\\d+|${RUSSIAN_INTERVAL_NUMBER_PATTERN})?\\s*` +
        "(минут(?:у|ы)?|час(?:а|ов)?|д(?:ень|ня|ней)|недел(?:ю|и|ь)|месяц(?:а|ев)?)",
        "iu",
    ));
    const intervalToken = intervalMatch?.[1]?.toLocaleLowerCase("ru-RU");
    const parsedInterval = intervalToken
        ? Number(intervalToken) || RUSSIAN_INTERVAL_NUMBERS[intervalToken]
        : 1;
    const rawInterval = Number.isFinite(parsedInterval) && parsedInterval > 0
        ? Math.floor(parsedInterval)
        : 1;
    const unit = intervalMatch?.[2]?.toLocaleLowerCase("ru-RU");

    if (halfHour || unit?.startsWith("минут") || unit?.startsWith("час")) {
        const intervalMinutes = clampIntervalMinutes(
            halfHour ? 30 : unit!.startsWith("час") ? rawInterval * 60 : rawInterval,
        );
        const schedule: RecurringTaskSchedule = {
            type: "interval",
            intervalMinutes,
            anchorDate,
        };
        return {
            schedule,
            nextRunAt: new Date(now.getTime() + intervalMinutes * 60_000),
            description: formatRecurringSchedule(schedule),
        };
    }

    const clock = parseClock(text) ?? { hour: 9, minute: 0 };
    const currentParts = getZonedDateTimeParts(now, timezone);
    const weekdays = parseWeekdays(text);
    let schedule: RecurringTaskSchedule;

    if (/(?:ежемесячно|кажд(?:ый|ые)\s+(?:(?:\d+|один|два|три|четыре|пять|шесть|семь|восемь|девять|десять|одиннадцать|двенадцать)\s+)?месяц|раз\s+в\s+(?:(?:\d+|один|два|три|четыре|пять|шесть|семь|восемь|девять|десять|одиннадцать|двенадцать)\s+)?месяц|каждого\s+\d{1,2}(?:-го)?\s+числа)/iu.test(text)) {
        const explicitDay = text.match(/(\d{1,2})(?:-го|го| числа)/iu)?.[1];
        schedule = {
            type: "monthly",
            interval: unit?.startsWith("месяц") ? clampInterval(rawInterval) : 1,
            dayOfMonth: Math.min(31, Math.max(1, Number(explicitDay ?? currentParts.day))),
            ...clock,
            anchorDate,
        };
    } else if (
        weekdays.length > 0 ||
        /(?:еженедельно|кажд(?:ую|ые)\s+(?:(?:\d+|один|одну|два|две|три|четыре|пять|шесть|семь|восемь|девять|десять|одиннадцать|двенадцать)\s+)?недел|раз\s+в\s+(?:(?:\d+|один|одну|два|две|три|четыре|пять|шесть|семь|восемь|девять|десять|одиннадцать|двенадцать)\s+)?недел)/iu.test(text)
    ) {
        schedule = {
            type: "weekly",
            interval: unit?.startsWith("недел") ? clampInterval(rawInterval) : 1,
            daysOfWeek: weekdays.length > 0 ? weekdays : [currentParts.weekdayIndex + 1],
            ...clock,
            anchorDate,
        };
    } else {
        schedule = {
            type: "daily",
            interval: unit?.startsWith("дн") ? clampInterval(rawInterval) : 1,
            ...clock,
            anchorDate,
        };
    }

    const nextRunAt = computeNextRecurringRun(schedule, now, timezone);
    return {
        schedule,
        nextRunAt,
        description: formatRecurringSchedule(schedule),
    };
}

export function computeNextRecurringRun(
    schedule: RecurringTaskSchedule,
    after: Date,
    timezone = USER_TIMEZONE,
): Date {
    if (schedule.type === "interval") {
        const intervalMs = clampIntervalMinutes(schedule.intervalMinutes) * 60_000;
        return new Date(after.getTime() + intervalMs);
    }

    const interval = clampInterval(schedule.interval);
    const afterParts = getZonedDateTimeParts(after, timezone);
    const hour = Math.min(23, Math.max(0, schedule.hour ?? 9));
    const minute = Math.min(59, Math.max(0, schedule.minute ?? 0));
    const searchHorizonDays = schedule.type === "monthly"
        ? Math.max(3_660, interval * 32 + 400)
        : 3_660;

    for (let offset = 0; offset <= searchHorizonDays; offset += 1) {
        const candidateDay = new Date(Date.UTC(
            afterParts.year,
            afterParts.month - 1,
            afterParts.day + offset,
        ));
        const year = candidateDay.getUTCFullYear();
        const month = candidateDay.getUTCMonth() + 1;
        const day = candidateDay.getUTCDate();
        const candidate = zonedDateTimeToDate(year, month, day, hour, minute, timezone);
        if (candidate.getTime() <= after.getTime()) continue;

        const candidateKey = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
        const dayDiff = localDayDiff(schedule.anchorDate, candidateKey);
        if (dayDiff < 0) continue;

        if (schedule.type === "daily" && dayDiff % interval === 0) return candidate;

        if (schedule.type === "weekly") {
            const weekday = ((candidateDay.getUTCDay() + 6) % 7) + 1;
            const weekDiff = Math.floor(dayDiff / 7);
            if (
                (schedule.daysOfWeek ?? []).includes(weekday) &&
                weekDiff % interval === 0
            ) return candidate;
        }

        if (schedule.type === "monthly") {
            const monthDiff = localMonthDiff(schedule.anchorDate, year, month);
            if (
                monthDiff >= 0 &&
                monthDiff % interval === 0 &&
                day === (schedule.dayOfMonth ?? 1)
            ) return candidate;
        }
    }

    throw new Error("Не удалось вычислить следующее выполнение регулярной задачи");
}

export function computeFollowingRecurringRun(
    schedule: RecurringTaskSchedule,
    scheduledFor: Date,
    now: Date,
    timezone = USER_TIMEZONE,
): Date {
    if (schedule.type !== "interval") {
        return computeNextRecurringRun(schedule, now, timezone);
    }
    const intervalMs = clampIntervalMinutes(schedule.intervalMinutes) * 60_000;
    const elapsedIntervals = Math.max(1, Math.floor((now.getTime() - scheduledFor.getTime()) / intervalMs) + 1);
    return new Date(scheduledFor.getTime() + elapsedIntervals * intervalMs);
}

export function formatRecurringSchedule(schedule: RecurringTaskSchedule): string {
    if (schedule.type === "interval") {
        const minutes = schedule.intervalMinutes ?? 60;
        if (minutes % 60 === 0) {
            const hours = minutes / 60;
            return hours === 1 ? "каждый час" : `каждые ${hours} ч`;
        }
        return `каждые ${minutes} мин`;
    }

    const time = `${String(schedule.hour ?? 9).padStart(2, "0")}:${String(schedule.minute ?? 0).padStart(2, "0")}`;
    const interval = clampInterval(schedule.interval);
    if (schedule.type === "daily") {
        return interval === 1 ? `каждый день в ${time}` : `каждые ${interval} дн. в ${time}`;
    }
    if (schedule.type === "weekly") {
        const days = (schedule.daysOfWeek ?? []).map((day) => WEEKDAY_LABELS[day]).join(", ");
        const prefix = interval === 1 ? "каждую неделю" : `каждые ${interval} нед.`;
        return `${prefix}, ${days || "в день создания"} в ${time}`;
    }
    const prefix = interval === 1 ? "каждый месяц" : `каждые ${interval} мес.`;
    return `${prefix}, ${schedule.dayOfMonth ?? 1}-го в ${time}`;
}
