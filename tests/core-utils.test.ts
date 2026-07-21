import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
    isLikelyBot,
    notifyUser,
    parseLLMJson,
    processMarkdownLinks,
    processReminderTime,
} from "../utils";
import { buildMemoryContextBlock } from "../utils/agentMemoryContext";
import { getActiveBotProfile, getActiveMemoryBotId, scopedBotKey } from "../utils/botIdentity";
import { llmCache } from "../utils/llmCache";

describe("parseLLMJson", () => {
    test("parses clean JSON values", () => {
        assert.deepEqual(parseLLMJson('{"ok":true,"count":2}'), { ok: true, count: 2 });
        assert.deepEqual(parseLLMJson('[1,2,3]'), [1, 2, 3]);
    });

    test("extracts an object from prose and code fences", () => {
        assert.deepEqual(parseLLMJson('Ответ:\n```json\n{"intent":"test"}\n```'), { intent: "test" });
    });

    test("handles nested objects, braces in strings, and escaped quotes", () => {
        const text = 'prefix {"nested":{"value":"a } brace and \\\"quote\\\""},"items":[1,2]} suffix';
        assert.deepEqual(parseLLMJson(text), {
            nested: { value: 'a } brace and "quote"' },
            items: [1, 2],
        });
    });

    test("chooses the first balanced object", () => {
        assert.deepEqual(parseLLMJson('first {"a":1} second {"b":2}'), { a: 1 });
    });

    test("returns null for empty or malformed content", () => {
        for (const value of ["", "   ", "not json", "{broken", "```json\nnope\n```"]) {
            assert.equal(parseLLMJson(value), null, value);
        }
    });
});

describe("reminder time processing", () => {
    const now = new Date("2026-01-10T10:00:00.000Z");

    test("preserves a valid future instant", () => {
        assert.equal(processReminderTime("2026-01-11T12:30:00.000Z", now), "2026-01-11T12:30:00.000Z");
    });

    test("uses a deterministic thirty-minute fallback for empty and invalid input", () => {
        assert.equal(processReminderTime("", now), "2026-01-10T10:30:00.000Z");
        assert.equal(processReminderTime("not-a-date", now), "2026-01-10T10:30:00.000Z");
    });

    test("moves a past zoned time into the future", () => {
        const result = new Date(processReminderTime("2020-01-01T23:45:00Z", now));
        assert.ok(result.getTime() > now.getTime());
        assert.equal(result.getMinutes(), 45);
    });

    test("uses the fallback for a past unzoned date", () => {
        assert.equal(processReminderTime("2020-01-01", now), "2026-01-10T10:30:00.000Z");
    });
});

describe("message utilities", () => {
    test("removes Markdown link labels and tracking parameters", () => {
        assert.equal(
            processMarkdownLinks("Открой [пример](https://example.com/path?q=secret&utm_source=test#part) сейчас"),
            "Открой https://example.com/path?q=secret#part сейчас",
        );
    });

    test("leaves plain URLs and text unchanged", () => {
        assert.equal(processMarkdownLinks("https://example.com/?q=1"), "https://example.com/?q=1");
        assert.equal(processMarkdownLinks("без ссылок"), "без ссылок");
    });

    test("recognizes bot-like usernames case-insensitively", () => {
        for (const value of ["helper_bot", "NewsBot", "robotics", "чатбот", "botham"] ) {
            assert.equal(isLikelyBot(value), true, value);
        }
        for (const value of [undefined, "", "alice", "batman"] ) {
            assert.equal(isLikelyBot(value), false, String(value));
        }
    });

    test("sends typing before a progress reply", async () => {
        const calls: string[] = [];
        const ctx = {
            chat: { id: 42 },
            api: { sendChatAction: async (id: number, action: string) => { calls.push(`action:${id}:${action}`); } },
            reply: async (text: string) => { calls.push(`reply:${text}`); },
        };
        await notifyUser(ctx, "Работаю");
        assert.deepEqual(calls, ["action:42:typing", "reply:Работаю"]);
    });

    test("skips progress notification without a chat and swallows transport errors", async () => {
        let called = false;
        await notifyUser({ api: {}, reply: () => { called = true; } }, "x");
        assert.equal(called, false);
        await assert.doesNotReject(notifyUser({
            chat: { id: 1 },
            api: { sendChatAction: async () => { throw new Error("offline"); } },
            reply: async () => { throw new Error("offline"); },
        }, "x"));
    });
});

describe("memory context and bot identity", () => {
    test("omits an empty memory block", () => {
        assert.equal(buildMemoryContextBlock({ domain: "personal", context: "  " }), "");
    });

    test("formats a non-empty memory block with its domain", () => {
        assert.equal(
            buildMemoryContextBlock({ domain: "health", context: "Любит прогулки" }),
            "\nРелевантный контекст из долговременной памяти (домен: health):\nЛюбит прогулки",
        );
    });

    test("keeps the supported bot profile scoped and rejects arbitrary profiles", () => {
        const previous = process.env.ASSISTANT_PROFILE;
        try {
            process.env.ASSISTANT_PROFILE = "KiraMindBot";
            assert.equal(getActiveBotProfile(), "KiraMindBot");
            assert.equal(getActiveMemoryBotId(), "kiramindbot");
            assert.equal(scopedBotKey(123), "KiraMindBot:123");
            process.env.ASSISTANT_PROFILE = "unsupported";
            assert.equal(getActiveBotProfile(), "KiraMindBot");
        } finally {
            if (previous === undefined) delete process.env.ASSISTANT_PROFILE;
            else process.env.ASSISTANT_PROFILE = previous;
        }
    });
});

describe("LLM cache", () => {
    test("stores and retrieves typed values", () => {
        const key = `test:${process.pid}:value`;
        llmCache.set(key, { answer: 42 }, 60_000);
        assert.deepEqual(llmCache.get<{ answer: number }>(key), { answer: 42 });
    });

    test("expires values and removes them on read", () => {
        const key = `test:${process.pid}:expired`;
        const before = llmCache.size;
        llmCache.set(key, "old", -1);
        assert.equal(llmCache.get(key), undefined);
        assert.equal(llmCache.size, before);
    });
});
