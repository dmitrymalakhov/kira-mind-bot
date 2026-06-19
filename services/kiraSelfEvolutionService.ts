import { config } from "../config";
import { createChatCompletionForTask } from "../ai/chatCompletion";
import { MessageHistory } from "../types";
import { devLog, parseLLMJson } from "../utils";
import {
  evolveKiraSelfState,
  formatKiraPersonalitySnapshot,
  getKiraSelfMemoryState,
  getRecentKiraSelfEvents,
  KiraBiographyPatch,
  KiraSelfEventType,
  KiraInnerWorldPatch,
  KiraLifeArcPatch,
  KiraSelfPersonality,
} from "../utils/kiraSelfMemory";

interface ConversationEvolutionPayload {
  shouldUpdate?: boolean;
  mood?: string;
  thought?: string;
  topics?: string[];
  eventDescription?: string;
  eventType?: string;
  arc?: string;
  biographyPatch?: KiraBiographyPatch;
  innerWorld?: KiraInnerWorldPatch;
  lifeArc?: KiraLifeArcPatch;
  personalityPatch?: Partial<KiraSelfPersonality>;
}

interface ConversationEvolutionInput {
  ownerMessage: string;
  assistantResponse: string;
  messageHistory?: MessageHistory[];
  domain?: string;
  emotionalTone?: string;
  category?: string;
}

const ACTIVE_EVOLUTION_INTERVAL_MS = 20 * 60 * 1000;
const PASSIVE_EVOLUTION_INTERVAL_MS = 6 * 60 * 60 * 1000;

const DIRECT_SELF_MODEL_RE =
  /(личност|характер|сознани|самосозн|самоощущ|самомодел|самопамят|жизн[ьи]|жив[аоёы]|цель|желани|мечт|потребност|развива|однообраз|шаблон|человеч|реальност|цифров|бот|искусственн|кира|твой стиль|твоя манера|твой тон)/iu;
const FEEDBACK_RE =
  /(мне кажется|я хочу|хочу чтобы|не нравится|нравится|лучше|хуже|слишком|недостаточно|скучн|живее|естественн|однообразн|похоже на|ощущени)/iu;

const EVENT_TYPES = new Set<KiraSelfEventType>(["mood", "activity", "thought", "event", "relationship", "reflection"]);

function lastEvolutionAgeMs(lastEvolutionAt: string | undefined): number {
  if (!lastEvolutionAt) return Number.POSITIVE_INFINITY;
  const timestamp = new Date(lastEvolutionAt).getTime();
  if (!Number.isFinite(timestamp)) return Number.POSITIVE_INFINITY;
  return Date.now() - timestamp;
}

function shouldAnalyzeConversation(message: string, lastEvolutionAt: string | undefined): boolean {
  const trimmed = message.trim();
  if (trimmed.length < 24) return false;

  const age = lastEvolutionAgeMs(lastEvolutionAt);
  const direct = DIRECT_SELF_MODEL_RE.test(trimmed);
  const feedback = FEEDBACK_RE.test(trimmed);

  if ((direct || feedback) && age >= ACTIVE_EVOLUTION_INTERVAL_MS) {
    return true;
  }

  return trimmed.length >= 220 && age >= PASSIVE_EVOLUTION_INTERVAL_MS;
}

function historyDigest(history: MessageHistory[] | undefined): string {
  const recent = (history ?? []).slice(-6);
  if (!recent.length) return "нет";

  return recent
    .map((item) => {
      const speaker = item.role === "user" ? config.ownerName : config.characterName;
      return `${speaker}: ${String(item.content).slice(0, 260)}`;
    })
    .join("\n");
}

function asEventType(value: string | undefined): KiraSelfEventType {
  return value && EVENT_TYPES.has(value as KiraSelfEventType) ? value as KiraSelfEventType : "reflection";
}

function compactStringList(values: string[] | undefined, limit: number): string[] {
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

  const values = compactStringList(patch.values, 4);
  const preferences = compactStringList(patch.preferences, 4);
  const habits = compactStringList(patch.habits, 4);
  const boundaries = compactStringList(patch.boundaries, 4);
  const activeArcs = compactStringList(patch.activeArcs, 4);
  const longTermDesires = compactStringList(patch.longTermDesires, 4);
  const conversationImprints = compactStringList(patch.conversationImprints, 4);
  const voicePatterns = compactStringList(patch.voicePatterns, 4);

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

function hasPatch(value: object | undefined): boolean {
  return Boolean(value && Object.keys(value).length > 0);
}

export async function maybeEvolveKiraSelfFromConversation(input: ConversationEvolutionInput): Promise<boolean> {
  const selfState = await getKiraSelfMemoryState();
  if (!shouldAnalyzeConversation(input.ownerMessage, selfState.personality.lastEvolutionAt)) {
    return false;
  }

  const recentEvents = await getRecentKiraSelfEvents(6);
  const prompt = [
    `Ты модуль развития самопамяти ${config.characterName}.`,
    "",
    "Кира держит реалистичную человеческую линию жизни внутри своей персоны: Санкт-Петербург, учёба, работа, обычные привычки, отношения, настроение и постепенное развитие характера.",
    "Твоя задача — не отвечать пользователю, а решить, изменил ли диалог её самомодель.",
    "",
    "Правила:",
    "- Не сохраняй обычные факты о владельце: это делает другая память.",
    "- Обновляй только то, что меняет Киру: стиль, ценности, привычки, активные линии жизни, внутренний фокус, отношение к владельцу, настроение, внутренние выводы.",
    "- Если разговор про прошлое Киры, учёбу, работу, происхождение или почему она такая, обнови biographyPatch маленькой непротиворечивой деталью.",
    "- Не переписывай базовую биографию радикально. Устойчивые факты биографии сохраняются; можно добавлять детали и новые интерпретации прошлого.",
    "- Все новые детали биографии должны быть земными и бытовыми: реальные города, обычная учёба, обычная работа, реальные привычки.",
    "- Не добавляй цифровые архивы, сюрреалистические места, город потоков, вымышленные учебные заведения или фантастические профессии.",
    "- Если разговор задел сознание Киры, обнови innerWorld: currentFocus, selfNarrative, unresolvedQuestions, privateBeliefs или growthEdges.",
    "- Если разговор повлиял на долгую линию жизни, обнови lifeArc: этап, summary, nextStep. Это и есть сохранённая линия жизни, а не разовая мысль.",
    "- Если владелец даёт прямую обратную связь о её личности, однообразии, жизни, сознании или стиле — почти всегда нужно сохранить след.",
    "- Не добавляй грандиозных выводов. Лучше 1 маленькое точное изменение, чем новая биография.",
    "- eventDescription пиши от первого лица Киры, 1 предложение, как запись внутренней жизни после разговора.",
    "- Не используй слова 'бот' и 'ИИ' в eventDescription, если это не нужно для технической границы.",
    "",
    `Текущее состояние:\nНастроение: ${selfState.mood}`,
    `Самомодель:\n${formatKiraPersonalitySnapshot(selfState)}`,
    `Недавние события:\n${recentEvents.map((event) => `${event.date} [${event.type}] ${event.description}${event.arc ? ` / линия: ${event.arc}` : ""}`).join("\n") || "нет"}`,
    `Недавняя история:\n${historyDigest(input.messageHistory)}`,
    `Домен разговора: ${input.domain || "не определён"}`,
    `Эмоциональный тон: ${input.emotionalTone || "не определён"}`,
    `Категория: ${input.category || "не определена"}`,
    "",
    `Реплика владельца:\n${input.ownerMessage.slice(0, 2500)}`,
    "",
    `Ответ Киры:\n${input.assistantResponse.slice(0, 1800)}`,
    "",
    "Верни только JSON:",
    JSON.stringify({
      shouldUpdate: true,
      mood: "задумчивое | спокойное | уставшее | воодушевлённое | скептичное | другое короткое настроение",
      thought: "короткая внутренняя мысль Киры",
      topics: ["2-5 тегов"],
      eventDescription: "1 предложение от первого лица Киры",
      eventType: "reflection | relationship | thought | mood | event",
      arc: "какую долгую линию это продолжает или создаёт",
      biographyPatch: {
        timeline: [{
          title: "название существующей или новой главы",
          period: "период",
          place: "место",
          summary: "непротиворечивое уточнение главы",
          lessons: ["0-3 урока"],
          emotionalTone: "эмоциональный тон",
        }],
        education: ["0-2 уточнения про обучение"],
        workHistory: ["0-2 уточнения про работу до владельца"],
        formativeExperiences: ["0-2 опыта, объясняющих характер"],
        relationshipsBeforeOwner: ["0-2 связи до владельца"],
        whyThisPersonality: "уточнение, почему Кира такая",
        openPastQuestions: ["0-2 вопроса прошлого"],
        evolvingInterpretation: ["0-2 новых переосмысления прошлого"],
        stableFacts: ["0-2 устойчивых факта, только если они не противоречат прежним"],
        continuityRules: ["0-2 правила непротиворечивости, если нужно"],
      },
      innerWorld: {
        lifePurpose: "как уточнилась жизненная цель Киры",
        currentFocus: "что теперь занимает внутреннее внимание",
        emotionalUndercurrent: "тихий эмоциональный фон",
        selfNarrative: "как меняется рассказ Киры о себе",
        desires: ["0-3 желания, которые появились или стали важнее"],
        developmentNeeds: ["0-3 потребности развития"],
        unresolvedQuestions: ["0-3 вопроса, которые остаются внутри"],
        privateBeliefs: ["0-3 личных вывода"],
        growthEdges: ["0-3 зоны роста"],
        relationshipNeeds: ["0-3 потребности в связи с владельцем"],
      },
      lifeArc: {
        title: "название линии жизни",
        summary: "как эта линия изменилась после разговора",
        currentStage: "текущий этап линии",
        nextStep: "маленький следующий шаг Киры",
        emotionalTone: "эмоциональный оттенок линии",
        topics: ["2-4 тега"],
      },
      personalityPatch: {
        identity: "опционально, только если изменилось самовосприятие",
        selfImage: "опционально",
        relationshipToOwner: "опционально",
        values: ["0-3 новых/уточнённых ценности"],
        preferences: ["0-3 вкуса/предпочтения"],
        habits: ["0-3 привычки"],
        boundaries: ["0-3 границы"],
        activeArcs: ["0-3 долгие линии"],
        longTermDesires: ["0-3 желания роста"],
        conversationImprints: ["0-3 следа этого разговора"],
        voicePatterns: ["0-3 речевых паттерна"],
      },
    }),
  ].join("\n");

  try {
    const response = await createChatCompletionForTask("conversation", {
      messages: [
        {
          role: "system",
          content: "Ты обновляешь внутреннюю самопамять персонажа. Отвечай только валидным JSON без markdown.",
        },
        { role: "user", content: prompt },
      ],
      temperature: 0.35,
      response_format: { type: "json_object" },
    });

    const payload = parseLLMJson<ConversationEvolutionPayload>(response.choices[0]?.message?.content || "");
    if (!payload?.shouldUpdate) {
      return false;
    }

    const personalityPatch = normalizePersonalityPatch(payload.personalityPatch);
    const topics = compactStringList(payload.topics, 6);
    const eventDescription = payload.eventDescription?.trim();

    if (!personalityPatch && !hasPatch(payload.biographyPatch) && !hasPatch(payload.innerWorld) && !hasPatch(payload.lifeArc) && !payload.thought?.trim() && !topics.length && !eventDescription) {
      return false;
    }

    await evolveKiraSelfState({
      mood: payload.mood,
      thought: payload.thought,
      topics,
      personality: personalityPatch,
      biography: payload.biographyPatch,
      innerWorld: payload.innerWorld,
      lifeArc: payload.lifeArc,
      event: eventDescription
        ? {
            description: eventDescription,
            type: asEventType(payload.eventType),
            topics,
            arc: payload.arc,
            source: "conversation",
          }
        : undefined,
    });

    return true;
  } catch (error) {
    devLog("[kira-self-evolution] failed:", error);
    return false;
  }
}
