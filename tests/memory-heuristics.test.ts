import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
    calcImportance,
    estimateHumanMemoryMetrics,
    extractTags,
    inferMemoryKind,
} from "../utils/enhancedDomainMemory";
import { rememberFact } from "../utils/domainMemory";
import { hasFreshPendingReminder } from "../utils/implicitReminderDetector";

describe("memory kind inference", () => {
    test("honors an explicit memory kind before heuristics", () => {
        assert.equal(inferMemoryKind("Я обещал позвонить", [], { memoryKind: "trait" }), "trait");
    });

    const cases: Array<[string, string, string[]?]> = [
        ["episode tag", "обычная запись", ["memory-episode"]],
        ["episode prefix", "[ЭПИЗОД ПАМЯТИ: поездка] детали"],
        ["chapter tag", "обычная запись", ["memory-chapter"]],
        ["chapter prefix", "[ГЛАВА ПАМЯТИ: весна] детали"],
        ["portrait tag", "обычная запись", ["portrait:Анна"]],
        ["portrait prefix", "[ПСИХОЛОГИЧЕСКИЙ ПОРТРЕТ: Анна] детали"],
        ["promise", "Я пообещал отправить документы"],
        ["boundary", "Не спрашивай меня о зарплате"],
        ["routine", "Каждое утро я бегаю"],
        ["preference", "Обожаю зелёный чай"],
        ["relationship", "Моя сестра живёт рядом"],
        ["open loop", "Осталось согласовать договор"],
        ["goal", "Планирую выучить испанский"],
        ["state", "Сейчас работает из дома"],
        ["event", "Вчера купил велосипед"],
        ["trait", "Для него важно говорить прямо"],
        ["fallback fact", "Стол сделан из дерева"],
    ];

    for (const [label, content, tags = []] of cases) {
        test(`recognizes ${label}`, () => {
            const expected = label === "open loop"
                ? "open_loop"
                : label.split(" ")[0] === "fallback"
                    ? "fact"
                    : label.split(" ")[0];
            assert.equal(inferMemoryKind(content, tags), expected);
        });
    }

    test("uses heuristic priority for a promise that also mentions a routine", () => {
        assert.equal(inferMemoryKind("Я обещал делать это каждое утро"), "promise");
    });

    test("uses boundary priority over preference wording", () => {
        assert.equal(inferMemoryKind("Не люблю, когда спрашивают об этом; не спрашивай"), "boundary");
    });
});

describe("human memory metrics", () => {
    const baseline = {
        content: "обычный короткий факт",
        importance: 0.5,
        confidence: 0.6,
    };

    test("returns all metrics inside the normalized range", () => {
        const metrics = estimateHumanMemoryMetrics(baseline);
        for (const value of Object.values(metrics)) {
            assert.ok(value >= 0 && value <= 1);
        }
    });

    test("makes concrete dated content more specific", () => {
        const vague = estimateHumanMemoryMetrics(baseline);
        const concrete = estimateHumanMemoryMetrics({
            ...baseline,
            content: "Анна встретится в Москве 21.07.2026 в 15 часов и принесёт документы",
            tags: ["работа", "срочно"],
        });
        assert.ok(concrete.specificity > vague.specificity);
    });

    test("anchor status increases strength", () => {
        const regular = estimateHumanMemoryMetrics(baseline);
        const anchor = estimateHumanMemoryMetrics({ ...baseline, isAnchor: true });
        assert.ok(anchor.strength > regular.strength);
    });

    test("retrieval increases strength but the boost is capped", () => {
        const never = estimateHumanMemoryMetrics({ ...baseline, retrievalCount: 0 });
        const often = estimateHumanMemoryMetrics({ ...baseline, retrievalCount: 100 });
        const extreme = estimateHumanMemoryMetrics({ ...baseline, retrievalCount: 1_000_000 });
        assert.ok(often.strength > never.strength);
        assert.ok(extreme.strength - never.strength <= 0.100001);
    });

    for (const status of ["expired", "superseded"] as const) {
        test(`${status} status weakens a memory`, () => {
            const active = estimateHumanMemoryMetrics({ ...baseline, status: "active" });
            const stale = estimateHumanMemoryMetrics({ ...baseline, status });
            assert.ok(stale.strength < active.strength);
        });
    }

    test("emotional arousal and flashbulb flag increase vividness", () => {
        const calm = estimateHumanMemoryMetrics(baseline);
        const emotional = estimateHumanMemoryMetrics({
            ...baseline,
            emotionalTag: { emotion: "joy", intensity: 0.9, arousal: 1, valence: 1, isFlashbulb: true } as any,
        });
        assert.ok(emotional.vividness > calm.vividness);
    });

    for (const memoryKind of ["episode", "event", "portrait", "relationship", "goal", "open_loop", "prospective"] as const) {
        test(`${memoryKind} kind adds vividness`, () => {
            const regular = estimateHumanMemoryMetrics(baseline);
            const typed = estimateHumanMemoryMetrics({ ...baseline, memoryKind });
            assert.ok(typed.vividness > regular.vividness);
        });
    }

    test("clamps very strong inputs to one", () => {
        const metrics = estimateHumanMemoryMetrics({
            content: "Анна в Москве 21.07.2026: " + "важная подробность ".repeat(10),
            importance: 10,
            confidence: 10,
            tags: ["a", "b"],
            isAnchor: true,
            retrievalCount: 1000,
            emotionalTag: { arousal: 10, isFlashbulb: true } as any,
            memoryKind: "episode",
        });
        assert.equal(metrics.strength, 1);
        assert.equal(metrics.vividness, 1);
    });

    test("clamps negative inputs to zero where applicable", () => {
        const metrics = estimateHumanMemoryMetrics({
            content: "x",
            importance: -10,
            confidence: -10,
            status: "expired",
        });
        assert.equal(metrics.strength, 0);
        assert.ok(metrics.vividness >= 0);
        assert.ok(metrics.specificity >= 0);
    });
});

describe("importance and tag extraction", () => {
    const importanceCases: Array<[string, string, string, number]> = [
        ["ordinary user message", "user", "обычный факт", 0.7],
        ["ordinary assistant message", "assistant", "обычный ответ", 0.5],
        ["unknown role", "system", "обычный текст", 0.5],
        ["reminder", "assistant", "Создано напоминание", 0.8],
        ["event with punctuation", "assistant", "Важное событие!", 1],
        ["user question", "user", "Когда встреча?", 0.9],
    ];

    for (const [label, role, content, expected] of importanceCases) {
        test(`calculates importance for ${label}`, () => {
            assert.ok(Math.abs(calcImportance(role, content) - expected) < 1e-12);
        });
    }

    test("extracts every supported tag from mixed case text", () => {
        assert.deepEqual(
            extractTags("СРОЧНО: завтра в офисе работа, семья и родители; тревога, страх, радость, грусть и печаль"),
            ["тревога", "радость", "грусть", "работа", "семья", "срочно"],
        );
    });

    test("returns unique tags even when several synonyms match", () => {
        assert.deepEqual(extractTags("тревога, паника и страх"), ["тревога"]);
    });

    test("returns an empty list for unrelated content", () => {
        assert.deepEqual(extractTags("нейтральная заметка"), []);
    });
});

describe("session memory helpers", () => {
    test("initializes a missing domain and stores the fact", () => {
        const ctx = { session: { domains: {} } } as any;
        rememberFact(ctx, "travel", "Хочет в Казань");
        assert.deepEqual(ctx.session.domains.travel, {
            summary: "",
            facts: ["Хочет в Казань"],
        });
    });

    test("appends facts without replacing an existing summary", () => {
        const ctx = {
            session: { domains: { work: { summary: "Текущая работа", facts: ["Факт 1"] } } },
        } as any;
        rememberFact(ctx, "work", "Факт 2");
        assert.equal(ctx.session.domains.work.summary, "Текущая работа");
        assert.deepEqual(ctx.session.domains.work.facts, ["Факт 1", "Факт 2"]);
    });

    test("does not trigger summarization at the ten-fact boundary", () => {
        const ctx = {
            session: { domains: { work: { summary: "", facts: Array.from({ length: 9 }, (_, i) => `Факт ${i}`) } } },
        } as any;
        rememberFact(ctx, "work", "Десятый");
        assert.equal(ctx.session.domains.work.facts.length, 10);
    });

    test("detects a fresh pending implicit reminder", () => {
        const now = Date.now();
        const ctx = { session: { pendingImplicitReminder: { createdAt: now - 299_999 } } } as any;
        assert.equal(hasFreshPendingReminder(ctx), true);
    });

    test("rejects a pending reminder exactly at the TTL boundary", () => {
        const now = Date.now();
        const ctx = { session: { pendingImplicitReminder: { createdAt: now - 300_000 } } } as any;
        assert.equal(hasFreshPendingReminder(ctx), false);
    });

    test("rejects missing and stale pending reminders", () => {
        assert.equal(hasFreshPendingReminder({ session: {} } as any), false);
        const ctx = { session: { pendingImplicitReminder: { createdAt: Date.now() - 600_000 } } } as any;
        assert.equal(hasFreshPendingReminder(ctx), false);
    });
});
