import { restoreReminderAfterRestart, setBotRef } from "./reminder";
import { setBotApi } from "./services/telegram";
import { createBot } from "./bot";
import { registerCommandHandlers } from "./handlers/commands";
import { registerTextMessageHandler } from "./handlers/textMessages";
import { registerPhotoMessageHandler } from "./handlers/photoMessages";
import { registerVoiceMessageHandler } from "./handlers/voiceMessages";
import { registerMediaMessageHandler } from "./handlers/mediaMessages";
import { registerLocationMessageHandler } from "./handlers/locationMessages";
import { registerReactionHandler } from "./handlers/reactionHandler";
import { NegotiationStore } from "./stores/NegotiationStore";
import { getVectorService } from "./services/VectorServiceFactory";
import { devLog } from "./utils";
import { AppDataSource } from "./data-source";
import { ReminderRepository } from "./services/ReminderRepository";
import { getTelegramMenuCommands } from "./capabilities";
import { warmAiPresetCache } from "./services/aiRuntimeConfigService";
import { startRuntimeHealthServer } from "./services/runtimeHealthServer";
import { startKiraLifeScheduler } from "./services/kiraLifeScheduler";
import { startDmReportScheduler } from "./services/dmReportScheduler";
import { startMemoryInsightScheduler } from "./services/memoryInsightScheduler";
import { startMemoryConsolidationScheduler } from "./services/memoryConsolidationScheduler";
import { startPersonalChatMemoryIndexer } from "./services/personalChatMemoryIndexer";
import { startReflectionModeScheduler } from "./services/reflectionModeScheduler";
import { startMorningDigestScheduler } from "./services/morningDigestScheduler";
import { startChatGroupTracker } from "./services/chatGroupTracker";
import { startChatPromptWatchPolling } from "./services/chatPromptWatchers";
import { startInboxGuardianScheduler } from "./services/inboxGuardianScheduler";
import { initReflectionMode } from "./services/reflectionModeService";
import { REACTIONS_ENABLED, ALLOWED_REACTIONS } from "./handlers/shared";


// Загрузка переменных окружения
console.log('🚀 Запуск Kira Mind Bot...');
console.log('📁 Рабочая директория:', __dirname);

const bot = createBot();
setBotRef(bot);
setBotApi(bot.api);
console.log('🤖 Бот создан успешно');
startRuntimeHealthServer();

// Регистрация всех обработчиков
registerCommandHandlers(bot);
console.log('⚙️ Обработчики команд зарегистрированы');

registerTextMessageHandler(bot);
registerPhotoMessageHandler(bot);
registerVoiceMessageHandler(bot);
registerMediaMessageHandler(bot);
registerLocationMessageHandler(bot);
registerReactionHandler(bot);
console.log('⚙️ Обработчики сообщений зарегистрированы');

// Уведомления и редактирование сводки переговоров в чате с ботом
NegotiationStore.setNotifyInBotChat(async (chatId, text) => {
    await bot.api.sendMessage(chatId, text);
});
NegotiationStore.setEditSummaryCallback(async (chatId, messageId, text, replyMarkup) => {
    await bot.api.editMessageText(chatId, messageId, text, {
        reply_markup: replyMarkup ?? { inline_keyboard: [] },
    });
});

// Инициализация векторного сервиса
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

// Настройки реакций
console.log('😀 Настройки реакций:', {
    enabled: REACTIONS_ENABLED,
    allowedCount: ALLOWED_REACTIONS.length,
    reactions: ALLOWED_REACTIONS
});

// ── Запуск бота ────────────────────────────────────────────

async function startBot() {
    try {
        console.log("🚀 Инициализация бота...");
        devLog("Starting the assistant bot...");

        console.log("🗄️  Инициализация базы данных...");
        await AppDataSource.initialize();
        console.log("✅ База данных подключена");

        console.log("🤖 Загрузка runtime AI preset...");
        const activeAiPreset = await warmAiPresetCache();
        console.log("✅ Runtime AI preset загружен:", activeAiPreset);

        console.log("📅 Загрузка активных напоминаний из БД...");
        const activeReminders = await ReminderRepository.loadActive();
        for (const reminder of activeReminders) {
            restoreReminderAfterRestart(bot, reminder);
        }
        console.log(`✅ Загружено активных напоминаний: ${activeReminders.length}`);

        console.log("🔗 Инициализация векторного сервиса...");
        await initializeVectorService();

        console.log("🎯 Запуск прослушивания событий...");
        startKiraLifeScheduler(bot);
        startDmReportScheduler(bot);
        startMemoryInsightScheduler(bot);
        startMemoryConsolidationScheduler();
        startPersonalChatMemoryIndexer();
        await initReflectionMode();
        startReflectionModeScheduler(bot);
        startMorningDigestScheduler(bot);
        startInboxGuardianScheduler(bot);
        startChatGroupTracker(bot);
        startChatPromptWatchPolling(bot.api);
        await bot.api.setMyCommands(getTelegramMenuCommands());
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
