import type { RecurrenceRule } from "../types/reminderTypes";

const HOUR_MS = 60 * 60 * 1000;
const MAX_CALENDAR_ADVANCES = 100_000;

function isValidDate(date: Date): boolean {
    return Number.isFinite(date.getTime());
}

function advanceCalendarOccurrence(fromDate: Date, rule: RecurrenceRule): Date | null {
    const next = new Date(fromDate);

    switch (rule.type) {
        case "daily":
            next.setDate(next.getDate() + rule.interval);
            break;
        case "weekly": {
            const daysOfWeek = [...new Set(rule.daysOfWeek ?? [])]
                .filter(day => Number.isInteger(day) && day >= 0 && day <= 6)
                .sort((left, right) => left - right);
            if (daysOfWeek.length === 0) {
                next.setDate(next.getDate() + 7 * rule.interval);
                break;
            }

            const currentDay = fromDate.getDay();
            const nextDay = daysOfWeek.find(day => day > currentDay);
            const daysToAdd = nextDay === undefined
                ? 7 - currentDay + daysOfWeek[0]
                : nextDay - currentDay;
            next.setDate(next.getDate() + daysToAdd);
            break;
        }
        case "monthly":
            next.setMonth(next.getMonth() + rule.interval);
            break;
        case "yearly":
            next.setFullYear(next.getFullYear() + rule.interval);
            break;
        case "hourly":
            return null;
    }

    return isValidDate(next) && next.getTime() > fromDate.getTime() ? next : null;
}

/**
 * Возвращает первое время повтора строго после afterDate.
 *
 * Просроченные интервалы намеренно пропускаются: после простоя бот выполняет
 * напоминание один раз, а не воспроизводит подряд все пропущенные срабатывания.
 */
export function getNextReminderOccurrence(
    fromDate: Date,
    rule: RecurrenceRule,
    afterDate: Date = new Date(),
): Date | null {
    if (
        !isValidDate(fromDate)
        || !isValidDate(afterDate)
        || !Number.isFinite(rule.interval)
        || rule.interval <= 0
        || (rule.type !== "hourly" && !Number.isInteger(rule.interval))
    ) {
        return null;
    }

    if (rule.type === "hourly") {
        const intervalMs = Math.round(rule.interval * HOUR_MS);
        if (!Number.isFinite(intervalMs) || intervalMs <= 0) return null;

        const elapsedMs = afterDate.getTime() - fromDate.getTime();
        const steps = Math.max(1, Math.floor(elapsedMs / intervalMs) + 1);
        const next = new Date(fromDate.getTime() + steps * intervalMs);
        return isValidDate(next) && next.getTime() > afterDate.getTime() ? next : null;
    }

    let next = advanceCalendarOccurrence(fromDate, rule);
    for (let advances = 0; next && next.getTime() <= afterDate.getTime(); advances += 1) {
        if (advances >= MAX_CALENDAR_ADVANCES) return null;
        next = advanceCalendarOccurrence(next, rule);
    }
    return next;
}
