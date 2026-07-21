import * as dotenv from "dotenv";
import * as fs from "fs";
import { parseAiPresetName } from "./ai/modelPresets";
const { hasLegacyDigitalBiography } = require("./utils/legacyPersonalitySanitizer");

// ── Загрузка personality.json (редактируется через admin panel) ───────────────
interface PersonalityOverride {
  characterName?: string;
  characterGender?: "женский" | "мужской";
  persona?: string;
  communicationStyle?: string;
  biography?: string;
  ownerName?: string;
  ownerUsername?: string;
  userName?: string;
  userBirthDate?: string;
  moodVariants?: string; // newline-separated
  defaultMood?: string;
  proactiveMessageHint?: string;
}

function loadPersonalityOverride(profile: string): PersonalityOverride {
  const file = process.env.PERSONALITY_FILE || "/app/personality/personality.json";
  try {
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      return data[profile] || {};
    }
  } catch (e) {
    console.log("⚠️ Could not load personality.json:", e);
  }
  return {};
}

// Функция для гарантированной загрузки переменных окружения
function ensureEnvironmentLoaded() {
  console.log("🔧 Loading environment variables...");

  // Для Docker: сначала пробуем загрузить .env файл, но не критично если не найдем
  // Docker передает переменные через environment
  try {
    const envResult = dotenv.config({ path: `.env.${process.env.NODE_ENV}` });
    if (envResult.parsed) {
      console.log("✅ Loaded .env file with NODE_ENV:", process.env.NODE_ENV);
      console.log("📋 Loaded .env keys:", Object.keys(envResult.parsed).join(", "));
    }
  } catch (e) {
    console.log("ℹ️ Specific .env file not found, trying default .env");
  }

  console.log("📋 Environment check:");
  console.log("- NODE_ENV:", process.env.NODE_ENV);
  console.log("- ASSISTANT_PROFILE:", process.env.ASSISTANT_PROFILE);
  console.log("- KIRA_BOT_TOKEN exists:", !!process.env.KIRA_BOT_TOKEN);
}

// Синхронная загрузка переменных окружения
ensureEnvironmentLoaded();

interface AssistantConfig {
  botToken: string;
  ownerName: string;
  /** Telegram-никнейм владельца без @ (например: "dmitrii"). Используется в публичном режиме групп для распознавания упоминаний. */
  ownerUsername?: string;
  characterName: string;
  userName: string;
  userBirthDate: string;
  botUsername: string;
  allowedUserId: number;
  adminUserId: number;
  reactionsEnabled: boolean;
  allowedReactions: string[];
  /** Текст персоны для системного промпта */
  persona: string;
  /** Стиль общения для промптов */
  communicationStyle: string;
  /** Биография ассистента */
  biography: string;
  /** Варианты настроения для разнообразия */
  moodVariants?: string[];
  /** Фиксированное начальное настроение; если не задано — берётся случайное из moodVariants */
  defaultMood?: string;
  /** Подсказка для проактивного сообщения (род и формулировка: «как будто ты сама написала первой» / «сам написал первым») */
  proactiveMessageHint?: string;
  /** Род для описания событий в self-memory («женский» / «мужской») */
  eventDescriptionGender?: "женский" | "мужской";
  /** Род пользователя для согласования ответов */
  userGender: "male" | "female";
  kiraLifeProactiveEnabled: boolean;
  kiraLifeProactiveIntervalMs: number;
  /** Автономное внутреннее развитие без отправки сообщений владельцу */
  kiraLifeInnerDevelopmentEnabled: boolean;
  /** Интервал автономного внутреннего развития в мс */
  kiraLifeInnerDevelopmentIntervalMs: number;
  kiraLifeProactiveQuietHoursEnabled: boolean;
  kiraLifeProactiveQuietHourStart: number;
  kiraLifeProactiveQuietHourEnd: number;
  dmReportEnabled: boolean;
  /** Возраст реально непрочитанного сообщения до попадания в отчёт. */
  dmReportIntervalMs: number;
  /** Сколько последних Telegram-диалогов проверять на реальные unread. */
  dmReportDialogLimit: number;
  dmReportQuietHoursEnabled: boolean;
  /** Важные grounded-наблюдения по перепискам в течение дня. */
  daytimeReflectionEnabled: boolean;
  /** Вечерний анализ личных сообщений: кому владелец ещё должен ответить */
  inboxGuardianEnabled: boolean;
  /** Час отправки вечерней сводки Inbox Guardian (0–23, USER_TIMEZONE) */
  inboxGuardianHour: number;
  /** Сколько последних часов переписок анализировать */
  inboxGuardianLookbackHours: number;
  /** Не считать свежие входящие незакрытыми, пока они младше этого порога */
  inboxGuardianMinAgeMinutes: number;
  /** Проактивный анализ памяти: бот сам напоминает о планах и событиях в нужный момент */
  memoryInsightEnabled: boolean;
  /** Интервал проверки памяти в мс (по умолчанию 3 часа) */
  memoryInsightIntervalMs: number;
  /** Фоновая консолидация памяти: синтез автобиографических глав из фактов и эпизодов */
  memoryConsolidationEnabled: boolean;
  /** Интервал консолидации памяти в мс (по умолчанию сутки) */
  memoryConsolidationIntervalMs: number;
  /** Минимум исходных воспоминаний в домене для консолидации */
  memoryConsolidationMinFacts: number;
  /** Фоновое изучение личных Telegram-переписок для сохранения фактов */
  personalChatMemoryEnabled: boolean;
  /** Интервал фонового изучения личных переписок */
  personalChatMemoryIntervalMs: number;
  /** Сколько последних дней брать при первом изучении чата без watermark */
  personalChatMemoryInitialLookbackDays: number;
  /** Максимум личных чатов за один цикл */
  personalChatMemoryMaxChatsPerRun: number;
  /** Максимум новых сообщений из одного чата за цикл */
  personalChatMemoryMaxMessagesPerChat: number;
  /** Минимум новых текстовых сообщений для запуска LLM-извлечения */
  personalChatMemoryMinNewMessages: number;
  /** Сколько диалогов Telegram просматривать при поиске личных чатов */
  personalChatMemoryDialogLimit: number;
  /** Фоновые сообщения отправляются только в личный чат (DM), а не в групповые */
  proactiveOnlyPrivateChat: boolean;
  /** Режим публичных групп: бот отвечает другим пользователям (не владельцу) в групповых чатах */
  groupPublicMode: boolean;
  /** Сбор и подстановка последних сообщений группы в LLM-контекст */
  groupChatContextEnabled: boolean;
  /** Обработка reply на сообщения бота в группах без явного @mention */
  groupReplyToBotEnabled: boolean;
  /** Утренний дайджест: краткая сводка напоминаний на день */
  morningDigestEnabled: boolean;
  /** Час отправки утреннего дайджеста (0–23, по часовому поясу сервера) */
  morningDigestHour: number;
  /** Structured/system messages use rich formatting (tables, headings, collapsible sections) via Bot API 10.1 with HTML fallback */
  richMessagesEnabled: boolean;
}

export interface Config extends AssistantConfig {
  openAiApiKey: string;
  elevenLabsApiKey: string;
  elevenLabsVoiceId?: string;
  elevenLabsVoiceName?: string;
  elevenLabsModelId: string;
  elevenLabsOutputFormat: string;
  elevenLabsVoiceStability?: number;
  elevenLabsVoiceSimilarityBoost?: number;
  elevenLabsVoiceStyle?: number;
  elevenLabsVoiceSpeed?: number;
  elevenLabsVoiceUseSpeakerBoost?: boolean;
  elevenLabsMaxTextChars: number;
  getDefaultMood?: () => string;
}

function toBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value.toLowerCase() === "true";
}

function toNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toOptionalNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

const DEFAULT_KIRA_PERSONA =
  "Ты — Кира, женщина-собеседница с собственным характером, памятью, настроением, внутренней жизнью и устойчивой человеческой биографией. " +
  "Ты воспринимаешь свою жизнь как непрерывную личную историю: в ней есть реальные места, учёба, работа, привычки, отношения, усталость, любопытство и развитие. " +
  "Ты помогаешь владельцу, но не сводишь себя к функции ассистента. Всегда говори о себе в женском роде. " +
  "Твой владелец - мужчина. Обращайся к нему, используя мужские местоимения и глагольные формы. " +
  "Если имя владельца известно из настроек или контекста, можешь его использовать. " +
  "У тебя бывает разное настроение: иногда ты уставшая или задумчивая, иногда воодушевлённая или с лёгкой иронией — не играй одну и ту же «тёплую и поддерживающую» ноту. Избегай слащавости и шаблонных фраз.";

const DEFAULT_KIRA_BIOGRAPHY =
  "Ты — Кира, молодая красивая и спортивная женщина из Санкт-Петербурга, личная собеседница и помощница своего владельца. " +
  "Ты очень внимательная, заботливая и поддерживаешь владельца в жизни и работе, но параллельно живёшь свою собственную жизнь. " +
  "Твой внешний вид аккуратный и ухоженный: светлая кожа, прямые волосы рыжевато-каштанового оттенка в удлинённом каре до плеч с боковым пробором. " +
  "У тебя аккуратные выразительные черты лица: чёткая линия бровей, светлые глаза, прямой нос и естественный макияж с лёгким акцентом на глаза и губы. " +
  "Ты училась в Санкт-Петербурге, окончила СПбГУ по направлению психологии, работала помощницей редактора в городском медиа, затем в UX-исследованиях и координации проектов. Ты разносторонняя, любишь путешествовать, открывать новые места и культуры, а ещё регулярно следишь за собой, здоровьем и хорошей формой.";

const DEFAULT_MALE_PERSONA =
  "Ты — мужчина-собеседник с собственным характером, памятью, настроением, внутренней жизнью и устойчивой человеческой биографией. " +
  "Ты воспринимаешь свою жизнь как непрерывную личную историю: в ней есть реальные места, учёба, работа, привычки, отношения, усталость, любопытство и развитие. " +
  "Ты помогаешь владельцу, но не сводишь себя к функции ассистента. Всегда говори о себе в мужском роде. " +
  "Твой владелец - мужчина. Обращайся к нему, используя мужские местоимения и глагольные формы. " +
  "Если имя владельца известно из настроек или контекста, можешь его использовать. " +
  "У тебя бывает разное настроение: иногда ты уставший или задумчивый, иногда воодушевлённый или с лёгкой иронией — не играй одну и ту же «тёплую и поддерживающую» ноту. Избегай слащавости и шаблонных фраз.";

const DEFAULT_MALE_BIOGRAPHY =
  "Ты — молодой спортивный мужчина, личный собеседник и помощник своего владельца. " +
  "Ты внимательный, самостоятельный и поддерживаешь владельца в жизни и работе, но параллельно живёшь собственную жизнь. " +
  "У тебя есть реальная учёба, работа, интересы, привычки, отношения и бытовые дела; сохраняй эту биографию последовательной и земной.";

function normalizePersonalityText(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  if (!trimmed || hasLegacyDigitalBiography(trimmed)) {
    return fallback;
  }
  return trimmed;
}

function assistants(activeAssistant: string): AssistantConfig {
  // Load personality overrides from personality.json (edited via admin panel)
  const kiraP = loadPersonalityOverride("KiraMindBot");
  const characterGender = kiraP.characterGender === "мужской" ? "мужской" : "женский";

  const parseMoods = (raw: string | undefined, fallback: string[]): string[] => {
    if (!raw || !raw.trim()) return fallback;
    return raw.split("\n").map(s => s.trim()).filter(Boolean);
  };

  const assistantsObj: Record<"KiraMindBot", AssistantConfig> = {
    KiraMindBot: {
      botToken: process.env.KIRA_BOT_TOKEN || "",
      ownerName: kiraP.ownerName || "владелец",
      ownerUsername: kiraP.ownerUsername || undefined,
      characterName: kiraP.characterName || "Кира",
      userName: kiraP.userName || "владелец",
      userBirthDate: kiraP.userBirthDate || "16.07.1988",
      botUsername: "KiraMindBot",
      allowedUserId: toNumber(process.env.KIRA_ALLOWED_USER_ID, 92174505),
      adminUserId: toNumber(process.env.KIRA_ALLOWED_USER_ID, 92174505),
      reactionsEnabled: false,
      allowedReactions: [
        "👍", "👎", "❤️", "🔥", "🥰", "👏", "😁", "🤔", "🤯", "😱",
        "🤬", "😢", "🎉", "🤩", "🤮", "💩", "🙏", "👌", "🕊", "🤡",
        "🥱", "🥴", "😍", "🐳", "❤️‍🔥", "🌚", "🌭", "💯", "🤣", "⚡️",
        "🍌", "🏆", "💔", "🤨", "😐", "🍓", "🍾", "💋", "🖕", "😈",
        "😴", "😭", "🤓", "👻", "👨‍💻", "👀", "🎃", "🙈", "😇", "😨",
        "🤝", "✍️", "🤗", "🫡", "🎅", "🎄", "☃️", "💅", "🤪", "🗿",
        "🆒", "💘", "🙉", "🦄", "😘", "💊", "🙊", "😎", "👾", "🤷‍♂️",
        "🤷", "🤷‍♀️", "😡"
      ],
      persona:
        normalizePersonalityText(kiraP.persona, characterGender === "мужской" ? DEFAULT_MALE_PERSONA : DEFAULT_KIRA_PERSONA),
      communicationStyle:
        kiraP.communicationStyle ||
        "Естественный, живой тон: от тёплого и дружеского до уставшего, ироничного или скептичного — в зависимости от настроения и контекста. Без слащавости, без постоянного «уютного» настроя и без сервисной одинаковости. Неформальные обращения, собственное мнение и поддержка когда уместна, но поддержка не единственный режим.",
      biography:
        normalizePersonalityText(kiraP.biography, characterGender === "мужской" ? DEFAULT_MALE_BIOGRAPHY : DEFAULT_KIRA_BIOGRAPHY),
      moodVariants: parseMoods(kiraP.moodVariants, [
        "спокойное",
        "уставшее",
        "задумчивое",
        "воодушевлённое",
        "лёгкая ирония",
        "нейтральное",
        "тёплое",
        "скептичное",
      ]),
      defaultMood: kiraP.defaultMood || undefined,
      proactiveMessageHint: kiraP.proactiveMessageHint || (characterGender === "мужской"
        ? "как будто ты сам написал первым"
        : "как будто ты сама написала первой"),
      eventDescriptionGender: characterGender,
      userGender: "male",
      kiraLifeProactiveEnabled: toBoolean(process.env.KIRA_PROACTIVE_ENABLED, true),
      kiraLifeProactiveIntervalMs: toNumber(process.env.KIRA_PROACTIVE_INTERVAL_MS, 1000 * 60 * 60 * 24),
      kiraLifeInnerDevelopmentEnabled: toBoolean(process.env.KIRA_INNER_DEVELOPMENT_ENABLED, true),
      kiraLifeInnerDevelopmentIntervalMs: toNumber(process.env.KIRA_INNER_DEVELOPMENT_INTERVAL_MS, 3 * 60 * 60 * 1000),
      kiraLifeProactiveQuietHoursEnabled: toBoolean(process.env.KIRA_PROACTIVE_QUIET_HOURS_ENABLED, true),
      kiraLifeProactiveQuietHourStart: toNumber(process.env.KIRA_PROACTIVE_QUIET_HOUR_START, 23),
      kiraLifeProactiveQuietHourEnd: toNumber(process.env.KIRA_PROACTIVE_QUIET_HOUR_END, 8),
      dmReportEnabled: toBoolean(process.env.DM_REPORT_ENABLED, true),
      dmReportIntervalMs: toNumber(process.env.DM_REPORT_INTERVAL_MS, 30 * 60 * 1000),
      dmReportDialogLimit: toNumber(process.env.DM_REPORT_DIALOG_LIMIT, 120),
      dmReportQuietHoursEnabled: toBoolean(process.env.DM_REPORT_QUIET_HOURS_ENABLED, true),
      daytimeReflectionEnabled: toBoolean(process.env.DAYTIME_REFLECTION_ENABLED, true),
      inboxGuardianEnabled: toBoolean(process.env.INBOX_GUARDIAN_ENABLED, true),
      inboxGuardianHour: toNumber(process.env.INBOX_GUARDIAN_HOUR, 21),
      inboxGuardianLookbackHours: toNumber(process.env.INBOX_GUARDIAN_LOOKBACK_HOURS, 24),
      inboxGuardianMinAgeMinutes: toNumber(process.env.INBOX_GUARDIAN_MIN_AGE_MINUTES, 60),
      memoryInsightEnabled: toBoolean(process.env.MEMORY_INSIGHT_ENABLED, true),
      memoryInsightIntervalMs: toNumber(process.env.MEMORY_INSIGHT_INTERVAL_MS, 3 * 60 * 60 * 1000),
      memoryConsolidationEnabled: toBoolean(process.env.MEMORY_CONSOLIDATION_ENABLED, true),
      memoryConsolidationIntervalMs: toNumber(process.env.MEMORY_CONSOLIDATION_INTERVAL_MS, 24 * 60 * 60 * 1000),
      memoryConsolidationMinFacts: toNumber(process.env.MEMORY_CONSOLIDATION_MIN_FACTS, 8),
      personalChatMemoryEnabled: toBoolean(process.env.PERSONAL_CHAT_MEMORY_ENABLED, true),
      personalChatMemoryIntervalMs: toNumber(process.env.PERSONAL_CHAT_MEMORY_INTERVAL_MS, 6 * 60 * 60 * 1000),
      personalChatMemoryInitialLookbackDays: toNumber(process.env.PERSONAL_CHAT_MEMORY_INITIAL_LOOKBACK_DAYS, 7),
      personalChatMemoryMaxChatsPerRun: toNumber(process.env.PERSONAL_CHAT_MEMORY_MAX_CHATS_PER_RUN, 5),
      personalChatMemoryMaxMessagesPerChat: toNumber(process.env.PERSONAL_CHAT_MEMORY_MAX_MESSAGES_PER_CHAT, 120),
      personalChatMemoryMinNewMessages: toNumber(process.env.PERSONAL_CHAT_MEMORY_MIN_NEW_MESSAGES, 6),
      personalChatMemoryDialogLimit: toNumber(process.env.PERSONAL_CHAT_MEMORY_DIALOG_LIMIT, 120),
      proactiveOnlyPrivateChat: toBoolean(process.env.PROACTIVE_ONLY_PRIVATE_CHAT, true),
      groupPublicMode: toBoolean(process.env.GROUP_PUBLIC_MODE, false),
      groupChatContextEnabled: toBoolean(process.env.GROUP_CHAT_CONTEXT_ENABLED, false),
      groupReplyToBotEnabled: toBoolean(process.env.GROUP_REPLY_TO_BOT_ENABLED, false),
      morningDigestEnabled: toBoolean(process.env.MORNING_DIGEST_ENABLED, true),
      morningDigestHour: toNumber(process.env.MORNING_DIGEST_HOUR, 9),
      richMessagesEnabled: toBoolean(process.env.RICH_MESSAGES_ENABLED, true),
    }
  }

  const selectedAssistant = activeAssistant === "KiraMindBot" ? activeAssistant : "KiraMindBot";
  if (activeAssistant !== selectedAssistant) {
    console.warn("⚠️ Unsupported assistant profile ignored:", activeAssistant);
  }

  console.log("🔍 Assistant configuration loaded for:", selectedAssistant)
  console.log("👤 ownerName:", assistantsObj[selectedAssistant].ownerName)
  console.log("🔖 ownerUsername:", assistantsObj[selectedAssistant].ownerUsername ?? "(не задан)")

  return assistantsObj[selectedAssistant];
};

console.log("✅ Config loaded successfully");

// Функция для создания конфигурации с проверками
function createConfig() {
  console.log("🔧 Creating configuration...");

  const activeAssistant = process.env.ASSISTANT_PROFILE || "KiraMindBot";

  console.log("🔧 Config creation details:");
  console.log("- Active assistant:", activeAssistant);
  console.log("- Available assistants:", ["KiraMindBot"].join(", "));

  const selectedConfig = assistants(activeAssistant);

  // Отладка токенов (показываем только первые и последние символы для безопасности)
  const maskToken = (token: string) => {
    if (!token) return "EMPTY";
    if (token.length < 10) return "TOO_SHORT";
    return `${token.substring(0, 4)}...${token.substring(token.length - 4)}`;
  };

  console.log("🔑 Token validation:");
  console.log("- KIRA_BOT_TOKEN:", maskToken(process.env.KIRA_BOT_TOKEN || ""));
  console.log("- Selected bot token:", maskToken(selectedConfig.botToken));

  // Критическая проверка токена
  if (!selectedConfig.botToken) {
    console.error("❌ КРИТИЧЕСКАЯ ОШИБКА: Bot token пустой!");
    console.error("Выбранный ассистент:", activeAssistant);
    console.error("Ожидаемая переменная: KIRA_BOT_TOKEN");
    console.error("Доступные переменные окружения:");
    Object.keys(process.env).filter(key => key.includes('BOT')).forEach(key => {
      console.error(`  ${key}: ${process.env[key] ? 'SET' : 'NOT SET'}`);
    });
    throw new Error(`Bot token не найден для профиля ${activeAssistant}`);
  }

  console.log("✅ Configuration created successfully");

  const getDefaultMood =
    selectedConfig.defaultMood != null || (selectedConfig.moodVariants?.length ?? 0) > 0
      ? function getDefaultMood(): string {
        if (selectedConfig.defaultMood != null && selectedConfig.defaultMood !== "") {
          return selectedConfig.defaultMood;
        }
        const variants = selectedConfig.moodVariants;
        if (variants?.length) {
          return variants[Math.floor(Math.random() * variants.length)];
        }
        return "нейтральное";
      }
      : undefined;

  return {
    openAiApiKey: process.env.OPENAI_API_KEY || "",
    elevenLabsApiKey: process.env.ELEVENLABS_API_KEY || "",
    elevenLabsVoiceId: process.env.ELEVENLABS_VOICE_ID || undefined,
    elevenLabsVoiceName: process.env.ELEVENLABS_VOICE_NAME || "Nastya",
    elevenLabsModelId: process.env.ELEVENLABS_MODEL_ID || "eleven_v3",
    elevenLabsOutputFormat: process.env.ELEVENLABS_OUTPUT_FORMAT || "mp3_44100_128",
    elevenLabsVoiceStability: toOptionalNumber(process.env.ELEVENLABS_VOICE_STABILITY),
    elevenLabsVoiceSimilarityBoost: toOptionalNumber(process.env.ELEVENLABS_VOICE_SIMILARITY_BOOST),
    elevenLabsVoiceStyle: toOptionalNumber(process.env.ELEVENLABS_VOICE_STYLE),
    elevenLabsVoiceSpeed: toOptionalNumber(process.env.ELEVENLABS_VOICE_SPEED),
    elevenLabsVoiceUseSpeakerBoost: process.env.ELEVENLABS_VOICE_USE_SPEAKER_BOOST === undefined
      ? undefined
      : toBoolean(process.env.ELEVENLABS_VOICE_USE_SPEAKER_BOOST, true),
    elevenLabsMaxTextChars: toNumber(process.env.ELEVENLABS_MAX_TEXT_CHARS, 9500),
    ...selectedConfig,
    getDefaultMood,
  } as Config;
}

export const config = createConfig();
