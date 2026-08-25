import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildDigestFallbackGreeting } from "../services/morningDigestScheduler";

describe("morning digest fallback", () => {
    test("does not promise an empty reminder list", () => {
        assert.equal(
            buildDigestFallbackGreeting(0),
            "Привет! Сегодня напоминаний нет.",
        );
    });

    test("keeps the reminder-list introduction when reminders exist", () => {
        assert.equal(
            buildDigestFallbackGreeting(2),
            "Привет! Вот что у тебя сегодня:",
        );
    });
});
