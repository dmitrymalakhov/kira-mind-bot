import * as dotenv from "dotenv";
import { devLog } from "../utils";
import openai from "../openai";

dotenv.config({ path: `.env.${process.env.NODE_ENV}` });


export interface ReactionDecision {
    reply?: string;
    botReaction?: string;
}

export async function reactionAgent(userReaction: string, botMessage: string): Promise<ReactionDecision> {
    try {
        const prompt = `Пользователь поставил реакцию "${userReaction}" на мое сообщение "${botMessage}".\n` +
            `Нужно решить, стоит ли ответить ему текстом и нужно ли поставить ответную реакцию на его сообщение.\n` +
            `Ответ верни строго в JSON формате {"reply":"текст или пустая строка","botReaction":"эмодзи или пустая строка"}`;

        const response = await openai.chat.completions.create({
            model: "gpt-5-nano",
            messages: [{ role: "user", content: prompt }],
            temperature: 0.7,
        });

        const aiResponse = response.choices[0]?.message?.content || "";
        devLog("Reaction agent response:", aiResponse);
        const match = aiResponse.match(/\{[\s\S]*\}/);
        if (match) {
            return JSON.parse(match[0]);
        }
    } catch (err) {
        console.error("Error in reaction agent:", err);
    }
    return {};
}

