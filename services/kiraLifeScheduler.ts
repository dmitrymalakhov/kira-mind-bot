import { Bot } from "grammy";
import { BotContext } from "../types";
import { config } from "../config";
import { getBotPersona, getCommunicationStyle, getBotBiography } from "../persona";
import openai from "../openai";
import {
  addKiraSelfEvent,
  getKiraSelfMemoryState,
  getRecentKiraSelfEvents,
  KiraSelfEvent,
} from "../utils/kiraSelfMemory";
import { getAllowedUserChatId } from "../utils/allowedUserChatStore";

const PROACTIVE_MESSAGE_FORMATS = [
  "поделись чем-то что произошло или что сейчас чувствуешь — искренне, без пафоса",
  "брось мысль или наблюдение, как будто само собой вырвалось",
  "задай Дмитрию вопрос — опираясь на своё событие или просто из любопытства",
  "напиши как будто только что вспомнила что хотела сказать",
  "коротко, как будто между делом что-то мелькнуло в голове",
  "поделись маленькой деталью дня — что заметила, что удивило, что раздражало",
];

let timer: NodeJS.Timeout | undefined;
let isRunning = false;
let lastSentAt = 0;

function getDayContext(): {
  weekday: string;
  isWeekend: boolean;
  timeOfDay: string;
  season: string;
} {
  const now = new Date();
  const day = now.getDay();
  const hour = now.getHours();
  const month = now.getMonth() + 1;

  const weekdays = ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"];

  let timeOfDay: string;
  if (hour >= 6 && hour < 12) timeOfDay = "утро";
  else if (hour >= 12 && hour < 17) timeOfDay = "день";
  else if (hour >= 17 && hour < 22) timeOfDay = "вечер";
  else timeOfDay = "ночь";

  let season: string;
  if (month >= 3 && month <= 5) season = "весна";
  else if (month >= 6 && month <= 8) season = "лето";
  else if (month >= 9 && month <= 11) season = "осень";
  else season = "зима";

  return {
    weekday: weekdays[day],
    isWeekend: day === 0 || day === 6,
    timeOfDay,
    season,
  };
}

function inQuietHours(now: Date): boolean {
  if (!config.kiraLifeProactiveQuietHoursEnabled) {
    return false;
  }

  const hour = now.getHours();
  const start = config.kiraLifeProactiveQuietHourStart;
  const end = config.kiraLifeProactiveQuietHourEnd;

  if (start === end) {
    return true;
  }

  if (start < end) {
    return hour >= start && hour < end;
  }

  return hour >= start || hour < end;
}

async function maybeGenerateLifeEvent(): Promise<KiraSelfEvent> {
  const recentEvents = await getRecentKiraSelfEvents(10);
  const memoryState = await getKiraSelfMemoryState();
  const dayCtx = getDayContext();

  // Collect used topics from recent events + state to avoid repetition
  const usedTopics = Array.from(new Set([
    ...memoryState.recentTopics,
    ...recentEvents.flatMap((e) => e.topics ?? []),
  ])).slice(0, 15);

  const recentDescriptions = recentEvents
    .slice(0, 5)
    .map((e) => `${new Date(e.date).toLocaleDateString("ru-RU", { weekday: "short", day: "numeric" })}: ${e.description}`)
    .join(" | ");

  const response = await openai.chat.completions.create({
    model: "gpt-4.1",
    messages: [
      {
        role: "system",
        content: `${getBotPersona()}\nБиография: ${getBotBiography()}\nСтиль: ${getCommunicationStyle()}`,
      },
      {
        role: "user",
        content:
          `Сгенерируй одно реалистичное событие или мысль из жизни Киры.\n` +
          `Контекст: ${dayCtx.weekday}, ${dayCtx.timeOfDay}, ${dayCtx.season}. ` +
          `${dayCtx.isWeekend ? "Сегодня выходной — возможны другие активности, чем в будни." : "Будний день."}\n\n` +
          `Последние события (для непрерывности, похожее НЕ повторяй): ${recentDescriptions || "нет"}.\n` +
          `Темы которых надо ИЗБЕГАТЬ — уже были недавно: ${usedTopics.join(", ") || "нет"}.\n\n` +
          `Категории для разнообразия (выбери одну, подходящую по контексту дня): тренировка/спорт, встреча с подругой/другом, готовка или новый рецепт, прогулка/природа, рабочие или домашние задачи, чтение книги, сериал/фильм/музыка, покупки/шопинг, уход за собой (маникюр/спа/косметика), путешествие/поездка/планирование поездки, размышление/философская мысль, мелкая неожиданность дня, планирование чего-то интересного.\n\n` +
          `Напиши JSON с полями: description, mood, thought, topics (массив строк 2-4 шт.), type.\n` +
          `description — 1-2 живых предложения с конкретными деталями: что именно, где, с кем (если уместно), что почувствовала. ${config.eventDescriptionGender ?? "женский"} род. Без абстракций.\n` +
          `mood — из набора: ${(config.moodVariants ?? ["спокойное", "уставшее", "задумчивое", "воодушевлённое", "нейтральное", "скептичное"]).join(", ")}. Утром — живее, вечером — спокойнее/устала.\n` +
          `thought — внутренняя реакция, короткая (1 предложение, опционально).\n` +
          `type — одно из: mood, activity, thought, event.`,
      },
    ],
    temperature: 0.9,
    response_format: { type: "json_object" },
  });

  const payload = response.choices[0]?.message?.content || "{}";
  const parsed = JSON.parse(payload) as {
    description?: string;
    mood?: string;
    thought?: string;
    topics?: string[];
    type?: "mood" | "activity" | "thought" | "event";
  };

  const description =
    parsed.description?.trim() ||
    (config.eventDescriptionGender === "мужской"
      ? "Сегодня обычный день, думал о разном."
      : "Сегодня обычный день, думала о разном.");

  return addKiraSelfEvent({
    description,
    mood: parsed.mood,
    thought: parsed.thought,
    topics: parsed.topics,
    type: parsed.type,
  });
}

async function buildProactiveMessage(): Promise<string> {
  const recentEvents = await getRecentKiraSelfEvents(2);
  const state = await getKiraSelfMemoryState();
  const formatHint = PROACTIVE_MESSAGE_FORMATS[Math.floor(Math.random() * PROACTIVE_MESSAGE_FORMATS.length)];

  const response = await openai.chat.completions.create({
    model: "gpt-4.1",
    messages: [
      {
        role: "system",
        content: `${getBotPersona()}\nБиография: ${getBotBiography()}\nСтиль: ${getCommunicationStyle()}`,
      },
      {
        role: "user",
        content:
          `Напиши короткое сообщение для ${config.ownerName} (1-3 предложения), ${config.proactiveMessageHint ?? "как будто ты написала первой"}.\n` +
          `Формат: ${formatHint}.\n` +
          `Опирайся на события: ${recentEvents.map((e) => e.description).join("; ")}.\n` +
          `Текущее настроение: ${state.mood}. Тон должен соответствовать настроению.\n` +
          `Строго: без приветствий-штампов ("Привет!", "Как твои дела?"), без упоминания что ты ИИ, без пояснений. Только само сообщение.`,
      },
    ],
    temperature: 0.85,
  });

  const fallback =
    config.eventDescriptionGender === "мужской"
      ? "Привет, как дела? Хотел спросить, как у тебя."
      : "Привет, как дела? Хотела спросить, как у тебя.";
  return response.choices[0]?.message?.content?.trim() || fallback;
}

async function runCycle(bot: Bot<BotContext>): Promise<void> {
  if (isRunning) {
    return;
  }

  isRunning = true;
  try {
    const now = new Date();
    if (inQuietHours(now)) {
      return;
    }

    if (Date.now() - lastSentAt < config.kiraLifeProactiveIntervalMs) {
      return;
    }

    await maybeGenerateLifeEvent();
    const message = await buildProactiveMessage();

    const chatId = (await getAllowedUserChatId()) ?? config.allowedUserId;
    await bot.api.sendMessage(chatId, message);

    lastSentAt = Date.now();
  } catch (error) {
    console.error("[kira-life] proactive cycle failed:", error);
  } finally {
    isRunning = false;
  }
}

export function startKiraLifeScheduler(bot: Bot<BotContext>): void {
  if (!config.kiraLifeProactiveEnabled) {
    return;
  }

  if (timer) {
    clearInterval(timer);
  }

  timer = setInterval(() => {
    runCycle(bot);
  }, config.kiraLifeProactiveIntervalMs);

  setTimeout(() => {
    runCycle(bot);
  }, 30_000);
}
