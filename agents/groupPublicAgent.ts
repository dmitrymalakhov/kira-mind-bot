/**
 * Group Public Agent
 *
 * Обрабатывает сообщения от не-владельцев в групповых чатах, когда включён GROUP_PUBLIC_MODE.
 *
 * Ограничения:
 * - Нет доступа к долговременной памяти (личные данные владельца не раскрываются)
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

type PublicIntent = "CONVERSATION" | "WEB_SEARCH" | "MAPS" | "IMAGE_GENERATION" | "CAPABILITIES";

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

export async function handleGroupPublicUserMessage(ctx: BotContext): Promise<void> {
    const message = ctx.message?.text || ctx.message?.caption || "";
    if (!message) return;

    try {
        await ctx.api.sendChatAction(ctx.chat!.id, "typing");

        const intent = await classifyPublicMessage(message);

        if (intent === "CAPABILITIES") {
            await ctx.reply(getCapabilitiesMessage());
            return;
        }

        if (intent === "IMAGE_GENERATION") {
            const result = await imageGenerationAgent(message, false, "", []);
            if (result.generatedImageUrl) {
                await ctx.replyWithPhoto(result.generatedImageUrl, {
                    caption: result.responseText || undefined,
                });
            } else {
                await ctx.reply(result.responseText || "Не удалось сгенерировать изображение.");
            }
            return;
        }

        if (intent === "MAPS") {
            const result = await mapsAgent(message, false, "", []);
            await ctx.reply(result.responseText || "Не удалось получить информацию о местоположении.");
            return;
        }

        if (intent === "WEB_SEARCH") {
            const result = await webSearchAgent(message, false, "", []);
            await ctx.reply(result.responseText || "Не удалось найти информацию.");
            return;
        }

        // CONVERSATION — прямой ответ без памяти
        await handlePublicConversation(ctx, message);
    } catch (error) {
        console.error("[group-public] error handling message:", error);
        await ctx.reply("Произошла ошибка при обработке запроса.");
    }
}

async function handlePublicConversation(ctx: BotContext, message: string): Promise<void> {
    const userName = ctx.from?.first_name || "Пользователь";

    const resp = await openai.chat.completions.create({
        model: "gpt-4.1",
        messages: [
            {
                role: "system",
                content:
                    `${getBotPersona()}\nБиография: ${getBotBiography()}\nСтиль: ${getCommunicationStyle()}\n\n` +
                    `ВАЖНО: Ты отвечаешь в публичном групповом чате. ` +
                    `Не раскрывай никакой личной информации о владельце (${config.ownerName}) и не обращайся к личным данным из памяти. ` +
                    `Отвечай на общие вопросы, будь дружелюбным и полезным. ` +
                    `Обращайся к пользователю по имени ${userName}.`,
            },
            {
                role: "user",
                content: message,
            },
        ],
        temperature: 0.8,
    });

    const reply = resp.choices[0]?.message?.content?.trim() || "Не смогла обработать запрос.";
    await ctx.reply(reply);
}
