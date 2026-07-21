import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildQuickChoiceKeyboard, consumeQuickChoice, isQuickChoiceCallback } from "../utils/quickChoice";

function context(): any {
    return { session: {} };
}

function callbacks(keyboard: any): string[] {
    return keyboard.inline_keyboard.flat().map((button: any) => button.callback_data);
}

function labels(keyboard: any): string[] {
    return keyboard.inline_keyboard.flat().map((button: any) => button.text);
}

describe("quick choices", () => {
    test("recognizes only its callback namespace", () => {
        assert.equal(isQuickChoiceCallback("qch:abc:0"), true);
        assert.equal(isQuickChoiceCallback("qch:"), true);
        assert.equal(isQuickChoiceCallback("qch"), false);
        assert.equal(isQuickChoiceCallback("other:abc:0"), false);
    });

    test("extracts numbered choices from a response", () => {
        const ctx = context();
        const keyboard = buildQuickChoiceKeyboard(
            ctx,
            "Что делать?",
            "1. Поставить напоминание\n2) Просто обсудить варианты",
            {} as any,
        );
        assert.ok(keyboard);
        assert.deepEqual(labels(keyboard), ["Да, напомни мне об этом", "Просто обсудить варианты"]);
        assert.equal(Object.keys(ctx.session.pendingQuickChoices).length, 1);
    });

    test("joins a lowercase continuation line to its option", () => {
        const ctx = context();
        const keyboard = buildQuickChoiceKeyboard(
            ctx,
            "Выбери",
            "1. Найти место\nрядом с офисом\n2. Найти в интернете",
            {} as any,
        );
        assert.ok(keyboard);
        const result = consumeQuickChoice(ctx, callbacks(keyboard)[0]);
        assert.match(result?.choice.message ?? "", /Найти место рядом с офисом/);
    });

    test("maps common option semantics to user-facing labels", () => {
        const ctx = context();
        const keyboard = buildQuickChoiceKeyboard(
            ctx,
            "Запрос",
            [
                "1. Создать изображение",
                "2. Найти адрес на карте",
                "3. Проверить сообщения",
                "4. Выполнить через браузер на сайте",
            ].join("\n"),
            {} as any,
        );
        assert.deepEqual(labels(keyboard), [
            "Да, создай изображение",
            "Да, найди на карте",
            "Да, проверь сообщения",
            "Да, сделай через браузер",
        ]);
    });

    test("falls back to distinct scored intents", () => {
        const ctx = context();
        const keyboard = buildQuickChoiceKeyboard(ctx, "исходный запрос", "Неясно", {
            intentScores: [
                { intent: "ВЕБ_ПОИСК", score: 0.7 },
                { intent: "ВЕБ_ПОИСК", score: 0.6 },
                { intent: "РАЗГОВОР", score: 0.5 },
                { intent: "НЕОПРЕДЕЛЕНО", score: 0.4 },
            ],
        } as any);
        assert.ok(keyboard);
        assert.deepEqual(labels(keyboard), ["Да, найди в интернете", "Давай просто обсудим"]);
        const selected = consumeQuickChoice(ctx, callbacks(keyboard)[0]);
        assert.equal(selected?.choice.message, "Найди актуальную информацию в интернете по исходному запросу: исходный запрос");
    });

    test("does not create a keyboard with fewer than two useful choices", () => {
        const ctx = context();
        assert.equal(buildQuickChoiceKeyboard(ctx, "x", "1. Только один вариант", {} as any), undefined);
        assert.equal(buildQuickChoiceKeyboard(ctx, "x", "нет вариантов", { intentScores: [] } as any), undefined);
        assert.equal(ctx.session.pendingQuickChoices, undefined);
    });

    test("caps choices at four", () => {
        const ctx = context();
        const keyboard = buildQuickChoiceKeyboard(
            ctx,
            "x",
            "1. Один\n2. Два\n3. Три\n4. Четыре\n5. Пять",
            {} as any,
        );
        assert.equal(labels(keyboard).length, 4);
    });

    test("truncates long button labels but keeps the full option in the message", () => {
        const ctx = context();
        const longOption = "Очень длинный вариант ответа ".repeat(5);
        const keyboard = buildQuickChoiceKeyboard(ctx, "x", `1. ${longOption}\n2. Короткий вариант`, {} as any);
        assert.ok(keyboard);
        assert.ok(labels(keyboard)[0].length <= 54);
        assert.equal(labels(keyboard)[0].endsWith("…"), true);
        const selected = consumeQuickChoice(ctx, callbacks(keyboard)[0]);
        assert.match(selected?.choice.message ?? "", /Очень длинный вариант ответа/);
    });

    test("consumes a selected choice exactly once", () => {
        const ctx = context();
        const keyboard = buildQuickChoiceKeyboard(ctx, "Исходный", "1. Первый\n2. Второй", {} as any)!;
        const callback = callbacks(keyboard)[1];
        const selected = consumeQuickChoice(ctx, callback);
        assert.equal(selected?.originalMessage, "Исходный");
        assert.match(selected?.choice.message ?? "", /Выбранный вариант 2: Второй/);
        assert.equal(ctx.session.pendingQuickChoices, undefined);
        assert.equal(consumeQuickChoice(ctx, callback), null);
    });

    test("marks browser cancellation choices as actions", () => {
        const ctx = context();
        const keyboard = buildQuickChoiceKeyboard(
            ctx,
            "Запись",
            "1. Отменить уже начатую браузерную задачу\n2. Продолжить оформление",
            {} as any,
        )!;
        const selected = consumeQuickChoice(ctx, callbacks(keyboard)[0]);
        assert.equal(selected?.choice.action, "cancel_browser_task");
    });

    test("rejects malformed, out-of-range, and expired callbacks", () => {
        const malformedCtx = context();
        assert.equal(consumeQuickChoice(malformedCtx, "other:id:0"), null);
        assert.equal(consumeQuickChoice(malformedCtx, "qch:id:nope"), null);
        assert.equal(consumeQuickChoice(malformedCtx, "qch::0"), null);

        const outOfRangeCtx = context();
        const keyboard = buildQuickChoiceKeyboard(outOfRangeCtx, "x", "1. Один\n2. Два", {} as any)!;
        const [, id] = callbacks(keyboard)[0].split(":");
        assert.equal(consumeQuickChoice(outOfRangeCtx, `qch:${id}:99`), null);

        const expiredCtx = context();
        const expiredKeyboard = buildQuickChoiceKeyboard(expiredCtx, "x", "1. Один\n2. Два", {} as any)!;
        const expiredCallback = callbacks(expiredKeyboard)[0];
        const expiredId = expiredCallback.split(":")[1];
        expiredCtx.session.pendingQuickChoices[expiredId].expiresAt = Date.now() - 1;
        assert.equal(consumeQuickChoice(expiredCtx, expiredCallback), null);
        assert.equal(expiredCtx.session.pendingQuickChoices, undefined);
    });
});
