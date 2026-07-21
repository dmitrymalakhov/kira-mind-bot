import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { sendMessage } from "../utils";
import { formatConversation } from "../utils/studyChatFlow";

describe("long message delivery", () => {
    test("sends short text once with the original options", async () => {
        const calls: any[][] = [];
        const options = { parse_mode: "HTML", reply_markup: { inline_keyboard: [] } };
        const ctx = { reply: async (...args: any[]) => { calls.push(args); return "sent"; } } as any;
        const result = await sendMessage(ctx, "Короткий текст", options);
        assert.equal(result, "sent");
        assert.deepEqual(calls, [["Короткий текст", options]]);
    });

    test("splits long text into sequentially numbered parts", async () => {
        const sent: string[] = [];
        const ctx = { reply: async (text: string) => { sent.push(text); return sent.length; } } as any;
        const result = await sendMessage(ctx, "x".repeat(8_500));
        assert.equal(sent.length, 3);
        assert.match(sent[0], /^Часть 1\/3\n\n/);
        assert.match(sent[1], /^Часть 2\/3\n\n/);
        assert.match(sent[2], /^Часть 3\/3\n\n/);
        assert.equal(result, 3);
    });

    test("never exceeds Telegram's message size after adding part labels", async () => {
        const sent: string[] = [];
        const ctx = { reply: async (text: string) => { sent.push(text); } } as any;
        await sendMessage(ctx, "x".repeat(8_500));
        assert.ok(sent.every((part) => part.length <= 4_000), sent.map((part) => part.length).join(", "));
    });

    test("attaches options only to the final part", async () => {
        const calls: any[][] = [];
        const options = { parse_mode: "HTML" };
        const ctx = { reply: async (...args: any[]) => { calls.push(args); } } as any;
        await sendMessage(ctx, "x".repeat(4_500), options);
        assert.equal(calls.length, 2);
        assert.equal(calls[0].length, 1);
        assert.deepEqual(calls[1][1], options);
    });

    test("prefers a paragraph boundary in the latter half of a part", async () => {
        const sent: string[] = [];
        const ctx = { reply: async (text: string) => { sent.push(text); } } as any;
        await sendMessage(ctx, `${"a".repeat(2_500)}\n\n${"b".repeat(2_500)}`);
        assert.equal(sent.length, 2);
        assert.ok(sent[0].endsWith("a"));
        assert.ok(sent[1].includes("b".repeat(100)));
    });

    test("falls back to a hard boundary for text without separators", async () => {
        const sent: string[] = [];
        const ctx = { reply: async (text: string) => { sent.push(text); } } as any;
        await sendMessage(ctx, "я".repeat(4_001));
        assert.equal(sent.length, 2);
        assert.ok(sent.every((part) => part.length <= 4_000));
    });
});

describe("studied conversation formatting", () => {
    test("sorts messages chronologically", () => {
        const result = formatConversation([
            { date: 200, message: "Второе", out: false },
            { date: 100, message: "Первое", out: false },
        ] as any, 1, "Анна");
        assert.ok(result.indexOf("Первое") < result.indexOf("Второе"));
    });

    test("labels outgoing messages as the owner", () => {
        const result = formatConversation([{ date: 100, message: "Привет", out: true }] as any, 1, "Анна");
        assert.match(result, /\] Я: Привет$/);
    });

    test("labels incoming messages with the contact name", () => {
        const result = formatConversation([{ date: 100, message: "Привет", out: false }] as any, 1, "Анна");
        assert.match(result, /\] Анна: Привет$/);
    });

    test("trims message text", () => {
        const result = formatConversation([{ date: 100, message: "  Привет  \n", out: false }] as any, 1, "Анна");
        assert.match(result, /Анна: Привет$/);
        assert.doesNotMatch(result, /  Привет/);
    });

    test("skips empty and media-only messages", () => {
        const result = formatConversation([
            { date: 100, message: "", out: false },
            { date: 101, message: "   ", out: false },
            { date: 102, out: false, media: {} },
            { date: 103, message: "Текст", out: false },
        ] as any, 1, "Анна");
        assert.equal(result.split("\n").length, 1);
        assert.match(result, /Текст/);
    });

    test("returns an empty string when there are no textual messages", () => {
        assert.equal(formatConversation([] as any, 1, "Анна"), "");
        assert.equal(formatConversation([{ date: 1, message: " " }] as any, 1, "Анна"), "");
    });
});
