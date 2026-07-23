import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createPlan, postProcessPlan } from "../orchestration/planner";
import { llmCache, LLM_CACHE_TTL } from "../utils/llmCache";
import {
    getReflectionMemoryNoiseReasons,
    isReflectionFactWorthSaving,
    isReflectionMemoryNoiseCandidate,
} from "../utils/reflectionMemoryFilter";
import {
    isBotMentioned,
    isContextDependentGroupMessage,
    isGroupChat,
    isMessageReplyToBot,
} from "../utils/groupChatContext";

function input(message: string, intent: string, subIntents?: Array<{ intent: string }>): any {
    return { message, classification: { intent, subIntents } };
}

describe("deterministic planner routes", () => {
    test("routes browser continuations before their stale classification", async () => {
        assert.deepEqual(await createPlan(input("Продолжи задачу в браузере через Playwright. шаг 2", "РАЗГОВОР")), {
            steps: [{ agentId: "browserTask" }],
        });
        assert.deepEqual(await createPlan(input("browserSessionId:abc", "НЕОПРЕДЕЛЕНО")), {
            steps: [{ agentId: "browserTask" }],
        });
    });

    test("routes protected single-agent intents without calling the LLM", async () => {
        const cases = [
            ["БРАУЗЕР_ЗАДАЧА", "browserTask"],
            ["ЗДОРОВЬЕ", "health"],
            ["НЕОПРЕДЕЛЕНО", "unclearIntent"],
            ["САМОИЗУЧЕНИЕ", "selfStudy"],
        ];
        for (const [intent, agentId] of cases) {
            assert.deepEqual(await createPlan(input("тест", intent)), { steps: [{ agentId }] }, intent);
        }
    });

    test("keeps today's agenda in conversation retrieval flow", async () => {
        assert.deepEqual(await createPlan(input("Что важного у меня сегодня?", "РАЗГОВОР")), {
            steps: [{ agentId: "conversation" }],
        });
    });

    test("does not let the planner replace a clear conversation with clarification", async () => {
        assert.deepEqual(await createPlan({
            message: "давай подробнее",
            classification: {
                intent: "РАЗГОВОР",
                confidenceLevel: "ВЫСОКИЙ",
                details: {},
            },
        }), {
            steps: [{ agentId: "conversation" }],
        });

        assert.deepEqual(postProcessPlan({
            steps: [{ agentId: "unclearIntent" }, { agentId: "conversation" }],
        }, {
            intent: "РАЗГОВОР",
            confidenceLevel: "ВЫСОКИЙ",
            details: {},
        }), {
            steps: [{ agentId: "conversation" }],
        });
    });

    test("routes a simple reminder directly", async () => {
        assert.deepEqual(await createPlan(input("Напомни завтра позвонить", "НАПОМИНАНИЕ")), {
            steps: [{ agentId: "reminder" }],
        });
    });

    test("removes a cached maps step from pure web search", async () => {
        const message = `web-${process.pid}`;
        llmCache.set(`plan:ВЕБ_ПОИСК:${message}`, {
            steps: [{ agentId: "maps" }, { agentId: "webSearch" }],
        }, LLM_CACHE_TTL.PLAN);
        assert.deepEqual(await createPlan(input(message, "ВЕБ_ПОИСК")), {
            steps: [{ agentId: "webSearch" }],
        });
    });

    test("retains maps when it is an explicit sub-intent", async () => {
        const message = `web-map-${process.pid}`;
        llmCache.set(`plan:ВЕБ_ПОИСК:${message}`, {
            steps: [{ agentId: "webSearch" }, { agentId: "maps" }],
        }, LLM_CACHE_TTL.PLAN);
        assert.deepEqual(await createPlan(input(message, "ВЕБ_ПОИСК", [{ intent: "КАРТЫ_ЛОКАЦИИ" }])), {
            steps: [{ agentId: "webSearch" }, { agentId: "maps" }],
        });
    });
});

describe("reflection memory quality thresholds", () => {
    test("rejects every fact below minimum confidence", () => {
        assert.equal(isReflectionFactWorthSaving({ content: "важный факт", temporalScope: "stable", importance: 1, confidence: 0.54 }), false);
    });

    test("applies stable, preference, routine, and relationship thresholds", () => {
        for (const temporalScope of ["stable", "preference", "routine", "relationship"] as const) {
            assert.equal(isReflectionFactWorthSaving({ content: "x", temporalScope, importance: 0.48, confidence: 0.7 }), true, temporalScope);
            assert.equal(isReflectionFactWorthSaving({ content: "x", temporalScope, importance: 0.47, confidence: 0.9 }), false, temporalScope);
        }
    });

    test("applies stricter temporal thresholds", () => {
        assert.equal(isReflectionFactWorthSaving({ content: "x", temporalScope: "future_plan", importance: 0.68, confidence: 0.7 }), true);
        assert.equal(isReflectionFactWorthSaving({ content: "x", temporalScope: "future_plan", importance: 0.67, confidence: 0.9 }), false);
        assert.equal(isReflectionFactWorthSaving({ content: "x", temporalScope: "past_event", importance: 0.70, confidence: 0.7 }), true);
        assert.equal(isReflectionFactWorthSaving({ content: "x", temporalScope: "current_state", importance: 0.78, confidence: 0.7 }), true);
    });

    test("requires both importance and confidence for unknown facts", () => {
        assert.equal(isReflectionFactWorthSaving({ content: "x", importance: 0.72, confidence: 0.70 }), true);
        assert.equal(isReflectionFactWorthSaving({ content: "x", importance: 0.72, confidence: 0.69 }), false);
        assert.equal(isReflectionFactWorthSaving({ content: "x", importance: 0.71, confidence: 0.9 }), false);
    });

    test("reads temporal scope from tags", () => {
        assert.equal(isReflectionFactWorthSaving({ content: "x", tags: ["temporal_scope:preference"], importance: 0.5, confidence: 0.7 }), true);
        assert.equal(isReflectionFactWorthSaving({ content: "x", tags: ["temporal_scope:current_state"], importance: 0.7, confidence: 0.9 }), false);
    });

    test("exempts episodes from reflection noise filters", () => {
        const episode = {
            content: "ChatGPT распознал файл сегодня",
            memoryKind: "episode",
            tags: ["memory-episode"],
        };
        assert.deepEqual(getReflectionMemoryNoiseReasons(episode), []);
        assert.equal(isReflectionMemoryNoiseCandidate(episode), false);
    });

    test("keeps durable routines despite technical keywords", () => {
        assert.equal(isReflectionMemoryNoiseCandidate({
            content: "Дмитрий регулярно использует ChatGPT для черновой расшифровки",
            temporalScope: "routine",
            importance: 0.7,
        }), false);
    });

    test("keeps durable location contexts", () => {
        for (const content of ["Анна сейчас в больнице", "Иван находится в командировке", "Мария переехала в Казань"]) {
            assert.equal(getReflectionMemoryNoiseReasons({ content, importance: 0.9 }).includes("temporary_state"), false, content);
        }
    });
});

describe("group message trigger classification", () => {
    test("recognizes group and supergroup chats only", () => {
        assert.equal(isGroupChat({ chat: { type: "group" } } as any), true);
        assert.equal(isGroupChat({ chat: { type: "supergroup" } } as any), true);
        assert.equal(isGroupChat({ chat: { type: "private" } } as any), false);
        assert.equal(isGroupChat({} as any), false);
    });

    test("recognizes short context-dependent questions", () => {
        const positives = ["А ты что думаешь?", "Как тебе?", "Согласна?", "Норм?", "А это?", "Ну и что дальше?"];
        for (const text of positives) assert.equal(isContextDependentGroupMessage(text), true, text);
    });

    test("ignores mentions while checking context dependence", () => {
        assert.equal(isContextDependentGroupMessage("@KiraMindBot а ты что думаешь?"), true);
        assert.equal(isContextDependentGroupMessage("@KiraMindBot"), false);
    });

    test("rejects self-contained statements and long unrelated questions", () => {
        assert.equal(isContextDependentGroupMessage("Сегодня мы закончили проект"), false);
        assert.equal(isContextDependentGroupMessage("Расскажи подробно об истории архитектуры Санкт-Петербурга и перечисли основные стили и периоды?"), false);
    });

    test("detects a real Telegram mention entity", () => {
        const text = "Привет @KiraMindBot";
        const ctx = { message: { entities: [{ type: "mention", offset: 7, length: 12 }] } } as any;
        assert.equal(isBotMentioned(ctx, text, "kiramindbot"), true);
        assert.equal(isBotMentioned(ctx, text, "otherbot"), false);
    });

    test("supports caption entities and ignores plain text without entities", () => {
        const text = "Фото @KiraMindBot";
        const ctx = { message: { caption_entities: [{ type: "mention", offset: 5, length: 12 }] } } as any;
        assert.equal(isBotMentioned(ctx, text, "KiraMindBot"), true);
        assert.equal(isBotMentioned({ message: {} } as any, text, "KiraMindBot"), false);
    });

    test("recognizes replies to the configured bot only", () => {
        const matching = { message: { reply_to_message: { from: { is_bot: true, username: "KiraMindBot" } } } } as any;
        const human = { message: { reply_to_message: { from: { is_bot: false, username: "KiraMindBot" } } } } as any;
        assert.equal(isMessageReplyToBot(matching, "kiramindbot"), true);
        assert.equal(isMessageReplyToBot(matching, "otherbot"), false);
        assert.equal(isMessageReplyToBot(human, "kiramindbot"), false);
    });
});
