import { Bot } from "grammy";
import { config } from "../config";
import { USER_TIMEZONE } from "../constants";
import { createChatCompletionForTask } from "../ai/chatCompletion";
import { getBotPersona, getCommunicationStyle } from "../persona";
import { MessageStore, StoredMessage } from "../stores/MessageStore";
import { BotContext } from "../types";
import { parseLLMJson } from "../utils";
import { getProactiveChatId } from "../utils/allowedUserChatStore";
import { getActiveBotProfile } from "../utils/botIdentity";
import { getSetting, setSetting } from "./botSettingsService";
import { esc, heading, paragraph, footer, RichBlock, sendStructured, checklist } from "../utils/richMessage";

const CHECK_INTERVAL_MS = 60_000;
const MAX_THREADS_PER_RUN = 30;
const MAX_MESSAGES_PER_THREAD = 12;
const LAST_RUN_SETTING_KEY = `${getActiveBotProfile()}:inboxGuardian:lastRunDate`;

export interface InboxThreadCandidate {
    chatId: string;
    senderName: string;
    senderUsername?: string;
    lastIncomingAt: Date;
    lastOwnAt?: Date;
    latestAt: Date;
    messages: StoredMessage[];
}

type InboxGuardianSignalType = "request" | "commitment" | "plan_change" | "decision" | "conflict" | "emotional" | "relationship";

export interface InboxGuardianLLMItem {
    chatId?: string;
    observation?: string;
    whyImportant?: string;
    kiraView?: string;
    suggestedAction?: string;
    sourceMessageIds?: number[];
    signalType?: string;
    urgency?: "high" | "normal" | "low";
    confidence?: number;
}

export interface InboxGuardianLLMResponse {
    items?: InboxGuardianLLMItem[];
}

export interface InboxGuardianItem {
    chatId: string;
    senderName: string;
    senderUsername?: string;
    lastIncomingAt: Date;
    observation: string;
    whyImportant: string;
    kiraView: string;
    suggestedAction: string;
    sourceMessageIds: number[];
    signalType: InboxGuardianSignalType;
    urgency: "high" | "normal" | "low";
    confidence: number;
}

let timer: NodeJS.Timeout | undefined;
let isRunning = false;
let daytimeWindowStartedAt = Date.now();
let daytimeAttemptsThisHour = 0;
let daytimeSentThisHour = 0;

// AI-budget: at most six grounded analyses and two actual messages per hour.
const DAYTIME_MAX_ATTEMPTS_PER_HOUR = 6;
const DAYTIME_MAX_SENT_PER_HOUR = 2;

function getZonedParts(date: Date): { year: string; month: string; day: string; hour: number; minute: number } {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: USER_TIMEZONE,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
    }).formatToParts(date);

    const get = (type: string) => parts.find(part => part.type === type)?.value || "00";
    return {
        year: get("year"),
        month: get("month"),
        day: get("day"),
        hour: Number(get("hour")),
        minute: Number(get("minute")),
    };
}

function todayDateKey(now = new Date()): string {
    const parts = getZonedParts(now);
    return `${parts.year}-${parts.month}-${parts.day}`;
}

function formatLocalDateTime(date: Date): string {
    return date.toLocaleString("ru-RU", {
        timeZone: USER_TIMEZONE,
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
    });
}

function truncate(text: string, maxLength: number): string {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (normalized.length <= maxLength) return normalized;
    return `${normalized.slice(0, maxLength)}...`;
}

function lastWhere<T>(items: T[], predicate: (item: T) => boolean): T | undefined {
    for (let i = items.length - 1; i >= 0; i--) {
        if (predicate(items[i])) return items[i];
    }
    return undefined;
}

function selectThreadCandidates(now: Date): InboxThreadCandidate[] {
    const minAgeMs = config.inboxGuardianMinAgeMinutes * 60_000;
    const recentThreads = MessageStore.getInstance().getRecentMessageThreads(config.inboxGuardianLookbackHours);

    return recentThreads
        .map((thread): InboxThreadCandidate | null => {
            const messages = thread.messages
                .filter(message => message.text?.trim())
                .sort((a, b) => a.date.getTime() - b.date.getTime());
            const lastIncoming = lastWhere(messages, message => !message.isOwn);
            if (!lastIncoming || messages.length === 0) return null;

            const latest = messages[messages.length - 1];
            const lastOwn = lastWhere(messages, message => Boolean(message.isOwn));
            const incomingAgeMs = now.getTime() - lastIncoming.date.getTime();

            if (!latest.isOwn && incomingAgeMs < minAgeMs) {
                return null;
            }

            const candidate: InboxThreadCandidate = {
                chatId: thread.chatId,
                senderName: lastIncoming.senderName,
                lastIncomingAt: lastIncoming.date,
                latestAt: latest.date,
                messages: messages.slice(-MAX_MESSAGES_PER_THREAD),
            };
            if (lastIncoming.senderUsername) {
                candidate.senderUsername = lastIncoming.senderUsername;
            }
            if (lastOwn?.date) {
                candidate.lastOwnAt = lastOwn.date;
            }
            return candidate;
        })
        .filter((candidate): candidate is InboxThreadCandidate => Boolean(candidate))
        .sort((a, b) => b.lastIncomingAt.getTime() - a.lastIncomingAt.getTime())
        .slice(0, MAX_THREADS_PER_RUN);
}

function formatThreadForPrompt(thread: InboxThreadCandidate, index: number): string {
    const username = thread.senderUsername ? ` @${thread.senderUsername}` : "";
    const lastOwn = thread.lastOwnAt ? formatLocalDateTime(thread.lastOwnAt) : "нет";
    const lines = thread.messages.map(message => {
        const author = message.isOwn ? "Я" : thread.senderName;
        return `[${formatLocalDateTime(message.date)}] ${author}: ${truncate(message.text || "[без текста]", 500)}`;
    });

    return [
        `Диалог ${index + 1}`,
        `chatId: ${thread.chatId}`,
        `контакт: ${thread.senderName}${username}`,
        `последнее входящее: ${formatLocalDateTime(thread.lastIncomingAt)}`,
        `последнее исходящее владельца: ${lastOwn}`,
        `последние сообщения:`,
        ...lines,
    ].join("\n");
}

function buildGuardianPrompt(
    threads: InboxThreadCandidate[],
    options: { daytime?: boolean; focusMessageIds?: Set<number> } = {},
): string {
    const context = threads.map(formatThreadForPrompt).join("\n\n---\n\n");
    const mode = options.daytime
        ? "Ты фильтр своевременной дневной рефлексии персонального Telegram-ассистента."
        : "Ты вечерний Inbox Guardian персонального Telegram-ассистента.";
    const focus = options.focusMessageIds?.size
        ? `\nАнализируй новый входящий фрагмент с message ID: ${[...options.focusMessageIds].join(", ")}. Каждый выбранный пункт обязан ссылаться хотя бы на один из этих ID и описывать сигнал собеседника, а не исходящую реплику владельца.`
        : "";
    return `${mode}

Владелец: ${config.ownerName}.
Текущая дата: ${formatLocalDateTime(new Date())}, часовой пояс: ${USER_TIMEZONE}.

Ниже личные диалоги за последние ${config.inboxGuardianLookbackHours} часов.

Твоя задача: выбрать ${options.daytime ? "не более одного срочного или своевременного" : "максимум три действительно важных"} наблюдения. Подходят незакрытая просьба или обязательство, изменение плана, важное решение, конфликт, либо заметный эмоциональный/отношенческий сигнал.${focus}

Правила:
- Если владелец уже ответил и вопрос выглядит закрытым, НЕ включай диалог.
- Если владелец ответил "сделаю позже", "скину завтра", "уточню", "посмотрю" и действие ещё не выполнено в видимом контексте — включи.
- Если это просто информация, small talk, благодарность, реакция, уведомление или вопрос уже решён — НЕ включай.
- Сам факт, что сообщение не прочитано, НЕ является причиной включения: этим занимается отдельный unread-report.
- Если не уверен, НЕ включай. Нужны только сильно незакрытые вопросы.
- Не выдумывай факты и не добавляй диалоги, которых нет в списке.
- sourceMessageIds должен содержать 1-5 реальных ID сообщений из выбранного диалога.
- signalType обязан описывать содержательный сигнал; тип "unread" запрещён.
- observation — что именно произошло без домыслов; whyImportant — почему это важно владельцу.
- kiraView — короткая личная позиция Киры, допускающая несогласие, но не выдающая догадку за факт.
- suggestedAction — ровно один практичный следующий шаг.

Верни только JSON:
{
  "items": [
    {
      "chatId": "строго один из chatId выше",
      "observation": "что произошло",
      "whyImportant": "почему это важно",
      "kiraView": "личная позиция Киры",
      "suggestedAction": "один следующий шаг",
      "sourceMessageIds": [123],
      "signalType": "request|commitment|plan_change|decision|conflict|emotional|relationship",
      "urgency": "high|normal|low",
      "confidence": 0.0
    }
  ]
}

Диалоги:

${context}`;
}

export function normalizeLLMItems(
    response: InboxGuardianLLMResponse | null,
    threads: InboxThreadCandidate[],
    options: { maxItems?: number; minConfidence?: number; requiredSourceMessageIds?: Set<number> } = {},
): InboxGuardianItem[] {
    const byChatId = new Map(threads.map(thread => [thread.chatId, thread]));
    const seen = new Set<string>();
    const items: InboxGuardianItem[] = [];

    for (const raw of response?.items ?? []) {
        const chatId = String(raw.chatId || "");
        const thread = byChatId.get(chatId);
        if (!thread || seen.has(chatId)) continue;

        const confidence = typeof raw.confidence === "number" ? raw.confidence : 0;
        if (confidence < (options.minConfidence ?? 0.7)) continue;

        const allowedSignalTypes: InboxGuardianSignalType[] = [
            "request", "commitment", "plan_change", "decision", "conflict", "emotional", "relationship",
        ];
        if (!raw.signalType || !allowedSignalTypes.includes(raw.signalType as InboxGuardianSignalType)) continue;
        const signalType = raw.signalType as InboxGuardianSignalType;

        const validIds = new Set(thread.messages.map(message => message.id));
        const sourceMessageIds = Array.from(new Set(raw.sourceMessageIds ?? []))
            .filter(id => Number.isInteger(id) && validIds.has(id))
            .slice(0, 5);
        if (options.requiredSourceMessageIds?.size && !sourceMessageIds.some(id => options.requiredSourceMessageIds!.has(id))) continue;
        const observation = truncate(String(raw.observation || "").trim(), 240);
        const whyImportant = truncate(String(raw.whyImportant || "").trim(), 220);
        const kiraView = truncate(String(raw.kiraView || "").trim(), 240);
        const suggestedAction = truncate(String(raw.suggestedAction || "").trim(), 200);
        if (!sourceMessageIds.length || !observation || !whyImportant || !kiraView || !suggestedAction) continue;

        const urgency = raw.urgency === "high" || raw.urgency === "low" ? raw.urgency : "normal";
        items.push({
            chatId,
            senderName: thread.senderName,
            senderUsername: thread.senderUsername,
            lastIncomingAt: thread.lastIncomingAt,
            observation,
            whyImportant,
            kiraView,
            suggestedAction,
            sourceMessageIds,
            signalType,
            urgency,
            confidence,
        });
        seen.add(chatId);
    }

    return items.sort((a, b) => {
        const urgencyRank = { high: 3, normal: 2, low: 1 };
        const byUrgency = urgencyRank[b.urgency] - urgencyRank[a.urgency];
        if (byUrgency !== 0) return byUrgency;
        return b.lastIncomingAt.getTime() - a.lastIncomingAt.getTime();
    }).slice(0, options.maxItems ?? 3);
}

async function analyzeThreads(
    threads: InboxThreadCandidate[],
    options: { daytime?: boolean; maxItems?: number; minConfidence?: number; requiredSourceMessageIds?: Set<number> } = {},
): Promise<InboxGuardianItem[]> {
    if (threads.length === 0) return [];

    try {
        const response = await createChatCompletionForTask('memoryExtraction', {
            messages: [
                {
                    role: "system",
                    content: `${getBotPersona()}\nСтиль: ${getCommunicationStyle()}\nТы строгий фильтр важных наблюдений в личных переписках. Отвечай только валидным JSON.`,
                },
                {
                    role: "user",
                    content: buildGuardianPrompt(threads, {
                        daytime: options.daytime,
                        focusMessageIds: options.requiredSourceMessageIds,
                    }),
                },
            ],
            temperature: 0.2,
            response_format: { type: "json_object" },
        });

        const parsed = parseLLMJson<InboxGuardianLLMResponse>(response.choices[0]?.message?.content || "");
        return normalizeLLMItems(parsed, threads, options);
    } catch (error) {
        console.error("[inbox-guardian] LLM analysis failed; suppressing report:", error);
        return [];
    }
}

function inProactiveQuietHours(now: Date): boolean {
    if (!config.kiraLifeProactiveQuietHoursEnabled) return false;
    const hour = getZonedParts(now).hour;
    const start = config.kiraLifeProactiveQuietHourStart;
    const end = config.kiraLifeProactiveQuietHourEnd;
    if (start === end) return true;
    return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

function reserveDaytimeAttempt(): boolean {
    const now = Date.now();
    if (now - daytimeWindowStartedAt >= 60 * 60_000) {
        daytimeWindowStartedAt = now;
        daytimeAttemptsThisHour = 0;
        daytimeSentThisHour = 0;
    }
    if (daytimeAttemptsThisHour >= DAYTIME_MAX_ATTEMPTS_PER_HOUR || daytimeSentThisHour >= DAYTIME_MAX_SENT_PER_HOUR) return false;
    daytimeAttemptsThisHour += 1;
    return true;
}

export function selectDaytimeContext(
    messages: StoredMessage[],
    focusIds: Set<number>,
): StoredMessage[] {
    const textual = messages.filter(message => message.text?.trim());
    const newest = textual.slice(0, MAX_MESSAGES_PER_THREAD);
    const selectedIds = new Set(newest.map(message => message.id));
    const focusedOutsideWindow = textual.filter(message => focusIds.has(message.id) && !selectedIds.has(message.id));

    return [...newest, ...focusedOutsideWindow]
        .sort((a, b) => a.date.getTime() - b.date.getTime());
}

export function selectIncomingDaytimeFocusIds(
    messages: StoredMessage[],
    currentMessageIds: number[],
): Set<number> {
    const requestedIds = new Set(currentMessageIds.filter(Number.isInteger));
    return new Set(
        messages
            .filter(message => !message.isOwn && requestedIds.has(message.id))
            .map(message => message.id),
    );
}

export async function sendDaytimeReflection(
    bot: Bot<BotContext>,
    input: { chatId: string; currentMessageIds: number[] },
): Promise<boolean> {
    if (
        getActiveBotProfile() !== "KiraMindBot"
        || !config.daytimeReflectionEnabled
        || inProactiveQuietHours(new Date())
    ) return false;
    const storedMessages = MessageStore.getInstance().getMessages(input.chatId);
    const focusIds = selectIncomingDaytimeFocusIds(storedMessages, input.currentMessageIds);
    if (focusIds.size === 0) return false;

    const messages = selectDaytimeContext(
        storedMessages,
        focusIds,
    );
    const lastIncoming = lastWhere(messages, message => !message.isOwn);
    if (!lastIncoming || messages.length === 0) return false;
    if (!reserveDaytimeAttempt()) return false;
    const lastOwn = lastWhere(messages, message => Boolean(message.isOwn));
    const candidate: InboxThreadCandidate = {
        chatId: input.chatId,
        senderName: lastIncoming.senderName,
        senderUsername: lastIncoming.senderUsername,
        lastIncomingAt: lastIncoming.date,
        lastOwnAt: lastOwn?.date,
        latestAt: messages[messages.length - 1].date,
        messages,
    };
    const items = await analyzeThreads([candidate], {
        daytime: true,
        maxItems: 1,
        minConfidence: 0.82,
        requiredSourceMessageIds: focusIds,
    });
    const item = items[0];
    if (!item) return false;

    const username = item.senderUsername ? ` (@${esc(item.senderUsername)})` : "";
    await sendStructured(bot.api as any, await getProactiveChatId(), [
        heading("💭 Что я заметила", 3),
        paragraph(`<b>${esc(item.senderName)}${username}</b><br/><i>Что произошло:</i> ${esc(item.observation)}`),
        paragraph(`<i>Почему это важно:</i> ${esc(item.whyImportant)}<br/><i>Моё мнение:</i> ${esc(item.kiraView)}<br/><i>Следующий шаг:</i> ${esc(item.suggestedAction)}`),
    ]);
    daytimeSentThisHour += 1;
    console.info(`[daytime-reflection] sent grounded observation for chat ${input.chatId}`);
    return true;
}

function buildGuardianReportBlocks(items: InboxGuardianItem[]): RichBlock[] {
    const urgencyLabel: Record<InboxGuardianItem["urgency"], string> = {
        high: "🔴 срочно",
        normal: "обычно",
        low: "не срочно",
    };

    const tailsWord = items.length === 1 ? "незакрытый хвост" : items.length < 5 ? "незакрытых хвоста" : "незакрытых хвостов";

    const blocks: RichBlock[] = [
        heading("🛡️ Вечерний Inbox Guardian", 3),
        paragraph(`За день вижу <b>${items.length}</b> ${tailsWord} по сообщениям:`),
    ];

    const checkItems = items.map((item) => {
        const username = item.senderUsername ? ` (@${esc(item.senderUsername)})` : "";
        const header = `${esc(item.senderName)}${username} · ${esc(formatLocalDateTime(item.lastIncomingAt))} · ${urgencyLabel[item.urgency]}`;
        const observation = `<i>Что вижу:</i> ${esc(item.observation)}`;
        const importance = `\n<i>Почему важно:</i> ${esc(item.whyImportant)}`;
        const view = `\n<i>Моё мнение:</i> ${esc(item.kiraView)}`;
        const action = `\n<i>Что сделать:</i> ${esc(item.suggestedAction)}`;
        // checklist-пункт с чекбоксом: пользователь может мысленно отметить сделанное.
        return { text: `<b>${header}</b>\n${observation}${importance}${view}${action}` };
    });
    blocks.push(checklist(checkItems));
    blocks.push(footer("Отметь чекбоксы у того, что уже закрыл — визуально удобнее."));

    return blocks;
}

async function runGuardian(bot: Bot<BotContext>): Promise<void> {
    if (isRunning) return;
    isRunning = true;

    try {
        const dateKey = todayDateKey();
        const lastRunDate = await getSetting(LAST_RUN_SETTING_KEY, "");
        if (lastRunDate === dateKey) return;

        const now = new Date();
        const threads = selectThreadCandidates(now);
        const items = await analyzeThreads(threads);

        if (items.length > 0) {
            const chatId = await getProactiveChatId();
            const blocks = buildGuardianReportBlocks(items);
            await sendStructured(bot.api as any, chatId, blocks);
            console.info(`[inbox-guardian] sent ${items.length} unresolved item(s)`);
        } else {
            console.info("[inbox-guardian] no unresolved inbox items");
        }

        await setSetting(LAST_RUN_SETTING_KEY, dateKey);
    } catch (error) {
        console.error("[inbox-guardian] cycle failed:", error);
    } finally {
        isRunning = false;
    }
}

export function startInboxGuardianScheduler(bot: Bot<BotContext>): void {
    if (getActiveBotProfile() !== "KiraMindBot") {
        return;
    }

    if (!config.inboxGuardianEnabled) {
        return;
    }

    if (timer) clearInterval(timer);

    const checkAndRun = () => {
        const now = new Date();
        const parts = getZonedParts(now);
        if (parts.hour === config.inboxGuardianHour && parts.minute < 5) {
            runGuardian(bot).catch(e => console.error("[inbox-guardian] failed:", e));
        }
    };

    timer = setInterval(checkAndRun, CHECK_INTERVAL_MS);
    checkAndRun();

    console.info(`[inbox-guardian] scheduler started, fires at ${config.inboxGuardianHour}:00 ${USER_TIMEZONE}`);
}
