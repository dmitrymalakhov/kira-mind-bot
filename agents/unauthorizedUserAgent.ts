import { BotContext, MessageHistory, UnauthorizedChatState } from "../types";
import { summarizeDialogue } from "../services/dialogueSummarizer";
import { isUserInContacts } from "../services/telegram";
import { devLog } from "../utils";
import { getBotPersona, getCommunicationStyle } from "../persona";
import { config } from "../config";
import openai from "../openai";


// Максимальное количество вопросов от бота
const MAX_BOT_QUESTIONS = 2;

/**
 * Функция для обработки сообщений от неавторизованных пользователей
 * @param ctx Контекст бота
 * @returns Promise<void>
 */
export async function handleUnauthorizedUserMessage(ctx: BotContext): Promise<void> {
    if (!ctx || !ctx.chat) {
        console.error("Контекст или чат не определены.");
        return;
    }

    try {
        // Инициализация информации о чате с неавторизованным пользователем
        if (!ctx.session.unauthorizedChat) {
            devLog("Создание новой информации о чате с неавторизованным пользователем");
            ctx.session.unauthorizedChat = {
                chatId: ctx.chat.id,
                username: ctx.from?.username || '',
                firstName: ctx.from?.first_name || 'Неизвестный пользователь',
                lastName: ctx.from?.last_name || '',
                messages: [],
                state: UnauthorizedChatState.Initial,
                lastInteractionTime: new Date(),
                context: '',
                questionCount: 0,
                timeoutUntil: null,
                timeoutMessageSent: false,
                isInContacts: false
            };

            // Проверяем, находится ли пользователь в контактах
            if (ctx.from) {
                ctx.session.unauthorizedChat.isInContacts = await isUserInContacts(ctx.from.id);
                devLog(`Пользователь ${ctx.from.id} ${ctx.session.unauthorizedChat.isInContacts ? 'найден' : 'не найден'} в контактах`);
            }
        }

        // Проверяем, находится ли пользователь в режиме тайм-аута
        if (ctx.session.unauthorizedChat.timeoutUntil) {
            const currentTime = new Date();
            const timeoutUntil = new Date(ctx.session.unauthorizedChat.timeoutUntil);

            if (currentTime < timeoutUntil) {
                // Если текущее время меньше времени окончания тайм-аута, не отвечаем
                devLog(`Пользователь в режиме тайм-аута до ${timeoutUntil.toLocaleString()}`);

                // Вычисляем оставшееся время тайм-аута в минутах
                const remainingMinutes = Math.ceil((timeoutUntil.getTime() - currentTime.getTime()) / (60 * 1000));

                // Отправляем сообщение только в первый раз, если пользователь пишет в режиме тайм-аута
                if (!ctx.session.unauthorizedChat.timeoutMessageSent) {
                    await ctx.reply(`Ваше обращение передано руководителю. Пожалуйста, ожидайте ответа. Вы сможете отправить новое обращение через ${remainingMinutes} мин.`);
                    ctx.session.unauthorizedChat.timeoutMessageSent = true;
                }
                return;
            } else {
                // Если тайм-аут истек, сбрасываем его и timeoutMessageSent
                ctx.session.unauthorizedChat.timeoutUntil = null;
                ctx.session.unauthorizedChat.timeoutMessageSent = false;
                // Сбрасываем состояние диалога, т.к. пользователь может начать новый диалог
                ctx.session.unauthorizedChat.state = UnauthorizedChatState.Initial;
                ctx.session.unauthorizedChat.questionCount = 0;
                ctx.session.unauthorizedChat.messages = [];
                devLog("Тайм-аут истек, разрешаем новый диалог");
            }
        }

        // Если получено сообщение от пользователя
        if (ctx.message && 'text' in ctx.message) {
            const messageText = ctx.message.text || '';

            // Проверка на таймаут (если прошло более 30 минут, сбрасываем диалог)
            const currentTime = new Date();
            const lastTime = ctx.session.unauthorizedChat.lastInteractionTime;
            const timeDifference = currentTime.getTime() - lastTime.getTime();
            const minutesDifference = timeDifference / (1000 * 60);

            if (minutesDifference > 30 && ctx.session.unauthorizedChat.state !== UnauthorizedChatState.Completed) {
                ctx.session.unauthorizedChat.context = '';
                ctx.session.unauthorizedChat.state = UnauthorizedChatState.Initial;
                ctx.session.unauthorizedChat.questionCount = 0;
                ctx.session.unauthorizedChat.messages = [];
                devLog("Сессия сброшена из-за неактивности (30+ минут)");
            }

            // Обновляем время последнего взаимодействия
            ctx.session.unauthorizedChat.lastInteractionTime = currentTime;

            // Сохраняем сообщение пользователя в истории
            ctx.session.unauthorizedChat.messages.push({
                role: 'user',
                content: messageText,
                timestamp: new Date()
            });

            // Проверяем, было ли уже завершено общение
            if (ctx.session.unauthorizedChat.state === UnauthorizedChatState.Completed) {
                devLog("Диалог уже был завершен ранее, но пользователь продолжает писать");

                // Сообщаем пользователю, что обращение уже передано
                const ownerGender = config.ownerName === "Юлия" ? "она" : "он";
                await ctx.reply(`Ваше обращение уже передано ${config.ownerName === "Юлия" ? "руководительнице" : "руководителю"}. ${ownerGender === "она" ? "Она" : "Он"} свяжется с вами в ближайшее время.`);
                return;
            }

            // Проверяем, находится ли пользователь в контактах
            if (ctx.session.unauthorizedChat.isInContacts) {
                // Для пользователей из контактов - используем диалоговый режим с уточняющими вопросами

                // Проверяем наличие контактной информации или запрос на завершение
                if (isCompletionRequest(messageText) || containsContactInfo(messageText)) {
                    devLog("Обнаружен запрос на завершение или контактная информация");
                    await finalizeConversation(ctx);
                    return;
                }

                // Проверяем, выполнены ли условия для завершения диалога
                if (ctx.session.unauthorizedChat.questionCount >= MAX_BOT_QUESTIONS &&
                    ctx.session.unauthorizedChat.messages.length >= (MAX_BOT_QUESTIONS * 2 + 1)) {
                    devLog(`Получен ответ на последний вопрос, завершаем диалог`);
                    await finalizeConversation(ctx);
                    return;
                }

                // Отправляем индикатор печати
                await ctx.api.sendChatAction(ctx.chat.id, "typing");

                // Генерируем ответ в зависимости от номера вопроса
                let response = "";
                if (ctx.session.unauthorizedChat.questionCount === 0) {
                    response = await generateFirstQuestion(ctx);
                    ctx.session.unauthorizedChat.state = UnauthorizedChatState.Question1;
                } else if (ctx.session.unauthorizedChat.questionCount === 1) {
                    response = await generateSecondQuestion(ctx);
                    ctx.session.unauthorizedChat.state = UnauthorizedChatState.Question2;
                }

                // Увеличиваем счетчик вопросов
                ctx.session.unauthorizedChat.questionCount = ctx.session.unauthorizedChat.questionCount + 1;
                devLog(`Отправлен вопрос ${ctx.session.unauthorizedChat.questionCount} из ${MAX_BOT_QUESTIONS}`);

                // Сохраняем ответ бота в истории
                ctx.session.unauthorizedChat.messages.push({
                    role: 'bot',
                    content: response,
                    timestamp: new Date()
                });

                // Отправляем ответ пользователю
                await ctx.reply(response);
                // Блок кода для пользователей НЕ из контактов
            } else {
                // Для пользователей НЕ из контактов - ждем второе сообщение или таймаут
                devLog("Пользователь не в контактах, обрабатываем сообщение");

                // Если это первое сообщение пользователя
                if (ctx.session.unauthorizedChat.messages.length === 1) {
                    // Статическое сообщение для пользователей не из контактов
                    const staticResponse = `Спасибо за ваше обращение. Пожалуйста, укажите ваш вопрос в течение 3 минут. Информация будет передана ${config.ownerName === "Юлия" ? "руководительнице" : "руководителю"}, и ${config.ownerName === "Юлия" ? "она" : "он"} свяжется с вами в ближайшее время.`;

                    // Сохраняем ответ бота в истории
                    ctx.session.unauthorizedChat.messages.push({
                        role: 'bot',
                        content: staticResponse,
                        timestamp: new Date()
                    });

                    // Отправляем статический ответ пользователю
                    await ctx.reply(staticResponse);

                    // Устанавливаем таймер на 3 минуты
                    setTimeout(async () => {
                        // Проверяем, что сессия и данные чата всё ещё существуют
                        if (ctx.session && ctx.session.unauthorizedChat) {
                            // Если пользователь больше ничего не написал (только 2 сообщения: первое пользователя и ответ бота)
                            if (ctx.session.unauthorizedChat.messages.length === 2 &&
                                ctx.session.unauthorizedChat.state !== UnauthorizedChatState.Completed) {
                                devLog("Пользователь не ответил в течение 3 минут, финализируем разговор");
                                await finalizeConversation(ctx);
                            }
                        }
                    }, 180000); // 3 минуты
                }
                // Если это второе или последующее сообщение пользователя
                else if (ctx.session.unauthorizedChat.messages.length >= 3 &&
                    ctx.session.unauthorizedChat.state === UnauthorizedChatState.Initial) {
                    devLog("Получено второе сообщение от пользователя, финализируем разговор");
                    await finalizeConversation(ctx);
                }
            }
        }
    } catch (error) {
        console.error("Ошибка при обработке сообщения от неавторизованного пользователя:", error);
        const characterName = config.characterName || "Ассистент";
        const ownerName = config.ownerName || "руководитель";
        await ctx.reply(`Прошу прощения за задержку. Я записал${config.characterName === "Кира" ? "а" : ""} ваше обращение и передам его ${ownerName}. Спасибо за понимание!`);
    }
}

/**
 * Завершает разговор и пересылает информацию руководителю
 * @param ctx Контекст бота
 */
async function finalizeConversation(ctx: BotContext): Promise<void> {
    if (!ctx.session || !ctx.session.unauthorizedChat) return;

    // Выбираем завершающее сообщение в зависимости от того, в контактах ли пользователь
    const ownerName = config.ownerName || "руководитель";
    const ownerGender = config.ownerName === "Юлия" ? "она" : "он";

    const closingResponse = ctx.session.unauthorizedChat.isInContacts
        ? `Спасибо за информацию! Я передал${config.characterName === "Кира" ? "а" : ""} ваше обращение ${ownerName}, ${ownerGender} свяжется с вами в ближайшее время.`
        : `Спасибо за обращение. Информация передана ${config.ownerName === "Юлия" ? "руководительнице" : "руководителю"}, ${ownerGender} рассмотрит ваш вопрос в ближайшее время.`;

    // Сохраняем ответ в истории
    ctx.session.unauthorizedChat.messages.push({
        role: 'bot',
        content: closingResponse,
        timestamp: new Date()
    });

    // Отправляем завершающее сообщение
    await ctx.reply(closingResponse);

    // Суммируем диалог и отправляем руководителю
    const dialogSummary = await summarizeUnauthorizedChat(ctx);
    await forwardToOwner(ctx, dialogSummary);

    // Устанавливаем состояние завершения
    ctx.session.unauthorizedChat.state = UnauthorizedChatState.Completed;

    // Устанавливаем тайм-аут на 30 минут
    const timeoutUntil = new Date();
    timeoutUntil.setMinutes(timeoutUntil.getMinutes() + 30);
    ctx.session.unauthorizedChat.timeoutUntil = timeoutUntil;
    ctx.session.unauthorizedChat.timeoutMessageSent = false;

    devLog(`Установлен тайм-аут до ${timeoutUntil.toLocaleString()}`);

    // Не очищаем историю полностью, чтобы сохранить контекст таймаута
    devLog("Разговор завершен и переслан руководителю");
}

/**
 * Генерирует первый вопрос для неавторизованного пользователя
 * @param ctx Контекст бота
 * @returns Promise<string> Первый вопрос
 */
async function generateFirstQuestion(ctx: BotContext): Promise<string> {
    if (!ctx.session || !ctx.session.unauthorizedChat) {
        const ownerName = config.ownerName || "руководителем";
        const ownerGender = config.ownerName === "Юлия" ? "ней" : "ним";
        return `Здравствуйте! По какому рабочему вопросу вы хотели бы связаться с ${ownerGender}?`;
    }

    const chat = ctx.session.unauthorizedChat;
    const firstName = chat.firstName || "Пользователь";

    try {
        const response = await openai.chat.completions.create({
            model: "gpt-5-nano",
            messages: [
                {
                    role: "system",
                    content: `${getBotPersona()} Стиль общения: ${getCommunicationStyle()} Твой руководитель - ${config.ownerName}. Ты общаешься с пользователем по имени ${firstName}.
                    Твоя задача - вежливо поприветствовать пользователя и задать первый уточняющий вопрос ТОЛЬКО о рабочих вопросах.
                    Используй обращение на "ты". Обязательно обратись по имени, если оно известно.

                    ВАЖНО: Если пользователь пишет о нерабочих, личных или отвлеченных темах, вежливо перенаправь
                    разговор, спрашивая, по какому рабочему вопросу он хочет связаться с твоим руководителем.

                    Твой ответ должен быть коротким (1-2 предложения) и заканчиваться вопросом о рабочих делах.`
                },
                {
                    role: "user",
                    content: `Пользователь ${firstName} написал: "${ctx.session.unauthorizedChat.messages[0]?.content || 'Привет'}".
                    Сгенерируй первый ответ с уточняющим вопросом ТОЛЬКО о рабочих темах.`
                }
            ],
            temperature: 0.7,
            max_completion_tokens: 1000,
        });

        const generatedResponse = response.choices[0]?.message?.content;
        if (generatedResponse) {
            return generatedResponse;
        }
    } catch (error) {
        console.error("Ошибка при генерации первого вопроса:", error);
    }

    // Запасной вариант
    const ownerName = config.ownerName || "руководителя";
    const characterName = config.characterName || "ассистент";
    return `Привет${firstName !== "Пользователь" ? `, ${firstName}` : ""}! Я ${characterName}, помощник ${ownerName}. По какому рабочему вопросу ты хотел бы с ${config.ownerName === "Юлия" ? "ней" : "ним"} связаться?`;
}

/**
 * Генерирует второй вопрос для неавторизованного пользователя
 * @param ctx Контекст бота
 * @returns Promise<string> Второй вопрос
 */
async function generateSecondQuestion(ctx: BotContext): Promise<string> {
    if (!ctx.session || !ctx.session.unauthorizedChat) {
        return "Спасибо за информацию. Расскажи, пожалуйста, подробнее о сути вопроса, чтобы мой руководитель мог подготовиться к обсуждению.";
    }

    const chat = ctx.session.unauthorizedChat;
    const firstName = chat.firstName || "Пользователь";
    const messages = chat.messages;
    const ownerName = config.ownerName || "руководитель";
    const ownerGender = config.ownerName === "Юлия" ? "она" : "он";

    try {
        const response = await openai.chat.completions.create({
            model: "gpt-5-nano",
            messages: [
                {
                    role: "system",
                    content: `${getBotPersona()} Стиль общения: ${getCommunicationStyle()} Твой руководитель - ${config.ownerName}. Ты общаешься с пользователем по имени ${firstName}.
                    Это твой второй и последний вопрос перед тем, как разговор будет завершен.

                    ВАЖНО: Обсуждай ТОЛЬКО рабочие темы. Если пользователь пишет о нерабочих темах,
                    вежливо перенаправь разговор на рабочий контекст.

                    Твоя задача - поблагодарить за предоставленную информацию и задать ВТОРОЙ уточняющий вопрос
                    о деталях рабочего вопроса. НЕ запрашивай контактные данные, просто узнай больше деталей
                    по рабочему вопросу.`
                },
                {
                    role: "user",
                    content: `Вот история диалога:
                    1. Пользователь: "${messages[0]?.content || 'Привет'}"
                    2. Ты: "${messages[1]?.content || 'Привет! Чем могу помочь?'}"
                    3. Пользователь: "${messages[2]?.content || 'Нужна помощь'}"
                    
                    Сгенерируй второй вопрос для уточнения деталей рабочего вопроса. НЕ запрашивай контактные данные.`
                }
            ],
            temperature: 0.7,
            max_completion_tokens: 1000,
        });

        const generatedResponse = response.choices[0]?.message?.content;
        if (generatedResponse) {
            return generatedResponse;
        }
    } catch (error) {
        console.error("Ошибка при генерации второго вопроса:", error);
    }

    // Запасной вариант
    return `Спасибо за информацию${firstName !== "Пользователь" ? `, ${firstName}` : ""}. Можешь, пожалуйста, уточнить детали этого вопроса, чтобы я ${config.characterName === "Кира" ? "могла" : "мог"} лучше подготовить ${ownerName} к обсуждению?`;
}

/**
 * Проверяет, содержит ли сообщение признаки запроса на завершение разговора
 * @param message Текст сообщения
 * @returns boolean - является ли сообщение запросом на завершение
 */
function isCompletionRequest(message: string): boolean {
    const lowercaseMessage = message.toLowerCase();

    const completionPhrases = [
        'до свидания', 'пока', 'прощай', 'всего доброго', 'всего хорошего',
        'спасибо за помощь', 'благодарю', 'конец', 'завершить', 'закончить',
        'передайте руководителю', 'сообщите', 'спасибо и до свидания'
    ];

    return completionPhrases.some(phrase => lowercaseMessage.includes(phrase));
}

/**
 * Проверяет, содержит ли сообщение контактную информацию
 * @param message Текст сообщения
 * @returns boolean - содержит ли сообщение контактную информацию
 */
function containsContactInfo(message: string): boolean {
    const contactPatterns = [
        /телефон[\s:]*(?:\+?[0-9]{1,3})?[\s\-\(\)]*[0-9]{3,}[0-9\s\-\(\)]+/i,
        /почта[\s:]*[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/i,
        /email[\s:]*[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/i,
        /контакт[\s:]*(?:(?:\+?[0-9]+)|(?:[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}))/i,
        /связаться[\s:]*(?:(?:\+?[0-9]+)|(?:[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}))/i,
        /(?:\+[0-9]{1,3})?[\s\-\(\)]*[0-9]{3,}[0-9\s\-\(\)]+/,
        /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/,
        /(?:telegram|телеграм|tg)[\s:]*@[a-zA-Z0-9_]{5,}/i,
        /(?:viber|вайбер)[\s:]*(?:\+?[0-9]{1,3})?[\s\-\(\)]*[0-9]{3,}[0-9\s\-\(\)]+/i,
        /(?:whatsapp|ватсап|вотсап)[\s:]*(?:\+?[0-9]{1,3})?[\s\-\(\)]*[0-9]{3,}[0-9\s\-\(\)]+/i
    ];

    return contactPatterns.some(pattern => pattern.test(message));
}

/**
 * Функция суммаризации диалога с неавторизованным пользователем
 * @param ctx Контекст бота
 * @returns Promise<string> Суммаризация диалога
 */
async function summarizeUnauthorizedChat(ctx: BotContext): Promise<string> {
    try {
        if (!ctx.session || !ctx.session.unauthorizedChat) {
            return "Не удалось получить данные для суммаризации диалога.";
        }

        const chat = ctx.session.unauthorizedChat;
        const messages = chat.messages || [];
        const userName = `${chat.firstName} ${chat.lastName}`.trim();
        const username = chat.username ? '@' + chat.username : '';
        const contactInfo = extractContactInfo(messages);

        // Для краткого диалога просто возвращаем полную историю
        if (messages.length <= 4) {
            return `⚡️ Новое обращение от ${userName} ${username ? `(${username})` : ''}:\n\n` +
                `${contactInfo ? `📱 Контактная информация: ${contactInfo}\n\n` : ''}` +
                `Полная история диалога:\n\n${messages.map((msg, i) =>
                    `${i + 1}. ${msg.role === 'user' ? userName : 'Ассистент'}: ${msg.content}`).join('\n\n')}`;
        }

        // Для длинного диалога используем суммаризацию
        const messagesForSummary = messages.map(msg => ({
            role: msg.role,
            content: msg.content,
            timestamp: msg.timestamp
        }));

        const summary = await summarizeDialogue(messagesForSummary);

        return `${contactInfo ? `📱 Контактная информация: ${contactInfo}\n\n` : ''}` +
            `${summary}\n\n` +
            `Полная история диалога:\n\n${messages.map((msg, i) =>
                `${i + 1}. ${msg.role === 'user' ? userName : config.characterName}: ${msg.content}`).join('\n\n')}`;
    } catch (error) {
        console.error("Ошибка при суммаризации диалога:", error);

        if (!ctx.session || !ctx.session.unauthorizedChat) {
            return "Не удалось получить данные для суммаризации диалога.";
        }

        const chat = ctx.session.unauthorizedChat;
        const contactInfo = extractContactInfo(chat.messages);

        return `⚡️ Обращение от ${chat.firstName} ${chat.lastName}:\n\n` +
            `${contactInfo ? `📱 Контактная информация: ${contactInfo}\n\n` : ''}` +
            chat.messages.map((msg, i) =>
                `${i + 1}. ${msg.role === 'user' ? 'Пользователь' : config.characterName}: ${msg.content}`).join('\n\n');
    }
}

/**
 * Извлекает контактную информацию из сообщений
 * @param messages История сообщений
 * @returns string | null Контактная информация
 */
function extractContactInfo(messages: MessageHistory[]): string | null {
    const userMessages = messages.filter(msg => msg.role === 'user').map(msg => msg.content);

    // Шаблоны для поиска контактной информации
    const phonePattern = /(?:\+?[0-9]{1,3})?[\s\-\(\)]*[0-9]{3,}[0-9\s\-\(\)]+/;
    const emailPattern = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
    const telegramPattern = /(?:telegram|телеграм|tg)[\s:]*@[a-zA-Z0-9_]{5,}/i;

    // Ищем контактную информацию в сообщениях
    const contactInfo = [];

    for (const message of userMessages) {
        // Проверяем наличие телефона
        const phoneMatch = message.match(phonePattern);
        if (phoneMatch) {
            contactInfo.push(`Телефон: ${phoneMatch[0].trim()}`);
        }

        // Проверяем наличие email
        const emailMatch = message.match(emailPattern);
        if (emailMatch) {
            contactInfo.push(`Email: ${emailMatch[0].trim()}`);
        }

        // Проверяем наличие Telegram
        const telegramMatch = message.match(telegramPattern);
        if (telegramMatch) {
            contactInfo.push(`Telegram: ${telegramMatch[0].trim().replace(/(?:telegram|телеграм|tg)[\s:]*/i, '')}`);
        }
    }

    return contactInfo.length > 0 ? contactInfo.join(', ') : null;
}

/**
 * Функция пересылки суммаризации руководителю
 * @param ctx Контекст бота
 * @param summary Суммаризация диалога
 * @returns Promise<void>
 */
export async function forwardToOwner(ctx: BotContext, summary: string): Promise<void> {
    try {
        const ALLOWED_USER_ID = config.allowedUserId;

        if (!ctx.session || !ctx.session.unauthorizedChat) {
            console.error("Не удалось получить данные пользователя для пересылки.");
            return;
        }

        const chat = ctx.session.unauthorizedChat;
        const userName = `${chat.firstName} ${chat.lastName}`.trim();
        const username = chat.username ? '@' + chat.username : '';

        // Отправляем сообщение руководителю
        const ownerName = config.ownerName || "руководитель";
        await ctx.api.sendMessage(
            ALLOWED_USER_ID,
            `🔔 Новое обращение от ${userName} ${username ? `(${username})` : ''}!\n\n${summary}`
        );

        devLog(`Обращение от ${userName} переслано к ${ownerName}`);
    } catch (error) {
        console.error("Ошибка при пересылке сообщения руководителю:", error);
    }
}