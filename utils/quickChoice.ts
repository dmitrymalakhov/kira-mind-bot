import { InlineKeyboard } from "grammy";
import type { BotContext } from "../types";
import type { MessageClassification } from "../orchestrator";

const CALLBACK_PREFIX = "qch";
const QUICK_CHOICE_TTL_MS = 10 * 60 * 1000;
const MAX_CHOICES = 4;
const MAX_LABEL_LENGTH = 54;

const INTENT_BUTTON_LABELS: Partial<Record<MessageClassification["intent"], string>> = {
    "НАПОМИНАНИЕ": "Да, поставь напоминание",
    "РАЗГОВОР": "Давай просто обсудим",
    "ГЕНЕРАЦИЯ_ИЗОБРАЖЕНИЯ": "Да, создай изображение",
    "КАРТЫ_ЛОКАЦИИ": "Да, найди на карте",
    "ПРОВЕРКА_СООБЩЕНИЙ": "Да, проверь сообщения",
    "ВЕБ_ПОИСК": "Да, найди в интернете",
    "ОТПРАВКА_СООБЩЕНИЯ": "Да, подготовь сообщение",
    "ДЕЛЕГИРОВАНИЕ_ЗАДАЧИ": "Да, договорись с контактом",
    "ВОЗМОЖНОСТИ_БОТА": "Да, покажи возможности",
    "БРАУЗЕР_ЗАДАЧА": "Да, сделай через браузер",
};

const INTENT_PROMPTS: Partial<Record<MessageClassification["intent"], string>> = {
    "НАПОМИНАНИЕ": "Поставь напоминание по исходному запросу",
    "РАЗГОВОР": "Давай просто обсудим исходный запрос",
    "ГЕНЕРАЦИЯ_ИЗОБРАЖЕНИЯ": "Создай изображение по исходному запросу",
    "КАРТЫ_ЛОКАЦИИ": "Найди место или маршрут по исходному запросу",
    "ПРОВЕРКА_СООБЩЕНИЙ": "Проверь сообщения по исходному запросу",
    "ВЕБ_ПОИСК": "Найди актуальную информацию в интернете по исходному запросу",
    "ОТПРАВКА_СООБЩЕНИЯ": "Подготовь или отправь сообщение по исходному запросу",
    "ДЕЛЕГИРОВАНИЕ_ЗАДАЧИ": "Самостоятельно договорись с контактом по исходному запросу",
    "ВОЗМОЖНОСТИ_БОТА": "Расскажи о возможностях бота по исходному запросу",
    "БРАУЗЕР_ЗАДАЧА": "Выполни исходный запрос через браузер",
};

type QuickChoice = {
    label: string;
    message: string;
};

export function isQuickChoiceCallback(callbackData: string): boolean {
    return callbackData.startsWith(`${CALLBACK_PREFIX}:`);
}

export function buildQuickChoiceKeyboard(
    ctx: BotContext,
    originalMessage: string,
    responseText: string,
    classification: MessageClassification
): InlineKeyboard | undefined {
    const choices = extractChoicesFromResponse(originalMessage, responseText);
    const fallbackChoices = choices.length >= 2 ? choices : buildChoicesFromIntents(originalMessage, classification);
    const usefulChoices = fallbackChoices.slice(0, MAX_CHOICES);
    if (usefulChoices.length < 2) return undefined;

    const id = makeChoiceId();
    const now = Date.now();
    pruneExpiredQuickChoices(ctx, now);
    if (!ctx.session.pendingQuickChoices) ctx.session.pendingQuickChoices = {};
    ctx.session.pendingQuickChoices[id] = {
        originalMessage,
        choices: usefulChoices,
        createdAt: now,
        expiresAt: now + QUICK_CHOICE_TTL_MS,
    };

    const keyboard = new InlineKeyboard();
    usefulChoices.forEach((choice, index) => {
        keyboard.text(choice.label, `${CALLBACK_PREFIX}:${id}:${index}`);
        if (index < usefulChoices.length - 1) keyboard.row();
    });
    return keyboard;
}

export function consumeQuickChoice(
    ctx: BotContext,
    callbackData: string
): { originalMessage: string; choice: QuickChoice } | null {
    if (!isQuickChoiceCallback(callbackData)) return null;
    const [, id, indexRaw] = callbackData.split(":");
    const index = Number(indexRaw);
    if (!id || !Number.isInteger(index)) return null;

    pruneExpiredQuickChoices(ctx);
    const pending = ctx.session.pendingQuickChoices?.[id];
    if (!pending) return null;

    const choice = pending.choices[index];
    delete ctx.session.pendingQuickChoices![id];
    if (Object.keys(ctx.session.pendingQuickChoices!).length === 0) {
        ctx.session.pendingQuickChoices = undefined;
    }

    if (!choice) return null;
    return {
        originalMessage: pending.originalMessage,
        choice,
    };
}

function extractChoicesFromResponse(originalMessage: string, responseText: string): QuickChoice[] {
    const lines = responseText.split(/\r?\n/);
    const options: string[] = [];
    let currentIndex = -1;

    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;

        const match = line.match(/^(\d{1,2})[\.)]\s+(.+)$/u);
        if (match) {
            const optionNumber = Number(match[1]);
            if (optionNumber < 1 || optionNumber > 9) continue;
            options.push(match[2].trim());
            currentIndex = options.length - 1;
            continue;
        }

        if (currentIndex >= 0 && !/^[А-ЯA-ZЁ]/u.test(line)) {
            options[currentIndex] = `${options[currentIndex]} ${line}`;
        }
    }

    return options
        .map((option, index) => option.replace(/[;.]$/u, "").trim())
        .filter((option) => option.length > 0)
        .slice(0, MAX_CHOICES)
        .map((option, index) => ({
            label: compactLabel(toUserAnswerLabel(option)),
            message: [
                `${toUserAnswerLabel(option)}.`,
                `Выбранный вариант ${index + 1}: ${option}.`,
                `Исходный запрос: ${originalMessage}`,
            ].join("\n"),
        }));
}

function toUserAnswerLabel(option: string): string {
    const normalized = option.replace(/\s+/g, " ").trim();
    const lower = normalized.toLowerCase();

    if ((/ска(?:жу|жи)/u.test(lower) || /подскаж/u.test(lower)) && /как\s+.*организ/u.test(lower)) {
        return "Да, подскажи как лучше";
    }
    if (/без\s+постановк[иуы]\s+напомин/u.test(lower) || /прикин/u.test(lower) || /выбр(?:ать|ем)\s+время/u.test(lower)) {
        return "Давай сначала выберем время";
    }
    if (/напомин/u.test(lower)) {
        return "Да, напомни мне об этом";
    }
    if (/изображен/u.test(lower)) {
        return "Да, создай изображение";
    }
    if (/(?:карт|маршрут|адрес|мест[оа])/u.test(lower)) {
        return "Да, найди на карте";
    }
    if (/(?:интернет|поищ|найд[иуы]|поиск)/u.test(lower)) {
        return "Да, найди в интернете";
    }
    if (/сообщени/u.test(lower) && /(?:провер|прочит|анализ)/u.test(lower)) {
        return "Да, проверь сообщения";
    }
    if (/сообщени/u.test(lower) && /(?:подготов|отправ)/u.test(lower)) {
        return "Да, подготовь сообщение";
    }
    if (/договор/u.test(lower)) {
        return "Да, договорись";
    }
    if (/(?:браузер|сайт)/u.test(lower)) {
        return "Да, сделай через браузер";
    }

    return fallbackUserAnswerLabel(normalized);
}

function fallbackUserAnswerLabel(option: string): string {
    let label = option
        .replace(/^если\s+хочешь,?\s*/iu, "")
        .replace(/^я\s+сразу\s+оформлю\s+/iu, "Оформи ")
        .replace(/^я\s+оформлю\s+/iu, "Оформи ")
        .replace(/^я\s+коротко\s+скажу\s+/iu, "Скажи ")
        .replace(/^я\s+скажу\s+/iu, "Скажи ")
        .replace(/^можем\s+/iu, "Давай ")
        .replace(/\bтебе\b/giu, "мне")
        .replace(/\bтвой\b/giu, "мой")
        .replace(/\bтвоя\b/giu, "моя")
        .replace(/\bтвое\b/giu, "мое")
        .replace(/\bтвоё\b/giu, "моё")
        .replace(/\bтвои\b/giu, "мои")
        .trim();

    if (label.includes(":")) {
        label = label.split(":")[0].trim();
    }

    if (!/^(?:да|давай|хочу|нужно|лучше|можно|ок|сначала|просто|оформи|скажи|напомни|поставь|подскажи|обсудим)(?:\s|,|$)/iu.test(label)) {
        label = `Да, ${lowercaseFirst(label)}`;
    }

    return uppercaseFirst(label);
}

function lowercaseFirst(text: string): string {
    return text ? text[0].toLocaleLowerCase("ru-RU") + text.slice(1) : text;
}

function uppercaseFirst(text: string): string {
    return text ? text[0].toLocaleUpperCase("ru-RU") + text.slice(1) : text;
}

function buildChoicesFromIntents(
    originalMessage: string,
    classification: MessageClassification
): QuickChoice[] {
    const seen = new Set<MessageClassification["intent"]>();
    return (classification.intentScores ?? [])
        .filter((candidate) => candidate.intent !== "НЕОПРЕДЕЛЕНО")
        .filter((candidate) => {
            if (seen.has(candidate.intent)) return false;
            seen.add(candidate.intent);
            return true;
        })
        .slice(0, MAX_CHOICES)
        .map((candidate) => {
            const label = INTENT_BUTTON_LABELS[candidate.intent] ?? candidate.intent;
            const prompt = INTENT_PROMPTS[candidate.intent] ?? label;
            return {
                label: compactLabel(label),
                message: `${prompt}: ${originalMessage}`,
            };
        });
}

function compactLabel(label: string): string {
    const singleLine = label.replace(/\s+/g, " ").trim();
    if (singleLine.length <= MAX_LABEL_LENGTH) return singleLine;
    return `${singleLine.slice(0, MAX_LABEL_LENGTH - 1).trimEnd()}…`;
}

function makeChoiceId(): string {
    const timePart = Date.now().toString(36).slice(-6);
    const randomPart = Math.random().toString(36).slice(2, 6);
    return `${timePart}${randomPart}`;
}

function pruneExpiredQuickChoices(ctx: BotContext, now = Date.now()) {
    const pending = ctx.session.pendingQuickChoices;
    if (!pending) return;

    for (const [id, quickChoice] of Object.entries(pending)) {
        if (quickChoice.expiresAt <= now) {
            delete pending[id];
        }
    }

    if (Object.keys(pending).length === 0) {
        ctx.session.pendingQuickChoices = undefined;
    }
}
