import { BOT_CAPABILITIES, BOT_COMMANDS, getCapabilitiesKnowledgeBase } from "../capabilities";
import { config } from "../config";
import openai, { openAiModels } from "../openai";
import { MessageHistory } from "../types";
import { getAsyncTaskErrors } from "../utils/enhancedDomainMemory";
import {
  addKiraSelfStudyReport,
  getKiraSelfMemoryState,
  getRecentKiraSelfEvents,
  getRecentKiraSelfStudyReports,
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

function normalizePayload(payload: SelfStudyPayload | null): Required<SelfStudyPayload> {
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

function fallbackPayload(): Required<SelfStudyPayload> {
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
  });
}

export async function runKiraSelfStudy(options: RunSelfStudyOptions): Promise<KiraSelfStudyReport> {
  const [selfState, recentEvents, recentReports] = await Promise.all([
    getKiraSelfMemoryState(),
    getRecentKiraSelfEvents(8),
    getRecentKiraSelfStudyReports(3),
  ]);

  const prompt = [
    `Ассистент: ${config.characterName}. Владелец: ${config.ownerName}.`,
    "",
    "Задача: провести самоизучение Telegram-бота по его реальному каталогу возможностей и состоянию.",
    "Нужно честно оценить:",
    "1. какие способности сейчас сильные;",
    "2. какие ограничения и риски есть;",
    "3. какие операционные потребности есть у ассистента, чтобы лучше помогать владельцу;",
    "4. какие 1-3 небольших эксперимента стоит попробовать;",
    "5. какие вопросы стоит задать владельцу для калибровки.",
    "",
    "Важно:",
    "- Используй только данные ниже, не выдумывай скрытых функций.",
    "- Потребности формулируй практично: обратная связь, данные, разрешения, уточнения, настройки, контекст.",
    "- Не изображай биологические потребности как факт.",
    "- Пиши от первого лица ассистента, но по-деловому.",
    "",
    `Триггер самоизучения: ${options.triggerMessage}`,
    "",
    `Каталог возможностей и команд:\n${getCapabilitiesKnowledgeBase({ publicMode: false })}`,
    "",
    `Текущее self-state: ${JSON.stringify(selfState)}`,
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
    }),
  ].join("\n");

  let payload: Required<SelfStudyPayload>;
  try {
    const response = await openai.chat.completions.create({
      model: openAiModels.conversationModel,
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
