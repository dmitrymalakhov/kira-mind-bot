import { randomUUID } from "crypto";
import type { BotContext } from "../types";
import type { RecurringTask } from "../types/recurringTaskTypes";
import { USER_TIMEZONE } from "../constants";
import {
    RECURRING_TASK_STALE_LOCK_MS,
    RecurringTaskRepository,
} from "./RecurringTaskRepository";
import {
    computeNextRecurringRun,
    formatRecurringSchedule,
    hasRecurringScheduleSignal,
    parseRecurringSchedule,
} from "../utils/recurringTaskSchedule";
import { buildRecurringTaskCard } from "../utils/recurringTaskCard";
import { sendStructuredBlocks } from "../utils";
import { editStructured } from "../utils/richMessage";
import { getActiveBotProfile } from "../utils/botIdentity";
import { InlineKeyboard } from "grammy";
import { editReplyMarkupIfChanged } from "../utils/telegramMessageEdit";

const EDIT_TTL_MS = 10 * 60 * 1000;
const CREATION_ACTION_RE = /(?:присыла(?:й|йте|ть)|отправля(?:й|йте|ть)|запуска(?:й|йте|ть)|выполня(?:й|йте|ть)|дела(?:й|йте|ть)|повторя(?:й|йте|ть)|повтори(?:те)?|поставь(?:те)?|ставь(?:те)?|добавь(?:те)?|запланируй(?:те)?|назначь(?:те)?)/iu;
const INLINE_CREATION_ACTION_RE = /(?:присыла(?:й|йте|ть)|отправля(?:й|йте|ть)|получать|находи(?:те|ть)?|ищи(?:те|ть)?|проверя(?:й|йте|ть)|собира(?:й|йте|ть)|готовь(?:те)?|подготавлива(?:й|йте|ть)|запуска(?:й|йте|ть)|выполня(?:й|йте|ть)|дела(?:й|йте|ть)|повторя(?:й|йте|ть))/iu;
const INLINE_REMINDER_RE = /(?:^|[\s,;:])(?:напомни|напоминай|не\s+дай\s+забыть|не\s+забудь|создай\s+напоминание)(?=$|[\s,.!?;:])/iu;
const REFERENCE_ONLY_RE = /^(?:это|его|так|этот\s+запрос|эту\s+задач[уи]|предыдущ(?:ий|ее|ую)\s+(?:запрос|сообщение|задач[уи])|то\s+же\s+самое|такое|этот\s+результат)[.!?]*$/iu;
const CREATION_PREAMBLE_RE = /^(?:(?:я|сразу|хочу|прошу|попрошу|давай|пожалуйста|можешь|нужно|надо)(?:\s+|$))+$/iu;
const LIST_RE = /(?:какие|покажи|показать|список|перечисли|что\s+за).{0,40}(?:регулярн|повторяющ).{0,20}(?:задач|запуск)|мои\s+(?:регулярные|повторяющиеся)\s+задачи/iu;
const NATURAL_TASK_SCOPE_RE = /(?:регулярн|повторяющ|фонов|расписан|задач|запуск)/iu;
const NATURAL_TASK_SCOPE_PHRASE_RE = /(?:(?:регулярн|повторяющ|фонов|расписан)\p{L}*\s+)*(?:задач|запуск)\p{L}*|(?:задач|запуск)\p{L}*\s+по\s+расписани\p{L}*/giu;
const NATURAL_DELETE_RE = /(?:удали(?:ть|те)?|отмени(?:ть|те)?|сотри(?:те)?)/iu;
const NATURAL_PAUSE_RE = /(?:поставь(?:те)?(?=[\s\S]{0,100}на\s+паузу)|сними(?:те)?(?=[\s\S]{0,100}с\s+расписания)|приостанови(?:ть|те)?|отключи(?:ть|те)?|выключи(?:ть|те)?|заморозь(?:те)?|останови(?:ть|те)?|перестань(?:те)?\s+(?:мне\s+)?(?:присылать|отправлять|показывать|делать|выполнять|запускать)|больше\s+не\s+(?:присылай(?:те)?|отправляй(?:те)?|показывай(?:те)?|делай(?:те)?|выполняй(?:те)?|запускай(?:те)?))/iu;
const NATURAL_RESUME_RE = /(?:возобнови(?:ть|те)?|включи(?:ть|те)?|продолжи(?:ть|те)?|сними(?:те)?(?=[\s\S]{0,100}с\s+паузы)|снова\s+(?:присылай(?:те)?|отправляй(?:те)?|показывай(?:те)?|делай(?:те)?|выполняй(?:те)?|запускай(?:те)?))/iu;
const NATURAL_STRONG_MANAGEMENT_RE = /(?:пауза|приостанов|возобнов|с\s+паузы|с\s+расписания|перестань|больше\s+не|снова\s+(?:присылай|отправляй|показывай|делай|выполняй|запускай))/iu;
const NATURAL_QUERY_NOISE_RE = /(?:(?:мне|пожалуйста)(?=$|[\s,])|(?:ежедневн|еженедельн|ежемесячн|регулярн|повторяющ|фонов|расписанн)\p{L}*)/giu;
const INLINE_SCHEDULE_FRAGMENT = [
    "кажд(?:ый|ая|ое|ую|ые|ого)\\s+(?:(?:\\d+|один|одну|два|две|три|четыре|пять|шесть|семь|восемь|девять|десять|одиннадцать|двенадцать)\\s+)?(?:минут(?:у|ы)?|час(?:а|ов)?|д(?:ень|ня|ней)|недел(?:ю|и|ь)|месяц(?:а|ев)?|утро|вечер|ночь)",
    "ежедневно",
    "еженедельно",
    "ежемесячно",
    "регулярно",
    "каждые\\s+полчаса",
    "каждого\\s+\\d{1,2}(?:-го)?\\s+числа",
    "по\\s+(?:будням|выходным|утрам|вечерам|ночам|понедельникам|вторникам|средам|четвергам|пятницам|субботам|воскресеньям)",
    "(?:каждый\\s+)?будний\\s+день",
    "(?:каждый\\s+)?рабоч(?:ий|ие)\\s+д(?:ень|ни)",
    "раз\\s+в\\s+(?:полчаса|(?:(?:\\d+|один|одну|два|две|три|четыре|пять|шесть|семь|восемь|девять|десять|одиннадцать|двенадцать)\\s+)?(?:минут(?:у|ы)?|час(?:а|ов)?|д(?:ень|ня|ней)|недел(?:ю|и|ь)|месяц(?:а|ев)?))",
    "на\\s+повтор",
].map((item) => `(?:${item})`).join("|");
const INLINE_CLOCK_FRAGMENT = "(?:в|к)\\s*(?:полдень|полночь|(?:[01]?\\d|2[0-3])(?:[:.](?:[0-5]\\d))?(?:\\s*(?:утра|дня|вечера|ночи))?(?:\\s+час(?:а|ов)?)?)";
const INLINE_SCHEDULE_DIRECTIVE_RE = new RegExp(
    `(?:${INLINE_CLOCK_FRAGMENT}\\s+)?(?:${INLINE_SCHEDULE_FRAGMENT})(?:\\s+${INLINE_CLOCK_FRAGMENT})?`,
    "giu",
);

function normalizeText(value: string): string {
    return value.replace(/\s+/g, " ").trim();
}

export function isRecurringTaskCreationFollowUp(text: string): boolean {
    if (!CREATION_ACTION_RE.test(text)) return false;
    const withoutAction = stripInlineCreationPrefix(text)
        .replace(CREATION_ACTION_RE, " ")
        .replace(
            /(?:^|[\s,;:])(?:супер|теперь|давай|мне|пожалуйста)(?=$|[\s,.!?;:])/giu,
            " ",
        )
        .replace(/\s+/g, " ")
        .replace(/^[\s,;:—-]+|[\s,;:—-]+$/gu, "")
        .trim();
    return REFERENCE_ONLY_RE.test(withoutAction);
}

function stripInlineCreationPrefix(value: string): string {
    let result = normalizeText(value)
        .replace(INLINE_SCHEDULE_DIRECTIVE_RE, " ")
        .replace(/\s+/g, " ")
        .replace(/^[\s,;:—-]+/u, "");
    for (let attempt = 0; attempt < 6; attempt += 1) {
        const before = result;
        result = result
            .replace(/^(?:(?:мне|для\s+меня|пожалуйста|прошу|нужно|надо)(?=$|[\s,;:—-])[\s,;:—-]*)/iu, "")
            .replace(/^[\s,;:—-]+/u, "");
        if (result === before) break;
    }
    return result
        .replace(/\s+([,.!?;:])/gu, "$1")
        .replace(/^[\s,;:—-]+|[\s,;:—-]+$/gu, "")
        .trim();
}

function buildInlineExecutionPrompt(action: string, taskText: string): string {
    if (/^(?:наход|ищ)/iu.test(action)) return `Найди ${taskText}`;
    if (/^провер/iu.test(action)) return `Проверь ${taskText}`;
    if (/^собира/iu.test(action)) return `Собери ${taskText}`;
    if (/^(?:готов|подготавлива)/iu.test(action)) return `Подготовь ${taskText}`;
    if (/^(?:присыла|отправля|получ)/iu.test(action)) return `Подготовь ${taskText}`;
    return `Выполни задачу: ${taskText}`;
}

function hasInlineTaskContent(value: string): boolean {
    return value.replace(/[^\p{L}\p{N}]/gu, "").length >= 2;
}

function isOnlyCreationPreamble(value: string): boolean {
    const normalized = stripInlineCreationPrefix(value)
        .replace(/[,.!?;:—-]+/gu, " ")
        .replace(/\s+/g, " ")
        .trim();
    return normalized.length === 0 || CREATION_PREAMBLE_RE.test(normalized);
}

export interface ParsedInlineRecurringTaskCreation {
    prompt: string;
    parsedSchedule: NonNullable<ReturnType<typeof parseRecurringSchedule>>;
}

export function parseInlineRecurringTaskCreation(
    text: string,
    timezone: string,
    now = new Date(),
): ParsedInlineRecurringTaskCreation | undefined {
    const parsedSchedule = parseRecurringSchedule(text, now, timezone);
    if (
        !parsedSchedule ||
        isRecurringTaskCreationFollowUp(text) ||
        INLINE_REMINDER_RE.test(text)
    ) return undefined;

    const actionMatch = INLINE_CREATION_ACTION_RE.exec(text);
    const useActionExtraction = Boolean(
        actionMatch?.index != null &&
        isOnlyCreationPreamble(text.slice(0, actionMatch.index)),
    );
    const taskText = stripInlineCreationPrefix(
        useActionExtraction && actionMatch?.index != null
            ? text.slice(actionMatch.index + actionMatch[0].length)
            : text,
    );
    if (!hasInlineTaskContent(taskText) || REFERENCE_ONLY_RE.test(taskText)) return undefined;

    return {
        prompt: useActionExtraction && actionMatch
            ? buildInlineExecutionPrompt(actionMatch[0], taskText)
            : taskText,
        parsedSchedule,
    };
}

export function isRecurringTaskListRequest(text: string): boolean {
    return LIST_RE.test(text);
}

export function buildRecurringTaskTitle(prompt: string): string {
    const normalized = normalizeText(prompt)
        .replace(/^(?:пожалуйста[,\s]+|слушай[,\s]+|кира[,\s]+)/iu, "");
    if (normalized.length <= 72) return normalized;
    return `${normalized.slice(0, 69).trimEnd()}…`;
}

export interface ParsedRecurringTaskEdit {
    title?: string;
    prompt?: string;
    parsedSchedule?: NonNullable<ReturnType<typeof parseRecurringSchedule>>;
    scheduleError?: string;
}

export function parseRecurringTaskEdit(
    text: string,
    timezone: string,
    now = new Date(),
): ParsedRecurringTaskEdit {
    const title = text.match(/(?:^|\n)\s*название\s*:\s*(.+?)(?=\n|$)/iu)?.[1]?.trim();
    const prompt = text.match(
        /(?:^|\n)\s*(?:запрос|текст|задача)\s*:\s*([\s\S]+?)(?=\n\s*(?:название|расписание)\s*:|$)/iu,
    )?.[1]?.trim();
    const scheduleField = text.match(
        /(?:^|\n)\s*расписание\s*:\s*([\s\S]*?)(?=\n\s*(?:название|запрос|текст|задача)\s*:|$)/iu,
    );
    const scheduleText = scheduleField?.[1]?.trim();
    const parsedSchedule = scheduleField
        ? scheduleText
            ? parseRecurringSchedule(scheduleText, now, timezone)
            : undefined
        : !title && !prompt
            ? parseRecurringSchedule(text, now, timezone)
            : undefined;

    return {
        title,
        prompt,
        parsedSchedule,
        scheduleError: scheduleField && !parsedSchedule
            ? "Не поняла новое расписание. Например: «расписание: по будням в 08:30»."
            : undefined,
    };
}

function taskMatchesQuery(task: RecurringTask, query: string): number {
    const normalized = normalizeText(query).toLocaleLowerCase("ru-RU");
    if (!normalized) return 0;
    const haystack = `${task.title} ${task.prompt} ${formatRecurringSchedule(task.schedule)}`
        .toLocaleLowerCase("ru-RU");
    if (haystack.includes(normalized)) return 100 + normalized.length;

    const tokenStems = (value: string): string[] => value
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .split(/\s+/)
        .filter(Boolean)
        .map((token) => token.replace(
            /(?:иями|ями|ами|ого|ему|ому|ыми|ими|иях|ах|ях|ией|ей|ой|ий|ый|ов|ев|ом|ем|ам|ям|у|ю|а|я|ы|и|е)$/iu,
            "",
        ))
        .filter((token) => token.length >= 3);
    const queryStems = tokenStems(normalized);
    const taskStems = tokenStems(haystack);
    return queryStems.reduce((score, queryStem) => (
        score + (taskStems.some((taskStem) =>
            taskStem.includes(queryStem) || queryStem.includes(taskStem)
        ) ? 1 : 0)
    ), 0);
}

export interface RecurringTaskNaturalMatch {
    task?: RecurringTask;
    candidates: RecurringTask[];
    reason: "matched" | "not_found" | "ambiguous";
}

export function findRecurringTaskNaturalMatch(
    tasks: RecurringTask[],
    query: string,
): RecurringTaskNaturalMatch {
    if (!query.trim()) {
        return tasks.length === 1
            ? { task: tasks[0], candidates: [tasks[0]], reason: "matched" }
            : { candidates: tasks, reason: tasks.length ? "ambiguous" : "not_found" };
    }
    const ranked = tasks
        .map((task) => ({ task, score: taskMatchesQuery(task, query) }))
        .filter((item) => item.score > 0)
        .sort((left, right) => right.score - left.score);
    if (ranked.length === 0) return { candidates: [], reason: "not_found" };
    const best = ranked.filter((item) => item.score === ranked[0].score);
    if (best.length > 1) {
        return { candidates: best.map((item) => item.task), reason: "ambiguous" };
    }
    return { task: ranked[0].task, candidates: [ranked[0].task], reason: "matched" };
}

export interface ParsedRecurringTaskManagement {
    action: "pause" | "resume" | "delete";
    query: string;
    explicitScope: boolean;
    strongIntent: boolean;
}

export function parseRecurringTaskManagement(
    text: string,
): ParsedRecurringTaskManagement | undefined {
    const explicitScope = NATURAL_TASK_SCOPE_RE.test(text);
    if (hasRecurringScheduleSignal(text) && !explicitScope) return undefined;

    const matches: Array<{
        action: ParsedRecurringTaskManagement["action"];
        match: RegExpMatchArray | null;
    }> = [
        { action: "delete", match: text.match(NATURAL_DELETE_RE) },
        { action: "pause", match: text.match(NATURAL_PAUSE_RE) },
        { action: "resume", match: text.match(NATURAL_RESUME_RE) },
    ];
    const selected = matches.find((item) => item.match);
    if (!selected?.match) return undefined;

    const query = normalizeText(text
        .replace(selected.match[0], " ")
        .replace(/(?:^|[\s,;:])(?:на\s+паузу|с\s+паузы|с\s+расписания)(?=$|[\s,.!?;:])/giu, " ")
        .replace(NATURAL_TASK_SCOPE_PHRASE_RE, " ")
        .replace(NATURAL_QUERY_NOISE_RE, " ")
        .replace(/^\s*(?:(?:эту|ту|мою|мне|для\s+меня|про|с|со)\s+)+/iu, "")
        .replace(/\s+/g, " "));
    return {
        action: selected.action,
        query,
        explicitScope,
        strongIntent: explicitScope || NATURAL_STRONG_MANAGEMENT_RE.test(text),
    };
}

export async function sendRecurringTasksMenu(ctx: BotContext, requestedIndex = 0): Promise<void> {
    const tasks = await RecurringTaskRepository.listByChatId(ctx.chat!.id);
    const { blocks, keyboard } = buildRecurringTaskCard(tasks, requestedIndex);
    await sendStructuredBlocks(ctx, ctx.chat!.id, blocks, { replyMarkup: keyboard });
}

export async function editRecurringTasksMenu(ctx: BotContext, requestedIndex = 0): Promise<void> {
    const callbackMessage = ctx.callbackQuery?.message;
    if (!callbackMessage) {
        await sendRecurringTasksMenu(ctx, requestedIndex);
        return;
    }
    const tasks = await RecurringTaskRepository.listByChatId(ctx.chat!.id);
    const { blocks, keyboard } = buildRecurringTaskCard(tasks, requestedIndex);
    await editStructured(
        ctx.api as any,
        callbackMessage.chat.id,
        callbackMessage.message_id,
        blocks,
        { replyMarkup: keyboard },
    );
}

async function handlePendingEdit(ctx: BotContext, text: string): Promise<boolean> {
    const pending = ctx.session.pendingRecurringTaskEdit;
    if (!pending) return false;
    if (pending.expiresAt <= Date.now()) {
        ctx.session.pendingRecurringTaskEdit = undefined;
        await ctx.reply("Время редактирования вышло. Открой /tasks и нажми «Изменить» ещё раз.");
        return true;
    }
    if (/^(?:отмена|отмени|не надо|стоп|cancel)$/iu.test(text.trim())) {
        ctx.session.pendingRecurringTaskEdit = undefined;
        await ctx.reply("Ок, редактирование регулярной задачи отменено.");
        return true;
    }

    const task = await RecurringTaskRepository.findById(pending.taskId, ctx.chat!.id);
    if (!task) {
        ctx.session.pendingRecurringTaskEdit = undefined;
        await ctx.reply("Не нашла эту регулярную задачу. Возможно, она уже удалена.");
        return true;
    }
    if (task.lockedAt && Date.now() - task.lockedAt.getTime() < RECURRING_TASK_STALE_LOCK_MS) {
        ctx.session.pendingRecurringTaskEdit = undefined;
        await ctx.reply("Эта задача сейчас выполняется. Попробуй изменить её после завершения запуска.");
        return true;
    }

    const { title, prompt, parsedSchedule, scheduleError } = parseRecurringTaskEdit(
        text,
        task.timezone,
    );

    if (scheduleError) {
        await ctx.reply(scheduleError);
        return true;
    }

    if (!title && !prompt && !parsedSchedule) {
        await ctx.reply(
            "Не поняла правку. Напиши, например:\n" +
            "«расписание: каждый будний день в 08:30»\n" +
            "или «запрос: найди свежие новости про космос».",
        );
        return true;
    }

    const patch: Parameters<typeof RecurringTaskRepository.update>[1] = {};
    if (title) patch.title = buildRecurringTaskTitle(title);
    if (prompt) {
        patch.prompt = prompt;
        if (!title) patch.title = buildRecurringTaskTitle(prompt);
        patch.contextHistory = [];
    }
    if (parsedSchedule) {
        patch.schedule = parsedSchedule.schedule;
        patch.nextRunAt = parsedSchedule.nextRunAt;
    }
    const updated = await RecurringTaskRepository.update(task.id, patch, ctx.chat!.id);
    if (!updated) {
        ctx.session.pendingRecurringTaskEdit = undefined;
        await ctx.reply("Задача начала выполняться до сохранения правки. Попробуй изменить её после завершения.");
        return true;
    }
    ctx.session.pendingRecurringTaskEdit = undefined;
    await ctx.reply(
        `Готово, обновила регулярную задачу «${patch.title ?? task.title}».` +
        (parsedSchedule ? ` Теперь: ${parsedSchedule.description}.` : ""),
    );
    return true;
}

async function handleNaturalManagement(ctx: BotContext, text: string): Promise<boolean> {
    if (isRecurringTaskListRequest(text)) {
        await sendRecurringTasksMenu(ctx);
        return true;
    }

    const management = parseRecurringTaskManagement(text);
    if (!management) return false;
    const tasks = await RecurringTaskRepository.listByChatId(ctx.chat!.id);
    if (tasks.length === 0) {
        if (!management.strongIntent) return false;
        await ctx.reply("У тебя пока нет регулярных задач.");
        return true;
    }

    const match = findRecurringTaskNaturalMatch(tasks, management.query);
    if (!match.task) {
        if (match.reason === "not_found" && !management.strongIntent) return false;
        if (match.reason === "not_found") {
            await ctx.reply(
                `Не нашла регулярную задачу по описанию «${management.query || text}». ` +
                "Покажи список командой /tasks или уточни название.",
            );
            return true;
        }
        const labels = match.candidates
            .slice(0, 5)
            .map((task, index) => `${index + 1}. ${task.title}`)
            .join("\n");
        await ctx.reply(
            "Под это описание подходит несколько регулярных задач. Уточни название:\n" +
            labels,
        );
        return true;
    }

    const task = match.task;
    if (management.action === "delete") {
        const deleted = await RecurringTaskRepository.delete(task.id, ctx.chat!.id);
        await ctx.reply(deleted
            ? `Удалила регулярную задачу «${task.title}».`
            : `Задача «${task.title}» сейчас выполняется. Удалить её можно после завершения запуска.`);
        return true;
    }
    if (management.action === "pause") {
        if (task.status === "paused") {
            await ctx.reply(`Задача «${task.title}» уже отключена.`);
            return true;
        }
        const updated = await RecurringTaskRepository.setStatus(task.id, "paused", ctx.chat!.id);
        await ctx.reply(updated
            ? `Отключила задачу «${task.title}». Она останется на паузе, пока ты её не возобновишь.`
            : "Не нашла эту регулярную задачу. Возможно, она уже удалена.");
        return true;
    }
    if (task.status === "active") {
        await ctx.reply(`Задача «${task.title}» уже включена.`);
        return true;
    }
    const updated = await RecurringTaskRepository.setStatus(task.id, "active", ctx.chat!.id);
    await ctx.reply(updated
        ? `Возобновила задачу «${task.title}». Следующий запуск — по расписанию.`
        : "Не нашла эту регулярную задачу. Возможно, она уже удалена.");
    return true;
}

interface RecurringTaskSource {
    prompt: string;
    messageId?: number;
    contextHistory?: Array<{ role: string; content: string }>;
}

async function createRecurringTask(
    ctx: BotContext,
    source: RecurringTaskSource,
    parsed: NonNullable<ReturnType<typeof parseRecurringSchedule>>,
): Promise<void> {
    const now = new Date();
    const task: RecurringTask = {
        id: randomUUID(),
        profile: getActiveBotProfile(),
        chatId: ctx.chat!.id,
        chatType: ctx.chat!.type === "group" || ctx.chat!.type === "supergroup"
            ? ctx.chat!.type
            : "private",
        chatTitle: "title" in ctx.chat! ? ctx.chat!.title : undefined,
        userId: ctx.from?.id ?? ctx.chat!.id,
        title: buildRecurringTaskTitle(source.prompt),
        prompt: source.prompt,
        contextHistory: source.contextHistory,
        originalMessageId: source.messageId,
        schedule: parsed.schedule,
        timezone: USER_TIMEZONE,
        status: "active",
        nextRunAt: parsed.nextRunAt,
        consecutiveFailures: 0,
        runCount: 0,
        createdAt: now,
        updatedAt: now,
    };
    await RecurringTaskRepository.create(task);
    await ctx.reply(
        `Поставила запрос «${task.title}» на повтор: ${formatRecurringSchedule(task.schedule)}. ` +
        `Следующий запуск — ${task.nextRunAt.toLocaleString("ru-RU", { timeZone: task.timezone, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}.`,
    );
}

async function handleCreation(
    ctx: BotContext,
    text: string,
    currentSource?: Omit<RecurringTaskSource, "prompt">,
): Promise<boolean> {
    const parsed = parseRecurringSchedule(text, new Date(), USER_TIMEZONE);
    if (!parsed) return false;

    if (isRecurringTaskCreationFollowUp(text)) {
        const candidate = ctx.session.lastSchedulableRequest;
        if (!candidate || Date.now() - candidate.createdAt > 7 * 24 * 60 * 60 * 1000) {
            await ctx.reply(
                "Не вижу недавнего запроса, который нужно повторять. Сначала отправь сам запрос, а следующим сообщением укажи расписание.",
            );
            return true;
        }
        await createRecurringTask(ctx, {
            prompt: candidate.text,
            messageId: candidate.messageId,
            contextHistory: candidate.contextHistory,
        }, parsed);
        return true;
    }

    const inline = parseInlineRecurringTaskCreation(text, USER_TIMEZONE);
    if (!inline) return false;
    await createRecurringTask(ctx, {
        prompt: inline.prompt,
        messageId: currentSource?.messageId,
        contextHistory: currentSource?.contextHistory,
    }, inline.parsedSchedule);
    return true;
}

export async function handleRecurringTaskText(
    ctx: BotContext,
    text: string,
    currentSource?: Omit<RecurringTaskSource, "prompt">,
): Promise<boolean> {
    if (await handlePendingEdit(ctx, text)) return true;
    if (await handleNaturalManagement(ctx, text)) return true;
    return handleCreation(ctx, text, currentSource);
}

export async function updateRecurringTaskSchedule(
    task: RecurringTask,
    scheduleText: string,
): Promise<RecurringTask | undefined> {
    const parsed = parseRecurringSchedule(scheduleText, new Date(), task.timezone);
    if (!parsed) return undefined;
    return RecurringTaskRepository.update(task.id, {
        schedule: parsed.schedule,
        nextRunAt: computeNextRecurringRun(parsed.schedule, new Date(), task.timezone),
    });
}

export function beginRecurringTaskEdit(ctx: BotContext, taskId: string): void {
    ctx.session.pendingRecurringTaskEdit = {
        taskId,
        createdAt: Date.now(),
        expiresAt: Date.now() + EDIT_TTL_MS,
    };
}

export async function handleRecurringTaskCallback(ctx: BotContext, data: string): Promise<boolean> {
    if (!data.startsWith("rt:")) return false;
    const [, action, value] = data.split(":");

    if (action === "noop") {
        await ctx.answerCallbackQuery();
        return true;
    }
    if (action === "nav") {
        await ctx.answerCallbackQuery();
        await editRecurringTasksMenu(ctx, Number(value) || 0);
        return true;
    }

    const task = value
        ? await RecurringTaskRepository.findById(value, ctx.chat!.id)
        : undefined;
    if (!task) {
        await ctx.answerCallbackQuery({ text: "Задача уже недоступна" });
        await editRecurringTasksMenu(ctx);
        return true;
    }
    const tasks = await RecurringTaskRepository.listByChatId(ctx.chat!.id);
    const index = Math.max(0, tasks.findIndex((item) => item.id === task.id));

    if (action === "pause" || action === "resume") {
        const status = action === "pause" ? "paused" : "active";
        await RecurringTaskRepository.setStatus(task.id, status, ctx.chat!.id);
        await ctx.answerCallbackQuery({ text: status === "active" ? "Задача возобновлена" : "Задача на паузе" });
        await editRecurringTasksMenu(ctx, index);
        return true;
    }

    if (action === "run") {
        if (task.lockedAt && Date.now() - task.lockedAt.getTime() < RECURRING_TASK_STALE_LOCK_MS) {
            await ctx.answerCallbackQuery({ text: "Задача уже выполняется" });
            return true;
        }
        const requested = await RecurringTaskRepository.requestRunNow(task.id, ctx.chat!.id);
        if (!requested) {
            await ctx.answerCallbackQuery({ text: "Задача уже выполняется" });
            await editRecurringTasksMenu(ctx, index);
            return true;
        }
        await ctx.answerCallbackQuery({ text: "Запущу в ближайшие секунды" });
        await editRecurringTasksMenu(ctx, index);
        return true;
    }

    if (action === "edit") {
        if (task.lockedAt && Date.now() - task.lockedAt.getTime() < RECURRING_TASK_STALE_LOCK_MS) {
            await ctx.answerCallbackQuery({ text: "Задача сейчас выполняется" });
            return true;
        }
        beginRecurringTaskEdit(ctx, task.id);
        await ctx.answerCallbackQuery({ text: "Жду правку" });
        await ctx.reply(
            "✏️ Напиши, что изменить в регулярной задаче.\n\n" +
            "Примеры:\n" +
            "«расписание: по будням в 08:30»\n" +
            "«запрос: найди главные новости про искусственный интеллект»\n" +
            "Можно прислать оба поля одним сообщением.",
        );
        return true;
    }

    if (action === "delete") {
        const callbackMessage = ctx.callbackQuery?.message;
        await ctx.answerCallbackQuery({ text: "Подтверди удаление" });
        if (callbackMessage) {
            const keyboard = new InlineKeyboard()
                .text("🗑 Да, удалить", `rt:delete-confirm:${task.id}`)
                .text("Не удалять", `rt:nav:${index}`);
            await editReplyMarkupIfChanged(ctx.api, callbackMessage, keyboard);
        }
        return true;
    }

    if (action === "delete-confirm") {
        const deleted = await RecurringTaskRepository.delete(task.id, ctx.chat!.id);
        await ctx.answerCallbackQuery({
            text: deleted ? "Задача удалена" : "Задача сейчас выполняется",
        });
        await editRecurringTasksMenu(ctx, index);
        return true;
    }

    await ctx.answerCallbackQuery();
    return true;
}
