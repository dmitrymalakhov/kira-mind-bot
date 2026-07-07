import { Bot } from "grammy";
import { config } from "../config";
import { USER_TIMEZONE } from "../constants";
import { createChatCompletionForTask } from "../ai/chatCompletion";
import { MessageStore, StoredMessage } from "../stores/MessageStore";
import { BotContext } from "../types";
import { parseLLMJson } from "../utils";
import { getProactiveChatId } from "../utils/allowedUserChatStore";
import { getActiveBotProfile } from "../utils/botIdentity";
import { getSetting, setSetting } from "./botSettingsService";
import { esc, heading, paragraph, blockquote, footer, RichBlock, sendStructured, checklist } from "../utils/richMessage";

const CHECK_INTERVAL_MS = 60_000;
const MAX_THREADS_PER_RUN = 30;
const MAX_MESSAGES_PER_THREAD = 12;
const LAST_RUN_SETTING_KEY = `${getActiveBotProfile()}:inboxGuardian:lastRunDate`;

interface InboxThreadCandidate {
    chatId: string;
    senderName: string;
    senderUsername?: string;
    lastIncomingAt: Date;
    lastOwnAt?: Date;
    latestAt: Date;
    messages: StoredMessage[];
}

interface InboxGuardianLLMItem {
    chatId?: string;
    whyOpen?: string;
    suggestedAction?: string;
    urgency?: "high" | "normal" | "low";
    confidence?: number;
}

interface InboxGuardianLLMResponse {
    items?: InboxGuardianLLMItem[];
}

interface InboxGuardianItem {
    chatId: string;
    senderName: string;
    senderUsername?: string;
    lastIncomingAt: Date;
    whyOpen: string;
    suggestedAction?: string;
    urgency: "high" | "normal" | "low";
    confidence: number;
}

let timer: NodeJS.Timeout | undefined;
let isRunning = false;

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

function buildGuardianPrompt(threads: InboxThreadCandidate[]): string {
    const context = threads.map(formatThreadForPrompt).join("\n\n---\n\n");
    return `Ты вечерний Inbox Guardian персонального Telegram-ассистента.

Владелец: ${config.ownerName}.
Текущая дата: ${formatLocalDateTime(new Date())}, часовой пояс: ${USER_TIMEZONE}.

Ниже личные диалоги за последние ${config.inboxGuardianLookbackHours} часов.

Твоя задача: выбрать только те диалоги, где у владельца явно остался незакрытый вопрос, просьба, обещание или ожидаемое действие.

Правила:
- Если владелец уже ответил и вопрос выглядит закрытым, НЕ включай диалог.
- Если владелец ответил "сделаю позже", "скину завтра", "уточню", "посмотрю" и действие ещё не выполнено в видимом контексте — включи.
- Если это просто информация, small talk, благодарность, реакция, уведомление или вопрос уже решён — НЕ включай.
- Если не уверен, НЕ включай. Нужны только сильно незакрытые вопросы.
- Не выдумывай факты и не добавляй диалоги, которых нет в списке.
- В whyOpen объясни конкретно, что осталось незакрытым.
- В suggestedAction напиши коротко, что владельцу лучше сделать.

Верни только JSON:
{
  "items": [
    {
      "chatId": "строго один из chatId выше",
      "whyOpen": "что осталось незакрытым",
      "suggestedAction": "короткое действие",
      "urgency": "high|normal|low",
      "confidence": 0.0
    }
  ]
}

Диалоги:

${context}`;
}

function looksActionable(text: string): boolean {
    return /(\?|можешь|сможешь|надо|нужно|пришл|скин|ответ|жду|когда|что думаешь|подтверди|посмотри|соглас|оплат|договор|созвон|напомн|please|can you|could you|send|need|waiting)/i
        .test(text);
}

function fallbackAnalyzeThreads(threads: InboxThreadCandidate[]): InboxGuardianItem[] {
    return threads
        .map((thread): InboxGuardianItem | null => {
            const latest = thread.messages[thread.messages.length - 1];
            if (!latest || latest.isOwn || !looksActionable(latest.text || "")) return null;
            const item: InboxGuardianItem = {
                chatId: thread.chatId,
                senderName: thread.senderName,
                lastIncomingAt: thread.lastIncomingAt,
                whyOpen: truncate(latest.text || "Последнее сообщение похоже на вопрос или просьбу.", 180),
                suggestedAction: "Проверить диалог и ответить, если вопрос ещё актуален.",
                urgency: "normal" as const,
                confidence: 0.68,
            };
            if (thread.senderUsername) {
                item.senderUsername = thread.senderUsername;
            }
            return item;
        })
        .filter((item): item is InboxGuardianItem => Boolean(item));
}

function normalizeLLMItems(
    response: InboxGuardianLLMResponse | null,
    threads: InboxThreadCandidate[]
): InboxGuardianItem[] {
    const byChatId = new Map(threads.map(thread => [thread.chatId, thread]));
    const seen = new Set<string>();
    const items: InboxGuardianItem[] = [];

    for (const raw of response?.items ?? []) {
        const chatId = String(raw.chatId || "");
        const thread = byChatId.get(chatId);
        if (!thread || seen.has(chatId)) continue;

        const confidence = typeof raw.confidence === "number" ? raw.confidence : 0;
        if (confidence < 0.65) continue;

        const whyOpen = truncate(String(raw.whyOpen || "").trim(), 260);
        if (!whyOpen) continue;

        const urgency = raw.urgency === "high" || raw.urgency === "low" ? raw.urgency : "normal";
        items.push({
            chatId,
            senderName: thread.senderName,
            senderUsername: thread.senderUsername,
            lastIncomingAt: thread.lastIncomingAt,
            whyOpen,
            suggestedAction: truncate(String(raw.suggestedAction || "").trim(), 220),
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
    });
}

async function analyzeThreads(threads: InboxThreadCandidate[]): Promise<InboxGuardianItem[]> {
    if (threads.length === 0) return [];

    try {
        const response = await createChatCompletionForTask('memoryExtraction', {
            messages: [
                {
                    role: "system",
                    content: "Ты строгий фильтр незакрытых вопросов в личных переписках. Отвечай только валидным JSON.",
                },
                {
                    role: "user",
                    content: buildGuardianPrompt(threads),
                },
            ],
            temperature: 0.2,
            response_format: { type: "json_object" },
        });

        const parsed = parseLLMJson<InboxGuardianLLMResponse>(response.choices[0]?.message?.content || "");
        return normalizeLLMItems(parsed, threads);
    } catch (error) {
        console.error("[inbox-guardian] LLM analysis failed, using fallback:", error);
        return fallbackAnalyzeThreads(threads);
    }
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
        const whyOpen = `Что висит: ${esc(item.whyOpen)}`;
        const action = item.suggestedAction ? `\nЧто сделать: ${esc(item.suggestedAction)}` : "";
        // checklist-пункт с чекбоксом: пользователь может мысленно отметить сделанное.
        return { text: `<b>${header}</b>\n${blockquote(whyOpen + action)}` };
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
