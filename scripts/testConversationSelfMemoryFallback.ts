import assert from "node:assert/strict";

process.env.KIRA_BOT_TOKEN = process.env.KIRA_BOT_TOKEN || "test-token";

import {
    buildAssistantLifeContext,
    buildCorruptedSelfMemoryReply,
} from "../utils/conversationSelfMemoryFallback";

const emptyContext = buildAssistantLifeContext(
    null,
    [],
    [],
    new Date("2026-06-27T10:00:00.000Z"),
);

assert.equal(emptyContext, "");

const reply = buildCorruptedSelfMemoryReply("Кира");
assert.match(reply, /внутренняя память о себе недоступна/i);
assert.match(reply, /не хочу придумывать/i);
assert.doesNotMatch(reply, /санкт-петербург/i);
assert.doesNotMatch(reply, /спбгу/i);

console.log("conversation self-memory fallback checks passed");
