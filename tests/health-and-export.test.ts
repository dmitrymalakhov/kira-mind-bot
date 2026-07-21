import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildHealthExportUrl } from "../admin-panel/src/api";
import { buildHealthMenuKeyboard, buildHealthMenuResult, shouldRouteHealthPhoto } from "../agents/healthAgent";

function keyboardRows(keyboard: any): any[][] {
    return keyboard.inline_keyboard;
}

describe("health menu", () => {
    test("contains every health log action", () => {
        const callbacks = keyboardRows(buildHealthMenuKeyboard()).flat().map((button) => button.callback_data);
        for (const kind of ["food", "drink", "symptom", "skin", "blood_pressure", "medication", "activity", "note"]) {
            assert.ok(callbacks.includes(`health:log:${kind}`), kind);
        }
    });

    test("contains analysis and both export periods", () => {
        const callbacks = keyboardRows(buildHealthMenuKeyboard()).flat().map((button) => button.callback_data);
        assert.ok(callbacks.includes("health:analysis_menu"));
        assert.ok(callbacks.includes("health:export:7"));
        assert.ok(callbacks.includes("health:export:30"));
    });

    test("keeps the compact row layout", () => {
        assert.deepEqual(keyboardRows(buildHealthMenuKeyboard()).map((row) => row.length), [2, 2, 2, 2, 1, 2]);
    });

    test("menu result explains supported input and medical limitation", () => {
        const result = buildHealthMenuResult();
        assert.match(result.responseText, /дневник здоровья/i);
        assert.match(result.responseText, /фото/i);
        assert.match(result.responseText, /не медицинский диагноз/i);
        assert.equal(keyboardRows(result.keyboard).flat().length, 11);
    });
});

describe("health photo routing", () => {
    test("routes any photo while a health log input is pending", () => {
        const ctx = { session: { pendingHealthLog: { expiresAt: Date.now() + 10_000 } } } as any;
        assert.equal(shouldRouteHealthPhoto(ctx, ""), true);
        assert.equal(shouldRouteHealthPhoto(ctx, "совсем другая подпись"), true);
    });

    test("does not use an expired pending health log", () => {
        const ctx = { session: { pendingHealthLog: { expiresAt: Date.now() - 1 } } } as any;
        assert.equal(shouldRouteHealthPhoto(ctx, ""), false);
    });

    const positiveCaptions = [
        "Добавь в дневник здоровья",
        "Вот что я съел",
        "Сегодня пью воду",
        "Сыпь на руке",
        "Кожа покраснела",
        "Сильный зуд",
        "Похоже на аллергию",
        "Есть отёк",
        "Давление 120/80",
        "Фото тонометра",
        "Пульс 72",
        "120 мм рт. ст.",
    ];

    for (const caption of positiveCaptions) {
        test(`routes health caption: ${caption}`, () => {
            assert.equal(shouldRouteHealthPhoto({ session: {} } as any, caption), true);
        });
    }

    for (const caption of ["", "   ", "Красивый закат", "Документы для работы", "Кот на диване"]) {
        test(`ignores unrelated caption: ${JSON.stringify(caption)}`, () => {
            assert.equal(shouldRouteHealthPhoto({ session: {} } as any, caption), false);
        });
    }

    test("matches health captions case-insensitively", () => {
        assert.equal(shouldRouteHealthPhoto({ session: {} } as any, "ФОТО ТОНОМЕТРА"), true);
    });
});

describe("health export URL", () => {
    test("builds the minimal URL with a format", () => {
        assert.equal(buildHealthExportUrl("json"), "/api/health/export?format=json");
    });

    test("preserves supported filters and encodes Unicode", () => {
        const url = new URL(buildHealthExportUrl("csv", {
            profile: "KiraMindBot",
            userId: "42",
            kind: "food",
            from: "2026-07-01",
            to: "2026-07-21",
            days: "7",
            q: "зелёный чай",
            limit: 50,
        }), "https://example.test");
        assert.equal(url.pathname, "/api/health/export");
        assert.equal(url.searchParams.get("profile"), "KiraMindBot");
        assert.equal(url.searchParams.get("userId"), "42");
        assert.equal(url.searchParams.get("kind"), "food");
        assert.equal(url.searchParams.get("from"), "2026-07-01");
        assert.equal(url.searchParams.get("to"), "2026-07-21");
        assert.equal(url.searchParams.get("days"), "7");
        assert.equal(url.searchParams.get("q"), "зелёный чай");
        assert.equal(url.searchParams.get("limit"), "50");
        assert.equal(url.searchParams.get("format"), "csv");
    });

    test("always removes pagination offset from an export", () => {
        const url = new URL(buildHealthExportUrl("txt", { offset: 120, limit: 25 }), "https://example.test");
        assert.equal(url.searchParams.has("offset"), false);
        assert.equal(url.searchParams.get("limit"), "25");
    });

    test("omits empty optional filters but preserves zero limits", () => {
        const url = new URL(buildHealthExportUrl("json", {
            kind: "",
            q: "",
            from: undefined,
            limit: 0,
        }), "https://example.test");
        assert.equal(url.searchParams.has("kind"), false);
        assert.equal(url.searchParams.has("q"), false);
        assert.equal(url.searchParams.has("from"), false);
        assert.equal(url.searchParams.get("limit"), "0");
    });
});
