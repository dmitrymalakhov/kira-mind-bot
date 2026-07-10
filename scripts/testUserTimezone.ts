import assert from "node:assert/strict";
import {
    addZonedDays,
    formatPromptDateTime,
    getZonedDateKey,
    getZonedDayContext,
    getZonedDateTimeParts,
    isSameZonedDate,
} from "../utils/time";

const userTimeZone = "Europe/Moscow";

const utcMorning = new Date("2026-06-28T05:25:00.000Z");
const promptTime = formatPromptDateTime(utcMorning, userTimeZone);
assert.match(promptTime, /\b0?8:25\b/u);
assert.doesNotMatch(promptTime, /\b0?5:25\b/u);

const morningContext = getZonedDayContext(utcMorning, userTimeZone);
assert.equal(morningContext.hour, 8);
assert.equal(morningContext.weekdayIndex, 6);
assert.equal(morningContext.timeOfDay, "утро");
assert.equal(morningContext.season, "лето");

const schedulerInstant = new Date("2026-06-30T21:02:00.000Z");
const schedulerParts = getZonedDateTimeParts(schedulerInstant, userTimeZone);
assert.equal(schedulerParts.hour, 0);
assert.equal(schedulerParts.minute, 2);

const dayBoundaryNow = new Date("2026-06-30T21:30:00.000Z");
const morningReminder = new Date("2026-07-01T06:00:00.000Z");
assert.equal(getZonedDateKey(dayBoundaryNow, userTimeZone), "2026-07-01");
assert.equal(getZonedDateKey(morningReminder, userTimeZone), "2026-07-01");
assert.equal(isSameZonedDate(dayBoundaryNow, morningReminder, userTimeZone), true);

const dstTimeZone = "Europe/Berlin";
const dstBoundary = new Date("2026-03-28T22:30:00.000Z");
const dstNextDay = addZonedDays(dstBoundary, 1, dstTimeZone);
assert.equal(getZonedDateKey(dstBoundary, dstTimeZone), "2026-03-28");
assert.equal(getZonedDateKey(dstNextDay, dstTimeZone), "2026-03-29");

console.log("user timezone helpers passed");
process.exit(0);
