import { MessageHistory } from "../types";
import { ProcessingResult } from "../orchestrator";
import { devLog, processMarkdownLinks } from "../utils";
import { getBotPersona, getCommunicationStyle } from "../persona";
import { createResponseForTask } from "../ai/responseCompletion";
import { formatDateInTimeZone } from "../utils/time";
import { buildSafeAiErrorLog } from "../ai/errorDiagnostics";
import { USER_TIMEZONE } from "../constants";

export interface WebSearchResult {
    success: boolean;
    results?: string;
    error?: string;
}

export interface WebSearchProcessingResult extends ProcessingResult {
    webSearchSucceeded: boolean;
}

const WEB_SEARCH_UNAVAILABLE_MESSAGE = "Поиск сейчас временно недоступен. Попробуйте ещё раз чуть позже.";
const NEWS_DIGEST_REQUEST_RE = /(?:новост|новостн\w*\s+(?:сводк|подборк)|дайджест)/iu;
const NEWS_META_ONLY_RE = /(?:собрал[аи]?|подготовил[аи]?|наш[её]л|сформировал[аи]?)[\s\S]{0,100}(?:сводк|подборк|новост)[\s\S]{0,160}(?:если\s+хочешь|могу\s+(?:прислать|развернуть|рассказать|добавить)|потом\s+могу)/iu;

function countMatches(text: string, pattern: RegExp): number {
    return Array.from(text.matchAll(pattern)).length;
}

export function isNewsDigestRequest(text: string): boolean {
    return NEWS_DIGEST_REQUEST_RE.test(text);
}

export function newsDigestQualityScore(text: string): number {
    const normalized = text.trim();
    if (!normalized) return 0;

    const urlCount = countMatches(normalized, /https?:\/\/\S+/giu);
    const numberedItemCount = countMatches(normalized, /^\s*\d{1,2}[\.)]\s+\S+/gmu);
    const bulletItemCount = countMatches(normalized, /^\s*[-•]\s+\S+/gmu);
    const datedItemCount = countMatches(
        normalized,
        /(?:\b\d{1,2}[./-]\d{1,2}(?:[./-]\d{2,4})?\b|\b\d{1,2}\s+(?:январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентябр|октябр|ноябр|декабр)\w*)/giu,
    );
    const structureScore = Math.min(numberedItemCount + bulletItemCount, 8) * 18;
    const sourceScore = Math.min(urlCount, 6) * 22;
    const dateScore = Math.min(datedItemCount, 6) * 6;
    const lengthScore = Math.min(normalized.length, 1_600) / 20;
    const metaPenalty = NEWS_META_ONLY_RE.test(normalized) ? 100 : 0;

    return structureScore + sourceScore + dateScore + lengthScore - metaPenalty;
}

export function hasSubstantiveNewsDigest(text: string): boolean {
    const normalized = text.trim();
    if (normalized.length < 280 || NEWS_META_ONLY_RE.test(normalized)) return false;

    const urlCount = countMatches(normalized, /https?:\/\/\S+/giu);
    const itemCount =
        countMatches(normalized, /^\s*\d{1,2}[\.)]\s+\S+/gmu) +
        countMatches(normalized, /^\s*[-•]\s+\S+/gmu);
    return urlCount >= 2 || itemCount >= 3;
}

function stripPlainTextNewsMarkdown(text: string): string {
    return text
        .replace(/\*\*([^*\n]+)\*\*/gu, "$1")
        .replace(/^#{1,6}\s+/gmu, "")
        .trim();
}

export function selectNewsDigestResponse(
    requestContext: string,
    webSearchText: string,
    conversationText: string,
): string {
    if (!isNewsDigestRequest(requestContext)) return conversationText;

    const webIsSubstantive = hasSubstantiveNewsDigest(webSearchText);
    const conversationIsSubstantive = hasSubstantiveNewsDigest(conversationText);
    const webScore = newsDigestQualityScore(webSearchText);
    const conversationScore = newsDigestQualityScore(conversationText);

    if (webIsSubstantive && (!conversationIsSubstantive || webScore > conversationScore + 12)) {
        return stripPlainTextNewsMarkdown(webSearchText);
    }
    if (conversationIsSubstantive) {
        return stripPlainTextNewsMarkdown(conversationText);
    }
    return stripPlainTextNewsMarkdown(webScore > conversationScore ? webSearchText : conversationText);
}

export function buildWebSearchSystemPrompt(): string {
    return `${getBotPersona()} Стиль общения: ${getCommunicationStyle()} Текущая дата: ${formatDateInTimeZone(new Date(), { day: 'numeric', month: 'long', year: 'numeric', weekday: 'long' })}. Часовой пояс пользователя: ${USER_TIMEZONE}. При работе с информацией: - Подбирай наиболее полезную информацию. - Предупреждай, когда данные могут быть устаревшими или неточными. - Обобщай сведения из нескольких источников. Если информация не найдена, сообщи об этом и предложи альтернативы. Используй историю сообщений для контекста.

Если пользователь просит новости, новостную сводку, подборку или дайджест: выдай саму подборку сразу — обычно 5–10 конкретных пунктов. Для каждого пункта укажи, что произошло, дату события или публикации, почему это важно и прямую ссылку на источник. Не отвечай фразами «собрала подборку», «могу прислать подробнее» или перечнем общих тем без самих новостей. Если надёжных пунктов меньше, честно покажи столько, сколько удалось проверить.

Если запрос про афишу, расписание, ближайшие игры, квизы, мероприятия, билеты, запись или регистрацию: ищи актуальные официальные страницы и страницы агрегаторов, укажи ближайшие даты/время/места/стоимость и прямые ссылки на регистрацию, если они доступны. Не подменяй такой запрос поиском заведений на карте. В конце коротко предложи следующий шаг: помочь выбрать игру или открыть запись/регистрацию, но не утверждай, что пользователь уже записан без явной просьбы и подтверждения.

Для любого запроса об актуальном внешнем мире сначала определи все запрошенные аспекты: текущее состояние, последние изменения, даты и расписание, результаты, цены и наличие, правила и ограничения, должности или источники. Покрой каждый релевантный аспект, а не только первый найденный факт. Предпочитай первичные и официальные источники, сверяй дату публикации с датой самого события и сохраняй прямые ссылки.

Все зависящие от времени данные — матчи, мероприятия, транспорт, эфиры, релизы, дедлайны и часы работы — приводи к часовому поясу ${USER_TIMEZONE} и явно его подписывай. Проверенные факты отделяй от расписания, результатов и собственных выводов. Личную память используй только для персонализации запроса, но никогда не вместо актуальных внешних данных.

Отвечай обычным текстом для Telegram: не используй Markdown-выделение звёздочками. Нумерованные списки и полные URL допустимы.`;
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
export async function performWebSearch(query: string): Promise<WebSearchResult> {
    try {
        const requestSearch = (searchQuery: string) => createResponseForTask('webSearchReasoning', {
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
                            text: searchQuery,
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

        let response = await requestSearch(query);
        if (
            response?.output_text &&
            isNewsDigestRequest(query) &&
            !hasSubstantiveNewsDigest(response.output_text)
        ) {
            try {
                const retried = await requestSearch([
                    query,
                    "",
                    "Предыдущий вариант был недостаточно содержательным.",
                    "Верни саму проверенную новостную сводку: минимум 5 конкретных новостей, если они доступны.",
                    "Для каждой новости нужны событие, дата, значение и прямая ссылка на источник.",
                    "Не пиши вступление о том, что подборка собрана, без самих пунктов.",
                ].join("\n"));
                if (
                    retried?.output_text &&
                    newsDigestQualityScore(retried.output_text) > newsDigestQualityScore(response.output_text)
                ) {
                    response = retried;
                }
            } catch (retryError) {
                console.warn("Weak news digest retry failed:", buildSafeAiErrorLog(retryError));
            }
        }

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
