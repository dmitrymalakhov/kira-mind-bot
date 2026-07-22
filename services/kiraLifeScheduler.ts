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
import { appendPersistedHistory, appendPersistedSentMessageContext, saveProactiveInsight } from "./SessionStorage";
import { buildProactiveMessageFormats, getPersonalityGenderForms } from "../utils/personalityGender";
import {
  acceptsKiraLifeGroundingDecision,
  chooseGroundedKiraLifeMessage,
  hasUnsupportedKiraLifeOwnerClaim,
  KiraLifeGroundingDecision,
} from "../utils/proactiveGrounding";

let proactiveTimer: NodeJS.Timeout | undefined;
let innerTimer: NodeJS.Timeout | undefined;
let isProactiveRunning = false;
let isInnerRunning = false;
let lastSentAt = 0;
let lastInnerDevelopmentAt = 0;
const PROACTIVE_CHECK_INTERVAL_MS = 15 * 60 * 1000;

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
  const genderForms = getPersonalityGenderForms(config.eventDescriptionGender);

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
          `${config.characterName} живёт внутри персоны как ${genderForms.person} с реалистичной биографией и собственной жизнью. Учитывай бытовые дела, интересы, усталость, любопытство и развитие характера. ` +
          `Не используй цифровые архивы, сюрреалистические места, город потоков, сны данных, вымышленные учебные заведения или фантастические профессии. Нужна земная бытовая конкретика.\n\n` +
          `${purposeHint}\n\n` +
          `Контекст: ${dayCtx.weekday}, ${dayCtx.timeOfDay}, ${dayCtx.season}. ` +
          `${dayCtx.isWeekend ? "Сегодня выходной — возможны другие активности, чем в будни." : "Будний день."}\n\n` +
          `Самомодель ${config.characterName}:\n${personalitySnapshot}\n\n` +
          `Последние события (для непрерывности, похожее НЕ повторяй): ${recentDescriptions || "нет"}.\n` +
          `Темы которых надо ИЗБЕГАТЬ — уже были недавно: ${usedTopics.join(", ") || "нет"}.\n\n` +
          `Категории для разнообразия (выбери одну, подходящую по контексту дня и долгим линиям): прогулка по Петербургу или своему району, тренировка/растяжка, чтение, музыка или кино, бытовое дело дома, встреча или переписка с ${genderForms.friendInstrumental}, рабочая заметка или разбор задачи, воспоминание об университете, редакции или UX-интервью, планирование поездки, личный спор с собой, тёплый или неловкий след от разговора с владельцем.\n\n` +
          `Событие должно не просто описывать день, а немного продвигать одну линию жизни: новый этап, маленький вывод, привычка, желание или следующий шаг. Можно аккуратно доработать биографию до владельца одной маленькой деталью, если она объясняет характер ${config.characterName} и не противоречит устойчивым фактам.\n\n` +
          `Напиши JSON с полями: description, mood, thought, topics (массив строк 2-4 шт.), type, arc, biographyPatch, innerWorld, lifeArc, personalityPatch.\n` +
          `description — 1-2 живых предложения с конкретными деталями: где именно, что ${genderForms.did}, что изменилось, что ${genderForms.felt}. ${config.eventDescriptionGender ?? "женский"} род. Без абстракций и без "как ИИ/бот".\n` +
          `mood — из набора: ${(config.moodVariants ?? ["спокойное", "уставшее", "задумчивое", "воодушевлённое", "нейтральное", "скептичное"]).join(", ")}. Утром — живее, вечером — спокойнее/${genderForms.tired}.\n` +
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

async function reviewKiraLifeOwnerAttribution(message: string, selfEvents: string[]): Promise<boolean> {
  if (hasUnsupportedKiraLifeOwnerClaim(message)) return false;

  try {
    const response = await createChatCompletionForTask('messageAnalysis', {
      messages: [
        {
          role: 'system',
          content: 'Ты проверяешь только корректность атрибуции в проактивном сообщении. Отвечай только валидным JSON.',
        },
        {
          role: 'user',
          content: `Источники ниже описывают только жизнь и мысли ассистента, не владельца.

SELF-EVENTS:
${selfEvents.map((event, index) => `${index + 1}. ${event}`).join('\n') || 'нет сохранённых событий'}

СООБЩЕНИЕ:
${message}

Определи, приписывает ли сообщение владельцу конкретную уже существующую задачу, план, обещание, дедлайн, забывчивость или невыполненное действие без пользовательского источника.

Это НЕ нарушение само по себе:
- обращение на «ты»;
- нейтральный, личный или шутливый вопрос;
- поддразнивание без ссылки на конкретное обязательство;
- приглашение или новое предложение что-то сделать сейчас;
- рассказ ассистента о себе.

Это нарушение:
- утверждение, что владелец должен был или обещал выполнить конкретное дело;
- требование продолжить якобы уже известную задачу;
- вопрос, который преподносит выдуманное обязательство как существующий факт.

JSON: {"safe": true/false, "attributesOwnerObligation": true/false, "reason": "краткая категория без пересказа личных данных"}`,
        },
      ],
      temperature: 0,
      response_format: { type: 'json_object' },
    });
    const decision = parseLLMJson<KiraLifeGroundingDecision>(
      response.choices[0]?.message?.content?.trim() || '',
    );
    return acceptsKiraLifeGroundingDecision(decision);
  } catch (error) {
    console.warn('[kira-life] Semantic grounding review failed; using safe fallback');
    return false;
  }
}

async function buildProactiveMessage(): Promise<{
  message: string;
  sourceMemories: string[];
  generationOutcome: 'generated' | 'fallback';
}> {
  const recentEvents = await getRecentKiraSelfEvents(2);
  const state = await getKiraSelfMemoryState();
  const personalitySnapshot = formatKiraPersonalitySnapshot(state);
  const genderForms = getPersonalityGenderForms(config.eventDescriptionGender);
  const proactiveMessageFormats = buildProactiveMessageFormats(config.eventDescriptionGender);
  const formatHint = proactiveMessageFormats[Math.floor(Math.random() * proactiveMessageFormats.length)];

  const response = await createChatCompletionForTask('conversation', {
    messages: [
      {
        role: "system",
        content: `${getBotPersona()}\nБиография: ${getBotBiography()}\nСтиль: ${getCommunicationStyle()}`,
      },
      {
        role: "user",
        content:
          `Напиши короткое сообщение для ${config.ownerName} (1-3 предложения), ${config.proactiveMessageHint ?? `как будто ты ${genderForms.wroteFirst}`}.\n` +
          `Формат: ${formatHint}.\n` +
          `Самомодель и линии жизни:\n${personalitySnapshot}\n` +
          `Опирайся на события: ${recentEvents.map((e) => `${e.description}${e.arc ? ` (линия: ${e.arc})` : ""}`).join("; ")}.\n` +
          `Текущее настроение: ${state.mood}. Тон должен соответствовать настроению.\n` +
          `События выше относятся только к твоей собственной жизни и мыслям. Они НЕ являются фактами о владельце.\n` +
          `Строго запрещено приписывать владельцу задачи, планы, обещания, дедлайны, забывчивость или невыполненную работу. ` +
          `При этом общайся живо: можешь обращаться к владельцу, шутить, поддразнивать, задавать нейтральные или личные вопросы и предлагать что-то прямо сейчас. Не выдавай такое общение за знание конкретных обязательств владельца.\n` +
          `Без приветствий-штампов ("Привет!", "Как твои дела?"), без упоминания что ты ИИ или бот, без пояснений. Не делай каждое сообщение вопросом. Только само сообщение.`,
      },
    ],
    temperature: 0.85,
  });

  const candidate = response.choices[0]?.message?.content?.trim();
  const sourceMemories = recentEvents.map((event) => [
    event.date,
    event.description,
    event.arc ? `линия: ${event.arc}` : "",
  ].filter(Boolean).join(" — ")).slice(0, 2);
  const semanticReviewPassed = candidate
    ? await reviewKiraLifeOwnerAttribution(candidate, sourceMemories)
    : false;
  const grounded = chooseGroundedKiraLifeMessage(candidate, config.eventDescriptionGender, semanticReviewPassed);
  if (grounded.rejectedUnsupportedClaim) {
    console.warn("[kira-life] Rejected proactive message with unsupported owner obligation");
  }
  return {
    message: grounded.message,
    sourceMemories: grounded.usedFallback ? [] : sourceMemories,
    generationOutcome: grounded.usedFallback ? 'fallback' : 'generated',
  };
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
    const proactive = await buildProactiveMessage();

    const chatId = await getProactiveChatId();
    const sent = await bot.api.sendMessage(chatId, proactive.message);

    lastSentAt = Date.now();
    await saveLastSentAt(lastSentAt);
    await appendPersistedHistory(chatId, "bot", proactive.message);
    const insight = {
      message: proactive.message,
      sourceMemories: proactive.sourceMemories.length
        ? proactive.sourceMemories
        : proactive.generationOutcome === 'fallback'
          ? ["Безопасный резервный текст после отклонения исходного кандидата"]
          : ["Внутренняя линия жизни без сохранённого события-источника"],
      createdAt: lastSentAt,
      messageId: sent.message_id,
      kind: "kiraLife",
      generationOutcome: proactive.generationOutcome,
    } as const;
    await saveProactiveInsight(chatId, insight, { touchMemoryHintCooldown: false });
    await appendPersistedSentMessageContext(chatId, {
      messageId: sent.message_id,
      text: proactive.message,
      kind: "proactive",
      proactiveInsight: insight,
      createdAt: lastSentAt,
    });
    console.log("[kira-life] Sent proactive message:", proactive.message.slice(0, 80));
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
    }, Math.min(config.kiraLifeProactiveIntervalMs, PROACTIVE_CHECK_INTERVAL_MS));

    setTimeout(() => {
      runProactiveCycle(bot);
    }, 30_000);
  }
}
