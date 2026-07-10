import { Bot } from "grammy";
import { BotContext } from "../types";
import { devLog } from "../utils";
import { addToHistory } from "../utils/history";
import { reactionAgent } from "../agents/reactionAgent";
import {
    ALLOWED_REACTIONS,
    REACTIONS_ENABLED,
} from "./shared";

// ── Регистрация обработчика реакций ────────────────────────

export function registerReactionHandler(bot: Bot<BotContext>): void {
    bot.on("message_reaction", async (ctx) => {
        try {
            devLog('😊 Получена реакция от пользователя:', ctx.from?.id);
            if (!ctx.session.isAllowedUser) return;

            const info = ctx.reactions();
            if (info.emojiAdded.length === 0) return;

            const added = info.emojiAdded[0];
            const reactedText = ctx.session.sentMessages?.[ctx.messageReaction.message_id] || "";

            const decision = await reactionAgent(added, reactedText);

            if (decision.reply) {
                await ctx.reply(decision.reply, { reply_to_message_id: ctx.messageReaction.message_id });
                await addToHistory(ctx, 'bot', decision.reply);
            }

            if (decision.botReaction && REACTIONS_ENABLED) {
                if (ALLOWED_REACTIONS.includes(decision.botReaction)) {
                    await ctx.react(decision.botReaction as any).catch(e => {
                        if (process.env.NODE_ENV === "development") {
                            console.error("Failed to react in message_reaction handler:", e.message);
                        }
                    });
                }
            }
        } catch (error) {
            console.error("Ошибка при обработке реакции:", error);
        }
    });
}
