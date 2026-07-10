/**
 * Smoke-тесты для utils/richMessage: рендер DSL-блоков в rich/HTML,
 * экранирование пользовательских данных, эмуляция таблицы в fallback,
 * разбиение длинных сообщений и фолбэк при ошибке sendRichMessage.
 *
 * Запуск: npm run test:ts -- testRichMessage
 */
import assert from "node:assert/strict";
import {
    esc,
    escAttr,
    heading,
    paragraph,
    list,
    checklist,
    table,
    blockquote,
    details,
    code,
    footer,
    divider,
    renderRichHtml,
    renderFallbackHtml,
    splitHtmlByBlocks,
    sendStructured,
    editStructured,
    editStructuredCtx,
    _resetRichUnsupportedForTests,
    _isRichUnsupported,
} from "../utils/richMessage";

// ── esc: экранирование спецсимволов HTML ─────────────────────

assert.equal(esc("простой текст"), "простой текст");
assert.equal(esc("a < b > c & d"), "a &lt; b &gt; c &amp; d");
assert.equal(esc(null), "");
assert.equal(esc(undefined), "");
assert.equal(esc(42), "42");
assert.equal(esc("уже &lt;"), "уже &amp;lt;", "двойное экранирование не должно ломать уже экранированное");
console.log("✓ esc() корректно экранирует спецсимволы и типы");

assert.equal(escAttr('a "b" c'), "a &quot;b&quot; c");
assert.equal(escAttr("d'e"), "d&apos;e");
console.log("✓ escAttr() экранирует кавычки");

// ── renderRichHtml: базовые блоки ────────────────────────────

assert.equal(renderRichHtml([paragraph("привет")]), "<p>привет</p>");
assert.equal(renderRichHtml([heading("Заголовок", 2)]), "<h2>Заголовок</h2>");
assert.equal(renderRichHtml([heading("Подзаголовок", 4)]), "<h4>Подзаголовок</h4>");
assert.equal(renderRichHtml([divider()]), "<hr/>");
assert.equal(renderRichHtml([footer("сноска")]), "<footer>сноска</footer>");
assert.equal(renderRichHtml([code("x = 1")]), "<pre>x = 1</pre>");
assert.equal(
    renderRichHtml([code("print(1)", "python")]),
    '<pre><code class="language-python">print(1)</code></pre>',
);
console.log("✓ renderRichHtml рендерит базовые блоки");

// ── renderRichHtml: blockquote с credit ──────────────────────

assert.equal(
    renderRichHtml([blockquote("цитата")]),
    "<blockquote>цитата</blockquote>",
);
assert.equal(
    renderRichHtml([blockquote("цитата", "автор")]),
    "<blockquote>цитата<cite>автор</cite></blockquote>",
);
console.log("✓ renderRichHtml рендерит blockquote с credit");

// ── renderRichHtml: списки и чек-листы ───────────────────────

assert.equal(
    renderRichHtml([list(["раз", "два"], false)]),
    "<ul><li>раз</li><li>два</li></ul>",
);
assert.equal(
    renderRichHtml([list(["раз", "два"], true)]),
    "<ol><li>раз</li><li>два</li></ol>",
);
assert.equal(
    renderRichHtml([checklist([{ text: "done", checked: true }, { text: "todo" }])]),
    "<ul><li><input type=\"checkbox\" checked>done</li><li><input type=\"checkbox\">todo</li></ul>",
);
console.log("✓ renderRichHtml рендерит списки и чек-листы");

// ── renderRichHtml: таблица ──────────────────────────────────

const tableRich = renderRichHtml([
    table({ headers: ["A", "B"], rows: [["1", "2"], ["3", "4"]], bordered: true, striped: true }),
]);
assert.ok(tableRich.startsWith("<table bordered striped>"), `ожидался table с attrs, got: ${tableRich}`);
assert.equal(tableRich.includes("<caption>"), false, "без caption");
assert.ok(tableRich.includes("<tr><th>A</th><th>B</th></tr>"), "должен быть заголовок");
assert.ok(tableRich.includes("<tr><td>1</td><td>2</td></tr>"), "должны быть строки");
console.log("✓ renderRichHtml рендерит таблицу с заголовком и строками");

const tableWithCaption = renderRichHtml([table({ rows: [["x"]], caption: "Заг" })]);
assert.ok(tableWithCaption.includes("<caption>Заг</caption>"));
console.log("✓ renderRichHtml рендерит caption таблицы");

// ── renderRichHtml: details ──────────────────────────────────

const detailsRich = renderRichHtml([details("сводка", [paragraph("тело")])]);
assert.ok(detailsRich.startsWith("<details>"), `ожидался <details>, got: ${detailsRich}`);
assert.ok(detailsRich.includes("<summary>сводка</summary>"));
assert.ok(detailsRich.includes("<p>тело</p>"));
assert.ok(!detailsRich.includes(" open"), "без open по умолчанию");

const detailsOpen = renderRichHtml([details("сводка", [paragraph("тело")], { open: true })]);
assert.ok(detailsOpen.startsWith("<details open>"));
console.log("✓ renderRichHtml рендерит details с open-флагом");

// ── renderFallbackHtml: эмуляция таблицы через <pre> ──────────

const fallbackTable = renderFallbackHtml([
    table({ headers: ["Имя", "Значение"], rows: [["один", "1"], ["два", "22"]] }),
]);
assert.ok(fallbackTable.startsWith("<pre>"), "fallback-таблица должна быть в <pre>");
assert.ok(fallbackTable.includes("Имя"), "должен быть заголовок");
assert.ok(fallbackTable.includes("─"), "должен быть разделитель под заголовком");
// Выравнивание: «1» добивается пробелами до ширины самого широкого значения в колонке («22» → 2 символа),
// т.е. ячейка «1» должна быть дополнена как минимум одним пробелом.
assert.ok(/один {2,}1 /.test(fallbackTable), `короткое значение должно добиваться пробелами, got: ${fallbackTable}`);
console.log("✓ renderFallbackHtml эмулирует таблицу через <pre> с выравниванием");

// ── renderFallbackHtml: заголовок → bold, details → summary ──

assert.equal(renderFallbackHtml([heading("Заголовок", 2)]), "<b>Заголовок</b>");
assert.equal(renderFallbackHtml([divider()]), "──────────");
assert.equal(renderFallbackHtml([footer("сноска")]), "<i>сноска</i>");
assert.equal(renderFallbackHtml([code("x=1")]), "<pre>x=1</pre>");
assert.equal(
    renderFallbackHtml([list(["a", "b"], false)]),
    "• a\n• b",
);
assert.equal(
    renderFallbackHtml([list(["a", "b"], true)]),
    "1. a\n2. b",
);
assert.equal(
    renderFallbackHtml([checklist([{ text: "done", checked: true }])]),
    "[x] done",
);
const fallbackDetails = renderFallbackHtml([details("сводка", [paragraph("тело")])]);
assert.ok(fallbackDetails.includes("<b>сводка</b>"));
assert.ok(fallbackDetails.includes("тело"));
console.log("✓ renderFallbackHtml корректно эмулирует все блоки");

// ── splitHtmlByBlocks: разбиение по блочным границам ─────────

const shortHtml = "<p>коротко</p>";
assert.deepEqual(splitHtmlByBlocks(shortHtml, 1000), [shortHtml]);

const longHtml = "<p>часть1</p>\n<p>часть2</p>\n<p>часть3</p>";
const parts = splitHtmlByBlocks(longHtml, 25); // лимит, forcing split
assert.ok(parts.length > 1, `ожидалось разбиение на >1 часть, got ${parts.length}`);
// Ни одна часть не должна превышать лимит (с допустимым запасом).
for (const p of parts) {
    assert.ok(p.length <= 30, `часть слишком длинная (${p.length}): ${p}`);
}
console.log(`✓ splitHtmlByBlocks разбил длинный HTML на ${parts.length} части по блочным границам`);

// ── sendStructured: длинный список режется по элементам, а не внутри HTML ──

_resetRichUnsupportedForTests();

const longListItems = Array.from({ length: 40 }, (_, i) => `<b>Пункт ${i + 1}</b> — ${"очень длинный текст ".repeat(20)}`);
let longListCalls: Array<{ text: string; other: Record<string, unknown> }> = [];
const apiFallbackOnly = {
    sendRichMessage: async () => {
        throw new Error("Bad Request: method not found");
    },
    sendMessage: async (chatId: unknown, text: string, other?: Record<string, unknown>) => {
        longListCalls.push({ text, other: other ?? {} });
        return { message_id: longListCalls.length };
    },
    editMessageText: async () => ({ message_id: 1 }),
};

// ── sendStructured: фолбэк при ошибке rich ───────────────────
//
// Эмулируем Api, у которого sendRichMessage падает с «method not found».
// После этого sendStructured должен фолбэчить на sendMessage с parse_mode HTML,
// а кеш richUnsupported должен включиться.

_resetRichUnsupportedForTests();

let sendMessageCalls: Array<{ text: string; other: Record<string, unknown> }> = [];
let richCalls = 0;

const apiUnsupported = {
    sendRichMessage: async () => {
        richCalls++;
        throw new Error("Bad Request: method not found");
    },
    sendMessage: async (chatId: unknown, text: string, other?: Record<string, unknown>) => {
        sendMessageCalls.push({ text, other: other ?? {} });
        return { message_id: 1 };
    },
    editMessageText: async () => ({ message_id: 1 }),
};

(async () => {
    await sendStructured(apiFallbackOnly as any, 777, [list(longListItems)]);
    assert.ok(longListCalls.length > 1, "длинный список должен разбиваться на несколько сообщений");
    for (const call of longListCalls) {
        assert.ok(call.text.length <= 4000, `часть длинного списка не должна превышать лимит: ${call.text.length}`);
        assert.ok(!/<[^>]*$/.test(call.text), "часть не должна заканчиваться незакрытым HTML-тегом");
        assert.equal((call.text.match(/<b>/g) ?? []).length, (call.text.match(/<\/b>/g) ?? []).length, "количество <b> и </b> должно совпадать");
    }
    console.log("✓ sendStructured режет длинные списки по элементам без порчи HTML");
    _resetRichUnsupportedForTests();

    await sendStructured(
        apiUnsupported as any,
        123,
        [heading("Тест", 3), paragraph("тело")],
    );

    assert.equal(richCalls, 1, "sendRichMessage должен был вызываться один раз");
    assert.equal(_isRichUnsupported(), true, "кеш richUnsupported должен включиться после ошибки");
    assert.equal(sendMessageCalls.length, 1, "sendMessage должен вызваться как фолбэк");
    assert.equal(sendMessageCalls[0].other.parse_mode, "HTML", "фолбэк должен идти с parse_mode HTML");
    assert.ok(sendMessageCalls[0].text.includes("Тест"), "фолбэк-текст должен содержать содержимое блоков");
    console.log("✓ sendStructured корректно фолбэчит на HTML при method not found");

    // Повторный вызов не должен даже пытаться в rich (кеш).
    richCalls = 0;
    sendMessageCalls = [];
    await sendStructured(apiUnsupported as any, 123, [paragraph("ещё")]);
    assert.equal(richCalls, 0, "после кеширования rich не должен вызываться");
    assert.equal(sendMessageCalls.length, 1, "сразу идёт sendMessage");
    console.log("✓ Кеш richUnsupported пропускает повторные попытки rich");

    // Ошибка валидации rich_message не должна навсегда отключать rich.
    _resetRichUnsupportedForTests();
    richCalls = 0;
    sendMessageCalls = [];
    const apiValidationError = {
        sendRichMessage: async () => {
            richCalls++;
            throw new Error("Bad Request: can't parse rich_message entity");
        },
        sendMessage: async (chatId: unknown, text: string, other?: Record<string, unknown>) => {
            sendMessageCalls.push({ text, other: other ?? {} });
            return { message_id: 1 };
        },
        editMessageText: async () => ({ message_id: 1 }),
    };
    await sendStructured(apiValidationError as any, 123, [paragraph("ошибка валидации")]);
    assert.equal(richCalls, 1, "первая попытка rich должна случиться");
    assert.equal(_isRichUnsupported(), false, "ошибка валидации не должна навсегда выключать rich");
    await sendStructured(apiValidationError as any, 123, [paragraph("вторая попытка")]);
    assert.equal(richCalls, 2, "rich должен пробоваться повторно после валидационной ошибки");
    console.log("✓ Ошибка валидации rich_message не кэширует unsupported");

    // ── sendStructured: rich поддерживается ──────────────────────
    //
    // Эмулируем Api, у которого sendRichMessage работает — fallback не нужен.

    _resetRichUnsupportedForTests();

    const apiSupported = {
        sendRichMessage: async (chatId: unknown, rich: { html: string }) => {
            return { message_id: 42, html: rich.html };
        },
        sendMessage: async () => {
            return { message_id: 1 };
        },
        editMessageText: async () => ({ message_id: 1 }),
    };

    const result = await sendStructured(
        apiSupported as any,
        456,
        [heading("OK", 3), table({ headers: ["A", "B"], rows: [["1", "2"]] })],
    ) as { message_id: number; html: string };

    assert.ok(result, "sendRichMessage должен вернуть результат");
    assert.ok(result.html.includes("<table"), "html должен содержать настоящую таблицу");
    console.log("✓ sendStructured использует rich без фолбэка при поддержке");

    // ── editStructured: слишком длинный fallback не должен падать ─────────

    _resetRichUnsupportedForTests();
    let editedText = "";
    const apiEditFallback = {
        sendRichMessage: async () => ({ message_id: 1 }),
        sendMessage: async () => ({ message_id: 1 }),
        editMessageText: async (_chatId: unknown, _messageId: number, text: string, other?: Record<string, unknown>) => {
            if (other?.rich_message) {
                throw new Error("Bad Request: method not found");
            }
            editedText = text;
            return { message_id: 99 };
        },
    };
    const hugeItems = Array.from({ length: 120 }, (_, i) => `<b>${i + 1}</b> ${"x".repeat(240)}`);
    await editStructured(apiEditFallback as any, 1, 2, [list(hugeItems)]);
    assert.ok(editedText.length <= 4000, `fallback edit должен укладываться в лимит Telegram, got ${editedText.length}`);
    assert.ok(editedText.includes("Сообщение сокращено"), "слишком длинный edit должен явно помечаться как сокращённый");
    console.log("✓ editStructured безопасно сокращает слишком длинный fallback");

    // ── editStructuredCtx: callback-fallback тоже должен ужиматься ─────────

    _resetRichUnsupportedForTests();
    let callbackEditedText = "";
    const ctxEditFallback = {
        editMessageText: async (textOrRich: unknown, other?: Record<string, unknown>) => {
            if (typeof textOrRich === "object" && textOrRich !== null && "html" in (textOrRich as Record<string, unknown>)) {
                throw new Error("Bad Request: method not found");
            }
            callbackEditedText = String(textOrRich);
            return { message_id: 100 };
        },
    };
    await editStructuredCtx(ctxEditFallback as any, [list(hugeItems)]);
    assert.ok(callbackEditedText.length <= 4000, `callback fallback должен укладываться в лимит Telegram, got ${callbackEditedText.length}`);
    assert.ok(callbackEditedText.includes("Сообщение сокращено"), "слишком длинный callback edit должен явно помечаться как сокращённый");
    console.log("✓ editStructuredCtx безопасно сокращает слишком длинный fallback");

    console.log("\n✅ Все smoke-тесты richMessage прошли.");
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
