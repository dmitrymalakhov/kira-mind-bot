import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { decideContextualFollowUp } from "../utils/contextualFollowUp";
import { buildClassificationCacheKey } from "../utils/classificationCache";
import {
    hasSubstantiveNewsDigest,
    selectNewsDigestResponse,
} from "../agents/webSearchAgent";

const newsHistory = [
    {
        role: "user",
        content: "найди в интернете свежие новости и сделай новостную сводку",
        timestamp: new Date("2026-07-23T09:27:37.000Z"),
    },
    {
        role: "bot",
        content: "Собрала короткую сводку свежих новостей. Могу разложить её подробнее.",
        timestamp: new Date("2026-07-23T09:27:54.000Z"),
    },
];

describe("contextual follow-ups", () => {
    test("continues a current-news request through web search", () => {
        assert.deepEqual(decideContextualFollowUp("давай подробнее", newsHistory), {
            intent: "ВЕБ_ПОИСК",
            knowledgeSource: "external_current",
            requestedFacets: ["facts", "sources"],
            reason: "contextual follow-up to current external knowledge",
        });
    });

    test("treats self-delivery of the referenced result as an in-chat response", () => {
        assert.deepEqual(decideContextualFollowUp("пришли мне её", [
            ...newsHistory,
            {
                role: "user",
                content: "давай подробнее",
                timestamp: new Date("2026-07-23T09:29:00.000Z"),
            },
            {
                role: "bot",
                content: "Собрала более полную свежую подборку по интернету.",
                timestamp: new Date("2026-07-23T09:30:15.000Z"),
            },
            {
                role: "user",
                content: "пришли мне её",
                timestamp: new Date("2026-07-23T09:30:30.000Z"),
            },
        ]), {
            intent: "ВЕБ_ПОИСК",
            knowledgeSource: "external_current",
            requestedFacets: ["facts", "sources"],
            reason: "contextual follow-up to current external knowledge",
        });
    });

    test("keeps a non-web expansion in ordinary conversation", () => {
        assert.deepEqual(decideContextualFollowUp("расскажи подробнее", [
            {
                role: "user",
                content: "что такое инкапсуляция",
                timestamp: new Date("2026-07-23T09:00:00.000Z"),
            },
            {
                role: "bot",
                content: "Это способ скрыть внутреннее устройство объекта.",
                timestamp: new Date("2026-07-23T09:00:05.000Z"),
            },
        ]), {
            intent: "РАЗГОВОР",
            knowledgeSource: "stable_general",
            requestedFacets: [],
            reason: "contextual in-chat follow-up",
        });
    });

    test("does not intercept explicit delivery to another person", () => {
        assert.equal(decideContextualFollowUp("отправь её Марии", newsHistory), null);
    });
});

describe("classification cache context", () => {
    test("uses recent history in the cache key for short contextual phrases", () => {
        const first = buildClassificationCacheKey("давай подробнее", newsHistory, []);
        const second = buildClassificationCacheKey("давай подробнее", [
            {
                role: "user",
                content: "объясни принцип инкапсуляции",
                timestamp: new Date("2026-07-23T10:00:00.000Z"),
            },
        ], []);

        assert.notEqual(first, second);
        assert.equal(first, buildClassificationCacheKey("давай подробнее", newsHistory, []));
    });
});

describe("news digest quality", () => {
    const concreteDigest = [
        "1. **Первая новость** — событие произошло 23 июля и имеет конкретные последствия.",
        "Источник: https://example.com/news-1",
        "",
        "2. Вторая новость — событие произошло 23 июля и имеет конкретные последствия.",
        "Источник: https://example.com/news-2",
        "",
        "3. Третья новость — событие произошло 23 июля и имеет конкретные последствия.",
        "Источник: https://example.com/news-3",
        "",
        "Вывод: это три отдельных подтверждённых события из свежей повестки.",
    ].join("\n");

    test("rejects a promise to provide news without the actual digest", () => {
        assert.equal(
            hasSubstantiveNewsDigest("Собрала свежую подборку. Если хочешь, могу прислать её подробнее."),
            false,
        );
        assert.equal(hasSubstantiveNewsDigest(concreteDigest), true);
    });

    test("keeps the substantive web result when conversation drops its contents", () => {
        const selected = selectNewsDigestResponse(
            "найди свежие новости и сделай новостную сводку",
            concreteDigest,
            "Собрала более полную подборку. Если хочешь, могу развернуть любой блок.",
        );
        assert.match(selected, /Первая новость/);
        assert.match(selected, /https:\/\/example\.com\/news-3/);
        assert.doesNotMatch(selected, /\*\*/);
    });
});
