import { Bot, InlineKeyboard } from "grammy";
import { BotContext } from "../types";
import { ContactsStore } from "../stores/ContactsStore";
import { getActiveReminders, buildReminderCard, buildChatPicker } from "../utils/reminderCard";
import { ReminderRegistry } from "../stores/ReminderRegistry";
import { getMessagesSummary, getUnreadMessagesPreview, markAllMessagesAsRead, resetAllMessages } from "../agents/readMessagesAgent";
import { EnhancedSessionData } from "../services/dialogueSummarizer";
import { sendMessage } from "../utils";
import { addToHistory } from "../utils/history";
import { registerMemoryCommands } from "./memoryCommands";
import { USER_TIMEZONE } from "../constants";
import { getCapabilitiesMessage } from "../capabilities";
import { getAllChats, isChatPublicMode, setChatPublicMode } from "../services/chatRegistry";
import { factAnalysisManager } from "../utils/factAnalysisTimer";
import { extractAndSaveFactsFromConversation } from "../utils/enhancedFactExtraction";

export function registerCommandHandlers(bot: Bot<BotContext>) {
    registerMemoryCommands(bot);
    bot.command("telegram_reset", async (ctx) => {
    try {
        // Вызываем функцию сброса сообщений
        const success = resetAllMessages();

        let responseText;
        if (success) {
            responseText = "Все сообщения из Telegram успешно сброшены и удалены из памяти. Теперь список непрочитанных сообщений пуст. ✅";
        } else {
            responseText = "Произошла ошибка при сбросе сообщений Telegram. Пожалуйста, попробуйте снова.";
        }

        await ctx.reply(responseText);
    } catch (error) {
        console.error("Ошибка при сбросе сообщений Telegram:", error);
        const errorMessage = "Произошла ошибка при сбросе сообщений Telegram. Пожалуйста, попробуйте снова.";

        await ctx.reply(errorMessage);
    }
});

// Команда /contacts - показать список контактов
bot.command("contacts", async (ctx) => {
    try {
        // Получаем хранилище контактов
        const contactsStore = ContactsStore.getInstance();

        // Получаем все контакты
        const contacts = contactsStore.getAllContacts();

        if (contacts.length === 0) {
            await ctx.reply("Список контактов пуст. Пожалуйста, сначала синхронизируйте контакты с помощью команды /sync_contacts.");
            return;
        }

        // Формируем сообщение со списком контактов
        let message = "📋 Список всех контактов:\n\n";

        contacts.forEach((contact, index) => {
            message += `${index + 1}. ${contact.firstName} ${contact.lastName || ''}`;

            if (contact.username) {
                message += ` (@${contact.username})`;
            }

            if (contact.phone) {
                message += ` - ${contact.phone}`;
            }

            if (contact.isFavorite) {
                message += " ⭐";
            }

            if (contact.tags && contact.tags.length > 0) {
                message += ` [${contact.tags.join(', ')}]`;
            }

            message += "\n";
        });

        message += `\nВсего контактов: ${contacts.length}`;

        // Отправляем сообщение со списком контактов
        await ctx.reply(message);
    } catch (error) {
        console.error("Ошибка при получении списка контактов:", error);
        await ctx.reply("Произошла ошибка при получении списка контактов. Пожалуйста, попробуйте позже.");
    }
});

// Команда /reminders - показать активные напоминания
bot.command("reminders", async (ctx) => {
    const isPrivate = ctx.chat?.type === 'private';

    if (!isPrivate) {
        // В групповом чате — показываем напоминания только этой группы
        const active = getActiveReminders(ctx);
        if (active.length === 0) {
            await ctx.reply("В этом чате пока нет активных напоминаний.");
            return;
        }
        const { text, keyboard } = buildReminderCard(active, 0);
        await ctx.reply(text, { reply_markup: keyboard });
        return;
    }

    // В приватном чате — проверяем напоминания во всех чатах
    ctx.session.viewingRemindersInChat = undefined;
    const allChats = ReminderRegistry.getInstance().getChatsWithActive();

    if (allChats.length === 0) {
        const msg = "У тебя пока нет активных напоминаний. Хочешь, чтобы я что-то запланировала? Просто скажи, о чём напомнить! 🌺";
        addToHistory(ctx, 'bot', msg);
        await ctx.reply(msg);
        return;
    }

    // Если есть только личные напоминания — карточки как обычно
    if (allChats.length === 1 && allChats[0].chatId === ctx.chat!.id) {
        const active = ReminderRegistry.getInstance().getActiveByChatId(ctx.chat!.id);
        const { text, keyboard } = buildReminderCard(active, 0);
        addToHistory(ctx, 'bot', text);
        await ctx.reply(text, { reply_markup: keyboard });
        return;
    }

    // Несколько чатов — показываем пикер
    const { text, keyboard } = buildChatPicker(allChats);
    await ctx.reply(text, { reply_markup: keyboard });
});

// Команда /clear - очистить историю сообщений
bot.command("clear", async (ctx) => {
    const userId = ctx.from?.id;

    if (userId) {
        factAnalysisManager.cancelAnalysis(userId);
    }

    let savedCount = 0;
    if (ctx.session.messageHistory.length >= 2) {
        savedCount = await extractAndSaveFactsFromConversation(ctx);
    }

    ctx.session.messageHistory = [];

    const factNote = savedCount > 0
        ? `Сохранено ${savedCount} новых фактов в долговременную память 🌱`
        : 'Новых фактов для сохранения не найдено.';
    await ctx.reply(`История сообщений очищена. ${factNote}`);
});

bot.command("telegram_unread", async (ctx) => {
    try {

        await ctx.api.sendChatAction(ctx.chat.id, "typing");

        // Получаем список непрочитанных сообщений за последние 24 часа
        const preview = getUnreadMessagesPreview(24);

        if (preview) {
            const keyboard = new InlineKeyboard().text("🔎 Суммаризация", "unread_summary");
            await ctx.reply(preview, { reply_markup: keyboard });
        } else {
            const noUnreadMessagesResponse = "У тебя нет непрочитанных сообщений в Telegram за последние 24 часа. Все сообщения прочитаны! 📬";
            await ctx.reply(noUnreadMessagesResponse);
        }


    } catch (error) {
        console.error("Ошибка при получении непрочитанных сообщений Telegram:", error);
        const errorMessage = "Произошла ошибка при получении непрочитанных сообщений Telegram. Пожалуйста, попробуйте позже или проверьте статус подключения.";

        addToHistory(ctx, 'bot', errorMessage);
        await ctx.reply(errorMessage);
    }
});

bot.command("telegram_read", async (ctx) => {
    try {
        const success = markAllMessagesAsRead();

        let responseText;
        if (success) {
            responseText = "Все сообщения из Telegram отмечены как прочитанные. 👍";
        } else {
            responseText = "Произошла ошибка при отметке сообщений как прочитанных. Пожалуйста, попробуйте снова.";
        }


        await ctx.reply(responseText);
    } catch (error) {
        console.error("Ошибка при отметке сообщений как прочитанных:", error);
        const errorMessage = "Произошла ошибка при отметке сообщений как прочитанных. Пожалуйста, попробуйте снова.";

        await ctx.reply(errorMessage);
    }
});

// Новая команда /summary - показать текущую суммаризацию диалога
bot.command("summary", async (ctx) => {
    const sessionData = ctx.session as EnhancedSessionData;
    let message = '';

    if (sessionData.dialogueSummary && sessionData.dialogueSummary.trim() !== '') {
        message = "📝 Вот что я запомнила из нашего общения:\n\n" + sessionData.dialogueSummary;
    } else {
        message = "У меня пока нет сохраненной суммаризации нашего разговора. Она будет создана автоматически после достаточного количества сообщений! 📚";
    }

    await ctx.reply(message);
});

bot.command("history", async (ctx) => {
    try {
        await ctx.api.sendChatAction(ctx.chat.id, "typing");

        const messageHistory = ctx.session.messageHistory;

        let historyMessage = "";

        if (messageHistory.length === 0) {
            historyMessage = "📝 История сообщений пуста. Начните диалог, чтобы увидеть историю!";
        } else {
            historyMessage = "📝 История сообщений (от новых к старым):\n\n";

            // Ограничиваем количество сообщений для отображения (макс. 20)
            const maxMessages = Math.min(messageHistory.length, 20);

            for (let i = 0; i < maxMessages; i++) {
                const message = messageHistory[i];
                const formattedDate = new Date(message.timestamp).toLocaleString('ru-RU', {
                    day: 'numeric',
                    month: 'numeric',
                    hour: 'numeric',
                    minute: 'numeric'
                });

                // Ограничиваем длину содержимого сообщения для отображения
                let content = message.content;
                if (content.length > 100) {
                    content = content.substring(0, 97) + "...";
                }

                historyMessage += `[${formattedDate}] ${message.role === 'user' ? '👤 Ты' : '🤖 Я'}: ${content}\n\n`;
            }

            if (messageHistory.length > maxMessages) {
                historyMessage += `... и еще ${messageHistory.length - maxMessages} сообщений в истории\n\n`;
            }

            historyMessage += "Для очистки истории используйте команду /clear";
        }

        // Отправляем сообщение с историей
        await ctx.reply(historyMessage);
    } catch (error) {
        console.error("Ошибка при получении истории сообщений:", error);
        const errorMessage = "Произошла ошибка при получении истории сообщений. Пожалуйста, попробуйте позже.";

        await ctx.reply(errorMessage);
    }
});

// Команда /chats - показать все чаты, в которых присутствует бот
bot.command("chats", async (ctx) => {
    try {
        const chats = await getAllChats();
        if (chats.length === 0) {
            await ctx.reply("Список чатов пока пуст.");
            return;
        }

        const typeLabel: Record<string, string> = {
            private: '👤 Личный',
            group: '👥 Группа',
            supergroup: '👥 Супергруппа',
            channel: '📢 Канал',
        };

        let msg = `📋 Чаты, где меня видят (${chats.length}):\n\n`;
        for (const chat of chats) {
            const type = typeLabel[chat.chatType] ?? chat.chatType;
            const usernameStr = chat.username ? ` @${chat.username}` : '';
            const lastSeen = new Date(chat.lastSeenAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });
            msg += `${type}: *${chat.title}*${usernameStr}\n`;
            msg += `  ID: \`${chat.chatId}\` · последний раз: ${lastSeen}\n\n`;
        }

        await ctx.reply(msg, { parse_mode: "Markdown" });
    } catch (error) {
        console.error("Ошибка при получении списка чатов:", error);
        await ctx.reply("Не удалось загрузить список чатов.");
    }
});

// Команда /public_mode — включить/выключить публичный режим в текущем групповом чате
bot.command("public_mode", async (ctx) => {
    const isGroup = ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup';
    if (!isGroup) {
        await ctx.reply("Эта команда работает только в групповых чатах.");
        return;
    }
    try {
        const current = await isChatPublicMode(ctx.chat!.id);
        const next = !current;
        await setChatPublicMode(ctx.chat!.id, next);
        await ctx.reply(
            next
                ? "✅ Публичный режим включён — теперь отвечаю всем участникам этого чата."
                : "🔒 Публичный режим выключен — отвечаю только владельцу."
        );
    } catch (error) {
        console.error("Ошибка при переключении публичного режима:", error);
        await ctx.reply("Не удалось изменить режим.");
    }
});

// Команда /help - показать справку (то же описание возможностей, что и на вопрос «что ты умеешь»)
bot.command("help", async (ctx) => {
    await ctx.reply(getCapabilitiesMessage(), { parse_mode: "Markdown" });
});
}
