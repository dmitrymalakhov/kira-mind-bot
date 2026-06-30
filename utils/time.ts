import { USER_TIMEZONE } from "../constants";

const WEEKDAY_INDEX_BY_EN_SHORT: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
};

const WEEKDAYS_RU = [
    "понедельник",
    "вторник",
    "среда",
    "четверг",
    "пятница",
    "суббота",
    "воскресенье",
];

export interface ZonedDateTimeParts {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
    weekdayIndex: number; // Monday-first: 0=пн, ..., 6=вс
}

export interface ZonedDayContext extends ZonedDateTimeParts {
    weekday: string;
    isWeekend: boolean;
    timeOfDay: string;
    season: string;
}

export function formatDateTimeInTimeZone(
    date: Date,
    options: Intl.DateTimeFormatOptions,
    timeZone: string = USER_TIMEZONE,
    locale = "ru-RU"
): string {
    return date.toLocaleString(locale, { ...options, timeZone });
}

export function formatDateInTimeZone(
    date: Date,
    options: Intl.DateTimeFormatOptions,
    timeZone: string = USER_TIMEZONE,
    locale = "ru-RU"
): string {
    return date.toLocaleDateString(locale, { ...options, timeZone });
}

export function formatPromptDateTime(date: Date, timeZone: string = USER_TIMEZONE): string {
    return formatDateTimeInTimeZone(date, {
        day: "numeric",
        month: "long",
        year: "numeric",
        hour: "numeric",
        minute: "numeric",
        weekday: "long",
    }, timeZone);
}

export function getTimeOfDay(hour: number): string {
    if (hour >= 6 && hour < 12) return "утро";
    if (hour >= 12 && hour < 17) return "день";
    if (hour >= 17 && hour < 22) return "вечер";
    return "ночь";
}

export function getSeason(month: number): string {
    if (month >= 3 && month <= 5) return "весна";
    if (month >= 6 && month <= 8) return "лето";
    if (month >= 9 && month <= 11) return "осень";
    return "зима";
}

export function getZonedDateTimeParts(date: Date, timeZone: string = USER_TIMEZONE): ZonedDateTimeParts {
    const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
    }).formatToParts(date);

    const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
    const weekdayShort = new Intl.DateTimeFormat("en-US", {
        timeZone,
        weekday: "short",
    }).format(date);

    const jsWeekdayIndex = WEEKDAY_INDEX_BY_EN_SHORT[weekdayShort] ?? 0;
    const weekdayIndex = (jsWeekdayIndex + 6) % 7;

    return {
        year: get("year"),
        month: get("month"),
        day: get("day"),
        hour: get("hour"),
        minute: get("minute"),
        second: get("second"),
        weekdayIndex,
    };
}

export function getTimeZoneOffsetMs(date: Date, timeZone: string = USER_TIMEZONE): number {
    const parts = getZonedDateTimeParts(date, timeZone);
    const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, 0);
    return asUtc - date.getTime();
}

export function zonedDateTimeToDate(
    year: number,
    month: number,
    day: number,
    hour: number,
    minute: number,
    timeZone: string = USER_TIMEZONE
): Date {
    let utcMs = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
    for (let i = 0; i < 3; i++) {
        utcMs = Date.UTC(year, month - 1, day, hour, minute, 0, 0) - getTimeZoneOffsetMs(new Date(utcMs), timeZone);
    }
    return new Date(utcMs);
}

export function getZonedDayContext(date: Date, timeZone: string = USER_TIMEZONE): ZonedDayContext {
    const parts = getZonedDateTimeParts(date, timeZone);
    return {
        ...parts,
        weekday: WEEKDAYS_RU[parts.weekdayIndex],
        isWeekend: parts.weekdayIndex >= 5,
        timeOfDay: getTimeOfDay(parts.hour),
        season: getSeason(parts.month),
    };
}

export function getZonedDateKey(date: Date, timeZone: string = USER_TIMEZONE): string {
    const parts = getZonedDateTimeParts(date, timeZone);
    return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

export function addDays(date: Date, days: number): Date {
    return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

export function addZonedDays(date: Date, days: number, timeZone: string = USER_TIMEZONE): Date {
    const parts = getZonedDateTimeParts(date, timeZone);
    const targetDay = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days, 0, 0, 0, 0));
    return zonedDateTimeToDate(
        targetDay.getUTCFullYear(),
        targetDay.getUTCMonth() + 1,
        targetDay.getUTCDate(),
        parts.hour,
        parts.minute,
        timeZone
    );
}

export function isSameZonedDate(left: Date, right: Date, timeZone: string = USER_TIMEZONE): boolean {
    return getZonedDateKey(left, timeZone) === getZonedDateKey(right, timeZone);
}

export function isZonedHourWithinRange(hour: number, start: number, end: number): boolean {
    if (start === end) return true;
    if (start < end) return hour >= start && hour < end;
    return hour >= start || hour < end;
}
