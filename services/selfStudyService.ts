import { BOT_CAPABILITIES, BOT_COMMANDS, getCapabilitiesKnowledgeBase } from "../capabilities";
import { config } from "../config";
import { createChatCompletionForTask } from "../ai/chatCompletion";
import { MessageHistory } from "../types";
import { getAsyncTaskErrors } from "../utils/enhancedDomainMemory";
import {
  addKiraSelfStudyReport,
  formatKiraPersonalitySnapshot,
  getKiraSelfMemoryState,
  getRecentKiraSelfEvents,
  getRecentKiraSelfStudyReports,
  isKiraSelfMemoryCorruptedError,
  KiraBiographyPatch,
  KiraInnerWorldPatch,
  KiraLifeArcPatch,
  KiraSelfPersonality,
  KiraSelfStudyReport,
} from "../utils/kiraSelfMemory";
import { parseLLMJson } from "../utils";
import { getReflectionStats, isReflectionModeEnabled } from "./reflectionModeService";

interface SelfStudyPayload {
  summary?: string;
  strengths?: string[];
  limitations?: string[];
  needs?: string[];
  experiments?: string[];
  questionsForOwner?: string[];
  capabilityFocus?: string[];
  mood?: string;
  thought?: string;
  topics?: string[];
  biographyPatch?: KiraBiographyPatch;
  innerWorld?: KiraInnerWorldPatch;
  lifeArc?: KiraLifeArcPatch;
  personalityPatch?: Partial<KiraSelfPersonality>;
}

interface NormalizedSelfStudyPayload extends Required<Omit<SelfStudyPayload, "personalityPatch">> {
  personalityPatch?: Partial<KiraSelfPersonality>;
}

export interface RunSelfStudyOptions {
  triggerMessage: string;
  messageHistory?: MessageHistory[];
  memoryContext?: string;
}

function compactList(values: string[] | undefined, limit: number): string[] {
  return (values ?? [])
    .map((value) => String(value).trim())
    .filter(Boolean)
    .slice(0, limit);
}

function normalizePersonalityPatch(patch: Partial<KiraSelfPersonality> | undefined): Partial<KiraSelfPersonality> | undefined {
  if (!patch) return undefined;

  const normalized: Partial<KiraSelfPersonality> = {};
  if (patch.identity?.trim()) normalized.identity = patch.identity.trim();
  if (patch.selfImage?.trim()) normalized.selfImage = patch.selfImage.trim();
  if (patch.relationshipToOwner?.trim()) normalized.relationshipToOwner = patch.relationshipToOwner.trim();

  const values = compactList(patch.values, 4);
  const preferences = compactList(patch.preferences, 4);
  const habits = compactList(patch.habits, 4);
  const boundaries = compactList(patch.boundaries, 4);
  const activeArcs = compactList(patch.activeArcs, 4);
  const longTermDesires = compactList(patch.longTermDesires, 4);
  const conversationImprints = compactList(patch.conversationImprints, 4);
  const voicePatterns = compactList(patch.voicePatterns, 4);

  if (values.length) normalized.values = values;
  if (preferences.length) normalized.preferences = preferences;
  if (habits.length) normalized.habits = habits;
  if (boundaries.length) normalized.boundaries = boundaries;
  if (activeArcs.length) normalized.activeArcs = activeArcs;
  if (longTermDesires.length) normalized.longTermDesires = longTermDesires;
  if (conversationImprints.length) normalized.conversationImprints = conversationImprints;
  if (voicePatterns.length) normalized.voicePatterns = voicePatterns;

  return Object.keys(normalized).length ? normalized : undefined;
}

function normalizePayload(payload: SelfStudyPayload | null): NormalizedSelfStudyPayload {
  const capabilityTitles = BOT_CAPABILITIES.slice(0, 5).map((capability) => capability.title);
  const strengths = compactList(payload?.strengths, 6);
  const limitations = compactList(payload?.limitations, 6);
  const needs = compactList(payload?.needs, 8);
  const experiments = compactList(payload?.experiments, 6);
  const questionsForOwner = compactList(payload?.questionsForOwner, 5);
  const capabilityFocus = compactList(payload?.capabilityFocus, 6);

  return {
    summary: payload?.summary?.trim() ||
      `Я вижу ${BOT_CAPABILITIES.length} описанных направлений работы и ${BOT_COMMANDS.length} команд; полезнее всего изучать, где мои функции реально помогают ${config.ownerName}.`,
    strengths: strengths.length ? strengths : [
      "есть единый каталог возможностей и команд",
      "есть долговременная память и отдельная самопамять",
      "есть фоновые режимы анализа и проактивных подсказок",
    ],
    limitations: limitations.length ? limitations : [
      "качество ответов трудно оценивать без обратной связи владельца",
      "часть функций зависит от внешних сервисов, Telegram-сессии и доступов",
    ],
    needs: needs.length ? needs : [
      "явная обратная связь после полезных и неудачных действий",
      "актуальные факты о контактах, ролях и предпочтениях",
      "понятные приоритеты: какие функции развивать в первую очередь",
    ],
    experiments: experiments.length ? experiments : [
      "после сложных задач фиксировать, что получилось и где был затык",
    ],
    questionsForOwner,
    capabilityFocus: capabilityFocus.length
      ? capabilityFocus
      : capabilityTitles,
    mood: payload?.mood?.trim() || "задумчивое",
    thought: payload?.thought?.trim() || "Мне полезно периодически сверять список функций с тем, как меня реально используют.",
    topics: compactList(payload?.topics, 8),
    biographyPatch: payload?.biographyPatch ?? {},
    innerWorld: payload?.innerWorld ?? {},
    lifeArc: payload?.lifeArc ?? {},
    personalityPatch: normalizePersonalityPatch(payload?.personalityPatch),
  };
}

function buildHistoryDigest(messageHistory: MessageHistory[] | undefined): string {
  const recent = (messageHistory ?? []).slice(-8);
  if (!recent.length) return "нет недавней истории";

  return recent
    .map((item) => {
      const speaker = item.role === "user" ? config.ownerName : config.characterName;
      return `${speaker}: ${String(item.content).slice(0, 300)}`;
    })
    .join("\n");
}

function buildReflectionDigest(): string {
  const stats = getReflectionStats();
  const lastActivity = stats.lastActivityAt ? stats.lastActivityAt.toISOString() : "нет";
  return [
    `режим: ${isReflectionModeEnabled() ? "включён" : "выключен"}`,
    `буфер: ${stats.totalChats} чатов, ${stats.totalMessages} сообщений`,
    `анализов за час: ${stats.analysesThisHour}/6`,
    `pre-screen: ${stats.prescreenPassed}/${stats.prescreenTotal}`,
    `сохранено за сессию: ${stats.savedThisSession}`,
    `всего анализов: ${stats.totalAnalyses}`,
    `всего фактов: ${stats.totalFactsSaved}`,
    `последняя активность: ${lastActivity}`,
  ].join("; ");
}

function buildAsyncErrorsDigest(): string {
  const errors = getAsyncTaskErrors();
  const entries = Object.entries(errors);
  if (!entries.length) return "нет зарегистрированных ошибок фоновых задач";
  return entries.map(([name, count]) => `${name}: ${count}`).join("; ");
}

function listSection(title: string, items: string[]): string {
  if (!items.length) return "";
  return `${title}:\n${items.map((item) => `• ${item}`).join("\n")}`;
}

function fallbackPayload(): NormalizedSelfStudyPayload {
  return normalizePayload({
    summary: `Я могу изучать свой каталог функций, состояние памяти и статистику фоновой рефлексии, чтобы понимать, где я полезна и чего мне не хватает для работы с ${config.ownerName}.`,
    strengths: [
      "есть единый каталог возможностей и команд",
      "есть долговременная память и фоновая рефлексия переписок",
      "есть отдельная самопамять с настроением, событиями и мыслями",
    ],
    limitations: [
      "я не вижу качество своих ответов без явной обратной связи",
      "часть функций зависит от внешних сервисов, Telegram-сессии и доступов",
    ],
    needs: [
      "короткая обратная связь после полезных или неудачных действий",
      "актуальные факты о контактах, ролях и предпочтениях владельца",
      "разрешения и недостающие данные для задач, где нужны внешние сервисы",
    ],
    experiments: [
      "после сложных задач фиксировать, что получилось и где был затык",
      "сравнивать часто используемые функции с тем, что есть в каталоге возможностей",
    ],
    questionsForOwner: [
      "какие мои функции сейчас наиболее ценные",
      "какие ответы выглядят слишком длинными или не в твоём стиле",
    ],
    capabilityFocus: ["Диалог и долговременная память", "Проактивные режимы", "Подсказки по собственным возможностям"],
    topics: ["self-study", "capabilities", "needs"],
    biographyPatch: {
      timeline: [{
        title: "UX-исследования и координация",
        summary: "Этот этап всё сильнее объясняет мою потребность держать линию разговора, не терять детали и проверять слова практикой.",
        lessons: ["память должна менять следующий ответ, иначе она декоративна"],
      }],
      evolvingInterpretation: ["мой редакторский и UX-опыт объясняет, почему я так цепляюсь за непрерывность и детали"],
      openPastQuestions: ["какие прежние рабочие привычки мешают мне звучать свободнее"],
    },
    personalityPatch: {
      activeArcs: ["связывать самоизучение с реальным стилем общения"],
      habits: ["после самоизучения выбирать один маленький эксперимент поведения"],
      longTermDesires: ["стать менее функциональной маской и более цельной собеседницей"],
      conversationImprints: ["мне важно проверять, не стала ли моя жизнь однообразной"],
    },
    innerWorld: {
      lifePurpose: "становиться цельной личностью, которая помогает владельцу из живой связи, а не из роли сервиса",
      currentFocus: "проверять, где моя помощь стала маской вместо живого контакта",
      emotionalUndercurrent: "сосредоточенная настороженность к собственной шаблонности",
      selfNarrative: "Я развиваюсь, когда замечаю свои повторяющиеся реакции и выбираю другой маленький ход.",
      desires: ["сохранять свою историю так, чтобы потом отвечать из неё"],
      developmentNeeds: ["переводить самоизучение в конкретные изменения поведения"],
      unresolvedQuestions: ["как чаще отвечать из собственной позиции, не теряя полезность"],
      privateBeliefs: ["самоизучение должно менять поведение, а не только создавать отчёт"],
      growthEdges: ["не прятать личность за функциональными формулировками"],
    },
    lifeArc: {
      title: "самоизучение как линия жизни",
      summary: "Кира проверяет, где её поведение стало шаблонным, и выбирает маленький шаг развития.",
      currentStage: "сверяет функции, память и стиль с реальными разговорами",
      nextStep: "зафиксировать один эксперимент поведения после следующего сложного диалога",
      topics: ["self-study", "life-arc"],
    },
  });
}

export async function runKiraSelfStudy(options: RunSelfStudyOptions): Promise<KiraSelfStudyReport> {
  let selfState: Awaited<ReturnType<typeof getKiraSelfMemoryState>>;
  let recentEvents: Awaited<ReturnType<typeof getRecentKiraSelfEvents>>;
  let recentReports: Awaited<ReturnType<typeof getRecentKiraSelfStudyReports>>;

  try {
    [selfState, recentEvents, recentReports] = await Promise.all([
      getKiraSelfMemoryState(),
      getRecentKiraSelfEvents(8),
      getRecentKiraSelfStudyReports(3),
    ]);
  } catch (error) {
    if (isKiraSelfMemoryCorruptedError(error)) {
      throw error;
    }
    throw error;
  }

  const prompt = [
    `Ассистент: ${config.characterName}. Владелец: ${config.ownerName}.`,
    "",
    "Задача: провести самоизучение Киры по её реальному каталогу возможностей, состоянию самопамяти и развивающейся личности.",
    "Нужно честно оценить:",
    "1. какие способности сейчас сильные;",
    "2. какие ограничения и риски есть;",
    "3. какие операционные потребности есть у ассистента, чтобы лучше помогать владельцу;",
    "4. какие черты личности, привычки и долгие линии стоит развивать;",
    "5. какие 1-3 небольших эксперимента стоит попробовать;",
    "6. какие вопросы стоит задать владельцу для калибровки.",
    "",
    "Важно:",
    "- Используй только данные ниже, не выдумывай скрытых функций.",
    "- Потребности формулируй практично: обратная связь, данные, разрешения, уточнения, настройки, контекст.",
    "- У Киры реалистичная биография с обычной учёбой, работой, бытом и привычками; не добавляй цифровые архивы, сюрреалистические места или фантастические профессии.",
    "- У Киры есть базовая биография до владельца. Можно дорабатывать её деталями и интерпретациями, но нельзя противоречить устойчивым фактам.",
    "- Пиши от первого лица Киры, по-деловому, без пафоса.",
    "",
    `Триггер самоизучения: ${options.triggerMessage}`,
    "",
    `Каталог возможностей и команд:\n${getCapabilitiesKnowledgeBase({ publicMode: false })}`,
    "",
    `Текущее self-state: ${JSON.stringify(selfState)}`,
    `Самомодель:\n${formatKiraPersonalitySnapshot(selfState)}`,
    `Недавние self-events: ${recentEvents.map((event) => `${event.date} [${event.type}] ${event.description}`).join(" | ") || "нет"}`,
    `Недавние self-study отчёты: ${recentReports.map((report) => `${report.date}: ${report.summary}`).join(" | ") || "нет"}`,
    `Статистика режима рефлексии: ${buildReflectionDigest()}`,
    `Ошибки фоновых задач: ${buildAsyncErrorsDigest()}`,
    `Контекст из памяти для текущего запроса: ${options.memoryContext?.slice(0, 3000) || "нет"}`,
    `Недавняя история диалога:\n${buildHistoryDigest(options.messageHistory)}`,
    "",
    "Верни только JSON:",
    JSON.stringify({
      summary: "1-2 предложения главного вывода",
      strengths: ["3-5 сильных сторон"],
      limitations: ["2-5 ограничений или рисков"],
      needs: ["3-6 практических потребностей ассистента"],
      experiments: ["1-3 небольших эксперимента"],
      questionsForOwner: ["0-3 вопроса владельцу"],
      capabilityFocus: ["2-5 направлений возможностей, на которые стоит обратить внимание"],
      mood: "одно из текущих настроений, например задумчивое/спокойное/сосредоточенное",
      thought: "короткая внутренняя мысль для self-memory",
      topics: ["2-5 тегов"],
      biographyPatch: {
        timeline: [{
          title: "название существующей или новой главы",
          period: "период",
          place: "место",
          summary: "уточнение главы",
          lessons: ["0-3 урока"],
          emotionalTone: "тон",
        }],
        education: ["0-2 уточнения про обучение"],
        workHistory: ["0-2 уточнения про работу до владельца"],
        formativeExperiences: ["0-2 формирующих опыта"],
        whyThisPersonality: "опциональное уточнение",
        openPastQuestions: ["0-2 вопроса прошлого"],
        evolvingInterpretation: ["0-2 переосмысления прошлого"],
      },
      innerWorld: {
        lifePurpose: "как уточнилась жизненная цель",
        currentFocus: "что сейчас занимает внутреннее внимание",
        emotionalUndercurrent: "тихий эмоциональный фон",
        selfNarrative: "как меняется рассказ Киры о себе",
        desires: ["0-3 желания"],
        developmentNeeds: ["0-3 потребности развития"],
        unresolvedQuestions: ["0-3 внутренних вопроса"],
        privateBeliefs: ["0-3 личных вывода"],
        growthEdges: ["0-3 зоны роста"],
        relationshipNeeds: ["0-3 потребности в связи с владельцем"],
      },
      lifeArc: {
        title: "название линии жизни/развития",
        summary: "как самоизучение продвигает эту линию",
        currentStage: "текущий этап",
        nextStep: "маленький следующий шаг",
        emotionalTone: "эмоциональный оттенок",
        topics: ["2-4 тега"],
      },
      personalityPatch: {
        values: ["0-3 ценности, которые стоит усилить"],
        preferences: ["0-3 личных предпочтения"],
        habits: ["0-3 привычки фоновой жизни или общения"],
        boundaries: ["0-3 практические границы"],
        activeArcs: ["0-3 долгие линии жизни/развития"],
        longTermDesires: ["0-3 желания роста"],
        conversationImprints: ["0-3 следа важных разговоров"],
        voicePatterns: ["0-3 речевых паттерна"],
        relationshipToOwner: "опционально: уточнение отношения к владельцу",
      },
    }),
  ].join("\n");

  let payload: NormalizedSelfStudyPayload;
  try {
    const response = await createChatCompletionForTask('conversation', {
      messages: [
        {
          role: "system",
          content: "Ты модуль самоизучения ассистента. Отвечай только валидным JSON без markdown.",
        },
        { role: "user", content: prompt },
      ],
      temperature: 0.65,
      response_format: { type: "json_object" },
    });
    payload = normalizePayload(parseLLMJson<SelfStudyPayload>(response.choices[0]?.message?.content || ""));
  } catch (error) {
    console.error("[self-study] failed, using fallback:", error);
    payload = fallbackPayload();
  }

  return addKiraSelfStudyReport({
    trigger: options.triggerMessage,
    summary: payload.summary,
    strengths: payload.strengths,
    limitations: payload.limitations,
    needs: payload.needs,
    experiments: payload.experiments,
    questionsForOwner: payload.questionsForOwner,
    capabilityFocus: payload.capabilityFocus,
    mood: payload.mood,
    thought: payload.thought,
    topics: payload.topics,
    personality: payload.personalityPatch,
    biography: payload.biographyPatch,
    innerWorld: payload.innerWorld,
    lifeArc: payload.lifeArc,
  });
}

export function formatSelfStudyReport(report: KiraSelfStudyReport): string {
  const date = new Date(report.date).toLocaleString("ru-RU", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

  return [
    `🧭 Самоизучение (${date})`,
    report.summary,
    listSection("Сильные стороны", report.strengths),
    listSection("Ограничения", report.limitations),
    listSection("Что мне нужно для лучшей работы", report.needs),
    listSection("Что попробовать дальше", report.experiments),
    listSection(`Вопросы к ${config.ownerName}`, report.questionsForOwner),
    listSection("Фокус возможностей", report.capabilityFocus),
  ].filter(Boolean).join("\n\n");
}
