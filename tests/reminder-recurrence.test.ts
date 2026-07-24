import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { getNextReminderOccurrence } from "../utils/reminderRecurrence";

describe("getNextReminderOccurrence", () => {
    test("supports sub-hour intervals without rounding them away", () => {
        const next = getNextReminderOccurrence(
            new Date("2026-01-10T10:00:00.000Z"),
            { type: "hourly", interval: 0.1666666667 },
            new Date("2026-01-10T10:00:01.000Z"),
        );

        assert.equal(next?.toISOString(), "2026-01-10T10:10:00.000Z");
    });

    test("advances past an exact fractional-interval boundary", () => {
        const next = getNextReminderOccurrence(
            new Date("2026-01-10T07:00:00.000Z"),
            { type: "hourly", interval: 0.1666666667 },
            new Date("2026-01-10T13:20:00.000Z"),
        );

        assert.equal(next?.toISOString(), "2026-01-10T13:30:00.000Z");
    });

    test("skips missed interval ticks after downtime", () => {
        const next = getNextReminderOccurrence(
            new Date("2026-01-10T07:00:00.000Z"),
            { type: "hourly", interval: 0.1666666667 },
            new Date("2026-01-10T13:16:00.000Z"),
        );

        assert.equal(next?.toISOString(), "2026-01-10T13:20:00.000Z");
    });

    test("keeps a future long interval on its original grid", () => {
        const next = getNextReminderOccurrence(
            new Date("2026-01-10T07:00:00.000Z"),
            { type: "hourly", interval: 10 },
            new Date("2026-01-10T13:16:00.000Z"),
        );

        assert.equal(next?.toISOString(), "2026-01-10T17:00:00.000Z");
    });

    test("rejects intervals that cannot advance time", () => {
        const start = new Date("2026-01-10T10:00:00.000Z");

        assert.equal(getNextReminderOccurrence(start, { type: "hourly", interval: 0 }, start), null);
        assert.equal(getNextReminderOccurrence(start, { type: "daily", interval: -1 }, start), null);
        assert.equal(getNextReminderOccurrence(start, { type: "monthly", interval: 0.5 }, start), null);
        assert.equal(getNextReminderOccurrence(start, { type: "weekly", interval: Number.NaN }, start), null);
    });
});
