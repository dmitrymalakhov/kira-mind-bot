import { Bot, InlineKeyboard } from "grammy";
import { BotContext, ChatPromptWatchWizardState } from "../types";
import { getAllChats } from "../services/chatRegistry";
import { listReadableTelegramChats } from "../services/telegram";
import { getProactiveChatId } from "../utils/allowedUserChatStore";
import {
    addChatPromptWatcher,
    listChatPromptWatchers,
    removeChatPromptWatcher,
    setChatPromptWatcherEnabled,
    type ChatPromptWatcher,
} from "../services/chatPromptWatchers";

const ITEMS_PER_PAGE = 6;
const WIZARD_TTL_MS = 15 * 60 * 1000;
const SOURCE_DIALOG_LIMIT = 500;

interface ChatOption {
    chatId: string;
    title: string;
    chatType: string;
    username?: string;
}

function parseCommandArgument(text: string | undefined, command: string): string {
    const source = text || `/${command}`;
    return source.replace(new RegExp(`^/${command}(?:@\\w+)?`, "i"), "").trim();
}

function newWizardState(): ChatPromptWatchWizardState {
    const now = Date.now();
    return {
        step: "source",
        sourcePage: 0,
        targetPage: 0,
        createdAt: now,
        expiresAt: now + WIZARD_TTL_MS,
    };
}

function usageText(): string {
    return [
        "Наблюдения за Telegram-чатами:",
        "",
        "/watch открывает меню настройки.",
        "",
        "В мастере можно выбирать чат кнопками или отправить сообщением часть названия, @username или id. Источник читается пользовательской Telegram-сессией, поэтому бот не обязан быть в исходном чате. Цель должна быть чатом или каналом, куда бот может писать.",
    ].join("\n");
}

function compact(text: string, maxLength: number): string {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (normalized.length <= maxLength) return normalized;
    return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

function chatTitle(chat: { title: string; username?: string } | undefined, fallback: string): string {
    if (!chat) return fallback;
    return chat.username ? `${chat.title} (@${chat.username})` : chat.title;
}

function normalizeQuery(value: string): string {
    return value
        .trim()
        .replace(/^["'«“]|["'»”]$/g, "")
        .replace(/^@/, "")
        .replace(/\s+/g, " ")
        .toLowerCase();
}

function chatToOption(chat: { chatId: string; title: string; chatType: string; username?: string }): ChatOption {
    return {
        chatId: chat.chatId,
        title: chatTitle(chat, chat.chatId),
        chatType: chat.chatType,
        username: chat.username,
    };
}

function botApiChatToOption(chat: any): ChatOption | null {
    if (chat?.id == null || !chat.type) return null;
    const firstName = typeof chat.first_name === "string" ? chat.first_name : "";
    const lastName = typeof chat.last_name === "string" ? chat.last_name : "";
    const title = typeof chat.title === "string" && chat.title.trim()
        ? chat.title.trim()
        : [firstName, lastName].filter(Boolean).join(" ").trim() || "Чат";
    const username = typeof chat.username === "string" ? chat.username : undefined;
    return {
        chatId: String(chat.id),
        title: username ? `${title} (@${username})` : title,
        chatType: chat.type,
        username,
    };
}

function matchScore(chat: ChatOption, query: string): number {
    const title = normalizeQuery(chat.title);
    const username = chat.username ? normalizeQuery(chat.username) : "";
    if (chat.chatId === query) return 100;
    if (username && username === query) return 95;
    if (title === query) return 90;
    if (username && username.startsWith(query)) return 80;
    if (title.startsWith(query)) return 75;
    if (username && username.includes(query)) return 65;
    if (title.includes(query)) return 60;
    if (query.includes(title) && title.length >= 4) return 50;
    return 0;
}

function sortBySearch(chats: ChatOption[], query: string): ChatOption[] {
    const normalized = normalizeQuery(query);
    if (!normalized) return chats;
    return chats
        .map((chat) => ({ chat, score: matchScore(chat, normalized) }))
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score)
        .map((item) => item.chat);
}

function targetLookupCandidates(query: string): Array<string | number> {
    const raw = query.trim();
    const normalized = normalizeQuery(query);
    const candidates = new Set<string | number>();

    if (/^-?\d+$/.test(raw)) {
        const asNumber = Number(raw);
        candidates.add(Number.isSafeInteger(asNumber) ? asNumber : raw);
    }

    const telegramLink = raw.match(/(?:https?:\/\/)?t\.me\/([A-Za-z0-9_]{5,})/i)?.[1];
    const username = telegramLink || normalized;
    if (/^[A-Za-z0-9_]{5,}$/.test(username)) {
        candidates.add(`@${username}`);
    }

    return [...candidates];
}

function typeLabel(chatType: string): string {
    const labels: Record<string, string> = {
        private: "личный",
        group: "группа",
        supergroup: "супергруппа",
        channel: "канал",
        unknown: "чат",
    };
    return labels[chatType] ?? chatType;
}

function getSourceChats(chats: ChatOption[]): ChatOption[] {
    return chats.filter((chat) => ["private", "group", "supergroup", "channel", "unknown"].includes(chat.chatType));
}

function getTargetChats(chats: ChatOption[]): ChatOption[] {
    return chats.filter((chat) => ["private", "group", "supergroup", "channel"].includes(chat.chatType));
}

function buildPagedKeyboard(
    prefix: "src" | "tgt",
    chats: ChatOption[],
    page: number,
    options: { includeMe?: boolean } = {},
): InlineKeyboard {
    const keyboard = new InlineKeyboard();
    if (options.includeMe) {
        keyboard.text("👤 Мне в личку", "cw:tgt:me").row();
    }

    const totalPages = Math.max(1, Math.ceil(chats.length / ITEMS_PER_PAGE));
    const safePage = Math.min(Math.max(0, page), totalPages - 1);
    const pageChats = chats.slice(safePage * ITEMS_PER_PAGE, safePage * ITEMS_PER_PAGE + ITEMS_PER_PAGE);

    for (const chat of pageChats) {
        keyboard.text(compact(`${chat.title} · ${typeLabel(chat.chatType)}`, 56), `cw:${prefix}:${chat.chatId}`).row();
    }

    if (totalPages > 1) {
        if (safePage > 0) keyboard.text("◀️", `cw:${prefix}p:${safePage - 1}`);
        keyboard.text(`${safePage + 1}/${totalPages}`, "cw:noop");
        if (safePage < totalPages - 1) keyboard.text("▶️", `cw:${prefix}p:${safePage + 1}`);
        keyboard.row();
    }

    keyboard.text("Меню", "cw:menu").text("Отмена", "cw:cancel");
    return keyboard;
}

function buildPromptKeyboard(): InlineKeyboard {
    return new InlineKeyboard()
        .text("Источник", "cw:edit:source")
        .text("Куда писать", "cw:edit:target").row()
        .text("Меню", "cw:menu")
        .text("Отмена", "cw:cancel");
}

function buildSourcePicker(chats: ChatOption[], state: ChatPromptWatchWizardState): { text: string; keyboard: InlineKeyboard } {
    const sourceChats = getSourceChats(chats);
    const text = [
        "📡 Настройка наблюдения",
        "",
        "Шаг 1/4: выбери Telegram-чат, за которым нужно следить.",
        "",
        sourceChats.length
            ? "Нажми на чат ниже или отправь сообщением часть названия, @username или id."
            : "Не удалось получить Telegram-диалоги пользовательского аккаунта. Проверь TELEGRAM_SESSION_STRING и доступ аккаунта.",
        "",
        "Источник читается правами пользовательского аккаунта, бот не обязан быть добавлен в этот чат.",
    ].join("\n");
    return { text, keyboard: buildPagedKeyboard("src", sourceChats, state.sourcePage ?? 0) };
}

function buildTargetPicker(chats: ChatOption[], state: ChatPromptWatchWizardState): { text: string; keyboard: InlineKeyboard } {
    const targetChats = getTargetChats(chats);
    const text = [
        "📡 Настройка наблюдения",
        "",
        `Источник: ${state.sourceChatTitle}`,
        "",
        "Шаг 2/4: выбери чат, куда бот будет присылать уведомления.",
        "",
        "Нажми на чат ниже, выбери «Мне в личку» или отправь сообщением часть названия, @username или id. Бот должен быть добавлен в этот чат/канал и иметь право писать.",
    ].join("\n");
    return { text, keyboard: buildPagedKeyboard("tgt", targetChats, state.targetPage ?? 0, { includeMe: true }) };
}

function buildPromptRequest(state: ChatPromptWatchWizardState): string {
    return [
        "📡 Настройка наблюдения",
        "",
        `Источник: ${state.sourceChatTitle}`,
        `Куда писать: ${state.targetChatTitle}`,
        "",
        "Шаг 3/4: напиши промпт-критерий.",
        "",
        "Примеры:",
        "• сообщай, если возникают проблемы, и дай фактуру",
        "• сообщай о блокерах по проекту и кто за них отвечает",
        "• сообщай, если упоминают сроки, риски или эскалации",
    ].join("\n");
}

function buildConfirmMessage(state: ChatPromptWatchWizardState): { text: string; keyboard: InlineKeyboard } {
    const keyboard = new InlineKeyboard()
        .text("✅ Создать", "cw:confirm").row()
        .text("Источник", "cw:edit:source")
        .text("Куда писать", "cw:edit:target").row()
        .text("Промпт", "cw:edit:prompt").row()
        .text("Меню", "cw:menu")
        .text("Отмена", "cw:cancel");

    const text = [
        "📡 Проверь настройку",
        "",
        `Источник: ${state.sourceChatTitle}`,
        `Куда писать: ${state.targetChatTitle}`,
        `Промпт: ${state.prompt}`,
        "",
        "Шаг 4/4: создать наблюдение?",
    ].join("\n");

    return { text, keyboard };
}

function formatWatcher(watcher: ChatPromptWatcher, index: number): string {
    const status = watcher.enabled ? "включено" : "пауза";
    const source = watcher.sourceChatTitle || watcher.sourceChatId;
    const target = watcher.targetChatTitle || watcher.targetChatId;
    const last = watcher.lastMatchedAt
        ? new Date(watcher.lastMatchedAt).toLocaleString("ru-RU", {
            day: "2-digit",
            month: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
        })
        : "не было";

    return [
        `${index + 1}. ${status} · id: ${watcher.id}`,
        `Источник: ${source}`,
        `Куда писать: ${target}`,
        `Промпт: ${compact(watcher.prompt, 220)}`,
        `Последнее срабатывание: ${last}`,
    ].join("\n");
}

function buildWatcherListKeyboard(watchers: ChatPromptWatcher[]): InlineKeyboard {
    const keyboard = new InlineKeyboard();
    keyboard.text("➕ Добавить", "cw:add").row();

    watchers.forEach((watcher, index) => {
        const label = `${index + 1}`;
        if (watcher.enabled) {
            keyboard.text(`⏸ ${label}`, `cw:pause:${watcher.id}`);
        } else {
            keyboard.text(`▶️ ${label}`, `cw:resume:${watcher.id}`);
        }
        keyboard.text(`🗑 ${label}`, `cw:remove:${watcher.id}`).row();
    });

    keyboard.text("Обновить", "cw:list").text("Меню", "cw:menu");
    return keyboard;
}

function buildWatchMenuKeyboard(hasActiveWizard: boolean): InlineKeyboard {
    const keyboard = new InlineKeyboard()
        .text("➕ Новое наблюдение", "cw:add").row()
        .text("📋 Наблюдения", "cw:list")
        .text("❔ Справка", "cw:help").row();

    if (hasActiveWizard) {
        keyboard.text("Продолжить настройку", "cw:continue").row()
            .text("Отменить настройку", "cw:cancel").row();
    }

    return keyboard;
}

function isExpired(state: ChatPromptWatchWizardState | undefined): boolean {
    return !state || Date.now() > state.expiresAt;
}

async function loadTargetChatOptions(): Promise<ChatOption[]> {
    const chats = await getAllChats();
    return chats.map(chatToOption);
}

async function loadSourceChatOptions(): Promise<ChatOption[]> {
    const chats = await listReadableTelegramChats(SOURCE_DIALOG_LIMIT);
    return chats.map((chat) => ({
        chatId: String(chat.id),
        title: chat.username ? `${chat.title} (@${chat.username})` : chat.title,
        chatType: chat.chatType,
        username: chat.username,
    }));
}

async function findCurrentChatOption(ctx: BotContext, chats: ChatOption[], allowFallback: boolean): Promise<ChatOption | null> {
    if (!ctx.chat?.id) return null;
    const known = chats.find((chat) => chat.chatId === String(ctx.chat!.id));
    if (known) return known;
    if (!allowFallback) return null;
    const title = ctx.chat && "title" in ctx.chat && ctx.chat.title ? ctx.chat.title : "Текущий чат";
    return {
        chatId: String(ctx.chat.id),
        title,
        chatType: ctx.chat.type ?? "unknown",
    };
}

async function findOwnerChatOption(chats: ChatOption[]): Promise<ChatOption> {
    const ownerChatId = await getProactiveChatId();
    const known = chats.find((chat) => chat.chatId === String(ownerChatId));
    return known ?? {
        chatId: String(ownerChatId),
        title: "Личный чат владельца",
        chatType: "private",
    };
}

async function findTargetChatViaBotApi(ctx: BotContext, query: string): Promise<ChatOption | null> {
    for (const candidate of targetLookupCandidates(query)) {
        try {
            const chat = await ctx.api.getChat(candidate);
            const option = botApiChatToOption(chat);
            if (option && getTargetChats([option]).length) return option;
        } catch {
            // Текстовый поиск часто пробует несуществующие @username; это не ошибка настройки.
        }
    }
    return null;
}

async function editOrReply(ctx: any, text: string, keyboard?: InlineKeyboard): Promise<void> {
    const options = keyboard ? { reply_markup: keyboard } : undefined;
    try {
        await ctx.editMessageText(text, options);
    } catch {
        await ctx.reply(text, options);
    }
}

function toTelegramChatId(chatId: string): number | string {
    const parsed = Number(chatId);
    return Number.isSafeInteger(parsed) ? parsed : chatId;
}

function errorToMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    try {
        return JSON.stringify(error);
    } catch {
        return String(error);
    }
}

async function validateTargetChat(ctx: BotContext, state: ChatPromptWatchWizardState): Promise<string | null> {
    if (!state.targetChatId) return "Целевой чат не выбран.";

    try {
        if (state.targetChatType === "channel") {
            const chatId = toTelegramChatId(state.targetChatId);
            const me = await ctx.api.getMe();
            const member = await ctx.api.getChatMember(chatId, me.id) as any;
            if (member.status === "creator") return null;
            if (member.status === "administrator" && member.can_post_messages !== false) return null;
            return "Для канала бот должен быть администратором с правом публиковать сообщения.";
        }
        await ctx.api.sendChatAction(toTelegramChatId(state.targetChatId), "typing");
        return null;
    } catch (error) {
        console.warn("[chatPromptWatchCommands] target chat validation failed:", error);
        return compact(errorToMessage(error), 300);
    }
}

async function showWatchMenu(ctx: any): Promise<void> {
    const watchers = await listChatPromptWatchers();
    const active = watchers.filter((watcher) => watcher.enabled).length;
    const paused = watchers.length - active;
    const state = ctx.session.chatPromptWatchState;
    const hasActiveWizard = Boolean(state && !isExpired(state));
    if (state && !hasActiveWizard) {
        delete ctx.session.chatPromptWatchState;
    }

    const text = [
        "📡 Наблюдения",
        "",
        `Всего: ${watchers.length}`,
        `Активно: ${active}`,
        `На паузе: ${paused}`,
        hasActiveWizard ? "" : undefined,
        hasActiveWizard ? "Есть незавершённая настройка." : undefined,
    ].filter((line): line is string => line !== undefined).join("\n");

    await editOrReply(ctx, text, buildWatchMenuKeyboard(hasActiveWizard));
}

async function showWatcherList(ctx: any): Promise<void> {
    const watchers = await listChatPromptWatchers();
    if (!watchers.length) {
        const keyboard = new InlineKeyboard()
            .text("➕ Добавить", "cw:add").row()
            .text("Меню", "cw:menu");
        await editOrReply(ctx, "Наблюдения пока не настроены.", keyboard);
        return;
    }

    const text = [
        `📡 Наблюдения (${watchers.length})`,
        "",
        watchers.map(formatWatcher).join("\n\n"),
        "",
        "Кнопки ниже: пауза/возобновить и удалить по номеру.",
    ].join("\n");
    await editOrReply(ctx, text, buildWatcherListKeyboard(watchers));
}

async function showCurrentWizardStep(ctx: any): Promise<void> {
    const state = ctx.session.chatPromptWatchState;
    if (isExpired(state)) {
        delete ctx.session.chatPromptWatchState;
        await showWatchMenu(ctx);
        return;
    }

    if (state!.step === "source") {
        await showSourcePicker(ctx, state!);
        return;
    }
    if (state!.step === "target") {
        await showTargetPicker(ctx, state!);
        return;
    }
    if (state!.step === "prompt") {
        await editOrReply(ctx, buildPromptRequest(state!), buildPromptKeyboard());
        return;
    }

    const { text, keyboard } = buildConfirmMessage(state!);
    await editOrReply(ctx, text, keyboard);
}

async function showSourcePicker(ctx: any, state: ChatPromptWatchWizardState): Promise<void> {
    const chats = await loadSourceChatOptions();
    const { text, keyboard } = buildSourcePicker(chats, state);
    await editOrReply(ctx, text, keyboard);
}

async function showTargetPicker(ctx: any, state: ChatPromptWatchWizardState): Promise<void> {
    const chats = await loadTargetChatOptions();
    const { text, keyboard } = buildTargetPicker(chats, state);
    await editOrReply(ctx, text, keyboard);
}

async function startWizard(ctx: BotContext, mode: "reply" | "edit" = "reply"): Promise<void> {
    const state = newWizardState();
    delete ctx.session.chatGroupState;
    delete ctx.session.chatAnalysisPeriodRequest;
    delete ctx.session.studyChatRequest;
    ctx.session.chatPromptWatchState = state;
    const chats = await loadSourceChatOptions();
    const { text, keyboard } = buildSourcePicker(chats, state);
    if (mode === "edit") {
        await editOrReply(ctx, text, keyboard);
        return;
    }
    await ctx.reply(text, { reply_markup: keyboard });
}

async function selectSource(ctx: any, chatId: string): Promise<void> {
    const state = ctx.session.chatPromptWatchState;
    if (isExpired(state)) {
        delete ctx.session.chatPromptWatchState;
        await editOrReply(ctx, "Мастер настройки истёк. Открой меню: /watch");
        return;
    }

    const chats = await loadSourceChatOptions();
    const chat = chats.find((item) => item.chatId === chatId);
    if (!chat) {
        await ctx.answerCallbackQuery?.("Источник не найден");
        return;
    }

    ctx.session.chatPromptWatchState = {
        ...state!,
        step: "target",
        sourceChatId: chat.chatId,
        sourceChatTitle: chat.title,
        sourceChatType: chat.chatType,
        targetPage: 0,
        expiresAt: Date.now() + WIZARD_TTL_MS,
    };
    await showTargetPicker(ctx, ctx.session.chatPromptWatchState);
}

async function selectTarget(ctx: any, chatId: string): Promise<void> {
    const state = ctx.session.chatPromptWatchState;
    if (isExpired(state)) {
        delete ctx.session.chatPromptWatchState;
        await editOrReply(ctx, "Мастер настройки истёк. Открой меню: /watch");
        return;
    }

    const chats = await loadTargetChatOptions();
    const chat = chatId === "me"
        ? await findOwnerChatOption(chats)
        : chats.find((item) => item.chatId === chatId);
    if (!chat) {
        await ctx.answerCallbackQuery?.("Целевой чат не найден");
        return;
    }
    if (!getTargetChats([chat]).length) {
        await ctx.answerCallbackQuery?.("Этот тип чата нельзя выбрать как цель");
        return;
    }

    ctx.session.chatPromptWatchState = {
        ...state!,
        step: "prompt",
        targetChatId: chat.chatId,
        targetChatTitle: chat.title,
        targetChatType: chat.chatType,
        expiresAt: Date.now() + WIZARD_TTL_MS,
    };
    await editOrReply(ctx, buildPromptRequest(ctx.session.chatPromptWatchState), buildPromptKeyboard());
}

async function handleWizardSearch(ctx: BotContext, state: ChatPromptWatchWizardState, query: string): Promise<boolean> {
    const normalized = normalizeQuery(query);
    if (["отмена", "cancel", "стоп"].includes(normalized)) {
        delete ctx.session.chatPromptWatchState;
        await showWatchMenu(ctx);
        return true;
    }

    const sourceChats = state.step === "source" ? await loadSourceChatOptions() : [];
    const targetChats = state.step === "target" ? await loadTargetChatOptions() : [];

    if (state.step === "source") {
        const direct = ["here", "тут", "здесь", "этот чат"].includes(normalized)
            ? await findCurrentChatOption(ctx, sourceChats, false)
            : null;
        const matches = direct ? [direct] : sortBySearch(getSourceChats(sourceChats), query);
        if (matches.length === 1) {
            const chat = matches[0];
            ctx.session.chatPromptWatchState = {
                ...state,
                step: "target",
                sourceChatId: chat.chatId,
                sourceChatTitle: chat.title,
                sourceChatType: chat.chatType,
                targetPage: 0,
                expiresAt: Date.now() + WIZARD_TTL_MS,
            };
            const targetOptions = await loadTargetChatOptions();
            const { text, keyboard } = buildTargetPicker(targetOptions, ctx.session.chatPromptWatchState);
            await ctx.reply(text, { reply_markup: keyboard });
            return true;
        }

        if (!matches.length) {
            await ctx.reply("Не нашла такой Telegram-чат среди диалогов пользовательского аккаунта. Напиши часть названия ещё раз.");
            return true;
        }

        const visibleMatches = matches.slice(0, ITEMS_PER_PAGE);
        const extraHint = matches.length > visibleMatches.length ? "\nПоказала первые варианты. Можно уточнить название текстом." : "";
        await ctx.reply(
            `Нашла несколько вариантов. Выбери источник:${extraHint}`,
            { reply_markup: buildPagedKeyboard("src", visibleMatches, 0) },
        );
        return true;
    }

    if (state.step === "target") {
        const direct = ["me", "личка", "лс", "мне", "owner", "владелец"].includes(normalized)
            ? await findOwnerChatOption(targetChats)
            : ["here", "тут", "здесь", "этот чат"].includes(normalized)
                ? await findCurrentChatOption(ctx, targetChats, true)
                : null;
        let matches = direct && getTargetChats([direct]).length
            ? [direct]
            : sortBySearch(getTargetChats(targetChats), query);
        if (!matches.length) {
            const foundByBotApi = await findTargetChatViaBotApi(ctx, query);
            matches = foundByBotApi ? [foundByBotApi] : [];
        }
        if (matches.length === 1) {
            const chat = matches[0];
            ctx.session.chatPromptWatchState = {
                ...state,
                step: "prompt",
                targetChatId: chat.chatId,
                targetChatTitle: chat.title,
                targetChatType: chat.chatType,
                expiresAt: Date.now() + WIZARD_TTL_MS,
            };
            await ctx.reply(buildPromptRequest(ctx.session.chatPromptWatchState), { reply_markup: buildPromptKeyboard() });
            return true;
        }

        if (!matches.length) {
            await ctx.reply("Не нашла такой целевой чат. Напиши часть названия ещё раз, @username, id, me для личного чата или добавь бота в нужную группу/канал.");
            return true;
        }

        const visibleMatches = matches.slice(0, ITEMS_PER_PAGE);
        const extraHint = matches.length > visibleMatches.length ? "\nПоказала первые варианты. Можно уточнить название текстом." : "";
        await ctx.reply(
            `Нашла несколько вариантов. Выбери, куда писать:${extraHint}`,
            { reply_markup: buildPagedKeyboard("tgt", visibleMatches, 0, { includeMe: true }) },
        );
        return true;
    }

    if (state.step === "prompt") {
        const prompt = query.trim();
        if (prompt.length < 8) {
            await ctx.reply("Промпт слишком короткий. Напиши подробнее, что именно отслеживать.");
            return true;
        }

        ctx.session.chatPromptWatchState = {
            ...state,
            step: "confirm",
            prompt,
            expiresAt: Date.now() + WIZARD_TTL_MS,
        };
        const { text, keyboard } = buildConfirmMessage(ctx.session.chatPromptWatchState);
        await ctx.reply(text, { reply_markup: keyboard });
        return true;
    }

    await ctx.reply("Сейчас нужно подтвердить настройку кнопкой ниже или отменить мастер.");
    return true;
}

export function registerChatPromptWatchCommands(bot: Bot<BotContext>) {
    bot.command("watch", async (ctx) => {
        await showWatchMenu(ctx);
    });

    bot.command("watch_help", async (ctx) => {
        const keyboard = new InlineKeyboard()
            .text("➕ Добавить", "cw:add").row()
            .text("📋 Наблюдения", "cw:list")
            .text("Меню", "cw:menu");
        await ctx.reply(usageText(), { reply_markup: keyboard });
    });

    bot.command("watch_list", async (ctx) => {
        await showWatcherList(ctx);
    });

    bot.command("watch_add", async (ctx) => {
        await startWizard(ctx);
    });

    bot.command("watch_remove", async (ctx) => {
        const id = parseCommandArgument(ctx.message?.text, "watch_remove");
        if (!id) {
            await ctx.reply("Укажи id наблюдения: /watch_remove <id>");
            return;
        }

        const removed = await removeChatPromptWatcher(id);
        await ctx.reply(removed ? `✅ Наблюдение ${id} удалено.` : `Не нашла наблюдение с id ${id}.`);
    });

    bot.command("watch_pause", async (ctx) => {
        const id = parseCommandArgument(ctx.message?.text, "watch_pause");
        if (!id) {
            await ctx.reply("Укажи id наблюдения: /watch_pause <id>");
            return;
        }

        const watcher = await setChatPromptWatcherEnabled(id, false);
        await ctx.reply(watcher ? `⏸ Наблюдение ${id} поставлено на паузу.` : `Не нашла наблюдение с id ${id}.`);
    });

    bot.command("watch_resume", async (ctx) => {
        const id = parseCommandArgument(ctx.message?.text, "watch_resume");
        if (!id) {
            await ctx.reply("Укажи id наблюдения: /watch_resume <id>");
            return;
        }

        const watcher = await setChatPromptWatcherEnabled(id, true);
        await ctx.reply(watcher ? `▶️ Наблюдение ${id} снова включено.` : `Не нашла наблюдение с id ${id}.`);
    });

    bot.callbackQuery("cw:menu", async (ctx) => {
        await ctx.answerCallbackQuery();
        await showWatchMenu(ctx);
    });

    bot.callbackQuery("cw:help", async (ctx) => {
        await ctx.answerCallbackQuery();
        const keyboard = new InlineKeyboard()
            .text("➕ Добавить", "cw:add").row()
            .text("📋 Наблюдения", "cw:list")
            .text("Меню", "cw:menu");
        await editOrReply(ctx, usageText(), keyboard);
    });

    bot.callbackQuery("cw:list", async (ctx) => {
        await ctx.answerCallbackQuery();
        await showWatcherList(ctx);
    });

    bot.callbackQuery("cw:add", async (ctx) => {
        await ctx.answerCallbackQuery();
        await startWizard(ctx, "edit");
    });

    bot.callbackQuery("cw:continue", async (ctx) => {
        await ctx.answerCallbackQuery();
        await showCurrentWizardStep(ctx);
    });

    bot.callbackQuery(/^cw:pause:([A-Za-z0-9_-]+)$/, async (ctx) => {
        await ctx.answerCallbackQuery();
        await setChatPromptWatcherEnabled(ctx.match[1], false);
        await showWatcherList(ctx);
    });

    bot.callbackQuery(/^cw:resume:([A-Za-z0-9_-]+)$/, async (ctx) => {
        await ctx.answerCallbackQuery();
        await setChatPromptWatcherEnabled(ctx.match[1], true);
        await showWatcherList(ctx);
    });

    bot.callbackQuery(/^cw:remove:([A-Za-z0-9_-]+)$/, async (ctx) => {
        await ctx.answerCallbackQuery();
        const watchers = await listChatPromptWatchers();
        const watcher = watchers.find((item) => item.id === ctx.match[1]);
        if (!watcher) {
            await showWatcherList(ctx);
            return;
        }
        const keyboard = new InlineKeyboard()
            .text("🗑 Удалить", `cw:remove-do:${watcher.id}`).row()
            .text("Назад", "cw:list");
        await editOrReply(ctx, [
            "Удалить наблюдение?",
            "",
            formatWatcher(watcher, 0),
        ].join("\n"), keyboard);
    });

    bot.callbackQuery(/^cw:remove-do:([A-Za-z0-9_-]+)$/, async (ctx) => {
        await ctx.answerCallbackQuery();
        await removeChatPromptWatcher(ctx.match[1]);
        await showWatcherList(ctx);
    });

    bot.callbackQuery("cw:noop", async (ctx) => {
        await ctx.answerCallbackQuery();
    });

    bot.callbackQuery("cw:cancel", async (ctx) => {
        await ctx.answerCallbackQuery("Отменено");
        delete ctx.session.chatPromptWatchState;
        await showWatchMenu(ctx);
    });

    bot.callbackQuery(/^cw:srcp:(\d+)$/, async (ctx) => {
        await ctx.answerCallbackQuery();
        const state = ctx.session.chatPromptWatchState;
        if (isExpired(state)) {
            delete ctx.session.chatPromptWatchState;
            await editOrReply(ctx, "Мастер настройки истёк. Открой меню: /watch");
            return;
        }
        ctx.session.chatPromptWatchState = {
            ...state!,
            step: "source",
            sourcePage: Number(ctx.match[1]),
            expiresAt: Date.now() + WIZARD_TTL_MS,
        };
        await showSourcePicker(ctx, ctx.session.chatPromptWatchState);
    });

    bot.callbackQuery(/^cw:tgtp:(\d+)$/, async (ctx) => {
        await ctx.answerCallbackQuery();
        const state = ctx.session.chatPromptWatchState;
        if (isExpired(state)) {
            delete ctx.session.chatPromptWatchState;
            await editOrReply(ctx, "Мастер настройки истёк. Открой меню: /watch");
            return;
        }
        ctx.session.chatPromptWatchState = {
            ...state!,
            step: "target",
            targetPage: Number(ctx.match[1]),
            expiresAt: Date.now() + WIZARD_TTL_MS,
        };
        await showTargetPicker(ctx, ctx.session.chatPromptWatchState);
    });

    bot.callbackQuery(/^cw:src:(-?\d+)$/, async (ctx) => {
        await ctx.answerCallbackQuery();
        await selectSource(ctx, ctx.match[1]);
    });

    bot.callbackQuery(/^cw:tgt:(-?\d+|me)$/, async (ctx) => {
        await ctx.answerCallbackQuery();
        await selectTarget(ctx, ctx.match[1]);
    });

    bot.callbackQuery("cw:edit:source", async (ctx) => {
        await ctx.answerCallbackQuery();
        const state = ctx.session.chatPromptWatchState;
        if (isExpired(state)) {
            delete ctx.session.chatPromptWatchState;
            await editOrReply(ctx, "Мастер настройки истёк. Открой меню: /watch");
            return;
        }
        ctx.session.chatPromptWatchState = {
            ...state!,
            step: "source",
            sourcePage: 0,
            expiresAt: Date.now() + WIZARD_TTL_MS,
        };
        await showSourcePicker(ctx, ctx.session.chatPromptWatchState);
    });

    bot.callbackQuery("cw:edit:target", async (ctx) => {
        await ctx.answerCallbackQuery();
        const state = ctx.session.chatPromptWatchState;
        if (isExpired(state)) {
            delete ctx.session.chatPromptWatchState;
            await editOrReply(ctx, "Мастер настройки истёк. Открой меню: /watch");
            return;
        }
        ctx.session.chatPromptWatchState = {
            ...state!,
            step: "target",
            targetPage: 0,
            expiresAt: Date.now() + WIZARD_TTL_MS,
        };
        await showTargetPicker(ctx, ctx.session.chatPromptWatchState);
    });

    bot.callbackQuery("cw:edit:prompt", async (ctx) => {
        await ctx.answerCallbackQuery();
        const state = ctx.session.chatPromptWatchState;
        if (isExpired(state)) {
            delete ctx.session.chatPromptWatchState;
            await editOrReply(ctx, "Мастер настройки истёк. Открой меню: /watch");
            return;
        }
        ctx.session.chatPromptWatchState = {
            ...state!,
            step: "prompt",
            expiresAt: Date.now() + WIZARD_TTL_MS,
        };
        await editOrReply(ctx, buildPromptRequest(ctx.session.chatPromptWatchState), buildPromptKeyboard());
    });

    bot.callbackQuery("cw:confirm", async (ctx) => {
        await ctx.answerCallbackQuery();
        const state = ctx.session.chatPromptWatchState;
        if (isExpired(state) || !state?.sourceChatId || !state.targetChatId || !state.prompt) {
            delete ctx.session.chatPromptWatchState;
            await editOrReply(ctx, "Мастер настройки истёк или заполнен не полностью. Открой меню: /watch");
            return;
        }

        const validationError = await validateTargetChat(ctx, state);
        if (validationError) {
            const keyboard = new InlineKeyboard()
                .text("Куда писать", "cw:edit:target").row()
                .text("Отмена", "cw:cancel");
            await editOrReply(ctx, [
                "Не смогла проверить целевой чат.",
                "",
                `Куда писать: ${state.targetChatTitle || state.targetChatId}`,
                `Ошибка: ${validationError}`,
                "",
                "Бот должен быть добавлен в этот чат и иметь право отправлять сообщения. Выбери другой чат или поправь права и нажми «Куда писать».",
            ].join("\n"), keyboard);
            return;
        }

        const watcher = await addChatPromptWatcher({
            sourceChatId: state.sourceChatId,
            sourceChatTitle: state.sourceChatTitle,
            targetChatId: state.targetChatId,
            targetChatTitle: state.targetChatTitle,
            prompt: state.prompt,
        });

        delete ctx.session.chatPromptWatchState;
        await editOrReply(ctx, [
            "✅ Наблюдение создано.",
            `id: ${watcher.id}`,
            `Источник: ${watcher.sourceChatTitle}`,
            `Куда писать: ${watcher.targetChatTitle}`,
            `Промпт: ${watcher.prompt}`,
            "",
            "Открыть меню: /watch",
        ].join("\n"));
    });

    bot.on("message:text", async (ctx, next) => {
        const state = ctx.session.chatPromptWatchState;
        if (!state) return next();
        if (ctx.message.text.trim().startsWith("/")) return next();

        if (isExpired(state)) {
            delete ctx.session.chatPromptWatchState;
            await ctx.reply("Мастер настройки истёк. Открой меню: /watch");
            return;
        }

        const handled = await handleWizardSearch(ctx, state, ctx.message.text);
        if (!handled) return next();
    });
}
