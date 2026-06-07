import { Bot, session } from "grammy";
import { TypeORMSessionStorage } from "./services/SessionStorage";
import { BotContext, SessionData } from "./types";
import { registerCallback } from "./callbacks";
import { handleUnauthorizedUserMessage } from "./agents/unauthorizedUserAgent";
import { handleGroupPublicUserMessage } from "./agents/groupPublicAgent";
import { devLog } from "./utils";
import { saveAllowedUserChatId } from "./utils/allowedUserChatStore";
import { upsertChat, isChatPublicMode } from "./services/chatRegistry";
import openai, { openAiModels } from "./openai";
import { getBotPersona } from "./persona";
import { config } from "./config";
import { pushGroupChatMessage } from "./stores/GroupChatBuffer";
import { isBotMentioned, isMessageReplyToBot } from "./utils/groupChatContext";
import { GroupChatMessageRepository } from "./services/GroupChatMessageRepository";

const DISMISSAL_VARIANTS = [
  "занята важными делами",
  "слушает только одного человека",
  "не в настроении заводить новые знакомства",
  "уже занята",
  "работает в приватном режиме",
];

// Rate limiting: userId → timestamp последнего dismissal (3 минуты cooldown)
const dismissalCooldown = new Map<number, number>();
const DISMISSAL_COOLDOWN_MS = 3 * 60 * 1000;

async function handleGroupPrivateDismissal(ctx: BotContext): Promise<void> {
  const userName = ctx.from?.first_name || "незнакомец";
  const hint = DISMISSAL_VARIANTS[Math.floor(Math.random() * DISMISSAL_VARIANTS.length)];

  try {
    const resp = await openai.chat.completions.create({
      model: openAiModels.memoryExtractionModel,
      messages: [
        {
          role: "system",
          content:
            `${getBotPersona()}\n` +
            `Тебя упомянули в групповом чате незнакомый пользователь, но ты работаешь только с ${config.ownerName} и не общаешься с посторонними. ` +
            `Придумай одну короткую (1 предложение), остроумную и немного дерзкую отшутку на русском. ` +
            `Скажи, что ${hint}, и принимаешь команды только от своего владельца. Без объяснений, только реплика.`,
        },
        {
          role: "user",
          content: `Пользователь ${userName} написал мне в групповом чате.`,
        },
      ],
      temperature: 1,
    });

    const reply = resp.choices[0]?.message?.content?.trim();
    if (reply) {
      await ctx.reply(reply);
    }
  } catch (error) {
    console.error("[group-dismissal] error:", error);
  }
}

// Функция для гарантированной загрузки конфигурации
function ensureConfigLoaded() {
  console.log("🔧 Ensuring config is properly loaded...");

  try {
    // Принудительно пересоздаем конфигурацию
    delete require.cache[require.resolve("./config")];
    const { config } = require("./config");

    console.log("📋 Config validation:");
    console.log("- botToken exists:", !!config.botToken);
    console.log("- botToken length:", config.botToken?.length || 0);
    console.log("- characterName:", config.characterName);
    console.log("- allowedUserId:", config.allowedUserId);

    if (!config.botToken) {
      throw new Error("Config loaded but botToken is empty!");
    }

    return config;
  } catch (error) {
    console.error("❌ Error loading config:", error);

    // Fallback: попробуем создать конфигурацию напрямую
    console.log("🔄 Trying fallback config creation...");

    const activeAssistant = process.env.ASSISTANT_PROFILE || "KiraMindBot";
    const botToken = activeAssistant === "SergeyBrainBot"
      ? process.env.SERGEY_BOT_TOKEN
      : process.env.KIRA_BOT_TOKEN;

    if (!botToken) {
      throw new Error(`No bot token found for profile: ${activeAssistant}`);
    }

    return {
      botToken,
      characterName: "Ассистент",
      allowedUserId: activeAssistant === "SergeyBrainBot" ? 108595356 : 92174505,
      openAiApiKey: process.env.OPENAI_API_KEY || "",
    };
  }
}

function createInitialSession(): SessionData {
  return {
    reminders: [],
    messageHistory: [],
    dialogueSummary: "",
    lastSummarizedIndex: -1,
    unauthorizedChat: undefined,
    domains: {},
    sentMessages: {},
  };
}

function ensureSessionDefaults(data: SessionData): SessionData {
  if (!Array.isArray(data.reminders)) data.reminders = [];
  if (!Array.isArray(data.messageHistory)) data.messageHistory = [];
  if (typeof data.dialogueSummary !== "string") data.dialogueSummary = "";
  if (typeof data.lastSummarizedIndex !== "number") data.lastSummarizedIndex = -1;
  if (!data.domains || typeof data.domains !== "object") data.domains = {};
  if (!data.sentMessages || typeof data.sentMessages !== "object") data.sentMessages = {};
  return data;
}

export function createBot() {
  // Гарантированная загрузка конфигурации
  const config = ensureConfigLoaded();

  // КРИТИЧЕСКАЯ ОТЛАДКА
  console.log("🔍 Bot.ts Debug:");
  console.log("NODE_ENV:", process.env.NODE_ENV);
  console.log("ASSISTANT_PROFILE:", process.env.ASSISTANT_PROFILE);
  console.log("SERGEY_BOT_TOKEN exists:", !!process.env.SERGEY_BOT_TOKEN);
  console.log("KIRA_BOT_TOKEN exists:", !!process.env.KIRA_BOT_TOKEN);

  // Маскируем токены для безопасности
  const maskToken = (token: string) => {
    if (!token) return "EMPTY";
    if (token.length < 10) return "TOO_SHORT";
    return `${token.substring(0, 4)}...${token.substring(token.length - 4)}`;
  };

  console.log("SERGEY_BOT_TOKEN value:", maskToken(process.env.SERGEY_BOT_TOKEN || ""));
  console.log("KIRA_BOT_TOKEN value:", maskToken(process.env.KIRA_BOT_TOKEN || ""));
  console.log("config.botToken:", maskToken(config.botToken));
  console.log("config object keys:", Object.keys(config));
  console.log("config.characterName:", config.characterName);
  console.log("config.botUsername:", config.botUsername);

  // Проверяем, что токен не пустой ПЕРЕД созданием бота
  if (!config.botToken || config.botToken.trim() === "") {
    console.error("❌ КРИТИЧЕСКАЯ ОШИБКА: config.botToken пустой!");
    console.error("Config summary:", JSON.stringify({
      characterName: config.characterName,
      botUsername: config.botUsername,
      allowedUserId: config.allowedUserId,
      botTokenExists: Boolean(config.botToken),
      openAiApiKeyExists: Boolean(config.openAiApiKey),
    }, null, 2));

    // Пробуем прямую проверку переменных окружения
    console.error("Прямая проверка env переменных:");
    console.error("process.env.SERGEY_BOT_TOKEN:", !!process.env.SERGEY_BOT_TOKEN);
    console.error("process.env.KIRA_BOT_TOKEN:", !!process.env.KIRA_BOT_TOKEN);

    // Попробуем использовать токен напрямую из env
    const directToken = process.env.ASSISTANT_PROFILE === "SergeyBrainBot"
      ? process.env.SERGEY_BOT_TOKEN
      : process.env.KIRA_BOT_TOKEN;

    console.error("Попытка использовать токен напрямую:", maskToken(directToken || ""));

    if (directToken) {
      console.log("✅ Найден токен напрямую из env, используем его");
      const bot = new Bot<BotContext>(directToken);
      setupBot(bot, config);
      return bot;
    }

    throw new Error(`Bot token пустой! ASSISTANT_PROFILE: ${process.env.ASSISTANT_PROFILE}, config.botToken: "${config.botToken}"`);
  }

  console.log("✅ Токен найден, создаем бота");
  const bot = new Bot<BotContext>(config.botToken);
  setupBot(bot, config);
  return bot;
}

function setupBot(bot: Bot<BotContext>, config: any) {
  bot.use(session({
    initial(): SessionData {
      return createInitialSession();
    },
    storage: new TypeORMSessionStorage(),
  }));

  // В групповых чатах реагируем только на явные упоминания бота (или команды)
  bot.use(async (ctx, next) => {
    const chatType = ctx.chat?.type;
    if (chatType === 'group' || chatType === 'supergroup') {
      // Callback-запросы (кнопки) всегда пропускаем
      if (ctx.callbackQuery) {
        await next();
        return;
      }
      const text = ctx.message?.text || ctx.message?.caption || '';
      // Команды пропускаем
      if (text.startsWith('/')) {
        await next();
        return;
      }

      const botUsername = config.botUsername.toLowerCase();

      // Сохраняем все сообщения в буфер для контекста (до фильтра по упоминанию).
      // Сообщения других ботов тоже важны: в группах часто спрашивают мнение Киры о них.
      const senderUsername = ctx.from?.username?.toLowerCase();
      const isOwnBotMessage = Boolean(ctx.from?.is_bot && senderUsername && senderUsername === botUsername);
      if (text && ctx.from && !isOwnBotMessage) {
        const groupMessage = {
          senderName: ctx.from.first_name || ctx.from.username || 'Участник',
          text,
          date: new Date((ctx.message?.date ?? 0) * 1000),
          messageId: ctx.message?.message_id,
          senderId: ctx.from.id,
          isBot: ctx.from.is_bot,
        };
        pushGroupChatMessage(ctx.chat!.id, groupMessage);
        GroupChatMessageRepository.save(ctx.chat!.id, groupMessage).catch((error) => {
          console.error('[group-context] persist message failed:', error);
        });
      }

      const isMentioned = isBotMentioned(ctx, text, botUsername);
      const isReplyToBot = isMessageReplyToBot(ctx, botUsername);
      if (!isMentioned && !isReplyToBot) return;
    }
    await next();
  });

  bot.use(async (ctx, next) => {
    if (!ctx.session) {
      ctx.session = createInitialSession();
    } else {
      ensureSessionDefaults(ctx.session);
    }

    ctx.session.isAllowedUser = ctx.from?.id === config.allowedUserId;
    devLog(`User ID: ${ctx.from?.id}, Allowed: ${ctx.session.isAllowedUser}`);

    if (ctx.session.isAllowedUser) {
      if (ctx.chat?.type === "private") {
        await saveAllowedUserChatId(ctx.chat.id);
      }
      if (ctx.chat) {
        const chat = ctx.chat;
        const title = chat.type === 'private'
          ? [('first_name' in chat ? chat.first_name : ''), ('last_name' in chat ? chat.last_name : '')].filter(Boolean).join(' ') || 'Личный чат'
          : ('title' in chat ? chat.title : '') || 'Группа';
        upsertChat({
          chatId: chat.id,
          title,
          chatType: chat.type,
          username: 'username' in chat ? chat.username : undefined,
        });
      }
      await next();
    } else {
      const isGroupChat = ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";
      if (isGroupChat && ctx.callbackQuery) {
        // Не-владелец нажал кнопку в группе — тихо отвечаем toast'ом, не спамим в чат
        await ctx.answerCallbackQuery({ text: "Кнопки только для владельца бота" }).catch(() => { });
      } else if (isGroupChat && (config.groupPublicMode || await isChatPublicMode(ctx.chat!.id))) {
        devLog(`Group public mode: handling message from user ${ctx.from?.id}`);
        await handleGroupPublicUserMessage(ctx);
      } else if (isGroupChat) {
        // Rate limiting: не чаще одного dismissal в 3 минуты на пользователя
        const userId = ctx.from?.id ?? 0;
        const lastSent = dismissalCooldown.get(userId) ?? 0;
        if (Date.now() - lastSent < DISMISSAL_COOLDOWN_MS) {
          devLog(`Group dismissal skipped (cooldown) for user ${userId}`);
        } else {
          devLog(`Group private mode: witty dismissal for user ${userId}`);
          dismissalCooldown.set(userId, Date.now());
          await handleGroupPrivateDismissal(ctx);
        }
      } else {
        devLog(`Access by unauthorized user: ${ctx.from?.id}`);
        await handleUnauthorizedUserMessage(ctx);
      }
    }
  });

  registerCallback(bot);
}
