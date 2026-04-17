import { Bot, InlineKeyboard } from "grammy";
import { markReminderAsCompleted, postponeReminder, Reminder, ReminderStatus, scheduleReminder } from "./reminder";
import { Chat, InputFile, User } from "grammy/types";
import { BotContext } from "./types";
import * as fs from 'fs';
import * as path from 'path';
import fetch from 'node-fetch';
import { processMessage, processImage, processImageGroup, type ProcessingResult } from "./orchestrator";
import { downloadVoiceMessage, transcribeAudio } from "./services/speechRecognition";
import { getMessagesSummary, markAllMessagesAsRead, resetAllMessages } from "./agents/readMessagesAgent";
import { handleUnauthorizedUserMessage } from "./agents/unauthorizedUserAgent";
import { GoogleMapsService } from "./services/googleMaps";
import { ContactsStore } from "./stores/ContactsStore";
import { deleteMessageDraft, getMessageDraft, saveMessageDraft, sendMessageFromDraft } from "./agents/sendMessagesAgent";
import {
    NegotiationStore,
    buildNegotiationSummaryText,
    buildNegotiationStopKeyboard,
} from "./stores/NegotiationStore";
import { initTelegramClient, sendMessage as sendTelegramMessage, setBotApi } from "./services/telegram";
import { devLog, sendMessage } from "./utils";
import { ReminderRegistry } from "./stores/ReminderRegistry";
import { addToHistory } from "./utils/history";
import { createBot } from "./bot";
import { registerCommandHandlers } from "./handlers/commands";
import { reactionAgent } from "./agents/reactionAgent";
import { getVectorService } from "./services/VectorServiceFactory";
import { config } from "./config";
import { startKiraLifeScheduler } from "./services/kiraLifeScheduler";
import { startDmReportScheduler } from "./services/dmReportScheduler";
import { startMemoryInsightScheduler } from "./services/memoryInsightScheduler";
import { startReflectionModeScheduler } from "./services/reflectionModeScheduler";
import { initReflectionMode } from "./services/reflectionModeService";
import { maybeProactiveHint } from "./utils/proactiveMemory";
import { maybeAskMemoryGap } from "./utils/memoryGapDetector";
import { AppDataSource } from "./data-source";
import { ReminderRepository } from "./services/ReminderRepository";


// Загрузка переменных окружения
console.log('🚀 Запуск Kira Mind Bot...');
console.log('📁 Рабочая директория:', __dirname);

// Максимальное количество сообщений в истории
const MAX_HISTORY_LENGTH = 10;

// Директория для временного хранения файлов
const TEMP_DIR = path.join(__dirname, 'temp');
if (!fs.existsSync(TEMP_DIR)) {
    console.log('📂 Создание временной директории:', TEMP_DIR);
    fs.mkdirSync(TEMP_DIR, { recursive: true });
    console.log('✅ Временная директория создана');
} else {
    console.log('📂 Временная директория уже существует:', TEMP_DIR);
}

const bot = createBot();
setBotApi(bot.api);
console.log('🤖 Бот создан успешно');

registerCommandHandlers(bot);
console.log('⚙️ Обработчики команд зарегистрированы');

// Уведомления и редактирование сводки переговоров в чате с ботом
NegotiationStore.setNotifyInBotChat(async (chatId, text) => {
    await bot.api.sendMessage(chatId, text);
});
NegotiationStore.setEditSummaryCallback(async (chatId, messageId, text, replyMarkup) => {
    await bot.api.editMessageText(chatId, messageId, text, {
        reply_markup: replyMarkup ?? { inline_keyboard: [] },
    });
});

// Initialize vector service for domain configurations (singleton)
const vectorService = getVectorService();
console.log('🔗 Векторный сервис создан:', vectorService ? 'успешно' : 'ошибка');

async function initializeVectorService() {
    if (vectorService) {
        console.log('🔗 Инициализация векторного сервиса...');
        try {
            await vectorService.initializeCollection();
            console.log('✅ Векторный сервис успешно инициализирован');
        } catch (error) {
            console.error('❌ Ошибка инициализации векторного сервиса:', error);
        }
    } else {
        console.error('❌ Векторный сервис не создан');
    }
}

// Список разрешенных эмодзи-реакций и настройка реакции
const ALLOWED_REACTIONS = config.allowedReactions;
const REACTIONS_ENABLED = config.reactionsEnabled;
console.log('😀 Настройки реакций:', {
    enabled: REACTIONS_ENABLED,
    allowedCount: ALLOWED_REACTIONS.length,
    reactions: ALLOWED_REACTIONS
});

function maybeReactToUser(ctx: BotContext, emoji?: string) {
    if (!REACTIONS_ENABLED) return;
    if (emoji && emoji !== "NONE") {
        if (ctx.chat?.type === "private" && ALLOWED_REACTIONS.includes(emoji)) {
            ctx.react(emoji as any).catch(e => {
                if (process.env.NODE_ENV === "development") {
                    console.error("Failed to react to message:", e.message);
                }
            });
        } else if (process.env.NODE_ENV === "development") {
            console.warn(`Reaction "${emoji}" not allowed or chat type not supported`);
        }
    }
}

async function replyAndStore(ctx: BotContext, text: string, options: any = {}) {
    const msg = await ctx.reply(text, options);
    if (!ctx.session.sentMessages) ctx.session.sentMessages = {};
    ctx.session.sentMessages[msg.message_id] = text;
    return msg;
}

async function saveRemindersFromResult(ctx: BotContext, result: ProcessingResult) {
    if (!result.reminderCreated) return;
    const list = result.reminderDetailsList ?? (result.reminderDetails ? [result.reminderDetails] : []);
    // Название группового чата — для пикера в приватном
    const chatType = ctx.chat?.type;
    const chatTitle = chatType === 'group' || chatType === 'supergroup'
        ? `👥 ${(ctx.chat as any).title ?? 'Группа'}`
        : undefined;
    for (const details of list) {
        const reminder: Reminder = {
            id: details.id,
            text: details.text,
            displayText: details.reminderMessage,
            dueDate: details.dueDate,
            chatId: ctx.chat!.id,
            status: ReminderStatus.Pending,
            createdAt: new Date(),
            targetChat: details.targetChat,
            chatTitle,
        };
        ctx.session.reminders.push(reminder);
        ReminderRegistry.getInstance().add(reminder);
        console.info(`[reminder] event=created id=${reminder.id} chatId=${reminder.chatId} due=${new Date(reminder.dueDate).toISOString()}` + (chatTitle ? ` chat="${chatTitle}"` : '') + (details.targetChat ? ` target=${details.targetChat.type}` : ""));
        await ReminderRepository.save(reminder).catch(e => console.error('[reminder] DB save failed on create:', e));
        scheduleReminder(bot, reminder);
    }
}
// Расширяем тип Message для поддержки пересланных сообщений
declare module "grammy/types" {
    interface Message {
        forward_from?: User;
        forward_from_chat?: Chat;
        forward_sender_name?: string;
        reply_to_message?: Message;
    }
}


// Функция для обработки медиагруппы
async function processMediaGroup(ctx: BotContext, mediaGroupId: string) {
    try {
        if (!ctx.session.mediaGroups) {
            console.error("Ошибка: медиагруппы не найдены в сессии");
            return;
        }

        if (!ctx.chat) {
            console.error("Ошибка: чат не найден в контексте");
            return;
        }

        const groupInfo = ctx.session.mediaGroups.get(mediaGroupId);
        if (!groupInfo || groupInfo.fileIds.length === 0) return;

        const fileIds = groupInfo.fileIds;
        const caption = groupInfo.caption || "";

        // Добавляем информацию о полученной группе изображений в историю
        let imageMessage = `[Группа изображений (${fileIds.length} шт.)]${caption ? ` с подписью: "${caption}"` : ''}`;
        await addToHistory(ctx, 'user', imageMessage);

        await ctx.api.sendChatAction(ctx.chat.id, "typing");

        // Скачиваем все изображения из группы
        const buffers = [];
        for (const fileId of fileIds) {
            const fileInfo = await ctx.api.getFile(fileId);
            if (fileInfo.file_path) {
                // URL для скачивания файла
                const fileUrl = `https://api.telegram.org/file/bot${bot.token}/${fileInfo.file_path}`;
                try {
                    // Загружаем файл
                    const response = await fetch(fileUrl);
                    const arrayBuffer = await response.arrayBuffer();
                    const buffer = Buffer.from(arrayBuffer);
                    buffers.push(buffer);
                } catch (error) {
                    console.error(`Ошибка при загрузке изображения: ${fileId}`, error);
                }

            }
        }

        // Если не удалось загрузить ни одно изображение
        if (buffers.length === 0) {
            const errorMessage = "Не удалось загрузить изображения из группы. Пожалуйста, попробуйте отправить их по одному.";
                await addToHistory(ctx, 'bot', errorMessage);
            await ctx.reply(errorMessage);
            return;
        }

        // Обрабатываем группу изображений
        const result = await processImageGroup(
            ctx,
            buffers,
            caption,
            ctx.session.messageHistory.slice().reverse() // Передаем историю в хронологическом порядке
        );

        // Обработка результата аналогично обработке одиночного изображения
        await saveRemindersFromResult(ctx, result);

        // Добавляем ответ бота в историю
        if (result.detectedText) {
            await addToHistory(ctx, 'bot', result.detectedText);
        }

        if (result.description) {
            await addToHistory(ctx, 'bot', result.description);
        }

        await addToHistory(ctx, 'bot', result.responseText);

        // Проверяем, было ли сгенерировано изображение
        if (result.imageGenerated && result.generatedImageUrl) {
            // Отправляем сначала текстовый ответ
            if (result.keyboard) {
                await ctx.reply(result.responseText, {
                    reply_markup: result.keyboard
                });
            } else {
                await ctx.reply(result.responseText);
            }

            try {
                // Затем отправляем изображение
                await ctx.api.sendChatAction(ctx.chat.id, "upload_photo");
                await ctx.replyWithPhoto(result.generatedImageUrl);

                // Добавляем информацию о сгенерированном изображении в историю
                await addToHistory(ctx, 'bot', `[Сгенерированное изображение: ${result.generatedImageUrl}]`);
            } catch (imageError) {
                console.error("Ошибка при отправке сгенерированного изображения:", imageError);
                await ctx.reply("К сожалению, не удалось отправить сгенерированное изображение. Возможно, проблема с URL или сервисом генерации изображений.");
            }
        } else {
            // Просто отправляем текстовый ответ
            if (result.keyboard) {
                await ctx.reply(result.responseText, {
                    reply_markup: result.keyboard
                });
            } else {
                await ctx.reply(result.responseText);
            }
        }
    } catch (error) {
        console.error("Ошибка при обработке группы изображений:", error);
        await ctx.reply("Произошла ошибка при обработке группы изображений. Пожалуйста, попробуйте еще раз или отправьте изображения по одному. 🌹");
    }
}

// Обработка текстовых сообщений
bot.on("message:text", async (ctx, next) => {
    try {
        devLog('📨 Получено текстовое сообщение от пользователя:', ctx.from?.id);
        const message = ctx.message.text;

        if (message.startsWith('/')) {
            await next();
            return;
        }

        // Текущее время для отслеживания временных промежутков
        const currentTime = Date.now();

        // Определяем, является ли сообщение пересланным
        const isForwarded = Boolean(ctx.message.forward_from || ctx.message.forward_from_chat || ctx.message.forward_sender_name);
        let forwardSource = '';

        if (ctx.message.forward_from) {
            forwardSource = ctx.message.forward_from.username || ctx.message.forward_from.first_name || "пользователя";
        } else if (ctx.message.forward_from_chat) {
            forwardSource = ctx.message.forward_from_chat.title || "чата";
        } else if (ctx.message.forward_sender_name) {
            forwardSource = ctx.message.forward_sender_name;
        }

        // Проверяем, было ли недавнее обычное сообщение пользователя,
        // которое можно объединить с текущим пересланным сообщением
        if (isForwarded && ctx.session.lastUserMessage &&
            !ctx.session.lastUserMessage.processed &&
            (currentTime - ctx.session.lastUserMessage.timestamp < 5000)) { // 5 секунд

            // Инициализация временной структуры для групп смешанных сообщений
            if (!ctx.session.forwardGroups) {
                ctx.session.forwardGroups = {};
            }

            // Используем единый ключ для всех пересылаемых сообщений в одной группе
            const forwardKey = "current_forward_group";

            if (!ctx.session.forwardGroups[forwardKey]) {
                // Создаем новую группу, если её еще нет
                ctx.session.forwardGroups[forwardKey] = {
                    messages: [],
                    sources: {}, // Для хранения сообщений по источникам
                    lastTime: currentTime,
                    timerId: null,
                    userMessages: [ctx.session.lastUserMessage.text] // Добавляем предыдущее обычное сообщение
                };
            }

            // Добавляем сообщение в группу с указанием источника
            if (!ctx.session.forwardGroups[forwardKey].sources[forwardSource]) {
                ctx.session.forwardGroups[forwardKey].sources[forwardSource] = [];
            }
            ctx.session.forwardGroups[forwardKey].sources[forwardSource].push(message);
            ctx.session.forwardGroups[forwardKey].lastTime = currentTime;

            // Отмечаем, что обычное сообщение обработано
            ctx.session.lastUserMessage.processed = true;

            // Сбрасываем предыдущий таймер, если он был
            if (ctx.session.forwardGroups[forwardKey].timerId) {
                clearTimeout(ctx.session.forwardGroups[forwardKey].timerId);
            }

            // Устанавливаем новый таймер для обработки этой группы
            const timerId = setTimeout(() => {
                processForwardedGroup(ctx, forwardKey);
            }, 2000);

            ctx.session.forwardGroups[forwardKey].timerId = timerId;

            return; // Пропускаем дальнейшую обработку
        }

        // Обработка обычного пересланного сообщения (без смешивания с сообщением пользователя)
        if (isForwarded) {
            // Инициализация временной структуры для групп пересланных сообщений
            if (!ctx.session.forwardGroups) {
                ctx.session.forwardGroups = {};
            }

            // Используем единый ключ для всех пересылаемых сообщений в одной группе
            const forwardKey = "current_forward_group";

            if (!ctx.session.forwardGroups[forwardKey]) {
                // Создаем новую группу, если её еще нет
                ctx.session.forwardGroups[forwardKey] = {
                    messages: [],
                    sources: {}, // Для хранения сообщений по источникам
                    lastTime: currentTime,
                    timerId: null,
                    userMessages: []
                };
            }

            // Добавляем сообщение в группу с указанием источника
            if (!ctx.session.forwardGroups[forwardKey].sources[forwardSource]) {
                ctx.session.forwardGroups[forwardKey].sources[forwardSource] = [];
            }
            ctx.session.forwardGroups[forwardKey].sources[forwardSource].push(message);
            ctx.session.forwardGroups[forwardKey].lastTime = currentTime;

            // Сбрасываем предыдущий таймер, если он был
            if (ctx.session.forwardGroups[forwardKey].timerId) {
                clearTimeout(ctx.session.forwardGroups[forwardKey].timerId);
            }

            // Устанавливаем новый таймер для обработки этой группы
            const timerId = setTimeout(() => {
                processForwardedGroup(ctx, forwardKey);
            }, 2000);

            ctx.session.forwardGroups[forwardKey].timerId = timerId;

            return; // Пропускаем дальнейшую обработку
        }

        // Если дошли до этого места, значит имеем дело с обычным сообщением пользователя

        // Ожидаем ответ пользователя для активной сессии переговоров (бот вёл переписку от его имени)
        const negotiationSession = NegotiationStore.getByChatId(ctx.chat!.id);
        if (negotiationSession?.waitingForUserReply) {
            const trimmed = message.trim().toLowerCase();
            if (trimmed === "отмена" || trimmed === "отмена переговоров") {
                const { summaryChatId, summaryMessageId, contactName } = negotiationSession;
                NegotiationStore.delete(negotiationSession.originalChatId, negotiationSession.contactId);
                if (summaryChatId != null && summaryMessageId != null) {
                    await ctx.api.editMessageText(
                        summaryChatId,
                        summaryMessageId,
                        `📩 Переговоры с ${contactName} отменены.`,
                        { reply_markup: { inline_keyboard: [] } }
                    ).catch(() => {});
                }
                await replyAndStore(ctx, "Переговоры отменены.");
                return;
            }
            const client = await initTelegramClient();
            if (client) {
                const sent = await sendTelegramMessage(client, negotiationSession.contactId, message, true, ctx.chat!.id);
                if (sent.success) {
                    negotiationSession.history.push({ role: "user", text: message, at: new Date() });
                    negotiationSession.waitingForUserReply = false;
                    NegotiationStore.update(negotiationSession.originalChatId, negotiationSession.contactId, {
                        history: negotiationSession.history,
                        waitingForUserReply: false,
                    });
                    if (negotiationSession.summaryChatId != null && negotiationSession.summaryMessageId != null) {
                        const summaryText = buildNegotiationSummaryText(negotiationSession);
                        await NegotiationStore.editSummary(
                            negotiationSession.summaryChatId,
                            negotiationSession.summaryMessageId,
                            summaryText,
                            buildNegotiationStopKeyboard()
                        ).catch(() => {});
                    }
                    await replyAndStore(ctx, "Отправлено.");
                } else {
                    await replyAndStore(ctx, "Не удалось отправить сообщение контакту. Попробуй ещё раз.");
                }
            } else {
                await replyAndStore(ctx, "Нет связи с Telegram. Попробуй позже.");
            }
            return;
        }

        // Сохраняем последнее сообщение пользователя для возможного объединения с последующими пересланными
        ctx.session.lastUserMessage = {
            text: message,
            timestamp: currentTime,
            processed: false
        };

        // Определяем, является ли сообщение ответом на другое сообщение
        let isReply = false;
        let replyToContent: string | undefined = undefined;
        let replyToSender: string | undefined = undefined;

        if (ctx.message.reply_to_message) {
            isReply = true;
            // Получаем текст сообщения, на которое отвечают
            if (ctx.message.reply_to_message.text) {
                replyToContent = ctx.message.reply_to_message.text;
            } else if (ctx.message.reply_to_message.caption) {
                replyToContent = `[Медиа с подписью: "${ctx.message.reply_to_message.caption}"]`;
            } else if (ctx.message.reply_to_message.photo) {
                replyToContent = '[Изображение]';
            } else if (ctx.message.reply_to_message.voice) {
                replyToContent = '[Голосовое сообщение]';
            } else if (ctx.message.reply_to_message.document) {
                replyToContent = `[Документ: ${ctx.message.reply_to_message.document.file_name || 'документ'}]`;
            } else {
                replyToContent = '[Сообщение]';
            }

            // Определяем отправителя сообщения, на которое отвечают
            if (ctx.message.reply_to_message.from) {
                replyToSender = ctx.message.reply_to_message.from.username ||
                    ctx.message.reply_to_message.from.first_name ||
                    'Пользователь';
            } else {
                replyToSender = 'Неизвестный пользователь';
            }
        }

        // Если сообщение является ответом, добавляем эту информацию в историю
        let userMessage = message;
        if (isReply && replyToContent) {
            // Добавляем информацию о реплае к сообщению пользователя
            userMessage = `[В ответ на "${replyToContent}" от ${replyToSender}]: ${message}`;
        }

        // Добавляем сообщение пользователя в историю
        await addToHistory(ctx, 'user', userMessage);

        // Устанавливаем таймер для обработки одиночного сообщения
        // (если в течение 2 секунд не придет пересланное сообщение)
        setTimeout(async () => {
            if (ctx.session.lastUserMessage &&
                ctx.session.lastUserMessage.text === message &&
                !ctx.session.lastUserMessage.processed) {

                ctx.session.lastUserMessage.processed = true;

                // Отправляем индикатор набора текста
                await ctx.api.sendChatAction(ctx.chat.id, "typing");

                // Используем оркестратор для обработки сообщения
                // Передаём userMessage (содержит reply-контекст если сообщение — ответ),
                // чтобы классификация, поиск по памяти и агенты видели полный контекст
                const result = await processMessage(
                    ctx,
                    userMessage,
                    false,
                    "",
                    ctx.session.messageHistory.slice().reverse() // Передаем историю в хронологическом порядке
                );

                // Обрабатываем результат
                await saveRemindersFromResult(ctx, result);

                if (result.negotiationSummarySent) {
                    await addToHistory(ctx, 'bot', '[Переговоры запущены — см. сообщение выше]');
                    maybeReactToUser(ctx, result.botReaction);
                    return;
                }

                // Добавляем ответ бота в историю
                await addToHistory(ctx, 'bot', result.responseText);

                // Если был сгенерирован ICS файл
                if (result.reminderCreated && result.icsFilePath) {
                    // Сначала отправляем текстовый ответ
                    if (result.keyboard) {
                        await replyAndStore(ctx, result.responseText, {
                            reply_markup: result.keyboard
                        });
                    } else {
                        await replyAndStore(ctx, result.responseText);
                    }

                    try {
                        // Затем отправляем ICS файл как документ
                        await ctx.api.sendChatAction(ctx.chat.id, "upload_document");

                        const fileStream = fs.createReadStream(result.icsFilePath);
                        const filename = path.basename(result.icsFilePath);
                        const inputFile = new InputFile(fileStream, filename);

                        await ctx.replyWithDocument(inputFile, {
                            caption: "Открой этот файл, чтобы добавить событие в свой календарь."
                        });

                        devLog(`ICS файл ${result.icsFilePath} отправлен пользователю`);

                        // Удаляем временный файл после отправки
                        fs.unlinkSync(result.icsFilePath);
                    } catch (fileError) {
                        console.error("Ошибка при отправке ICS файла:", fileError);
                        await ctx.reply("К сожалению, не удалось отправить файл календаря. Но я всё равно напомню тебе о событии в назначенное время.");
                    }
                }
                // Если было сгенерировано изображение
                else if (result.imageGenerated && result.generatedImageUrl) {
                    // Сначала отправляем текстовый ответ
                    if (result.keyboard) {
                        await replyAndStore(ctx, result.responseText, {
                            reply_markup: result.keyboard
                        });
                    } else {
                        await replyAndStore(ctx, result.responseText);
                    }

                    try {
                        // Затем отправляем изображение
                        await ctx.api.sendChatAction(ctx.chat.id, "upload_photo");
                        await ctx.replyWithPhoto(result.generatedImageUrl);

                        // Добавляем информацию о сгенерированном изображении в историю
                        await addToHistory(ctx, 'bot', `[Сгенерированное изображение: ${result.generatedImageUrl}]`);
                    } catch (imageError) {
                        console.error("Ошибка при отправке сгенерированного изображения:", imageError);
                        await ctx.reply("К сожалению, не удалось отправить сгенерированное изображение. Возможно, проблема с URL или сервисом генерации изображений.");
                    }
                } else {
                    // Просто отправляем текстовый ответ, если изображение или ICS не были сгенерированы
                    if (result.keyboard) {
                        await replyAndStore(ctx, result.responseText, {
                            reply_markup: result.keyboard
                        });
                    } else {
                        await replyAndStore(ctx, result.responseText);
                    }
                }

                maybeReactToUser(ctx, result.botReaction);

                if (ctx.session.lastFactSaveError) {
                    await ctx.reply(`⚠️ ${ctx.session.lastFactSaveError}`);
                    delete ctx.session.lastFactSaveError;
                }

                // Проактивная память: бот может вспомнить что-то уместное из долговременной памяти
                maybeProactiveHint(ctx, message, result.responseText).catch(() => {});
                // Детекция пробелов: если упомянут незнакомый человек — задать уточняющий вопрос
                maybeAskMemoryGap(ctx, message).catch(() => {});
            }
        }, 2000); // Ждем 2 секунды перед обработкой одиночного сообщения
    } catch (error) {
        console.error("Ошибка при обработке сообщения:", error);
        await ctx.reply("Что-то пошло не так... Давай попробуем еще раз? 💫");
    }
});

// Функция для обработки группы пересланных сообщений
async function processForwardedGroup(ctx: BotContext, forwardKey: string) {
    if (!ctx.chat || !ctx.session.forwardGroups) {
        return;
    }

    try {
        const group = ctx.session.forwardGroups[forwardKey];
        if (!group) return;

        // Получаем сгруппированные по источникам сообщения
        const sources = group.sources || {};
        const userMessages = group.userMessages || [];

        // Проверяем, есть ли у нас что-то для обработки
        if (Object.keys(sources).length === 0 && userMessages.length === 0) {
            devLog("Пустая группа сообщений, нечего обрабатывать");
            delete ctx.session.forwardGroups[forwardKey];
            return;
        }

        // Форматируем информацию для истории сообщений в виде единого треда
        let historyEntry = "[Пересланный тред сообщений]:\n";

        // Добавляем сообщения, сгруппированные по отправителям
        for (const source in sources) {
            const messages = sources[source];
            if (messages.length > 0) {
                historyEntry += `${source}: ${messages.join("\n" + source + ": ")}\n`;
            }
        }

        // Добавляем комментарии пользователя, если они есть
        if (userMessages.length > 0) {
            historyEntry += "\n[Комментарий пользователя]:\n";
            historyEntry += userMessages.join("\n");
        }

        // Проверка на наличие первого сообщения пользователя в истории
        const recentUserMessage = ctx.session.messageHistory.find(msg =>
            msg.role === 'user' &&
            !msg.content.startsWith('[Пересланный тред сообщений]') &&
            !msg.content.startsWith('[Пересланные сообщения') &&
            new Date().getTime() - new Date(msg.timestamp).getTime() < 5000 // в течение последних 5 секунд
        );

        if (recentUserMessage && !historyEntry.includes(recentUserMessage.content)) {
            // Удаляем это сообщение из истории, т.к. мы будем включать его в группу
            ctx.session.messageHistory = ctx.session.messageHistory.filter(
                msg => msg !== recentUserMessage
            );

            // Добавляем его к комментариям пользователя
            if (userMessages.length === 0) {
                historyEntry += "\n[Комментарий пользователя]:\n";
                historyEntry += recentUserMessage.content;

                // Также добавляем в userMessages для textToProcess
                userMessages.push(recentUserMessage.content);
            }
        }

        // Добавляем в историю как единое сообщение
        await addToHistory(ctx, 'user', historyEntry);

        // Отправляем индикатор набора текста
        await ctx.api.sendChatAction(ctx.chat.id, "typing");

        // Формируем общий текст сообщения для обработки
        let textToProcess = "Пересланные сообщения из треда:\n";

        // Добавляем сообщения по отправителям
        for (const source in sources) {
            const messages = sources[source];
            if (messages.length > 0) {
                textToProcess += `${source}:\n${messages.join("\n")}\n\n`;
            }
        }

        // Добавляем пользовательские сообщения как комментарий, если они есть
        if (userMessages.length > 0) {
            textToProcess += `Мой комментарий: ${userMessages.join(" ")}`;
        }

        devLog("Обработка треда сообщений:", textToProcess);

        // Обрабатываем объединенное сообщение через оркестратор
        const result = await processMessage(
            ctx,
            textToProcess,
            true,
            "треда сообщений",
            ctx.session.messageHistory.slice().reverse()
        );

        // Обрабатываем результат
        await saveRemindersFromResult(ctx, result);

        // Добавляем ответ бота в историю
        await addToHistory(ctx, 'bot', result.responseText);

        // Отправляем результат обработки
        if (result.reminderCreated && result.icsFilePath) {
            if (result.keyboard) {
                await ctx.reply(result.responseText, {
                    reply_markup: result.keyboard
                });
            } else {
                await ctx.reply(result.responseText);
            }

            try {
                await ctx.api.sendChatAction(ctx.chat.id, "upload_document");
                const fileStream = fs.createReadStream(result.icsFilePath);
                const filename = path.basename(result.icsFilePath);
                const inputFile = new InputFile(fileStream, filename);

                await ctx.replyWithDocument(inputFile, {
                    caption: "Открой этот файл, чтобы добавить событие в свой календарь."
                });

                fs.unlinkSync(result.icsFilePath);
            } catch (fileError) {
                console.error("Ошибка при отправке ICS файла:", fileError);
                await ctx.reply("К сожалению, не удалось отправить файл календаря. Но я всё равно напомню тебе о событии в назначенное время.");
            }
        } else if (result.imageGenerated && result.generatedImageUrl) {
            if (result.keyboard) {
                await ctx.reply(result.responseText, {
                    reply_markup: result.keyboard
                });
            } else {
                await ctx.reply(result.responseText);
            }

            try {
                await ctx.api.sendChatAction(ctx.chat.id, "upload_photo");
                await ctx.replyWithPhoto(result.generatedImageUrl);
                await addToHistory(ctx, 'bot', `[Сгенерированное изображение: ${result.generatedImageUrl}]`);
            } catch (imageError) {
                console.error("Ошибка при отправке сгенерированного изображения:", imageError);
                await ctx.reply("К сожалению, не удалось отправить сгенерированное изображение. Возможно, проблема с URL или сервисом генерации изображений.");
            }
        } else {
            if (result.keyboard) {
                await ctx.reply(result.responseText, {
                    reply_markup: result.keyboard
                });
            } else {
                await ctx.reply(result.responseText);
            }
        }

        if (ctx.session.lastFactSaveError) {
            await ctx.reply(`⚠️ ${ctx.session.lastFactSaveError}`);
            delete ctx.session.lastFactSaveError;
        }

        // Удаляем обработанную группу из памяти
        delete ctx.session.forwardGroups[forwardKey];

    } catch (error) {
        console.error("Ошибка при обработке группы пересланных сообщений:", error);
        await ctx.reply("Произошла ошибка при обработке пересланных сообщений. Пожалуйста, попробуйте еще раз.");

        // Удаляем группу даже в случае ошибки
        if (ctx.session.forwardGroups) {
            delete ctx.session.forwardGroups[forwardKey];
        }
    }
}

// Обработка изображений
bot.on("message:photo", async (ctx) => {
    try {
        devLog('🖼️ Получено изображение от пользователя:', ctx.from?.id);
        const caption = ctx.message.caption || "";
        const photoInfo = ctx.message.photo;
        const bestPhoto = photoInfo[photoInfo.length - 1]; // Берем фото с наилучшим качеством
        const fileId = bestPhoto.file_id;

        // Проверяем, является ли фото частью медиагруппы
        if (ctx.message.media_group_id) {
            // Обработка медиагруппы
            const mediaGroupId = ctx.message.media_group_id;

            // Инициализируем коллекцию медиагрупп, если это первое сообщение
            if (!ctx.session.mediaGroups) {
                ctx.session.mediaGroups = new Map();
            }

            // Сохраняем файлы из группы
            if (!ctx.session.mediaGroups.has(mediaGroupId)) {
                ctx.session.mediaGroups.set(mediaGroupId, {
                    fileIds: [fileId],
                    caption: caption,
                    timestamp: Date.now(),
                    processed: false
                });
            } else {
                const groupInfo = ctx.session.mediaGroups.get(mediaGroupId);
                if (!groupInfo) {
                    console.error("Ошибка: медиагруппа не найдена в сессии");
                    return;
                }

                groupInfo.fileIds.push(fileId);
                // Берем подпись из любого сообщения группы, где она есть
                if (!groupInfo.caption && caption) {
                    groupInfo.caption = caption;
                }
                ctx.session.mediaGroups.set(mediaGroupId, groupInfo);
            }

            setTimeout(async () => {
                if (!ctx.session.mediaGroups) {
                    console.error("Ошибка: медиагруппы не найдены в сессии");
                    return;
                }

                const groupInfo = ctx.session.mediaGroups.get(mediaGroupId);
                if (groupInfo && !groupInfo.processed) {
                    groupInfo.processed = true;
                    ctx.session.mediaGroups.set(mediaGroupId, groupInfo);

                    // Обрабатываем медиагруппу
                    await processMediaGroup(ctx, mediaGroupId);
                }
            }, 1000);

            return; // Прерываем выполнение, чтобы не обрабатывать отдельные фото из группы
        }

        // === НАЧАЛО СУЩЕСТВУЮЩЕГО КОДА ДЛЯ ОДИНОЧНЫХ ФОТО ===
        // Проверяем, является ли сообщение ответом на другое сообщение
        let isReply = false;
        let replyToContent: string | undefined = undefined;
        let replyToSender: string | undefined = undefined;

        if (ctx.message.reply_to_message) {
            isReply = true;
            // Получаем текст сообщения, на которое отвечают
            if (ctx.message.reply_to_message.text) {
                replyToContent = ctx.message.reply_to_message.text;
            } else if (ctx.message.reply_to_message.caption) {
                replyToContent = `[Медиа с подписью: "${ctx.message.reply_to_message.caption}"]`;
            } else if (ctx.message.reply_to_message.photo) {
                replyToContent = '[Изображение]';
            } else if (ctx.message.reply_to_message.voice) {
                replyToContent = '[Голосовое сообщение]';
            } else if (ctx.message.reply_to_message.document) {
                replyToContent = `[Документ: ${ctx.message.reply_to_message.document.file_name || 'документ'}]`;
            } else {
                replyToContent = '[Сообщение]';
            }

            // Определяем отправителя сообщения, на которое отвечают
            if (ctx.message.reply_to_message.from) {
                replyToSender = ctx.message.reply_to_message.from.username ||
                    ctx.message.reply_to_message.from.first_name ||
                    'Пользователь';
            } else {
                replyToSender = 'Неизвестный пользователь';
            }
        }

        // Добавляем информацию о полученном изображении в историю с учётом реплая
        let imageMessage = `[Изображение]${caption ? ` с подписью: "${caption}"` : ''}`;
        if (isReply && replyToContent) {
            imageMessage = `[В ответ на "${replyToContent}" от ${replyToSender}]: ${imageMessage}`;
        }
        await addToHistory(ctx, 'user', imageMessage);

        await ctx.api.sendChatAction(ctx.chat.id, "typing");

        // Получаем файл изображения
        const fileInfo = await ctx.api.getFile(fileId);

        // Если бот работает на API Telegram, у файла будет путь
        if (fileInfo.file_path) {
            // URL для скачивания файла
            const fileUrl = `https://api.telegram.org/file/bot${bot.token}/${fileInfo.file_path}`;

            try {
                // Загружаем файл
                const response = await fetch(fileUrl);
                const arrayBuffer = await response.arrayBuffer();
                const buffer = Buffer.from(arrayBuffer);

                // Временное сохранение файла
                const tempFilePath = path.join(TEMP_DIR, `${fileId}.jpg`);
                fs.writeFileSync(tempFilePath, buffer);

                // Обрабатываем изображение через новый оркестратор processImage
                const result = await processImage(
                    ctx,
                    buffer,
                    caption,
                    ctx.session.messageHistory.slice().reverse() // Передаем историю в хронологическом порядке
                );

                // Если было создано напоминание, сохраняем его
                await saveRemindersFromResult(ctx, result);

                // Добавляем ответ бота в историю
                if (result.detectedText) {
                    await addToHistory(ctx, 'bot', result.detectedText);
                }

                if (result.description) {
                    await addToHistory(ctx, 'bot', result.description);
                }

                await addToHistory(ctx, 'bot', result.responseText);

                // Проверяем, было ли сгенерировано изображение
                if (result.imageGenerated && result.generatedImageUrl) {
                    // Отправляем сначала текстовый ответ
                    if (result.keyboard) {
                        await ctx.reply(result.responseText, {
                            reply_markup: result.keyboard
                        });
                    } else {
                        await ctx.reply(result.responseText);
                    }

                    try {
                        // Затем отправляем изображение
                        await ctx.api.sendChatAction(ctx.chat.id, "upload_photo");
                        await ctx.replyWithPhoto(result.generatedImageUrl);

                        // Добавляем информацию о сгенерированном изображении в историю
                        await addToHistory(ctx, 'bot', `[Сгенерированное изображение: ${result.generatedImageUrl}]`);
                    } catch (imageError) {
                        console.error("Ошибка при отправке сгенерированного изображения:", imageError);
                        await ctx.reply("К сожалению, не удалось отправить сгенерированное изображение. Возможно, проблема с URL или сервисом генерации изображений.");
                    }
                } else {
                    // Просто отправляем текстовый ответ
                    if (result.keyboard) {
                        await ctx.reply(result.responseText, {
                            reply_markup: result.keyboard
                        });
                    } else {
                        await ctx.reply(result.responseText);
                    }
                }

                if (ctx.session.lastFactSaveError) {
                    await ctx.reply(`⚠️ ${ctx.session.lastFactSaveError}`);
                    delete ctx.session.lastFactSaveError;
                }

                // Удаляем временный файл
                fs.unlinkSync(tempFilePath);

            } catch (downloadError) {
                console.error("Ошибка при загрузке изображения:", downloadError);

                // Отправляем запасной ответ
                const fallbackResponse = "Я получила ваше изображение, но, к сожалению, не смогла его детально проанализировать из-за технической проблемы. Могу я чем-то еще помочь вам? 💫";

                await ctx.reply(fallbackResponse);
            }
        } else {
            const noFilePathResponse = "Я получила ваше изображение, но не могу получить к нему доступ. Возможно, проблема с API Telegram. Пожалуйста, попробуйте отправить изображение еще раз или опишите, что на нем. 🌷";
            await ctx.reply(noFilePathResponse);
        }
        // === КОНЕЦ СУЩЕСТВУЮЩЕГО КОДА ДЛЯ ОДИНОЧНЫХ ФОТО ===
    } catch (error) {
        console.error("Ошибка при обработке изображения:", error);
        await ctx.reply("Произошла ошибка при обработке изображения. Я очень хочу помочь вам, пожалуйста, попробуйте отправить его еще раз. 🌹");
    }
});



// Обработка документов
bot.on("message:document", async (ctx) => {
    try {
        const caption = ctx.message.caption || "";
        const fileId = ctx.message.document.file_id;
        const fileName = ctx.message.document.file_name || "документ";

        // Добавляем в историю
        await addToHistory(ctx, 'user', `[Документ: ${fileName}]${caption ? ` с подписью: "${caption}"` : ''}`);

        await ctx.api.sendChatAction(ctx.chat.id, "typing");

        // Если есть подпись, обрабатываем ее
        let responseText = "";
        if (caption) {
            // Используем новый оркестратор для обработки подписи
            const result = await processMessage(
                ctx,
                caption,
                false,
                "",
                ctx.session.messageHistory.slice().reverse()
            );

            // Если было создано напоминание, сохраняем его
            await saveRemindersFromResult(ctx, result);

            // Если было сгенерировано изображение
            if (result.imageGenerated && result.generatedImageUrl) {
                responseText = `Я получила твой документ "${fileName}". ${result.responseText}`;

                // Отправляем текстовый ответ
                await ctx.reply(responseText);

                try {
                    // Затем отправляем изображение
                    await ctx.api.sendChatAction(ctx.chat.id, "upload_photo");
                    await ctx.replyWithPhoto(result.generatedImageUrl);

                    // Добавляем информацию о сгенерированном изображении в историю
                    await addToHistory(ctx, 'bot', `[Сгенерированное изображение: ${result.generatedImageUrl}]`);
                } catch (imageError) {
                    console.error("Ошибка при отправке сгенерированного изображения:", imageError);
                    await ctx.reply("К сожалению, не удалось отправить сгенерированное изображение. Возможно, проблема с URL или сервисом генерации изображений.");
                }
            } else {
                responseText = `Я получила твой документ "${fileName}". ${result.responseText}`;
                await ctx.reply(responseText);
            }
        } else {
            responseText = `Я получила твой документ "${fileName}". К сожалению, я пока не могу полностью анализировать содержимое документов, но могу помочь тебе с составлением ответа или напоминанием, связанным с этим документом.\n\nЧем я могу помочь тебе с этим документом? 📄`;
            await ctx.reply(responseText);
        }

        await addToHistory(ctx, 'bot', responseText);
    } catch (error) {
        console.error("Ошибка при обработке документа:", error);
        await ctx.reply("Произошла ошибка при обработке документа. Пожалуйста, попробуй еще раз или отправь документ в другом формате. 📑");
    }
});

// Обработка аудио сообщений
bot.on("message:audio", async (ctx) => {
    try {
        const caption = ctx.message.caption || "";

        // Добавляем в историю
        await addToHistory(ctx, 'user', `[аудиофайл]${caption ? ` с подписью: "${caption}"` : ''}`);

        await ctx.api.sendChatAction(ctx.chat.id, "typing");

        // Если есть подпись, обрабатываем ее
        let responseText = "";
        if (caption) {
            // Используем новый оркестратор для обработки подписи
            const result = await processMessage(
                ctx,
                caption,
                false,
                "",
                ctx.session.messageHistory.slice().reverse()
            );

            // Если было создано напоминание, сохраняем его
            await saveRemindersFromResult(ctx, result);

            // Если было сгенерировано изображение
            if (result.imageGenerated && result.generatedImageUrl) {
                responseText = `Я получила твой аудиофайл. ${result.responseText}`;

                // Отправляем текстовый ответ
                await ctx.reply(responseText);

                try {
                    // Затем отправляем изображение
                    await ctx.api.sendChatAction(ctx.chat.id, "upload_photo");
                    await ctx.replyWithPhoto(result.generatedImageUrl);

                    // Добавляем информацию о сгенерированном изображении в историю
                    await addToHistory(ctx, 'bot', `[Сгенерированное изображение: ${result.generatedImageUrl}]`);
                } catch (imageError) {
                    console.error("Ошибка при отправке сгенерированного изображения:", imageError);
                    await ctx.reply("К сожалению, не удалось отправить сгенерированное изображение. Возможно, проблема с URL или сервисом генерации изображений.");
                }
            } else {
                responseText = `Я получила твой аудиофайл. ${result.responseText}`;
                await ctx.reply(responseText);
            }
        } else {
            responseText = `Я получила твой аудиофайл. К сожалению, я пока не могу анализировать аудио, но могу помочь тебе с напоминанием или другими задачами, связанными с этим сообщением.\n\nЧем я могу тебе помочь? 🎵`;
            await ctx.reply(responseText);
        }

        await addToHistory(ctx, 'bot', responseText);
    } catch (error) {
        console.error("Ошибка при обработке аудио:", error);
        await ctx.reply("Произошла ошибка при обработке аудио. Пожалуйста, попробуй еще раз или отправь текстовое сообщение. 🎧");
    }
});

// Модифицированная часть обработчика голосовых сообщений
// в файле index.ts

bot.on("message:voice", async (ctx) => {
    try {
        devLog('🎤 Получено голосовое сообщение от пользователя:', ctx.from?.id);
        await ctx.api.sendChatAction(ctx.chat.id, "typing");

        // Проверяем, является ли сообщение ответом на другое сообщение
        let isReply = false;
        let replyToContent: string | undefined = undefined;
        let replyToSender: string | undefined = undefined;

        if (ctx.message.reply_to_message) {
            isReply = true;
            // Получаем текст сообщения, на которое отвечают
            if (ctx.message.reply_to_message.text) {
                replyToContent = ctx.message.reply_to_message.text;
            } else if (ctx.message.reply_to_message.caption) {
                replyToContent = `[Медиа с подписью: "${ctx.message.reply_to_message.caption}"]`;
            } else if (ctx.message.reply_to_message.photo) {
                replyToContent = '[Изображение]';
            } else if (ctx.message.reply_to_message.voice) {
                replyToContent = '[Голосовое сообщение]';
            } else if (ctx.message.reply_to_message.document) {
                replyToContent = `[Документ: ${ctx.message.reply_to_message.document.file_name || 'документ'}]`;
            } else {
                replyToContent = '[Сообщение]';
            }

            // Определяем отправителя сообщения, на которое отвечают
            if (ctx.message.reply_to_message.from) {
                replyToSender = ctx.message.reply_to_message.from.username ||
                    ctx.message.reply_to_message.from.first_name ||
                    'Пользователь';
            } else {
                replyToSender = 'Неизвестный пользователь';
            }
        }

        // Добавляем в историю информацию о получении голосового сообщения с учётом реплая
        let voiceMessage = '[Голосовое сообщение]';
        if (isReply && replyToContent) {
            voiceMessage = `[В ответ на "${replyToContent}" от ${replyToSender}]: ${voiceMessage}`;
        }
        await addToHistory(ctx, 'user', voiceMessage);

        // Получаем информацию о голосовом сообщении
        const voice = ctx.message.voice;
        const fileId = voice.file_id;

        // Отправляем промежуточное сообщение
        const processingMsg = await ctx.reply("Слушаю твое сообщение, секунду... 🎧");

        // Получаем файл голосового сообщения
        const fileInfo = await ctx.api.getFile(fileId);

        if (fileInfo.file_path) {
            // URL для скачивания файла
            const fileUrl = `https://api.telegram.org/file/bot${bot.token}/${fileInfo.file_path}`;

            // Временное сохранение файла
            const tempFilePath = path.join(TEMP_DIR, `${fileId}.ogg`);

            try {
                // Загружаем файл
                await downloadVoiceMessage(fileUrl, tempFilePath);

                // Распознаем речь в текст
                const transcribedText = await transcribeAudio(tempFilePath);

                if (transcribedText && transcribedText.trim() !== '') {
                    // Добавляем распознанный текст в историю с учётом реплая
                    let transcribedMessage = `[Голосовое сообщение]: ${transcribedText}`;
                    if (isReply && replyToContent) {
                        // Обновляем запись о голосовом сообщении, добавляя распознанный текст
                        // Но сохраняем информацию о реплае
                        // Ищем последнее сообщение пользователя в истории
                        const lastUserMsgIndex = ctx.session.messageHistory.findIndex(msg => msg.role === 'user');
                        if (lastUserMsgIndex !== -1) {
                            // Обновляем запись, сохраняя информацию о реплае
                            ctx.session.messageHistory[lastUserMsgIndex].content =
                                ctx.session.messageHistory[lastUserMsgIndex].content.replace(
                                    '[Голосовое сообщение]',
                                    `[Голосовое сообщение]: ${transcribedText}`
                                );
                        } else {
                            // Если по какой-то причине не нашли запись, добавляем новую
                            await addToHistory(ctx, 'user', transcribedMessage);
                        }
                    } else {
                        // Если это не реплай, просто обновляем последнюю запись
                        const lastUserMsgIndex = ctx.session.messageHistory.findIndex(msg => msg.role === 'user');
                        if (lastUserMsgIndex !== -1) {
                            ctx.session.messageHistory[lastUserMsgIndex].content = transcribedMessage;
                        } else {
                            await addToHistory(ctx, 'user', transcribedMessage);
                        }
                    }

                    // Отправляем подтверждение распознавания
                    await ctx.api.editMessageText(
                        ctx.chat.id,
                        processingMsg.message_id,
                        `Я распознала твое голосовое сообщение:\n\n"${transcribedText}"\n\nОбрабатываю...`
                    );

                    try {
                        // Обрабатываем текст так же, как обычные текстовые сообщения
                        const result = await processMessage(
                            ctx,
                            transcribedText,
                            false,
                            "",
                            ctx.session.messageHistory.slice().reverse()
                        );

                        // Обрабатываем результат, аналогично обработке текстовых сообщений
                        await saveRemindersFromResult(ctx, result);

                        // Добавляем ответ бота в историю
                        await addToHistory(ctx, 'bot', result.responseText);

                        if (result.reminderCreated && result.icsFilePath) {
                            // Сначала отправляем текстовый ответ
                            if (result.keyboard) {
                                await ctx.reply(result.responseText, {
                                    reply_markup: result.keyboard
                                });
                            } else {
                                await ctx.reply(result.responseText);
                            }

                            try {
                                // Затем отправляем ICS файл как документ
                                await ctx.api.sendChatAction(ctx.chat.id, "upload_document");

                                const fileStream = fs.createReadStream(result.icsFilePath);
                                const filename = path.basename(result.icsFilePath);
                                const inputFile = new InputFile(fileStream, filename);

                                await ctx.replyWithDocument(inputFile, {
                                    caption: "Открой этот файл, чтобы добавить событие в свой календарь."
                                });

                                devLog(`ICS файл ${result.icsFilePath} отправлен пользователю`);

                                // Удаляем временный файл после отправки
                                fs.unlinkSync(result.icsFilePath);
                            } catch (fileError) {
                                console.error("Ошибка при отправке ICS файла:", fileError);
                                await ctx.reply("К сожалению, не удалось отправить файл календаря. Но я всё равно напомню тебе о событии в назначенное время.");
                            }
                        } else if (result.imageGenerated && result.generatedImageUrl) {
                            // Отправляем текстовый ответ
                            if (result.keyboard) {
                                await ctx.reply(result.responseText, {
                                    reply_markup: result.keyboard
                                });
                            } else {
                                await ctx.reply(result.responseText);
                            }

                            try {
                                // Затем отправляем изображение
                                await ctx.api.sendChatAction(ctx.chat.id, "upload_photo");
                                await ctx.replyWithPhoto(result.generatedImageUrl);

                                // Добавляем информацию о сгенерированном изображении в историю
                                await addToHistory(ctx, 'bot', `[Сгенерированное изображение: ${result.generatedImageUrl}]`);
                            } catch (imageError) {
                                console.error("Ошибка при отправке сгенерированного изображения:", imageError);
                                await ctx.reply("К сожалению, не удалось отправить сгенерированное изображение. Возможно, проблема с URL или сервисом генерации изображений.");
                            }
                        } else {
                            // Отправляем ответ БЕЗ указания parse_mode
                            if (result.keyboard) {
                                await ctx.reply(result.responseText, {
                                    reply_markup: result.keyboard
                                });
                            } else {
                                await ctx.reply(result.responseText);
                            }
                        }

                        if (ctx.session.lastFactSaveError) {
                            await ctx.reply(`⚠️ ${ctx.session.lastFactSaveError}`);
                            delete ctx.session.lastFactSaveError;
                        }
                    } catch (processingError) {
                        console.error("Ошибка при обработке распознанного текста:", processingError);
                        await ctx.reply(`Я распознала твое сообщение как: "${transcribedText}", но возникла ошибка при его обработке. Можешь отправить текстом?`);
                    }
                } else {
                    // Если не удалось распознать текст
                    const noTextResponse = "Я получила твое голосовое сообщение, но не смогла разобрать, что ты говоришь. Можешь повторить погромче или прислать текстовое сообщение? 🙏";
                    await ctx.api.editMessageText(ctx.chat.id, processingMsg.message_id, noTextResponse);
                }

                // Удаляем временный файл
                fs.unlinkSync(tempFilePath);

            } catch (processingError) {
                console.error("Ошибка при обработке голосового сообщения:", processingError);

                // Отправляем сообщение об ошибке
                const errorResponse = "Я получила твое голосовое сообщение, но возникла техническая проблема при его обработке. Можешь отправить текстом? 🙏";
                await addToHistory(ctx, 'bot', errorResponse);
                await ctx.api.editMessageText(ctx.chat.id, processingMsg.message_id, errorResponse);

                // Удаляем временный файл, если он существует
                if (fs.existsSync(tempFilePath)) {
                    fs.unlinkSync(tempFilePath);
                }
            }
        } else {
            const noFilePathResponse = "Я получила твое голосовое сообщение, но не могу получить к нему доступ. Возможно, проблема с API Telegram. Можешь отправить текстом? 🎤";
            await addToHistory(ctx, 'bot', noFilePathResponse);
            await ctx.api.editMessageText(ctx.chat.id, processingMsg.message_id, noFilePathResponse);
        }
    } catch (error) {
        console.error("Ошибка при обработке голосового сообщения:", error);
        await ctx.reply("Произошла ошибка при обработке твоего голосового сообщения. Пожалуйста, попробуй еще раз или отправь свой вопрос текстом. 🙏");
    }
});

bot.on("message:location", async (ctx) => {
    try {
        devLog('📍 Получена геолокация от пользователя:', ctx.from?.id);
        const location = ctx.message.location;
        const latitude = location.latitude;
        const longitude = location.longitude;

        // Добавляем информацию о полученной геолокации в историю
        await addToHistory(ctx, 'user', `[Геолокация: ${latitude}, ${longitude}]`);

        // Сохраняем геолокацию в сессии
        ctx.session.lastLocation = {
            latitude,
            longitude,
            timestamp: new Date()
        };

        await ctx.api.sendChatAction(ctx.chat.id, "typing");

        // Пытаемся получить адрес для этой локации через Google Maps API
        try {
            const mapsService = new GoogleMapsService();

            // Запрашиваем обратное геокодирование
            const geocodingResult = await mapsService.geocodeAddress(`${latitude},${longitude}`);

            if (geocodingResult && geocodingResult.formatted_address) {
                // Сохраняем полученный адрес в сессии
                ctx.session.lastLocation.address = geocodingResult.formatted_address;

                // Отправляем сообщение с распознанным адресом
                const responseText = `Я получила твою геолокацию! 📍\n\nТы находишься по адресу: ${geocodingResult.formatted_address}\n\nТеперь ты можешь спросить меня о местах поблизости, например:\n- Найди кафе рядом\n- Где ближайшая аптека?\n- Покажи рестораны в радиусе 1 км`;

                await addToHistory(ctx, 'bot', responseText);
                await ctx.reply(responseText);
            } else {
                // Если не удалось получить адрес
                const responseText = `Я получила твою геолокацию (${latitude}, ${longitude})! 📍\n\nТеперь ты можешь спросить меня о местах поблизости, например:\n- Найди кафе рядом\n- Где ближайшая аптека?\n- Покажи рестораны в радиусе 1 км`;

                await addToHistory(ctx, 'bot', responseText);
                await ctx.reply(responseText);
            }
        } catch (geocodingError) {
            console.error("Ошибка при геокодировании:", geocodingError);

            // Отправляем сообщение без адреса
            const responseText = `Я получила твою геолокацию! 📍\n\nКоординаты: ${latitude}, ${longitude}\n\nТеперь ты можешь спросить меня о местах поблизости, например:\n- Найди кафе рядом\n- Где ближайшая аптека?\n- Покажи рестораны в радиусе 1 км`;

            await addToHistory(ctx, 'bot', responseText);
            await ctx.reply(responseText);
        }
    } catch (error) {
        console.error("Ошибка при обработке геолокации:", error);
        await ctx.reply("Произошла ошибка при обработке твоей геолокации. Пожалуйста, попробуй еще раз или укажи местоположение в сообщении. 🌍");
    }
});

// Обработка реакций пользователя на сообщения бота
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

// Запуск бота
async function startBot() {
    try {
        console.log("🚀 Инициализация бота...");
        devLog("Starting the assistant bot...");

        console.log("🗄️  Инициализация базы данных...");
        await AppDataSource.initialize();
        console.log("✅ База данных подключена");

        console.log("📅 Загрузка активных напоминаний из БД...");
        const pendingReminders = await ReminderRepository.loadPending();
        for (const reminder of pendingReminders) {
            ReminderRegistry.getInstance().add(reminder);
            scheduleReminder(bot, reminder);
        }
        console.log(`✅ Загружено и запланировано ${pendingReminders.length} напоминаний`);

        console.log("🔗 Инициализация векторного сервиса...");
        await initializeVectorService();

        console.log("🎯 Запуск прослушивания событий...");
        startKiraLifeScheduler(bot);
        startDmReportScheduler(bot);
        startMemoryInsightScheduler(bot);
        await initReflectionMode();
        startReflectionModeScheduler(bot);
        await bot.api.setMyCommands([
            { command: "reflection", description: "Режим рефлексии и накопления знаний" },
            { command: "reminders", description: "Мои напоминания" },
            { command: "chats", description: "Список чатов" },
            { command: "contacts", description: "Список контактов" },
            { command: "telegram_unread", description: "Непрочитанные сообщения" },
            { command: "summary", description: "Сводка диалога" },
            { command: "clear", description: "Очистить историю и сохранить факты" },
            { command: "help", description: "Мои возможности" },
        ]);
        await bot.start();

        console.log("✅ Бот успешно запущен и готов к работе!");
        console.log("📡 Бот ожидает сообщения...");
    } catch (error) {
        console.error("❌ Критическая ошибка при запуске бота:", error);
        if (error instanceof Error) {
            console.error("Stack trace:", error.stack);
        }
        process.exit(1);
    }
}

console.log("🔄 Инициализация завершена, запуск бота...");
startBot();
