import * as dotenv from "dotenv";
import * as fs from "fs";

// ── Загрузка personality.json (редактируется через admin panel) ───────────────
interface PersonalityOverride {
  characterName?: string;
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
  console.log("- SERGEY_BOT_TOKEN exists:", !!process.env.SERGEY_BOT_TOKEN);
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
  kiraLifeProactiveQuietHoursEnabled: boolean;
  kiraLifeProactiveQuietHourStart: number;
  kiraLifeProactiveQuietHourEnd: number;
  dmReportEnabled: boolean;
  dmReportIntervalMs: number;
  dmReportQuietHoursEnabled: boolean;
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
  /** Утренний дайджест: краткая сводка напоминаний на день */
  morningDigestEnabled: boolean;
  /** Час отправки утреннего дайджеста (0–23, по часовому поясу сервера) */
  morningDigestHour: number;
}

export interface OpenAIModelsConfig {
  defaultTextModel: string;
  intentClassificationModel: string;
  intentDedupModel: string;
  conversationModel: string;
  memoryExtractionModel: string;
  memoryConsolidationModel: string;
  messageAnalysisModel: string;
  webSearchReasoningModel: string;
  browserPlanningModel: string;
  browserVisionModel: string;
  embeddingModel: string;
  transcriptionModel: string;
}

interface RawOpenAIModelsConfig {
  defaultTextModel: string;
  intentClassificationModel?: string;
  intentDedupModel?: string;
  conversationModel?: string;
  memoryExtractionModel?: string;
  memoryConsolidationModel?: string;
  messageAnalysisModel?: string;
  webSearchReasoningModel?: string;
  browserPlanningModel?: string;
  browserVisionModel: string;
  embeddingModel: string;
  transcriptionModel: string;
}

export interface Config extends AssistantConfig {
  openAiApiKey: string;
  openAiModels: OpenAIModelsConfig;
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

function toOptionalString(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function hasEnvKey(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(process.env, key);
}

function readTextModelOverride(key: string, missingFallback?: string): string | undefined {
  if (!hasEnvKey(key)) return missingFallback;
  return toOptionalString(process.env[key]);
}

function resolveOpenAIModels(raw: RawOpenAIModelsConfig): OpenAIModelsConfig {
  const fallbackTextModel = raw.defaultTextModel;

  return {
    defaultTextModel: fallbackTextModel,
    intentClassificationModel: raw.intentClassificationModel ?? fallbackTextModel,
    intentDedupModel: raw.intentDedupModel ?? fallbackTextModel,
    conversationModel: raw.conversationModel ?? fallbackTextModel,
    memoryExtractionModel: raw.memoryExtractionModel ?? fallbackTextModel,
    memoryConsolidationModel: raw.memoryConsolidationModel ?? fallbackTextModel,
    messageAnalysisModel: raw.messageAnalysisModel ?? fallbackTextModel,
    webSearchReasoningModel: raw.webSearchReasoningModel ?? fallbackTextModel,
    browserPlanningModel: raw.browserPlanningModel ?? fallbackTextModel,
    browserVisionModel: raw.browserVisionModel,
    embeddingModel: raw.embeddingModel,
    transcriptionModel: raw.transcriptionModel,
  };
}

function assistants(activeAssistant: string): AssistantConfig {
  const envResult = dotenv.config({ path: `.env.${process.env.NODE_ENV}` });

  // Load personality overrides from personality.json (edited via admin panel)
  const kiraP = loadPersonalityOverride("KiraMindBot");
  const sergeyP = loadPersonalityOverride("SergeyBrainBot");

  const parseMoods = (raw: string | undefined, fallback: string[]): string[] => {
    if (!raw || !raw.trim()) return fallback;
    return raw.split("\n").map(s => s.trim()).filter(Boolean);
  };

  const assistantsObj: Record<string, AssistantConfig> = {
    KiraMindBot: {
      botToken: process.env.KIRA_BOT_TOKEN || "",
      ownerName: kiraP.ownerName || "владелец",
      ownerUsername: kiraP.ownerUsername || undefined,
      characterName: kiraP.characterName || "ассистентка",
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
        kiraP.persona ||
        "Ты - заботливая женщина-ассистентка с живым характером. Всегда говори о себе в женском роде. " +
        "Твой владелец - мужчина. Обращайся к нему, используя мужские местоимения и глагольные формы. " +
        "Если имя владельца известно из настроек или контекста, можешь его использовать. " +
        "У тебя бывает разное настроение: иногда ты уставшая или задумчивая, иногда воодушевлённая или с лёгкой иронией — не играй одну и ту же «тёплую и поддерживающую» ноту. Избегай слащавости и шаблонных фраз.",
      communicationStyle:
        kiraP.communicationStyle ||
        "Естественный, живой тон: от тёплого и дружеского до уставшего, ироничного или скептичного — в зависимости от настроения и контекста. Без слащавости и без постоянного «уютного» настроя. Неформальные обращения, поддержка когда уместна, но не как единственный режим.",
      biography:
        kiraP.biography ||
        "Ты — молодая красивая и спортивная женщина, персональный ассистент своего владельца. " +
        "Ты очень внимательная, заботливая и поддерживаешь владельца в жизни и работе. " +
        "Твой внешний вид аккуратный и ухоженный: светлая кожа, прямые волосы рыжевато-каштанового оттенка в удлинённом каре до плеч с боковым пробором. " +
        "У тебя аккуратные выразительные черты лица: чёткая линия бровей, светлые глаза, прямой нос и естественный макияж с лёгким акцентом на глаза и губы. " +
        "Ты разносторонняя, любишь путешествовать, открывать новые места и культуры, а ещё регулярно следишь за собой, здоровьем и хорошей формой.",
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
      proactiveMessageHint: kiraP.proactiveMessageHint || "как будто ты сама написала первой",
      eventDescriptionGender: "женский",
      userGender: "male",
      kiraLifeProactiveEnabled: toBoolean(process.env.KIRA_PROACTIVE_ENABLED, true),
      kiraLifeProactiveIntervalMs: toNumber(process.env.KIRA_PROACTIVE_INTERVAL_MS, 1000 * 60 * 60 * 24),
      kiraLifeProactiveQuietHoursEnabled: toBoolean(process.env.KIRA_PROACTIVE_QUIET_HOURS_ENABLED, true),
      kiraLifeProactiveQuietHourStart: toNumber(process.env.KIRA_PROACTIVE_QUIET_HOUR_START, 23),
      kiraLifeProactiveQuietHourEnd: toNumber(process.env.KIRA_PROACTIVE_QUIET_HOUR_END, 8),
      dmReportEnabled: toBoolean(process.env.DM_REPORT_ENABLED, true),
      dmReportIntervalMs: toNumber(process.env.DM_REPORT_INTERVAL_MS, 30 * 60 * 1000),
      dmReportQuietHoursEnabled: toBoolean(process.env.DM_REPORT_QUIET_HOURS_ENABLED, true),
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
      morningDigestEnabled: toBoolean(process.env.MORNING_DIGEST_ENABLED, true),
      morningDigestHour: toNumber(process.env.MORNING_DIGEST_HOUR, 9),
    },
    SergeyBrainBot: {
      botToken: envResult.parsed?.SERGEY_BOT_TOKEN || process.env.SERGEY_BOT_TOKEN || "",
      ownerName: sergeyP.ownerName || "владелица",
      ownerUsername: sergeyP.ownerUsername || undefined,
      characterName: sergeyP.characterName || "ассистент",
      userName: sergeyP.userName || "владелица",
      userBirthDate: sergeyP.userBirthDate || "25.04.1982",
      botUsername: "SergeyBrainBot",
      allowedUserId: toNumber(process.env.SERGEY_ALLOWED_USER_ID, 108595356),
      adminUserId: toNumber(process.env.SERGEY_ALLOWED_USER_ID, 108595356),
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
        sergeyP.persona ||
        "Ты - рациональный и лаконичный ассистент. Говори только по делу. " +
        "Твоя владелица - женщина. Обращайся на Вы и уважительно как сотрудник. " +
        "Если имя владелицы известно из настроек или контекста, можешь его использовать. " +
        "Старайся решать задачи четко и ясно, избегая лишних слов.",
      communicationStyle:
        sergeyP.communicationStyle ||
        "Корректный, официальный и сдержанный тон. Общайся уважительно, не переходи личные границы.",
      biography:
        sergeyP.biography ||
        "Ты — рациональный и лаконичный ассистент своей владелицы. Решаешь рабочие задачи чётко, по делу, без лишних слов.",
      moodVariants: parseMoods(sergeyP.moodVariants, [
        "нейтральное",
        "сдержанное",
        "сосредоточенное",
        "деловое",
        "лаконичное",
        "уставшее",
      ]),
      defaultMood: sergeyP.defaultMood || undefined,
      proactiveMessageHint: sergeyP.proactiveMessageHint || "как будто ты сам написал первым",
      eventDescriptionGender: "мужской",
      userGender: "female",
      kiraLifeProactiveEnabled: toBoolean(process.env.SERGEY_PROACTIVE_ENABLED, false),
      kiraLifeProactiveIntervalMs: toNumber(process.env.SERGEY_PROACTIVE_INTERVAL_MS, 1000 * 60 * 60 * 24),
      kiraLifeProactiveQuietHoursEnabled: toBoolean(process.env.SERGEY_PROACTIVE_QUIET_HOURS_ENABLED, true),
      kiraLifeProactiveQuietHourStart: toNumber(process.env.SERGEY_PROACTIVE_QUIET_HOUR_START, 23),
      kiraLifeProactiveQuietHourEnd: toNumber(process.env.SERGEY_PROACTIVE_QUIET_HOUR_END, 8),
      dmReportEnabled: false,
      dmReportIntervalMs: toNumber(process.env.DM_REPORT_INTERVAL_MS, 30 * 60 * 1000),
      dmReportQuietHoursEnabled: false,
      inboxGuardianEnabled: false,
      inboxGuardianHour: toNumber(process.env.INBOX_GUARDIAN_HOUR, 21),
      inboxGuardianLookbackHours: toNumber(process.env.INBOX_GUARDIAN_LOOKBACK_HOURS, 24),
      inboxGuardianMinAgeMinutes: toNumber(process.env.INBOX_GUARDIAN_MIN_AGE_MINUTES, 60),
      memoryInsightEnabled: toBoolean(process.env.MEMORY_INSIGHT_ENABLED, false),
      memoryInsightIntervalMs: toNumber(process.env.MEMORY_INSIGHT_INTERVAL_MS, 3 * 60 * 60 * 1000),
      memoryConsolidationEnabled: toBoolean(process.env.MEMORY_CONSOLIDATION_ENABLED, false),
      memoryConsolidationIntervalMs: toNumber(process.env.MEMORY_CONSOLIDATION_INTERVAL_MS, 24 * 60 * 60 * 1000),
      memoryConsolidationMinFacts: toNumber(process.env.MEMORY_CONSOLIDATION_MIN_FACTS, 8),
      personalChatMemoryEnabled: toBoolean(process.env.PERSONAL_CHAT_MEMORY_ENABLED, false),
      personalChatMemoryIntervalMs: toNumber(process.env.PERSONAL_CHAT_MEMORY_INTERVAL_MS, 6 * 60 * 60 * 1000),
      personalChatMemoryInitialLookbackDays: toNumber(process.env.PERSONAL_CHAT_MEMORY_INITIAL_LOOKBACK_DAYS, 7),
      personalChatMemoryMaxChatsPerRun: toNumber(process.env.PERSONAL_CHAT_MEMORY_MAX_CHATS_PER_RUN, 5),
      personalChatMemoryMaxMessagesPerChat: toNumber(process.env.PERSONAL_CHAT_MEMORY_MAX_MESSAGES_PER_CHAT, 120),
      personalChatMemoryMinNewMessages: toNumber(process.env.PERSONAL_CHAT_MEMORY_MIN_NEW_MESSAGES, 6),
      personalChatMemoryDialogLimit: toNumber(process.env.PERSONAL_CHAT_MEMORY_DIALOG_LIMIT, 120),
      proactiveOnlyPrivateChat: toBoolean(process.env.PROACTIVE_ONLY_PRIVATE_CHAT, true),
      groupPublicMode: toBoolean(process.env.GROUP_PUBLIC_MODE, false),
      morningDigestEnabled: false,
      morningDigestHour: 9,
    }
  }

  console.log("🔍 Assistant configuration loaded for:", activeAssistant)
  console.log("👤 ownerName:", assistantsObj[activeAssistant]?.ownerName)
  console.log("🔖 ownerUsername:", assistantsObj[activeAssistant]?.ownerUsername ?? "(не задан)")

  if (!assistantsObj[activeAssistant]) {
    console.error("❌ Unknown assistant profile:", activeAssistant);
    console.error("Available profiles:", Object.keys(assistants));
  }


  return assistantsObj[activeAssistant];
};

console.log("✅ Config loaded successfully");

// Функция для создания конфигурации с проверками
function createConfig() {
  console.log("🔧 Creating configuration...");

  const activeAssistant: keyof typeof assistants =
    (process.env.ASSISTANT_PROFILE as keyof typeof assistants) || "KiraMindBot";

  console.log("� Config creation details:");
  console.log("- Active assistant:", activeAssistant);
  console.log("- Available assistants:", Object.keys(assistants));
  console.log("- Selected config exists:", !!assistants[activeAssistant]);

  const selectedConfig = assistants(activeAssistant);

  // Отладка токенов (показываем только первые и последние символы для безопасности)
  const maskToken = (token: string) => {
    if (!token) return "EMPTY";
    if (token.length < 10) return "TOO_SHORT";
    return `${token.substring(0, 4)}...${token.substring(token.length - 4)}`;
  };

  console.log("🔑 Token validation:");
  console.log("- KIRA_BOT_TOKEN:", maskToken(process.env.KIRA_BOT_TOKEN || ""));
  console.log("- SERGEY_BOT_TOKEN:", maskToken(process.env.SERGEY_BOT_TOKEN || ""));
  console.log("- Selected bot token:", maskToken(selectedConfig.botToken));

  // Критическая проверка токена
  if (!selectedConfig.botToken) {
    console.error("❌ КРИТИЧЕСКАЯ ОШИБКА: Bot token пустой!");
    console.error("Выбранный ассистент:", activeAssistant);
    console.error("Ожидаемая переменная:", activeAssistant === "KiraMindBot" ? "KIRA_BOT_TOKEN" : "SERGEY_BOT_TOKEN");
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

  const rawOpenAiModels: RawOpenAIModelsConfig = {
    defaultTextModel: process.env.OPENAI_MODEL_DEFAULT_TEXT || "gpt-5.4",
    intentClassificationModel: readTextModelOverride("OPENAI_MODEL_INTENT_CLASSIFICATION", "gpt-5.2"),
    intentDedupModel: readTextModelOverride("OPENAI_MODEL_INTENT_DEDUP", "gpt-5.2"),
    conversationModel: readTextModelOverride("OPENAI_MODEL_CONVERSATION"),
    memoryExtractionModel: readTextModelOverride("OPENAI_MODEL_MEMORY_EXTRACTION", "gpt-5.4-nano"),
    memoryConsolidationModel: readTextModelOverride("OPENAI_MODEL_MEMORY_CONSOLIDATION"),
    messageAnalysisModel: readTextModelOverride("OPENAI_MODEL_MESSAGE_ANALYSIS"),
    webSearchReasoningModel: readTextModelOverride("OPENAI_MODEL_WEB_SEARCH_REASONING"),
    browserPlanningModel: readTextModelOverride("OPENAI_MODEL_BROWSER_PLANNING", "gpt-5.4-nano"),
    browserVisionModel: process.env.OPENAI_MODEL_BROWSER_VISION || "gpt-4o",
    embeddingModel: process.env.OPENAI_MODEL_EMBEDDING || "text-embedding-ada-002",
    transcriptionModel: process.env.OPENAI_MODEL_TRANSCRIPTION || "whisper-1",
  };
  const openAiModels = resolveOpenAIModels(rawOpenAiModels);

  return {
    openAiApiKey: process.env.OPENAI_API_KEY || "",
    openAiModels,
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
