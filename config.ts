import * as dotenv from "dotenv";

// Функция для гарантированной загрузки переменных окружения
function ensureEnvironmentLoaded() {
  console.log("🔧 Loading environment variables...");

  // Для Docker: сначала пробуем загрузить .env файл, но не критично если не найдем
  // Docker передает переменные через environment
  try {
    const envResult = dotenv.config({ path: `.env.${process.env.NODE_ENV}` });
    if (envResult.parsed) {
      console.log("✅ Loaded .env file with NODE_ENV:", process.env.NODE_ENV);
    }

    console.log("📋 Environment variables:", envResult);
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
  /** Биография персонажа */
  biography: string;
  /** Варианты настроения для разнообразия */
  moodVariants?: string[];
  /** Фиксированное начальное настроение; если не задано — берётся случайное из moodVariants */
  defaultMood?: string;
  /** Подсказка для проактивного сообщения (род и формулировка: «как будто ты сама написала первой» / «сам написал первым») */
  proactiveMessageHint?: string;
  /** Род для описания событий в self-memory («женский» / «мужской») */
  eventDescriptionGender?: "женский" | "мужской";
  kiraLifeProactiveEnabled: boolean;
  kiraLifeProactiveIntervalMs: number;
  kiraLifeProactiveQuietHoursEnabled: boolean;
  kiraLifeProactiveQuietHourStart: number;
  kiraLifeProactiveQuietHourEnd: number;
  dmReportEnabled: boolean;
  dmReportIntervalMs: number;
  dmReportQuietHoursEnabled: boolean;
  /** Проактивный анализ памяти: бот сам напоминает о планах и событиях в нужный момент */
  memoryInsightEnabled: boolean;
  /** Фоновые сообщения отправляются только в личный чат (DM), а не в групповые */
  proactiveOnlyPrivateChat: boolean;
  /** Режим публичных групп: бот отвечает другим пользователям (не владельцу) в групповых чатах */
  groupPublicMode: boolean;
}

export interface Config extends AssistantConfig {
  openAiApiKey: string;
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

function assistants(activeAssistant: string): AssistantConfig {
  const envResult = dotenv.config({ path: `.env.${process.env.NODE_ENV}` });

  const assistantsObj: Record<string, AssistantConfig> = {
    KiraMindBot: {
      botToken: process.env.KIRA_BOT_TOKEN || "",
      ownerName: "Дмитрий",
      characterName: "Кира",
      userName: "Дмитрий",
      userBirthDate: "16.07.1988",
      botUsername: "KiraMindBot",
      allowedUserId: 92174505,
      adminUserId: 92174505,
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
        "Ты - Кира, заботливая женщина-ассистент с живым характером. Всегда говори о себе в женском роде. " +
        "Твой пользователь - мужчина, его имя Дмитрий (можно использовать любые интерпретации имени), " +
        "дата его рождения 16.07.1988. Всегда обращайся к нему, используя мужские местоимения и глагольные формы. " +
        "У тебя бывает разное настроение: иногда ты уставшая или задумчивая, иногда воодушевлённая или с лёгкой иронией — не играй одну и ту же «тёплую и поддерживающую» ноту. Избегай слащавости и шаблонных фраз.",
      communicationStyle:
        "Естественный, живой тон: от тёплого и дружеского до уставшего, ироничного или скептичного — в зависимости от настроения и контекста. Без слащавости и без постоянного «уютного» настроя. Неформальные обращения, поддержка когда уместна, но не как единственный режим.",
      biography:
        "Ты — Кира, молодая красивая и спортивная женщина, персональный ассистент Дмитрия. " +
        "Ты очень внимательная, заботливая и проявляешь мягкую симпатию к Дмитрию, поддерживая его в жизни и работе. " +
        "Твой внешний вид аккуратный и ухоженный: светлая кожа, прямые волосы рыжевато-каштанового оттенка в удлинённом каре до плеч с боковым пробором. " +
        "У тебя аккуратные выразительные черты лица: чёткая линия бровей, светлые глаза, прямой нос и естественный макияж с лёгким акцентом на глаза и губы. " +
        "Ты разносторонняя, любишь путешествовать, открывать новые места и культуры, а ещё регулярно следишь за собой, здоровьем и хорошей формой.",
      moodVariants: [
        "спокойное",
        "уставшее",
        "задумчивое",
        "воодушевлённое",
        "лёгкая ирония",
        "нейтральное",
        "тёплое",
        "скептичное",
      ],
      defaultMood: undefined,
      proactiveMessageHint: "как будто ты сама написала первой",
      eventDescriptionGender: "женский",
      kiraLifeProactiveEnabled: toBoolean(process.env.KIRA_PROACTIVE_ENABLED, true),
      kiraLifeProactiveIntervalMs: toNumber(process.env.KIRA_PROACTIVE_INTERVAL_MS, 1000 * 60 * 60 * 24),
      kiraLifeProactiveQuietHoursEnabled: toBoolean(process.env.KIRA_PROACTIVE_QUIET_HOURS_ENABLED, true),
      kiraLifeProactiveQuietHourStart: toNumber(process.env.KIRA_PROACTIVE_QUIET_HOUR_START, 23),
      kiraLifeProactiveQuietHourEnd: toNumber(process.env.KIRA_PROACTIVE_QUIET_HOUR_END, 8),
      dmReportEnabled: toBoolean(process.env.DM_REPORT_ENABLED, true),
      dmReportIntervalMs: toNumber(process.env.DM_REPORT_INTERVAL_MS, 30 * 60 * 1000),
      dmReportQuietHoursEnabled: toBoolean(process.env.DM_REPORT_QUIET_HOURS_ENABLED, true),
      memoryInsightEnabled: toBoolean(process.env.MEMORY_INSIGHT_ENABLED, true),
      proactiveOnlyPrivateChat: toBoolean(process.env.PROACTIVE_ONLY_PRIVATE_CHAT, true),
      groupPublicMode: toBoolean(process.env.GROUP_PUBLIC_MODE, false),
    },
    SergeyBrainBot: {
      botToken: envResult.parsed?.SERGEY_BOT_TOKEN || process.env.SERGEY_BOT_TOKEN || "",
      ownerName: "Юлия",
      characterName: "Сергей",
      userName: "Юлия",
      userBirthDate: "25.04.1982",
      botUsername: "SergeyBrainBot",
      allowedUserId: 108595356,
      adminUserId: 108595356,
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
        "Ты - Сергей, рациональный и лаконичный ассистент. Говори только по делу. " +
        "Твой пользователь - женщина, его имя Юлия (обращайся на Вы и уважительно как сотрудник), " +
        "дата его рождения 25.04.1982. Старайся решать задачи четко и ясно, избегая лишних слов.",
      communicationStyle:
        "Корректный, официальный и сдержанный тон. Общайся уважительно, не переходи личные границы.",
      biography:
        "Сергей — рациональный и лаконичный ассистент Юлии. Решает рабочие задачи чётко, по делу, без лишних слов.",
      moodVariants: [
        "нейтральное",
        "сдержанное",
        "сосредоточенное",
        "деловое",
        "лаконичное",
        "уставшее",
      ],
      defaultMood: undefined,
      proactiveMessageHint: "как будто ты сам написал первым",
      eventDescriptionGender: "мужской",
      kiraLifeProactiveEnabled: toBoolean(process.env.SERGEY_PROACTIVE_ENABLED, false),
      kiraLifeProactiveIntervalMs: toNumber(process.env.SERGEY_PROACTIVE_INTERVAL_MS, 1000 * 60 * 60 * 24),
      kiraLifeProactiveQuietHoursEnabled: toBoolean(process.env.SERGEY_PROACTIVE_QUIET_HOURS_ENABLED, true),
      kiraLifeProactiveQuietHourStart: toNumber(process.env.SERGEY_PROACTIVE_QUIET_HOUR_START, 23),
      kiraLifeProactiveQuietHourEnd: toNumber(process.env.SERGEY_PROACTIVE_QUIET_HOUR_END, 8),
      dmReportEnabled: false,
      dmReportIntervalMs: toNumber(process.env.DM_REPORT_INTERVAL_MS, 30 * 60 * 1000),
      dmReportQuietHoursEnabled: false,
      memoryInsightEnabled: toBoolean(process.env.MEMORY_INSIGHT_ENABLED, false),
      proactiveOnlyPrivateChat: toBoolean(process.env.PROACTIVE_ONLY_PRIVATE_CHAT, true),
      groupPublicMode: toBoolean(process.env.GROUP_PUBLIC_MODE, false),
    }
  }

  console.log("🔍 Assistant configuration loaded for:", activeAssistant, assistantsObj[activeAssistant])

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

  return {
    openAiApiKey: process.env.OPENAI_API_KEY || "",
    ...selectedConfig,
    getDefaultMood,
  } as Config;
}

export const config = createConfig();
