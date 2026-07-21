/**
 * Structured rich formatting для системных/структурных сообщений бота.
 *
 * Использует Bot API 10.1 sendRichMessage / editMessageText({rich_message}) с
 * автоматическим фолбэком на sendMessage({parse_mode:"HTML"}) если rich
 * сообщение не поддерживается клиентом/Bot API.
 *
 * Назначение: дайджесты, списки напоминаний/контактов/чатов, сводные отчёты —
 * всё, что выигрывает от таблиц, заголовков, сворачиваемых секций.
 *
 * НЕ используется для свободных ответов LLM в диалоге — там бот остаётся
 * «как живой человек» и форматирование намеренно не применяется.
 */

import type { InlineKeyboardMarkup } from "grammy/types";
import {
    recordReplyMarkupState,
    runMessageEditIfChanged,
    stableTelegramStateFingerprint,
} from "./telegramMessageEdit";

/**
 * Аварийный рубильник rich-форматирования без редеплоя кода.
 * Читается из env напрямую, чтобы модуль не зависел от инициализации config
 * (которая требует KIRA_BOT_TOKEN и падает в unit-тестах).
 * Дефолт — true, как и config.richMessagesEnabled.
 */
function isRichEnabled(): boolean {
    const v = process.env.RICH_MESSAGES_ENABLED;
    return v === undefined ? true : v.toLowerCase() === "true";
}

// ── Inline-текст и экранирование ─────────────────────────────

/**
 * Экранирует строку для безопасной вставки в HTML-контент (rich и fallback).
 *
 * Главное правило: любой пользовательский текст (имена контактов, тексты
 * напоминаний, названия чатов, тела входящих сообщений) должен проходить через
 * esc() перед вставкой в блок. Это закрывает класс багов, когда спецсимволы
 * `* _ [ ] < >` ломали рендер markdown/HTML.
 */
export function esc(value: unknown): string {
    if (value === null || value === undefined) return "";
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

/**
 * Экранирует строку для использования внутри HTML-атрибута (href, summary).
 */
export function escAttr(value: unknown): string {
    return esc(value)
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

// ── DSL блоков ───────────────────────────────────────────────
//
// Inline-текст внутри блоков — это HTML-строка с базовыми inline-тегами
// (<b>, <i>, <code>, <a href="...">, <tg-spoiler>, <s>, <u>, <mark>).
// Сырой пользовательский текст оборачивается через esc() перед вставкой.
// Это даёт единый inline-формат для обоих рендеров (rich и fallback).

export interface ParagraphBlock {
    type: "paragraph";
    text: string;
}

export interface HeadingBlock {
    type: "heading";
    text: string;
    level: 1 | 2 | 3 | 4 | 5 | 6;
}

export interface DividerBlock {
    type: "divider";
}

export interface FooterBlock {
    type: "footer";
    text: string;
}

export interface CodeBlock {
    type: "code";
    text: string;
    language?: string;
}

export interface BlockquoteBlock {
    type: "blockquote";
    /** Inline-HTML текст цитаты (многострочный через \n) */
    text: string;
    credit?: string;
}

export interface ListBlock {
    type: "list";
    /** Inline-HTML элементов */
    items: string[];
    ordered?: boolean;
}

export interface ChecklistItem {
    text: string;
    checked?: boolean;
}

export interface ChecklistBlock {
    type: "checklist";
    items: ChecklistItem[];
}

export interface TableBlock {
    type: "table";
    headers?: string[];
    /** Строки ячеек (inline-HTML). Длина каждой строки = headers.length */
    rows: string[][];
    caption?: string;
    striped?: boolean;
    bordered?: boolean;
}

export interface DetailsBlock {
    type: "details";
    summary: string;
    blocks: RichBlock[];
    open?: boolean;
}

export type RichBlock =
    | ParagraphBlock
    | HeadingBlock
    | DividerBlock
    | FooterBlock
    | CodeBlock
    | BlockquoteBlock
    | ListBlock
    | ChecklistBlock
    | TableBlock
    | DetailsBlock;

// ── Builder-функции ──────────────────────────────────────────

export const paragraph = (text: string): ParagraphBlock => ({ type: "paragraph", text });
export const heading = (text: string, level: 1 | 2 | 3 | 4 | 5 | 6 = 2): HeadingBlock => ({ type: "heading", text, level });
export const divider = (): DividerBlock => ({ type: "divider" });
export const footer = (text: string): FooterBlock => ({ type: "footer", text });
export const code = (text: string, language?: string): CodeBlock => ({ type: "code", text, language });
export const blockquote = (text: string, credit?: string): BlockquoteBlock => ({ type: "blockquote", text, credit });
export const list = (items: string[], ordered = false): ListBlock => ({ type: "list", items, ordered });
export const checklist = (items: ChecklistItem[]): ChecklistBlock => ({ type: "checklist", items });

export function table(opts: {
    headers?: string[];
    rows: string[][];
    caption?: string;
    striped?: boolean;
    bordered?: boolean;
}): TableBlock {
    return {
        type: "table",
        headers: opts.headers,
        rows: opts.rows,
        caption: opts.caption,
        striped: opts.striped,
        bordered: opts.bordered,
    };
}

export function details(summary: string, blocks: RichBlock[], opts: { open?: boolean } = {}): DetailsBlock {
    return { type: "details", summary, blocks, open: opts.open };
}

// ── Рендер в rich-HTML (Bot API 10.1 sendRichMessage) ────────

/**
 * Рендерит блоки в расширенный HTML для sendRichMessage / editMessageText({rich_message}).
 * Поддерживает полный набор: таблицы, заголовки h1-h6, <details>, <pre>, <blockquote>.
 */
export function renderRichHtml(blocks: RichBlock[]): string {
    return blocks
        .map(renderRichBlock)
        .filter(Boolean)
        .join("<br/>");
}

function renderRichBlock(block: RichBlock): string {
    switch (block.type) {
        case "paragraph":
            return block.text;
        case "heading":
            return `<b>${block.text}</b>`;
        case "divider":
            return "──────────";
        case "footer":
            return `<i>${block.text}</i>`;
        case "code":
            return block.language
                ? `<pre><code class="language-${escAttr(block.language)}">${esc(block.text)}</code></pre>`
                : `<pre>${esc(block.text)}</pre>`;
        case "blockquote": {
            const credit = block.credit ? `<cite>${block.credit}</cite>` : "";
            return `<blockquote>${block.text}${credit}</blockquote>`;
        }
        case "list": {
            return block.items
                .map((item, i) => (block.ordered ? `${i + 1}. ${item}` : `• ${item}`))
                .join("<br/>");
        }
        case "checklist": {
            return block.items
                .map((i) => `${i.checked ? "[x]" : "[ ]"} ${i.text}`)
                .join("<br/>");
        }
        case "table": {
            const attrs = [block.bordered !== false ? "bordered" : "", block.striped ? "striped" : ""]
                .filter(Boolean)
                .join(" ");
            const attrStr = attrs ? ` ${attrs}` : "";
            const caption = block.caption ? `<caption>${block.caption}</caption>` : "";
            const headerRow = block.headers
                ? `<tr>${block.headers.map((h) => `<th>${h}</th>`).join("")}</tr>`
                : "";
            const bodyRows = block.rows
                .map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`)
                .join("");
            return `<table${attrStr}>${caption}${headerRow}${bodyRows}</table>`;
        }
        case "details": {
            const body = renderRichHtml(block.blocks);
            return body ? `<b>${block.summary}</b><br/>${body}` : `<b>${block.summary}</b>`;
        }
        default:
            return "";
    }
}

// ── Рендер в fallback-HTML (sendMessage с parse_mode: HTML) ──
//
// sendMessage поддерживает только базовые теги: b, i, u, s, code, pre, a,
// blockquote, tg-spoiler, br. Таблицы, заголовки и <details> недоступны —
// они эмулируются: заголовок → <b>, таблица → <pre> с выравниванием столбцов,
// details → <b>summary</b> + содержимое в <blockquote>.

const FALLBACK_MAX_LENGTH = 4000;
const FALLBACK_TRUNCATION_NOTICE = "⚠️ Сообщение сокращено: полная версия не поместилась в лимит Telegram.";

export function renderFallbackHtml(blocks: RichBlock[]): string {
    return blocks.map(renderFallbackBlock).join("\n").trim();
}

function renderFallbackBlock(block: RichBlock): string {
    switch (block.type) {
        case "paragraph":
            return block.text;
        case "heading":
            return `<b>${block.text}</b>`;
        case "divider":
            return "──────────";
        case "footer":
            return `<i>${block.text}</i>`;
        case "code":
            return `<pre>${esc(block.text)}</pre>`;
        case "blockquote": {
            const credit = block.credit ? ` — <i>${block.credit}</i>` : "";
            return `<blockquote>${block.text}${credit}</blockquote>`;
        }
        case "list": {
            return block.items
                .map((item, i) => (block.ordered ? `${i + 1}. ${item}` : `• ${item}`))
                .join("\n");
        }
        case "checklist": {
            return block.items
                .map((i) => `${i.checked ? "[x]" : "[ ]"} ${i.text}`)
                .join("\n");
        }
        case "table": {
            return renderFallbackTable(block);
        }
        case "details": {
            const body = renderFallbackHtml(block.blocks);
            return `<b>${block.summary}</b>\n${body}`;
        }
        default:
            return "";
    }
}

/**
 * Эмуляция таблицы через <pre> с выравниванием столбцов по ширине.
 * Используется только в fallback; rich-рендер отдаёт настоящую <table>.
 */
function renderFallbackTable(block: TableBlock): string {
    const caption = block.caption ? `${block.caption}\n` : "";
    const headerCells = block.headers ?? [];
    const colCount = Math.max(headerCells.length, ...block.rows.map((r) => r.length));
    const widths: number[] = new Array(colCount).fill(0);
    const allRows = [headerCells, ...block.rows];
    for (const row of allRows) {
        for (let c = 0; c < colCount; c++) {
            const cell = stripInlineTags(row[c] ?? "");
            widths[c] = Math.max(widths[c], cell.length);
        }
    }
    const lines = allRows
        .map((row) =>
            row
                .map((cell, c) => padCell(stripInlineTags(cell ?? ""), widths[c]))
                .join("  "),
        );
    if (headerCells.length) {
        lines.splice(1, 0, widths.map((w) => "─".repeat(w)).join("──"));
    }
    return `<pre>${caption}${lines.join("\n")}</pre>`;
}

/** Убирает inline-HTML-теги для измерения ширины в fallback-таблице. */
function stripInlineTags(s: string): string {
    return s.replace(/<[^>]+>/g, "");
}

function padCell(s: string, width: number): string {
    return s.length >= width ? s : s + " ".repeat(width - s.length);
}

// ── Кеш несовместимости rich message ─────────────────────────
//
// Если первый sendRichMessage упал с "method not found" / "not supported",
// запоминаем это и больше не пробуем rich в текущем процессе — сразу
// отправляем fallback. Сбрасывается только рестартом процесса.

let richUnsupported = false;

function markRichUnsupported(): void {
    if (!richUnsupported) {
        richUnsupported = true;
        console.warn("[richMessage] sendRichMessage не поддерживается, далее используется HTML fallback");
    }
}

function isRichDisabledByError(error: unknown): boolean {
    const msg = error instanceof Error ? error.message : String(error);
    return (
        /method not found/i.test(msg) ||
        /not supported/i.test(msg) ||
        /unknown method/i.test(msg) ||
        /sendrichmessage/i.test(msg) ||
        /bad request.*method/i.test(msg)
    );
}

// ── Типы целей отправки ──────────────────────────────────────
//
// grammy Api частично типизировано; для совместимости с разными контекстами
// (bot.api из планировщика, ctx.api из handler) принимаем минимальный порт.

interface ApiLike {
    sendRichMessage: (
        chatId: number | string,
        richMessage: { html: string },
        other?: Record<string, unknown>,
    ) => Promise<unknown>;
    sendMessage: (
        chatId: number | string,
        text: string,
        other?: Record<string, unknown>,
    ) => Promise<unknown>;
    editMessageText: (
        chatId: number | string,
        messageId: number,
        text: string,
        other?: Record<string, unknown>,
    ) => Promise<unknown>;
}

export interface SendStructuredOptions {
    /** reply_markup: InlineKeyboard / объект клавиатуры */
    replyMarkup?: unknown;
    /** reply_parameters для ответа на сообщение */
    replyParameters?: unknown;
    /** reply_to_message_id (короткий путь для reply_parameters) */
    replyToMessageId?: number;
    disableNotification?: boolean;
    /** Доп. поля для other (business_connection_id и т.п.) */
    extra?: Record<string, unknown>;
}

export interface EditStructuredOptions {
    replyMarkup?: InlineKeyboardMarkup;
    extra?: Record<string, unknown>;
}

function buildSendOther(opts: SendStructuredOptions): Record<string, unknown> {
    const other: Record<string, unknown> = {};
    if (opts.replyMarkup !== undefined) other.reply_markup = opts.replyMarkup;
    if (opts.replyParameters !== undefined) other.reply_parameters = opts.replyParameters;
    if (opts.replyToMessageId !== undefined) other.reply_to_message_id = opts.replyToMessageId;
    if (opts.disableNotification) other.disable_notification = true;
    if (opts.extra) Object.assign(other, opts.extra);
    return other;
}

// ── Отправка ─────────────────────────────────────────────────

/**
 * Отправляет структурное сообщение через sendRichMessage с фолбэком на
 * sendMessage({parse_mode:"HTML"}). При превышении лимита fallback (4096)
 * сообщение разбивается на части; клавиатура крепится к последней части.
 *
 * @returns результат последней отправки (как ctx.reply / bot.api.sendMessage).
 */
export async function sendStructured(
    api: ApiLike,
    chatId: number | string,
    blocks: RichBlock[],
    opts: SendStructuredOptions = {},
): Promise<unknown> {
    const useRich = isRichEnabled() && !richUnsupported && blocks.length > 0;

    if (useRich) {
        try {
            const html = renderRichHtml(blocks);
            return await api.sendRichMessage(chatId, { html }, buildSendOther(opts));
        } catch (error) {
            if (isRichDisabledByError(error)) {
                markRichUnsupported();
            } else {
                devLogRich("sendRichMessage failed, fallback to HTML", error);
            }
        }
    }

    const other = buildSendOther(opts);
    return sendFallbackBlocks(api, chatId, blocks, { ...other, parse_mode: "HTML" });
}

/**
 * Редактирует существующее сообщение через editMessageText({rich_message}) с
 * фолбэком на editMessageText({text, parse_mode:"HTML"}).
 */
export async function editStructured(
    api: ApiLike,
    chatId: number | string,
    messageId: number,
    blocks: RichBlock[],
    opts: EditStructuredOptions = {},
): Promise<unknown> {
    const desiredFingerprint = stableTelegramStateFingerprint({
        blocks,
        replyMarkup: opts.replyMarkup,
        extra: opts.extra,
    });
    return runMessageEditIfChanged(chatId, messageId, desiredFingerprint, () =>
        performStructuredEdit(api, chatId, messageId, blocks, opts)
    );
}

async function performStructuredEdit(
    api: ApiLike,
    chatId: number | string,
    messageId: number,
    blocks: RichBlock[],
    opts: EditStructuredOptions,
): Promise<unknown> {
    const useRich = isRichEnabled() && !richUnsupported && blocks.length > 0;

    if (useRich) {
        try {
            const html = renderRichHtml(blocks);
            const other: Record<string, unknown> = { rich_message: { html } };
            if (opts.replyMarkup !== undefined) other.reply_markup = opts.replyMarkup;
            if (opts.extra) Object.assign(other, opts.extra);
            const result = await (api as { editMessageText: (a: unknown, b: unknown, c: unknown, d?: unknown) => Promise<unknown> })
                .editMessageText(chatId, messageId, "", other);
            if (opts.replyMarkup !== undefined) {
                recordReplyMarkupState(chatId, messageId, opts.replyMarkup);
            }
            return result;
        } catch (error) {
            if (isRichDisabledByError(error)) {
                markRichUnsupported();
            } else {
                devLogRich("editMessageText(rich) failed, fallback to HTML", error);
            }
        }
    }

    const html = fitFallbackHtml(blocks, FALLBACK_MAX_LENGTH);
    const other: Record<string, unknown> = { parse_mode: "HTML" };
    if (opts.replyMarkup !== undefined) other.reply_markup = opts.replyMarkup;
    if (opts.extra) Object.assign(other, opts.extra);
    const result = await api.editMessageText(chatId, messageId, html, other);
    if (opts.replyMarkup !== undefined) {
        recordReplyMarkupState(chatId, messageId, opts.replyMarkup);
    }
    return result;
}

// ── Split для длинных fallback-сообщений ──────────────────────

async function sendFallbackBlocks(
    api: ApiLike,
    chatId: number | string,
    blocks: RichBlock[],
    other: Record<string, unknown>,
): Promise<unknown> {
    const chunkedBlocks = splitBlocksForFallback(blocks, FALLBACK_MAX_LENGTH);
    if (chunkedBlocks.length === 1) {
        return api.sendMessage(chatId, renderFallbackHtml(chunkedBlocks[0]), other);
    }

    let result: unknown;
    for (let i = 0; i < chunkedBlocks.length; i++) {
        const isLast = i === chunkedBlocks.length - 1;
        const partOther = isLast
            ? other
            : { parse_mode: other.parse_mode };
        result = await api.sendMessage(chatId, renderFallbackHtml(chunkedBlocks[i]), partOther);
    }
    return result;
}

function fitFallbackHtml(blocks: RichBlock[], maxLength: number): string {
    const fullHtml = renderFallbackHtml(blocks);
    if (fullHtml.length <= maxLength) {
        return fullHtml;
    }

    const noticeBlock = footer(FALLBACK_TRUNCATION_NOTICE);
    const chunkedBlocks = splitBlocksForFallback(blocks, maxLength);
    const fitted: RichBlock[] = [];

    for (const chunk of chunkedBlocks) {
        const candidate = [...fitted, ...chunk, noticeBlock];
        if (renderFallbackHtml(candidate).length > maxLength) {
            break;
        }
        fitted.push(...chunk);
    }

    if (fitted.length === 0) {
        return renderFallbackHtml([paragraph(esc(truncatePlainText(fullHtml, maxLength - FALLBACK_TRUNCATION_NOTICE.length - 8))), noticeBlock]);
    }

    return renderFallbackHtml([...fitted, noticeBlock]);
}

function splitBlocksForFallback(blocks: RichBlock[], maxLength: number): RichBlock[][] {
    const chunks: RichBlock[][] = [];
    let current: RichBlock[] = [];

    const flushCurrent = () => {
        if (current.length > 0) {
            chunks.push(current);
            current = [];
        }
    };

    for (const block of blocks) {
        const variants = splitOversizedBlockForFallback(block, maxLength);
        for (const variant of variants) {
            const candidate = [...current, variant];
            if (current.length > 0 && renderFallbackHtml(candidate).length > maxLength) {
                flushCurrent();
            }
            if (renderFallbackHtml([variant]).length > maxLength) {
                chunks.push([truncateBlockForFallback(variant, maxLength)]);
                continue;
            }
            current.push(variant);
        }
    }

    flushCurrent();
    return chunks.length > 0 ? chunks : [[]];
}

function splitOversizedBlockForFallback(block: RichBlock, maxLength: number): RichBlock[] {
    if (renderFallbackHtml([block]).length <= maxLength) {
        return [block];
    }

    switch (block.type) {
        case "list":
            return splitListBlockForFallback(block, maxLength);
        case "checklist":
            return splitChecklistBlockForFallback(block, maxLength);
        case "details":
            return splitDetailsBlockForFallback(block, maxLength);
        default:
            return [truncateBlockForFallback(block, maxLength)];
    }
}

function splitListBlockForFallback(block: ListBlock, maxLength: number): ListBlock[] {
    const chunks: ListBlock[] = [];
    let items: string[] = [];
    for (const item of block.items) {
        const candidate: ListBlock = { ...block, items: [...items, item] };
        if (items.length > 0 && renderFallbackHtml([candidate]).length > maxLength) {
            chunks.push({ ...block, items });
            items = [item];
            continue;
        }
        if (renderFallbackHtml([{ ...block, items: [item] }]).length > maxLength) {
            chunks.push({ ...block, items: [truncateInlineHtml(item, maxLength - 16)] });
            items = [];
            continue;
        }
        items.push(item);
    }
    if (items.length > 0) {
        chunks.push({ ...block, items });
    }
    return chunks;
}

function splitChecklistBlockForFallback(block: ChecklistBlock, maxLength: number): ChecklistBlock[] {
    const chunks: ChecklistBlock[] = [];
    let items: ChecklistItem[] = [];
    for (const item of block.items) {
        const candidate: ChecklistBlock = { ...block, items: [...items, item] };
        if (items.length > 0 && renderFallbackHtml([candidate]).length > maxLength) {
            chunks.push({ ...block, items });
            items = [item];
            continue;
        }
        if (renderFallbackHtml([{ ...block, items: [item] }]).length > maxLength) {
            chunks.push({ ...block, items: [{ ...item, text: truncateInlineHtml(item.text, maxLength - 16) }] });
            items = [];
            continue;
        }
        items.push(item);
    }
    if (items.length > 0) {
        chunks.push({ ...block, items });
    }
    return chunks;
}

function splitDetailsBlockForFallback(block: DetailsBlock, maxLength: number): RichBlock[] {
    const summaryBlock = heading(block.summary, 4);
    const bodyChunks = splitBlocksForFallback(block.blocks, Math.max(64, maxLength - renderFallbackHtml([summaryBlock]).length - 2));
    return bodyChunks.map((bodyChunk) => ({
        type: "details",
        summary: block.summary,
        blocks: bodyChunk,
        open: block.open,
    }));
}

function truncateBlockForFallback(block: RichBlock, maxLength: number): RichBlock {
    switch (block.type) {
        case "paragraph":
            return { ...block, text: esc(truncatePlainText(stripInlineTags(block.text), maxLength - 8)) };
        case "heading":
            return { ...block, text: esc(truncatePlainText(stripInlineTags(block.text), maxLength - 8)) };
        case "footer":
            return { ...block, text: esc(truncatePlainText(stripInlineTags(block.text), maxLength - 8)) };
        case "blockquote":
            return { ...block, text: esc(truncatePlainText(stripInlineTags(block.text), maxLength - 8)), credit: block.credit ? esc(truncatePlainText(stripInlineTags(block.credit), 64)) : undefined };
        case "code":
            return { ...block, text: truncatePlainText(block.text, maxLength - 16) };
        case "table":
            return {
                type: "code",
                text: truncatePlainText(stripInlineTags(renderFallbackTable(block)), maxLength - 16),
            };
        case "details":
            return {
                type: "details",
                summary: esc(truncatePlainText(stripInlineTags(block.summary), 128)),
                blocks: [paragraph(esc(FALLBACK_TRUNCATION_NOTICE))],
                open: block.open,
            };
        default:
            return paragraph(esc(FALLBACK_TRUNCATION_NOTICE));
    }
}

function truncateInlineHtml(text: string, maxLength: number): string {
    return esc(truncatePlainText(stripInlineTags(text), maxLength));
}

function truncatePlainText(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    if (maxLength <= 1) return "…";
    return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

async function sendHtmlWithSplit(
    api: ApiLike,
    chatId: number | string,
    html: string,
    other: Record<string, unknown>,
): Promise<unknown> {
    if (html.length <= FALLBACK_MAX_LENGTH) {
        return api.sendMessage(chatId, html, other);
    }

    const parts = splitHtmlByBlocks(html, FALLBACK_MAX_LENGTH);
    let result: unknown;
    for (let i = 0; i < parts.length; i++) {
        const isLast = i === parts.length - 1;
        // Клавиатура и reply крепятся только к последней части.
        const partOther = isLast
            ? other
            : { parse_mode: other.parse_mode };
        result = await api.sendMessage(chatId, parts[i], partOther);
    }
    return result;
}

/**
 * Разбивает HTML по блочным границам (</p>, </ul>, </table>, </pre>,
 * </blockquote>, </details>, пустым строкам), не разрезая inline-разметку.
 */
export function splitHtmlByBlocks(html: string, maxLength: number): string[] {
    if (html.length <= maxLength) return [html];

    const blockEndRegex = /(<\/(?:p|ul|ol|table|pre|blockquote|details|footer)>|<\/?[bh]\d>|──────────)/g;
    const parts: string[] = [];
    let start = 0;

    while (start < html.length) {
        if (html.length - start <= maxLength) {
            parts.push(html.slice(start));
            break;
        }
        const window = html.slice(start, start + maxLength);
        blockEndRegex.lastIndex = 0;
        let lastEnd = -1;
        let match: RegExpExecArray | null;
        while ((match = blockEndRegex.exec(window)) !== null) {
            lastEnd = match.index + match[0].length;
        }
        if (lastEnd <= 0) {
            // Нет блочной границы — режем по последней пустой строке или жёстко.
            const nl = window.lastIndexOf("\n\n");
            lastEnd = nl > maxLength / 2 ? nl + 2 : maxLength;
        }
        parts.push(html.slice(start, start + lastEnd).trim());
        start += lastEnd;
        while (html[start] === "\n") start++;
    }
    return parts.filter((p) => p.length > 0);
}

// ── Утилиты ──────────────────────────────────────────────────

function devLogRich(...args: unknown[]): void {
    if (process.env.NODE_ENV === "development") {
        console.log("[richMessage]", ...args);
    }
}

/**
 * Принудительно сбрасывает кеш несовместимости. Только для тестов.
 */
export function _resetRichUnsupportedForTests(): void {
    richUnsupported = false;
}

/**
 * Возвращает текущее состояние кеша несовместимости. Только для тестов/диагностики.
 */
export function _isRichUnsupported(): boolean {
    return richUnsupported;
}

// ── Редактирование через grammy callback-context ──────────────
//
// В callback-обработчиках у grammy есть context-aware ctx.editMessageText,
// который сам извлекает chat_id/message_id из callback_query.message и умеет
// принимать InputRichMessage напрямую. Здесь — обёртка с тем же фолбэком на
// HTML, что и editStructured, для единообразия.

interface CallbackCtxLike {
    // any: grammy context-aware editMessageText строже узкого интерфейса
    // (контравариантность параметра text), точный тип лишь создавал бы приведения.
    editMessageText: any;
}

/**
 * Редактирует сообщение callback-контекста через rich с фолбэком на HTML.
 * Использует ctx.editMessageText — grammy сам подставляет chat_id/message_id.
 */
export async function editStructuredCtx(
    ctx: CallbackCtxLike,
    blocks: RichBlock[],
    opts: { replyMarkup?: unknown; extra?: Record<string, unknown> } = {},
): Promise<unknown> {
    const useRich = isRichEnabled() && !richUnsupported && blocks.length > 0;

    if (useRich) {
        try {
            const html = renderRichHtml(blocks);
            const other: Record<string, unknown> = {};
            if (opts.replyMarkup !== undefined) other.reply_markup = opts.replyMarkup;
            if (opts.extra) Object.assign(other, opts.extra);
            // InputRichMessage — объект {html}; grammy маппит объект → rich_message.
            return await ctx.editMessageText({ html }, other);
        } catch (error) {
            if (isRichDisabledByError(error)) {
                markRichUnsupported();
            } else {
                devLogRich("ctx.editMessageText(rich) failed, fallback to HTML", error);
            }
        }
    }

    const html = fitFallbackHtml(blocks, FALLBACK_MAX_LENGTH);
    const other: Record<string, unknown> = { parse_mode: "HTML" };
    if (opts.replyMarkup !== undefined) other.reply_markup = opts.replyMarkup;
    if (opts.extra) Object.assign(other, opts.extra);
    return ctx.editMessageText(html, other);
}
