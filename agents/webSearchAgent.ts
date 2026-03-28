import { MessageHistory } from "../types";
import { ProcessingResult } from "../orchestrator";
import { devLog, processMarkdownLinks } from "../utils";
import { getBotPersona, getCommunicationStyle } from "../persona";
import { config } from "../config";
import openai from "../openai";

interface WebSearchResult {
    success: boolean;
    results?: string;
    error?: string;
}

export async function webSearchAgent(
    message: string,
    isForwarded: boolean = false,
    forwardFrom: string = "",
    messageHistory: MessageHistory[] = [],
    memoryContext: string = ""
): Promise<ProcessingResult> {
    try {
        let historyContext = "";
        if (messageHistory.length > 0) {
            historyContext = "\nИстория переписки (от старых к новым):\n";
            messageHistory.forEach((item, index) => {
                historyContext += `${index + 1}. ${item.role === 'user' ? 'Пользователь' : 'Бот'}: ${item.content}\n`;
            });
        }

        const searchResponse = await performWebSearch(`${historyContext}${memoryContext}\n\nЗапрос пользователя: ${message}`);

        if (searchResponse.success && searchResponse.results) {
            devLog("Web search successful. Returning results.");
            return {
                responseText: searchResponse.results
            };
        } else {
            console.error("Web search failed:", searchResponse.error);

            const errorMessage = `Не удалось получить результаты поиска${searchResponse.error ? `: ${searchResponse.error}` : ""}. Попробуйте сформулировать запрос иначе.`;

            return {
                responseText: errorMessage
            };
        }
    } catch (error) {
        console.error("Error in webSearchAgent:", error);

        const errorMessage = "Произошла ошибка при поиске информации. Попробуйте позже.";
        return {
            responseText: errorMessage
        };
    }
}

/**
 * Альтернативная реализация веб-поиска с использованием API OpenAI
 * Реализует поиск через модель gpt-4o с доступом к интернету
 * @param query Поисковый запрос
 * @returns Результаты поиска или информация об ошибке
 */
async function performWebSearch(query: string): Promise<WebSearchResult> {
    try {
        const response = await openai.responses.create({
            model: "gpt-4.1",
            input: [
                {
                    role: "system",
                    content: [
                        {
                            type: "input_text",
                            text: `${getBotPersona()} Стиль общения: ${getCommunicationStyle()} Текущая дата: ${new Date().toLocaleString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', weekday: 'long' })}. При работе с информацией: - Подбирай наиболее полезную информацию. - Предупреждай, когда данные могут быть устаревшими или неточными. - Обобщай сведения из нескольких источников. Если информация не найдена, сообщи об этом и предложи альтернативы. Используй историю сообщений для контекста.`,
                        },
                    ],
                },
                {
                    role: "user",
                    content: [
                        {
                            type: "input_text",
                            text: query,
                        },
                    ],
                },
            ],
            text: {
                format: {
                    type: "text",
                },
            },
            reasoning: {},
            tools: [
                {
                    type: "web_search_preview",
                    user_location: {
                        type: "approximate",
                    },
                    search_context_size: "medium",
                },
            ],
            temperature: 1,
            max_output_tokens: 2048,
            top_p: 1,
            store: true,
        });

        devLog(response);

        if (response && response.output_text) {
            return {
                success: true,
                results: processMarkdownLinks(response.output_text),
            };
        } else {
            return {
                success: false,
                error: "Поиск не дал результатов. Попробуйте уточнить запрос.",
            };
        }
    } catch (error: any) {
        console.error("Error during web search with OpenAI:", error);
        return {
            success: false,
            error: `Произошла ошибка при выполнении поиска${error && error.message ? `: ${error.message}` : ""}.`,
        };
    }
}
