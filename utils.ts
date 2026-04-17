import { MAX_MESSAGE_LENGTH } from "./constants";
import { BotContext } from "./types";

export const devLog = (...args: any[]) => {
    if (process.env.NODE_ENV === "development") {
        console.log(...args);
    }
};

/**
 * Отправляет пользователю короткое уведомление о прогрессе (typing + текст).
 * Ошибки при отправке глушатся, чтобы не ломать основной поток.
 */
export async function notifyUser(ctx: BotContext | any, text: string): Promise<void> {
    try {
        const chatId = ctx?.chat?.id;
        if (!chatId) return;
        await ctx.api.sendChatAction(chatId, 'typing');
        await ctx.reply(text);
    } catch (e) {
        devLog('notifyUser: failed to send progress', e);
    }
}

/**
 * Надёжный парсинг JSON из ответа LLM.
 *
 * Стратегия (от быстрой к медленной):
 * 1. JSON.parse(text) — если модель вернула чистый JSON
 * 2. Извлечение первого JSON-объекта через сбалансированный обход скобок
 * 3. Regex /\{[\s\S]*\}/ как последний резерв
 *
 * Возвращает распарсенный объект или null при неудаче.
 */
export function parseLLMJson<T = unknown>(text: string): T | null {
    const trimmed = text.trim();
    if (!trimmed) return null;

    // 1. Прямой парсинг
    try { return JSON.parse(trimmed) as T; } catch { /* fall through */ }

    // 2. Сбалансированный обход: находим первый { и идём до парной }
    const start = trimmed.indexOf('{');
    if (start !== -1) {
        let depth = 0;
        let inString = false;
        let escape = false;
        for (let i = start; i < trimmed.length; i++) {
            const ch = trimmed[i];
            if (escape) { escape = false; continue; }
            if (ch === '\\' && inString) { escape = true; continue; }
            if (ch === '"') { inString = !inString; continue; }
            if (inString) continue;
            if (ch === '{') depth++;
            else if (ch === '}') {
                depth--;
                if (depth === 0) {
                    try { return JSON.parse(trimmed.slice(start, i + 1)) as T; } catch { break; }
                }
            }
        }
    }

    // 3. Regex-резерв (жадный, как раньше)
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (match) {
        try { return JSON.parse(match[0]) as T; } catch { /* fall through */ }
    }

    return null;
}

/**
 * Обрабатывает и нормализует время для напоминаний,
 * обеспечивая корректное преобразование форматов и учёт временных зон
 * @param dateString Строка с датой в различных форматах
 * @param currentDate Текущая дата (по умолчанию - текущее время)
 * @returns ISO строка с корректным временем для напоминания
 */
export function processReminderTime(dateString: string, currentDate = new Date()): string {
    try {
        // Проверяем, что строка не пустая
        if (!dateString || dateString.trim() === '') {
            devLog("Empty date string, using fallback");
            const fallback = new Date(currentDate.getTime() + 30 * 60 * 1000);
            return fallback.toISOString();
        }

        // Проверяем валидность формата даты
        const date = new Date(dateString);

        if (isNaN(date.getTime())) {
            devLog(`Invalid date: "${dateString}", using fallback`);
            // Возвращаем текущее время + 30 минут для некорректных дат
            const fallback = new Date(currentDate.getTime() + 30 * 60 * 1000);
            return fallback.toISOString();
        }

        // Для отладки
        devLog(`Original date string: "${dateString}"`);
        devLog(`Parsed as UTC: ${date.toISOString()}`);

        // Проверяем, находится ли дата в прошлом
        if (date.getTime() < currentDate.getTime()) {
            devLog("Date was parsed as being in the past");

            // Если исходная строка содержит информацию о временной зоне
            if (dateString.includes('+') || dateString.includes('Z')) {
                // Извлекаем часы и минуты для сохранения указанного времени
                const timeMatch = dateString.match(/T(\d{2}):(\d{2})/);
                if (timeMatch) {
                    const hours = parseInt(timeMatch[1], 10);
                    const minutes = parseInt(timeMatch[2], 10);

                    devLog(`Extracted time components: ${hours}:${minutes}`);

                    // Создаем скорректированную дату с тем же временем, но сегодня
                    const adjusted = new Date(currentDate);
                    adjusted.setHours(hours, minutes, 0, 0);

                    // Если всё еще в прошлом, добавляем день
                    if (adjusted.getTime() < currentDate.getTime()) {
                        adjusted.setDate(adjusted.getDate() + 1);
                        devLog(`Still in past, added a day: ${adjusted.toISOString()}`);
                    } else {
                        devLog(`Adjusted to today: ${adjusted.toISOString()}`);
                    }

                    return adjusted.toISOString();
                }
            }

            // Запасной вариант: установить на 30 минут вперед
            const fallback = new Date(currentDate.getTime() + 30 * 60 * 1000);
            devLog(`Using +30 min fallback: ${fallback.toISOString()}`);
            return fallback.toISOString();
        }

        // Дата корректна и в будущем
        return date.toISOString();
    } catch (error) {
        console.error("Error processing reminder time:", error);
        // Возвращаем текущее время + 30 минут при ошибке
        const fallback = new Date(currentDate.getTime() + 30 * 60 * 1000);
        return fallback.toISOString();
    }
}

/**
 * Нормализует время напоминания, обрабатывая различные форматы и временные зоны.
 * Эта функция гарантирует, что напоминание всегда будет установлено на будущее время.
 * @param dateString Строка с датой в различных форматах
 * @returns Нормализованная ISO строка даты
 */
export function normalizeReminderTime(dateString: string): string {
    try {
        // Create a Date object from the input string
        const date = new Date(dateString);

        // Check if the date is valid
        if (isNaN(date.getTime())) {
            // Return current time + 30 minutes if invalid
            const fallbackDate = new Date();
            fallbackDate.setMinutes(fallbackDate.getMinutes() + 30);
            return fallbackDate.toISOString();
        }

        // If the date has timezone information (like +03:00)
        // and it's parsed as being in the past, add a day to ensure it's in the future
        const now = new Date();
        if (date < now) {
            devLog(`Input date ${date.toISOString()} was parsed as being in the past.`);
            devLog(`Original input: "${dateString}"`);

            // If the time includes timezone info but is in the past,
            // it's likely that we need to interpret it as a future time
            if (dateString.includes('+') || dateString.includes('Z')) {
                // Extract hours and minutes from the original string to preserve the intended time
                const timeMatch = dateString.match(/T(\d{2}):(\d{2})/);
                if (timeMatch) {
                    const hours = parseInt(timeMatch[1], 10);
                    const minutes = parseInt(timeMatch[2], 10);

                    // Set time to the intended hour/minute, but today
                    const adjustedDate = new Date();
                    adjustedDate.setHours(hours, minutes, 0, 0);

                    // If it's still in the past, add a day
                    if (adjustedDate < now) {
                        adjustedDate.setDate(adjustedDate.getDate() + 1);
                    }

                    devLog(`Adjusted to future time: ${adjustedDate.toISOString()}`);
                    return adjustedDate.toISOString();
                }
            }

            // Default fallback: set time to 30 minutes from now
            const fallbackDate = new Date();
            fallbackDate.setMinutes(fallbackDate.getMinutes() + 30);
            devLog(`Using fallback: ${fallbackDate.toISOString()}`);
            return fallbackDate.toISOString();
        }

        // Return ISO string if the date is valid and in the future
        return date.toISOString();
    } catch (error) {
        console.error("Error normalizing date:", error);
        // Return current time + 30 minutes in case of error
        const fallbackDate = new Date();
        fallbackDate.setMinutes(fallbackDate.getMinutes() + 30);
        return fallbackDate.toISOString();
    }
}

export function processMarkdownLinks(inputText: string): string {
    // Регулярное выражение для поиска ссылок в формате [текст](URL)
    const markdownLinkRegex = /\[.*?\]\((https?:\/\/[^\s)]+)\)/g;

    return inputText.replace(markdownLinkRegex, (match, url) => {
        // Создаем объект URL для удобной работы с адресом
        const urlObject = new URL(url);
        // Очищаем параметры запроса
        urlObject.search = '';
        // Возвращаем обновленный URL без текстовой метки и параметров запроса
        return urlObject.toString();
    });
}

/**
 * Проверяет, является ли пользователь ботом по его username
 * @param username Имя пользователя
 * @returns true если похоже на бота, иначе false
 */
export function isLikelyBot(username?: string): boolean {
    if (!username) return false;

    const lowercaseUsername = username.toLowerCase();
    return lowercaseUsername.endsWith('bot') ||
        lowercaseUsername.endsWith('_bot') ||
        lowercaseUsername.includes('бот') ||
        lowercaseUsername.includes('bot');
}

/**
 * Отправляет длинное сообщение, разбивая его на части при необходимости
 * 
 * @param ctx Контекст бота
 * @param text Текст сообщения для отправки
 * @param options Дополнительные опции для отправки (markdown, клавиатура и т.д.)
 * @returns Promise с результатом последней отправки
 */
export async function sendMessage(
    ctx: BotContext,
    text: string,
    options: any = {}
): Promise<any> {
    // Если сообщение короче максимальной длины, отправляем как обычно
    if (text.length <= MAX_MESSAGE_LENGTH) {
        return await ctx.reply(text, options);
    }

    // Разбиваем сообщение на части
    const parts = splitMessage(text);
    let result;

    // Отправляем каждую часть последовательно
    for (let i = 0; i < parts.length; i++) {
        const isLastPart = i === parts.length - 1;

        // Только для последней части используем переданные опции (клавиатуру и т.д.)
        if (isLastPart) {
            result = await ctx.reply(parts[i], options);
        } else {
            // Для всех частей, кроме последней, опции не используем
            result = await ctx.reply(parts[i]);
        }
    }

    return result;
}

/**
 * Разбивает длинное сообщение на части
 * 
 * @param text Текст для разбивки
 * @returns Массив частей сообщения
 */
function splitMessage(text: string): string[] {
    const parts: string[] = [];

    // Проверяем, нужно ли разбивать сообщение
    if (text.length <= MAX_MESSAGE_LENGTH) {
        return [text];
    }

    let remainingText = text;

    while (remainingText.length > 0) {
        // Если оставшийся текст короче или равен максимальной длине
        if (remainingText.length <= MAX_MESSAGE_LENGTH) {
            parts.push(remainingText);
            break;
        }

        // Ищем позицию для разбивки текста
        // Сначала пытаемся разбить по абзацам
        let splitPos = remainingText.lastIndexOf('\n\n', MAX_MESSAGE_LENGTH);

        // Если абзац не найден, пытаемся разбить по переносам строки
        if (splitPos === -1 || splitPos < MAX_MESSAGE_LENGTH / 2) {
            splitPos = remainingText.lastIndexOf('\n', MAX_MESSAGE_LENGTH);
        }

        // Если перенос строки не найден, пытаемся разбить по предложениям
        if (splitPos === -1 || splitPos < MAX_MESSAGE_LENGTH / 2) {
            const sentenceBreaks = ['. ', '! ', '? '];
            for (const sentenceBreak of sentenceBreaks) {
                const tempSplitPos = remainingText.lastIndexOf(sentenceBreak, MAX_MESSAGE_LENGTH);
                if (tempSplitPos !== -1 && tempSplitPos > MAX_MESSAGE_LENGTH / 2) {
                    splitPos = tempSplitPos + 1; // +1 чтобы включить пробел после знака
                    break;
                }
            }
        }

        // Если не удалось найти удобное место для разбивки, просто разбиваем по максимальной длине
        if (splitPos === -1 || splitPos < MAX_MESSAGE_LENGTH / 2) {
            splitPos = MAX_MESSAGE_LENGTH;
        }

        // Добавляем часть сообщения
        parts.push(remainingText.substring(0, splitPos));

        // Обновляем оставшийся текст
        remainingText = remainingText.substring(splitPos).trim();

        // Если осталось что-то вроде коротких разделителей в начале, убираем их
        remainingText = remainingText.replace(/^[\s.,;:!?]+/, '');
    }

    // Добавляем счетчик частей к каждой части
    return parts.map((part, index) =>
        `Часть ${index + 1}/${parts.length}\n\n${part}`
    );
}
