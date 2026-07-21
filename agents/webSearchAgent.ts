import { MessageHistory } from "../types";
import { ProcessingResult } from "../orchestrator";
import { devLog, processMarkdownLinks } from "../utils";
import { getBotPersona, getCommunicationStyle } from "../persona";
import { createResponseForTask } from "../ai/responseCompletion";
import { formatDateInTimeZone } from "../utils/time";
import { buildSafeAiErrorLog } from "../ai/errorDiagnostics";
import { USER_TIMEZONE } from "../constants";

interface WebSearchResult {
    success: boolean;
    results?: string;
    error?: string;
}

export interface WebSearchProcessingResult extends ProcessingResult {
    webSearchSucceeded: boolean;
}

const WEB_SEARCH_UNAVAILABLE_MESSAGE = "Поиск сейчас временно недоступен. Попробуйте ещё раз чуть позже.";

export function buildWebSearchSystemPrompt(): string {
    return `${getBotPersona()} Стиль общения: ${getCommunicationStyle()} Текущая дата: ${formatDateInTimeZone(new Date(), { day: 'numeric', month: 'long', year: 'numeric', weekday: 'long' })}. Часовой пояс пользователя: ${USER_TIMEZONE}. При работе с информацией: - Подбирай наиболее полезную информацию. - Предупреждай, когда данные могут быть устаревшими или неточными. - Обобщай сведения из нескольких источников. Если информация не найдена, сообщи об этом и предложи альтернативы. Используй историю сообщений для контекста.

Если запрос про афишу, расписание, ближайшие игры, квизы, мероприятия, билеты, запись или регистрацию: ищи актуальные официальные страницы и страницы агрегаторов, укажи ближайшие даты/время/места/стоимость и прямые ссылки на регистрацию, если они доступны. Не подменяй такой запрос поиском заведений на карте. В конце коротко предложи следующий шаг: помочь выбрать игру или открыть запись/регистрацию, но не утверждай, что пользователь уже записан без явной просьбы и подтверждения.

Для любого запроса об актуальном внешнем мире сначала определи все запрошенные аспекты: текущее состояние, последние изменения, даты и расписание, результаты, цены и наличие, правила и ограничения, должности или источники. Покрой каждый релевантный аспект, а не только первый найденный факт. Предпочитай первичные и официальные источники, сверяй дату публикации с датой самого события и сохраняй прямые ссылки.

Все зависящие от времени данные — матчи, мероприятия, транспорт, эфиры, релизы, дедлайны и часы работы — приводи к часовому поясу ${USER_TIMEZONE} и явно его подписывай. Проверенные факты отделяй от расписания, результатов и собственных выводов. Личную память используй только для персонализации запроса, но никогда не вместо актуальных внешних данных.`;
}

export async function webSearchAgent(
    message: string,
    isForwarded: boolean = false,
    forwardFrom: string = "",
    messageHistory: MessageHistory[] = [],
    memoryContext: string = ""
): Promise<WebSearchProcessingResult> {
    try {
        let historyContext = "";
        if (messageHistory.length > 0) {
            historyContext = "\nИстория переписки (от старых к новым):\n";
            messageHistory.forEach((item, index) => {
                historyContext += `${index + 1}. ${item.role === 'user' ? 'Пользователь' : 'Бот'}: ${item.content}\n`;
            });
        }

        const memoryBlock = memoryContext ? `\nКонтекст из долговременной памяти (используй для уточнения поискового запроса):\n${memoryContext}\n` : '';
        const searchResponse = await performWebSearch(`${historyContext}${memoryBlock}\n\nЗапрос пользователя: ${message}`);

        if (searchResponse.success && searchResponse.results) {
            devLog("Web search successful. Returning results.");
            return {
                responseText: searchResponse.results,
                webSearchSucceeded: true,
            };
        } else {
            return {
                responseText: WEB_SEARCH_UNAVAILABLE_MESSAGE,
                webSearchSucceeded: false,
            };
        }
    } catch (error) {
        console.error("Unexpected webSearchAgent failure:", buildSafeAiErrorLog(error));

        const errorMessage = "Произошла ошибка при поиске информации. Попробуйте позже.";
        return {
            responseText: errorMessage,
            webSearchSucceeded: false,
        };
    }
}

/**
 * Выполняет provider-aware веб-поиск через task routing активного AI preset-а.
 * @param query Поисковый запрос
 * @returns Результаты поиска или информация об ошибке
 */
async function performWebSearch(query: string): Promise<WebSearchResult> {
    try {
        const response = await createResponseForTask('webSearchReasoning', {
            input: [
                {
                    role: "system",
                    content: [
                        {
                            type: "input_text",
                            text: buildWebSearchSystemPrompt(),
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
        console.error("Web search providers failed:", buildSafeAiErrorLog(error));
        return {
            success: false,
            error: "provider_unavailable",
        };
    }
}
