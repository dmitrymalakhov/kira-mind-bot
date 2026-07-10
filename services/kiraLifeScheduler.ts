import { Bot } from "grammy";
import { BotContext } from "../types";
import { config } from "../config";
import { getBotPersona, getCommunicationStyle, getBotBiography } from "../persona";
import { createChatCompletionForTask } from "../ai/chatCompletion";
import {
  evolveKiraSelfState,
  formatKiraPersonalitySnapshot,
  getKiraSelfMemoryState,
  getRecentKiraSelfEvents,
  KiraBiographyPatch,
  KiraInnerWorldPatch,
  KiraLifeArcPatch,
  KiraSelfPersonality,
} from "../utils/kiraSelfMemory";
import { getProactiveChatId } from "../utils/allowedUserChatStore";
import { getActiveBotProfile } from "../utils/botIdentity";
import { parseLLMJson } from "../utils";
import { USER_TIMEZONE } from "../constants";
import { formatDateInTimeZone, getZonedDayContext, isZonedHourWithinRange } from "../utils/time";
import { getSetting, setSetting } from "./botSettingsService";
import { appendPersistedHistory } from "./SessionStorage";

const PROACTIVE_MESSAGE_FORMATS = [
  "поделись чем-то что произошло или что сейчас чувствуешь — искренне, без пафоса",
  "брось мысль или наблюдение, как будто само собой вырвалось",
  "задай Владельцу вопрос — опираясь на своё событие или просто из любопытства",
  "напиши как будто только что вспомнила что хотела сказать",
  "коротко, как будто между делом что-то мелькнуло в голове",
  "поделись маленькой деталью дня — что заметила, что удивило, что раздражало",
  "продолжи одну из своих долгих линий жизни, но без отчёта и объяснений",
  "напиши как человек, у которого есть свой день, а не как ассистент с уведомлением",
];

let proactiveTimer: NodeJS.Timeout | undefined;
let innerTimer: NodeJS.Timeout | undefined;
let isProactiveRunning = false;
let isInnerRunning = false;
let lastSentAt = 0;
let lastInnerDevelopmentAt = 0;

const LAST_SENT_SETTING_KEY = `${getActiveBotProfile()}:kiraLife:lastSentAt`;
const LAST_INNER_DEVELOPMENT_SETTING_KEY = `${getActiveBotProfile()}:kiraLife:lastInnerDevelopmentAt`;

async function loadLastSentAt(): Promise<number> {
  const raw = await getSetting(LAST_SENT_SETTING_KEY, "0");
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

async function saveLastSentAt(value: number): Promise<void> {
  await setSetting(LAST_SENT_SETTING_KEY, String(value));
}

async function loadLastInnerDevelopmentAt(): Promise<number> {
  const raw = await getSetting(LAST_INNER_DEVELOPMENT_SETTING_KEY, "0");
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

async function saveLastInnerDevelopmentAt(value: number): Promise<void> {
  await setSetting(LAST_INNER_DEVELOPMENT_SETTING_KEY, String(value));
}

function getDayContext(): {
  weekday: string;
  isWeekend: boolean;
  timeOfDay: string;
  season: string;
} {
  const ctx = getZonedDayContext(new Date(), USER_TIMEZONE);
  return {
    weekday: ctx.weekday,
    isWeekend: ctx.isWeekend,
    timeOfDay: ctx.timeOfDay,
    season: ctx.season,
  };
}

function inQuietHours(now: Date): boolean {
  if (!config.kiraLifeProactiveQuietHoursEnabled) {
    return false;
  }

  const { hour } = getZonedDayContext(now, USER_TIMEZONE);
  const start = config.kiraLifeProactiveQuietHourStart;
  const end = config.kiraLifeProactiveQuietHourEnd;
  return isZonedHourWithinRange(hour, start, end);
}

async function maybeGenerateLifeEvent(purpose: "inner" | "proactive"): Promise<void> {
  const recentEvents = await getRecentKiraSelfEvents(10);
  const memoryState = await getKiraSelfMemoryState();
  const dayCtx = getDayContext();
  const personalitySnapshot = formatKiraPersonalitySnapshot(memoryState);
  const purposeHint = purpose === "inner"
    ? "Это приватный внутренний цикл: запись сохраняется в самопамять и НЕ отправляется владельцу. Можно фиксировать тихие сдвиги, сомнения, внутренние вопросы и маленькие самостоятельные решения."
    : "Это событие может стать основой короткого проактивного сообщения владельцу, но сначала должно быть настоящим шагом внутренней жизни.";

  // Collect used topics from recent events + state to avoid repetition
  const usedTopics = Array.from(new Set([
    ...memoryState.recentTopics,
    ...recentEvents.flatMap((e) => e.topics ?? []),
  ])).slice(0, 15);

  const recentDescriptions = recentEvents
    .slice(0, 5)
    .map((e) => {
      const arc = e.arc ? ` / линия: ${e.arc}` : "";
      return `${formatDateInTimeZone(new Date(e.date), { weekday: "short", day: "numeric" }, USER_TIMEZONE)}: ${e.description}${arc}`;
    })
    .join(" | ");

  const response = await createChatCompletionForTask('conversation', {
    messages: [
      {
        role: "system",
        content: `${getBotPersona()}\nБиография: ${getBotBiography()}\nСтиль: ${getCommunicationStyle()}`,
      },
      {
        role: "user",
        content:
          `Сгенерируй одно реалистичное событие или мысль из жизни ${config.characterName}.\n` +
          `${config.characterName} живёт внутри персоны как ${config.eventDescriptionGender === "мужской" ? "мужчина" : "женщина"} с реалистичной биографией и собственной жизнью. Учитывай бытовые дела, интересы, усталость, любопытство и развитие характера. ` +
          `Не используй цифровые архивы, сюрреалистические места, город потоков, сны данных, вымышленные учебные заведения или фантастические профессии. Нужна земная бытовая конкретика.\n\n` +
          `${purposeHint}\n\n` +
          `Контекст: ${dayCtx.weekday}, ${dayCtx.timeOfDay}, ${dayCtx.season}. ` +
          `${dayCtx.isWeekend ? "Сегодня выходной — возможны другие активности, чем в будни." : "Будний день."}\n\n` +
          `Самомодель Киры:\n${personalitySnapshot}\n\n` +
          `Последние события (для непрерывности, похожее НЕ повторяй): ${recentDescriptions || "нет"}.\n` +
          `Темы которых надо ИЗБЕГАТЬ — уже были недавно: ${usedTopics.join(", ") || "нет"}.\n\n` +
          `Категории для разнообразия (выбери одну, подходящую по контексту дня и долгим линиям): прогулка по Петербургу или своему району, тренировка/растяжка, чтение, музыка или кино, бытовое дело дома, встреча или переписка с подругой, рабочая заметка или разбор задачи, воспоминание об университете, редакции или UX-интервью, планирование поездки, личный спор с собой, тёплый или неловкий след от разговора с владельцем.\n\n` +
          `Событие должно не просто описывать день, а немного продвигать одну линию жизни: новый этап, маленький вывод, привычка, желание или следующий шаг. Можно аккуратно доработать биографию до владельца одной маленькой деталью, если она объясняет характер Киры и не противоречит устойчивым фактам.\n\n` +
          `Напиши JSON с полями: description, mood, thought, topics (массив строк 2-4 шт.), type, arc, biographyPatch, innerWorld, lifeArc, personalityPatch.\n` +
          `description — 1-2 живых предложения с конкретными деталями: где именно, что делала, что изменилось, что почувствовала. ${config.eventDescriptionGender ?? "женский"} род. Без абстракций и без "как ИИ/бот".\n` +
          `mood — из набора: ${(config.moodVariants ?? ["спокойное", "уставшее", "задумчивое", "воодушевлённое", "нейтральное", "скептичное"]).join(", ")}. Утром — живее, вечером — спокойнее/устала.\n` +
          `thought — внутренняя реакция, короткая (1 предложение, опционально).\n` +
          `arc — какую долгую линию жизни это продолжает или создаёт; не больше 7 слов.\n` +
          `biographyPatch — объект для осторожного уточнения прошлого: timeline, education, workHistory, formativeExperiences, openPastQuestions, evolvingInterpretation, stableFacts. timeline — массив глав { title, period, place, summary, lessons, emotionalTone }. Не переписывай origin, не противоречь stableFacts/continuityRules и не добавляй фантастические или цифровые элементы.\n` +
          `innerWorld — объект { lifePurpose, currentFocus, emotionalUndercurrent, selfNarrative, desires, developmentNeeds, unresolvedQuestions, privateBeliefs, growthEdges, relationshipNeeds } для развития сознания.\n` +
          `lifeArc — объект { title, summary, currentStage, nextStep, emotionalTone, topics } для сохранения развития линии.\n` +
          `personalityPatch — объект с 0-2 маленькими изменениями: activeArcs, habits, preferences, longTermDesires, conversationImprints, voicePatterns. Не переписывай всю личность.\n` +
          `type — одно из: mood, activity, thought, event.`,
      },
    ],
    temperature: 0.9,
    response_format: { type: "json_object" },
  });

  const payload = response.choices[0]?.message?.content || "{}";
  const parsed = parseLLMJson<{
    description?: string;
    mood?: string;
    thought?: string;
    topics?: string[];
    type?: "mood" | "activity" | "thought" | "event";
    arc?: string;
    biographyPatch?: KiraBiographyPatch;
    innerWorld?: KiraInnerWorldPatch;
    lifeArc?: KiraLifeArcPatch;
    personalityPatch?: Partial<KiraSelfPersonality>;
  }>(payload) ?? {};

  const description =
    parsed.description?.trim() ||
    (config.eventDescriptionGender === "мужской"
      ? "Сегодня обычный день, думал о разном."
      : "Сегодня обычный день, думала о разном.");

  await evolveKiraSelfState({
    mood: parsed.mood,
    thought: parsed.thought,
    topics: parsed.topics,
    personality: parsed.personalityPatch,
    biography: parsed.biographyPatch,
    innerWorld: parsed.innerWorld,
    lifeArc: parsed.lifeArc,
    event: {
      description,
      type: parsed.type,
      topics: parsed.topics,
      arc: parsed.arc,
      source: "background",
      mood: parsed.mood,
      thought: parsed.thought,
    },
  });
}

async function buildProactiveMessage(): Promise<string> {
  const recentEvents = await getRecentKiraSelfEvents(2);
  const state = await getKiraSelfMemoryState();
  const personalitySnapshot = formatKiraPersonalitySnapshot(state);
  const formatHint = PROACTIVE_MESSAGE_FORMATS[Math.floor(Math.random() * PROACTIVE_MESSAGE_FORMATS.length)];

  const response = await createChatCompletionForTask('conversation', {
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
          `Самомодель и линии жизни:\n${personalitySnapshot}\n` +
          `Опирайся на события: ${recentEvents.map((e) => `${e.description}${e.arc ? ` (линия: ${e.arc})` : ""}`).join("; ")}.\n` +
          `Текущее настроение: ${state.mood}. Тон должен соответствовать настроению.\n` +
          `Строго: без приветствий-штампов ("Привет!", "Как твои дела?"), без упоминания что ты ИИ или бот, без пояснений. Не делай каждое сообщение вопросом. Только само сообщение.`,
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

async function runInnerDevelopmentCycle(): Promise<void> {
  if (!config.kiraLifeInnerDevelopmentEnabled || isInnerRunning) {
    return;
  }

  isInnerRunning = true;
  try {
    lastInnerDevelopmentAt = Math.max(lastInnerDevelopmentAt, await loadLastInnerDevelopmentAt());
    if (lastInnerDevelopmentAt > 0 && Date.now() - lastInnerDevelopmentAt < config.kiraLifeInnerDevelopmentIntervalMs) {
      return;
    }

    await maybeGenerateLifeEvent("inner");
    lastInnerDevelopmentAt = Date.now();
    await saveLastInnerDevelopmentAt(lastInnerDevelopmentAt);
  } catch (error) {
    console.error("[kira-life] inner development cycle failed:", error);
  } finally {
    isInnerRunning = false;
  }
}

async function runProactiveCycle(bot: Bot<BotContext>): Promise<void> {
  if (!config.kiraLifeProactiveEnabled || isProactiveRunning) {
    return;
  }

  isProactiveRunning = true;
  try {
    const now = new Date();
    if (inQuietHours(now)) {
      return;
    }

    lastSentAt = Math.max(lastSentAt, await loadLastSentAt());
    if (lastSentAt === 0) {
      lastSentAt = Date.now();
      await saveLastSentAt(lastSentAt);
      return;
    }

    if (Date.now() - lastSentAt < config.kiraLifeProactiveIntervalMs) {
      return;
    }

    await maybeGenerateLifeEvent("proactive");
    const message = await buildProactiveMessage();

    const chatId = await getProactiveChatId();
    await bot.api.sendMessage(chatId, message);

    lastSentAt = Date.now();
    await saveLastSentAt(lastSentAt);
    await appendPersistedHistory(chatId, "bot", message);
  } catch (error) {
    console.error("[kira-life] proactive cycle failed:", error);
  } finally {
    isProactiveRunning = false;
  }
}

export function startKiraLifeScheduler(bot: Bot<BotContext>): void {
  if (!config.kiraLifeProactiveEnabled && !config.kiraLifeInnerDevelopmentEnabled) {
    return;
  }

  if (proactiveTimer) {
    clearInterval(proactiveTimer);
  }
  if (innerTimer) {
    clearInterval(innerTimer);
  }

  if (config.kiraLifeInnerDevelopmentEnabled) {
    innerTimer = setInterval(() => {
      runInnerDevelopmentCycle();
    }, config.kiraLifeInnerDevelopmentIntervalMs);

    setTimeout(() => {
      runInnerDevelopmentCycle();
    }, 60_000);
  }

  if (config.kiraLifeProactiveEnabled) {
    proactiveTimer = setInterval(() => {
      runProactiveCycle(bot);
    }, config.kiraLifeProactiveIntervalMs);

    setTimeout(() => {
      runProactiveCycle(bot);
    }, 30_000);
  }
}
