import { OpenAI } from "openai";
import { config } from "./config";

// Centralized OpenAI client to reuse a single instance across the project
export const openai = new OpenAI({
    apiKey: config.openAiApiKey || process.env.OPENAI_API_KEY,
});

export default openai;
