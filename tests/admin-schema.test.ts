import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CONFIG_SCHEMA } from "../admin-panel/src/schema";

describe("admin configuration schema", () => {
    const fields = CONFIG_SCHEMA.flatMap((section) => section.fields);

    test("uses unique non-empty section IDs", () => {
        const ids = CONFIG_SCHEMA.map((section) => section.id);
        assert.equal(new Set(ids).size, ids.length);
        assert.equal(ids.every(Boolean), true);
    });

    test("provides a title, icon, and at least one field per section", () => {
        for (const section of CONFIG_SCHEMA) {
            assert.ok(section.title.trim(), section.id);
            assert.ok(section.icon.trim(), section.id);
            assert.ok(section.fields.length > 0, section.id);
        }
    });

    test("uses unique environment keys", () => {
        const keys = fields.map((field) => field.key);
        assert.equal(new Set(keys).size, keys.length);
    });

    test("provides labels and supported editor types for every field", () => {
        const supported = new Set(["text", "password", "number", "toggle", "textarea", "duration", "select"]);
        for (const field of fields) {
            assert.ok(field.key.trim());
            assert.ok(field.label.trim(), field.key);
            assert.equal(supported.has(field.type), true, `${field.key}:${field.type}`);
        }
    });

    test("keeps critical credentials marked as required passwords", () => {
        for (const key of ["OPENAI_API_KEY", "KIRA_BOT_TOKEN", "DB_PASSWORD"]) {
            const field = fields.find((candidate) => candidate.key === key);
            assert.ok(field, key);
            assert.equal(field?.required, true, key);
            assert.equal(field?.type, "password", key);
        }
    });

    test("keeps interval settings on the duration editor", () => {
        const intervalFields = fields.filter((field) => field.key.endsWith("_INTERVAL_MS") || field.key === "REMINDER_EXPIRY_TIME_MS");
        assert.ok(intervalFields.length > 0);
        for (const field of intervalFields) assert.equal(field.type, "duration", field.key);
    });
});
