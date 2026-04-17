/**
 * Group Public Agent
 *
 * Обрабатывает сообщения от не-владельцев в групповых чатах, когда включён GROUP_PUBLIC_MODE.
 *
 * Ограничения:
 * - Доступ к долговременной памяти только по явно разрешённым доменам (allowedDomains чата)
 * - Недоступны: readMessages, sendMessage, negotiateOnBehalf, reminder
 * - Доступны: conversation, webSearch, maps, imageGeneration, capabilities
 */

import { BotContext } from "../types";
import { config } from "../config";
import { getBotPersona, getCommunicationStyle, getBotBiography } from "../persona";
import { webSearchAgent } from "./webSearchAgent";
import { mapsAgent } from "./googleMapsAgent";
import { imageGenerationAgent } from "./imageGenerationAgent";
import { getCapabilitiesMessage } from "../capabilities";
import openai from "../openai";
import { parseLLMJson } from "../utils";
import { searchMemories } from "../utils/enhancedDomainMemory";
import { getChatAllowedDomains, getChatForbiddenTopics } from "../services/chatRegistry";

type PublicIntent = "CONVERSATION" | "WEB_SEARCH" | "MAPS" | "IMAGE_GENERATION" | "CAPABILITIES";

// ── Группoвая история диалогов (in-memory, per chatId) ───────────────────────
interface GroupHistoryEntry {
    userName: string;
    userMessage: string;
    botResponse: string;
}

const MAX_GROUP_HISTORY = 10;
const groupChatHistory = new Map<number, GroupHistoryEntry[]>();

function getGroupHistory(chatId: number): GroupHistoryEntry[] {
    return groupChatHistory.get(chatId) ?? [];
}

function pushGroupHistory(chatId: number, entry: GroupHistoryEntry): void {
    const history = groupChatHistory.get(chatId) ?? [];
    history.push(entry);
    if (history.length > MAX_GROUP_HISTORY) history.shift();
    groupChatHistory.set(chatId, history);
}

async function classifyPublicMessage(message: string): Promise<PublicIntent> {
    try {
        const resp = await openai.chat.completions.create({
            model: "gpt-5-nano",
            messages: [
                {
                    role: "system",
                    content: "Classify the user message into exactly one intent. Reply with JSON only: {\"intent\": \"...\"}. Intents: CONVERSATION, WEB_SEARCH, MAPS, IMAGE_GENERATION, CAPABILITIES.",
                },
                {
                    role: "user",
                    content: `Message: "${message}"\n\nRules:\n- WEB_SEARCH: user asks to find/search info online, news, facts\n- MAPS: routes, addresses, places, navigation\n- IMAGE_GENERATION: draw/generate/create image/picture\n- CAPABILITIES: asks what the bot can do, its features\n- CONVERSATION: everything else (questions, chat, advice, etc.)`,
                },
            ],
            temperature: 1,
        });
        const text = resp.choices[0]?.message?.content?.trim() || "";
        const parsed = parseLLMJson<{ intent?: string }>(text);
        const intent = parsed?.intent?.toUpperCase() as PublicIntent;
        const allowed: PublicIntent[] = ["CONVERSATION", "WEB_SEARCH", "MAPS", "IMAGE_GENERATION", "CAPABILITIES"];
        return allowed.includes(intent) ? intent : "CONVERSATION";
    } catch {
        return "CONVERSATION";
    }
}

async function buildMemoryContext(ctx: BotContext, message: string, allowedDomains: string[]): Promise<string> {
    if (allowedDomains.length === 0) return '';

    // Сообщение уже нормализовано (@никнейм → имя владельца) до вызова этой функции.
    // Ищем память от имени владельца (все воспоминания хранятся под его userId).
    const ownerUserId = String(config.allowedUserId);

    const results: string[] = [];
    for (const domain of allowedDomains) {
        const found = await searchMemories(ctx, message, { domain, limit: 3 }, ownerUserId);
        for (const r of found) {
            results.push(`[${domain}] ${r.content}`);
        }
    }

    if (results.length === 0) return '';
    return '\n\nКонтекст из памяти (только публично доступные домены):\n' + results.join('\n');
}

/** Заменяет @ownerUsername на имя владельца во всём тексте — до классификации и поиска */
function normalizeOwnerMention(text: string): string {
    if (!config.ownerUsername) return text;
    const re = new RegExp(`@${config.ownerUsername}`, 'gi');
    return text.replace(re, config.ownerName);
}

export async function handleGroupPublicUserMessage(ctx: BotContext): Promise<void> {
    const raw = ctx.message?.text || ctx.message?.caption || "";
    if (!raw) return;

    // Нормализуем @никнейм владельца до любой обработки
    const message = normalizeOwnerMention(raw);

    const chatId = ctx.chat!.id;
    const userName = ctx.from?.first_name || "Пользователь";

    try {
        await ctx.api.sendChatAction(chatId, "typing");

        const intent = await classifyPublicMessage(message);

        if (intent === "CAPABILITIES") {
            await ctx.reply(getCapabilitiesMessage());
            return;
        }

        if (intent === "IMAGE_GENERATION") {
            const result = await imageGenerationAgent(message, false, "", []);
            let replyText: string;
            if (result.generatedImageUrl) {
                await ctx.replyWithPhoto(result.generatedImageUrl, {
                    caption: result.responseText || undefined,
                });
                replyText = result.responseText || "[изображение]";
            } else {
                replyText = result.responseText || "Не удалось сгенерировать изображение.";
                await ctx.reply(replyText);
            }
            pushGroupHistory(chatId, { userName, userMessage: message, botResponse: replyText });
            return;
        }

        if (intent === "MAPS") {
            const result = await mapsAgent(message, false, "", []);
            const replyText = result.responseText || "Не удалось получить информацию о местоположении.";
            await ctx.reply(replyText);
            pushGroupHistory(chatId, { userName, userMessage: message, botResponse: replyText });
            return;
        }

        if (intent === "WEB_SEARCH") {
            const result = await webSearchAgent(message, false, "", []);
            const replyText = result.responseText || "Не удалось найти информацию.";
            await ctx.reply(replyText);
            pushGroupHistory(chatId, { userName, userMessage: message, botResponse: replyText });
            return;
        }

        // CONVERSATION — с историей чата, контекстом памяти и запрещёнными темами
        const [allowedDomains, forbiddenTopics] = await Promise.all([
            getChatAllowedDomains(chatId),
            getChatForbiddenTopics(chatId),
        ]);
        const history = getGroupHistory(chatId);
        await handlePublicConversation(ctx, message, userName, allowedDomains, forbiddenTopics, history);
    } catch (error) {
        console.error("[group-public] error handling message:", error);
        await ctx.reply("Произошла ошибка при обработке запроса.");
    }
}

async function handlePublicConversation(
    ctx: BotContext,
    message: string,
    userName: string,
    allowedDomains: string[],
    forbiddenTopics: string,
    history: GroupHistoryEntry[],
): Promise<void> {
    const chatId = ctx.chat!.id;
    const memoryContext = await buildMemoryContext(ctx, message, allowedDomains);

    const forbiddenBlock = forbiddenTopics.trim()
        ? `\n\nЗАПРЕЩЁННЫЕ ТЕМЫ: Следующие темы полностью запрещены к обсуждению. Если пользователь поднимает любую из них — вежливо откажи и не продолжай тему:\n${forbiddenTopics.trim()}`
        : '';

    const ownerRef = config.ownerUsername
        ? `${config.ownerName} (никнейм @${config.ownerUsername})`
        : config.ownerName;

    const systemContent =
        // Персонаж без owner-specific части (getBotPersona содержит "Твой пользователь — Дмитрий" и ломает контекст)
        `Ты — ${config.characterName}. ${getBotBiography()}\nСтиль общения: ${getCommunicationStyle()}\n\n` +
        // Контекст публичного чата
        `Ты отвечаешь в публичном групповом чате.\n` +
        `Сейчас с тобой общается пользователь по имени ${userName}. Обращайся к нему ТОЛЬКО как "${userName}".\n` +
        `Владелец бота — ${ownerRef} — сейчас НЕ пишет. Не путай собеседника с владельцем.\n` +
        `Если спрашивают о владельце (${ownerRef}) — отвечай строго по данным из памяти ниже. Нет данных — скажи что не знаешь.\n` +
        `Отвечай дружелюбно и по делу.` +
        forbiddenBlock +
        memoryContext;

    // Формируем историю предыдущих обменов как messages[]
    const historyMessages: { role: "user" | "assistant"; content: string }[] = [];
    for (const entry of history) {
        historyMessages.push({ role: "user", content: `[${entry.userName}]: ${entry.userMessage}` });
        historyMessages.push({ role: "assistant", content: entry.botResponse });
    }

    const resp = await openai.chat.completions.create({
        model: "gpt-5.4",
        messages: [
            { role: "system", content: systemContent },
            ...historyMessages,
            { role: "user", content: `[${userName}]: ${message}` },
        ],
        temperature: 0.8,
    });

    const reply = resp.choices[0]?.message?.content?.trim() || "Не смогла обработать запрос.";
    await ctx.reply(reply);
    pushGroupHistory(chatId, { userName, userMessage: message, botResponse: reply });
}
