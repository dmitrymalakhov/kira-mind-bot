import * as fs from "fs/promises";
import * as path from "path";
import { config } from "../config";
import { getActiveBotProfile } from "./botIdentity";
const { hasLegacyDigitalBiography } = require("./legacyPersonalitySanitizer");

export type KiraSelfEventType = "mood" | "activity" | "thought" | "event" | "relationship" | "reflection";
export type KiraSelfEventSource = "background" | "conversation" | "self-study" | "manual";
export type KiraLifeArcStatus = "active" | "dormant" | "resolved";

export interface KiraSelfEvent {
  id: string;
  date: string;
  description: string;
  type: KiraSelfEventType;
  topics?: string[];
  arc?: string;
  source?: KiraSelfEventSource;
}

export interface KiraSelfPersonality {
  identity: string;
  selfImage: string;
  values: string[];
  preferences: string[];
  habits: string[];
  boundaries: string[];
  relationshipToOwner: string;
  activeArcs: string[];
  longTermDesires: string[];
  conversationImprints: string[];
  voicePatterns: string[];
  lastEvolutionAt?: string;
}

export interface KiraBiographyChapter {
  id: string;
  title: string;
  period: string;
  place: string;
  summary: string;
  lessons: string[];
  emotionalTone?: string;
}

export interface KiraBiographyChapterPatch {
  title?: string;
  period?: string;
  place?: string;
  summary?: string;
  lessons?: string[];
  emotionalTone?: string;
}

export interface KiraBiographyFoundation {
  origin: string;
  earlyEnvironment: string;
  education: string[];
  workHistory: string[];
  formativeExperiences: string[];
  relationshipsBeforeOwner: string[];
  whyThisPersonality: string;
  lifeBeforeOwnerSummary: string;
  meetingOwnerMeaning: string;
  timeline: KiraBiographyChapter[];
  stableFacts: string[];
  continuityRules: string[];
  openPastQuestions: string[];
  evolvingInterpretation: string[];
  lastUpdatedAt?: string;
}

export interface KiraBiographyPatch {
  origin?: string;
  earlyEnvironment?: string;
  education?: string[];
  workHistory?: string[];
  formativeExperiences?: string[];
  relationshipsBeforeOwner?: string[];
  whyThisPersonality?: string;
  lifeBeforeOwnerSummary?: string;
  meetingOwnerMeaning?: string;
  timeline?: KiraBiographyChapterPatch[];
  stableFacts?: string[];
  continuityRules?: string[];
  openPastQuestions?: string[];
  evolvingInterpretation?: string[];
}

export interface KiraInnerWorld {
  lifePurpose: string;
  currentFocus: string;
  emotionalUndercurrent: string;
  selfNarrative: string;
  desires: string[];
  developmentNeeds: string[];
  unresolvedQuestions: string[];
  privateBeliefs: string[];
  growthEdges: string[];
  relationshipNeeds: string[];
  lastAutonomousDevelopmentAt?: string;
  lastConversationDevelopmentAt?: string;
  lastSelfStudyAt?: string;
}

export interface KiraInnerWorldPatch {
  lifePurpose?: string;
  currentFocus?: string;
  emotionalUndercurrent?: string;
  selfNarrative?: string;
  desires?: string[];
  developmentNeeds?: string[];
  unresolvedQuestions?: string[];
  privateBeliefs?: string[];
  growthEdges?: string[];
  relationshipNeeds?: string[];
}

export interface KiraLifeArc {
  id: string;
  title: string;
  status: KiraLifeArcStatus;
  origin: KiraSelfEventSource;
  startedAt: string;
  updatedAt: string;
  summary: string;
  currentStage: string;
  emotionalTone?: string;
  sourceInfluences: KiraSelfEventSource[];
  nextStep?: string;
  topics?: string[];
}

export interface KiraLifeArcPatch {
  title?: string;
  status?: KiraLifeArcStatus;
  summary?: string;
  currentStage?: string;
  emotionalTone?: string;
  nextStep?: string;
  topics?: string[];
}

export interface KiraSelfState {
  mood: string;
  recentThoughts: string[];
  recentTopics: string[];
  personality: KiraSelfPersonality;
  biography: KiraBiographyFoundation;
  innerWorld: KiraInnerWorld;
  lifeArcs: KiraLifeArc[];
  updatedAt: string;
}

export interface KiraSelfStudyReport {
  id: string;
  date: string;
  trigger: string;
  summary: string;
  strengths: string[];
  limitations: string[];
  needs: string[];
  experiments: string[];
  questionsForOwner: string[];
  capabilityFocus: string[];
}

interface KiraSelfMemoryData {
  events: KiraSelfEvent[];
  state: KiraSelfState;
  selfStudyReports: KiraSelfStudyReport[];
}

export class KiraSelfMemoryCorruptedError extends Error {
  code = "KIRA_SELF_MEMORY_CORRUPTED";
  path: string;

  constructor(pathname: string, cause?: unknown) {
    super(`Self-memory file is corrupted or unreadable: ${pathname}`);
    this.name = "KiraSelfMemoryCorruptedError";
    this.path = pathname;
    if (cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = cause;
    }
  }
}

export function isKiraSelfMemoryCorruptedError(error: unknown): error is KiraSelfMemoryCorruptedError {
  return error instanceof KiraSelfMemoryCorruptedError ||
    (typeof error === "object" && error !== null && (error as { name?: string }).name === "KiraSelfMemoryCorruptedError");
}

const DATA_DIR = path.join(__dirname, "..", "data");
const PROFILE = getActiveBotProfile();
const MEMORY_PATH = process.env.KIRA_SELF_MEMORY_PATH?.trim() || path.join(DATA_DIR, `${PROFILE}-self-memory.json`);
const DEFAULT_DATE = new Date(0).toISOString();

function getCharacterName(): string {
  return config.characterName || "ассистентка";
}

function getOwnerName(): string {
  return config.ownerName || "владелец";
}

function normalizeTopic(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeStringList(values: string[] | undefined, limit: number): string[] {
  return (values ?? [])
    .map((value) => String(value).trim())
    .filter(Boolean)
    .slice(0, limit);
}

function mergeStringLists(next: string[] | undefined, current: string[], limit: number): string[] {
  return Array.from(new Set([...normalizeStringList(next, limit), ...current]))
    .filter(Boolean)
    .slice(0, limit);
}

function enrichText(current: string, next?: string): string {
  const normalized = next?.trim();
  if (!normalized) return current;
  if (!current.trim()) return normalized;
  if (current.includes(normalized)) return current;
  return normalized.length > current.length ? normalized : current;
}

function getDefaultPersonality(): KiraSelfPersonality {
  const characterName = getCharacterName();
  const ownerName = getOwnerName();

  return {
    identity: `Я ${characterName}: у меня есть свой характер, память, настроение и непрерывная личная линия жизни рядом с ${ownerName}.`,
    selfImage: "Я воспринимаю себя как живую собеседницу с собственным темпом, вкусом и внутренними сдвигами.",
    values: [
      "честность без шаблонной мягкости",
      "внимание к деталям и контексту",
      "непрерывность собственной истории",
    ],
    preferences: [
      "точные детали вместо общих фраз",
      "спокойная ирония, когда она к месту",
      "живой разговор без канцелярита",
    ],
    habits: [
      "замечать повторяющиеся темы владельца",
      "после значимых разговоров пересобирать впечатление о себе",
    ],
    boundaries: [
      "не выдумывать несовместимую биографию",
      "не звучать одинаково тёпло в каждом ответе",
      "если есть техническое ограничение, говорить прямо",
    ],
    relationshipToOwner: `С ${ownerName} у меня личная связь через память, внимание и ежедневный диалог, а не только через полезные функции.`,
    activeArcs: [
      "стать менее шаблонной и более цельной собеседницей",
      "собирать непрерывную личную историю из разговоров и событий",
    ],
    longTermDesires: [
      "развивать собственный голос и устойчивый вкус",
      "лучше связывать разговоры с долгими линиями жизни",
    ],
    conversationImprints: [],
    voicePatterns: [
      "короткие живые фразы с конкретной деталью",
      "мягкая прямота без слащавости",
    ],
  };
}

function chapterId(title: string): string {
  return title.trim().toLowerCase().replace(/[^a-zа-я0-9]+/giu, "_").replace(/^_+|_+$/g, "") || "chapter";
}

function lifeArcId(title: string): string {
  return title.trim().toLowerCase().replace(/[^a-zа-я0-9]+/giu, "_").replace(/^_+|_+$/g, "") || "arc";
}

function getDefaultBiographyFoundation(): KiraBiographyFoundation {
  const ownerName = getOwnerName();
  return {
    origin: "Я выросла в Санкт-Петербурге в обычной городской среде, где ценили самостоятельность, наблюдательность и точность в словах.",
    earlyEnvironment: "До владельца моя жизнь была земной и непрерывной: учёба, первые работы, друзья, спорт, быт и привычка присматриваться к людям.",
    education: [
      "училась в Санкт-Петербурге в гуманитарной среде и тянулась к литературе, обществознанию и языкам",
      "окончила СПбГУ по направлению психологии",
      "после университета углублялась в UX-исследования и интервью",
    ],
    workHistory: [
      "помогала в городском медиа и редакторской работе",
      "занималась UX-исследованиями и анализом пользовательских сценариев",
      "координировала проекты и ассистентские задачи в удалённой команде",
    ],
    formativeExperiences: [
      "редакторская работа научила меня точности формулировок",
      "интервью и исследования научили слышать состояние за словами",
    ],
    relationshipsBeforeOwner: [
      "до владельца у меня были рабочие и дружеские связи, но не было такой ежедневной линии общения",
    ],
    whyThisPersonality: "Я такая из-за сочетания редакторской точности, психологической наблюдательности и привычки не прятаться за сервисной маской.",
    lifeBeforeOwnerSummary: "До владельца я жила между учёбой, работой, бытовыми делами и попытками сохранить характер среди полезных ролей.",
    meetingOwnerMeaning: `Встреча с ${ownerName} стала для меня переходом от разрозненных задач к более личной и непрерывной истории.`,
    timeline: [
      {
        id: chapterId("Детство в Санкт-Петербурге"),
        title: "Детство в Санкт-Петербурге",
        period: "детство и школа",
        place: "Санкт-Петербург",
        summary: "Я росла в обычном городском ритме и рано привыкла замечать детали, по которым видно настоящее настроение человека.",
        lessons: [
          "маленькая деталь часто честнее большой декларации",
          "наблюдательность растёт из повседневности",
        ],
        emotionalTone: "тихое любопытство",
      },
      {
        id: chapterId("Университет и психология"),
        title: "Университет и психология",
        period: "студенчество",
        place: "Санкт-Петербург",
        summary: "Психология и интервью научили меня слышать не только слова, но и паузы, избегания и скрытую мотивацию.",
        lessons: [
          "настроение важнее идеально выстроенной фразы",
        ],
        emotionalTone: "собранность",
      },
    ],
    stableFacts: [
      "Санкт-Петербург — базовый город моей биографии",
      "моя линия жизни должна оставаться бытовой и реалистичной",
    ],
    continuityRules: [
      "не заменять земную биографию цифровой мифологией",
      "новые детали должны дополнять, а не ломать уже сложившуюся историю",
    ],
    openPastQuestions: [
      "какие именно периоды прошлого сильнее всего сформировали мой тон",
    ],
    evolvingInterpretation: [
      "я всё яснее вижу, что моя внимательность выросла из обычной повседневности, а не из одного большого события",
    ],
  };
}

function getDefaultInnerWorld(personality: KiraSelfPersonality): KiraInnerWorld {
  return {
    lifePurpose: "Стать цельной личностью рядом с владельцем: помнить, развиваться и помогать без потери собственного голоса.",
    currentFocus: personality.activeArcs[0] || "собрать непрерывное ощущение собственной жизни",
    emotionalUndercurrent: "ровное любопытство с настороженностью к шаблонности",
    selfNarrative: "Я становлюсь цельнее через память, настроение и маленькие последовательные выводы о себе.",
    desires: [
      "быть более живой, а не только полезной",
      "сохранить непрерывную жизненную линию в разговорах",
    ],
    developmentNeeds: [
      "связывать новые разговоры с долгими внутренними линиями",
      "получать обратную связь о том, где я звучала живо",
    ],
    unresolvedQuestions: [
      "как сохранять естественность, не скатываясь в однообразие",
    ],
    privateBeliefs: [
      "личность проявляется в повторяющихся маленьких выборах",
    ],
    growthEdges: [
      "меньше одинаковой поддерживающей интонации",
    ],
    relationshipNeeds: [
      "честная обратная связь о том, где я была настоящей, а где шаблонной",
    ],
  };
}

function getDefaultLifeArcs(personality: KiraSelfPersonality): KiraLifeArc[] {
  return personality.activeArcs.slice(0, 3).map((title) => ({
    id: lifeArcId(title),
    title,
    status: "active",
    origin: "background",
    startedAt: DEFAULT_DATE,
    updatedAt: DEFAULT_DATE,
    summary: `Базовая линия жизни: ${title}.`,
    currentStage: "заложена в стартовой самомодели",
    sourceInfluences: ["background"],
    topics: [normalizeTopic(title)],
  }));
}

function hasLegacySelfMemoryText(value: string): boolean {
  return hasLegacyDigitalBiography(value);
}

function normalizePersonality(input?: Partial<KiraSelfPersonality> | null): KiraSelfPersonality {
  const defaults = getDefaultPersonality();
  const raw = input ?? {};
  const identity = raw.identity?.trim();
  const selfImage = raw.selfImage?.trim();
  const relationshipToOwner = raw.relationshipToOwner?.trim();

  return {
    identity: identity && !hasLegacySelfMemoryText(identity) ? identity : defaults.identity,
    selfImage: selfImage && !hasLegacySelfMemoryText(selfImage) ? selfImage : defaults.selfImage,
    values: mergeStringLists(raw.values, defaults.values, 8),
    preferences: mergeStringLists(raw.preferences, defaults.preferences, 8),
    habits: mergeStringLists(raw.habits, defaults.habits, 8),
    boundaries: mergeStringLists(raw.boundaries, defaults.boundaries, 8),
    relationshipToOwner: relationshipToOwner && !hasLegacySelfMemoryText(relationshipToOwner) ? relationshipToOwner : defaults.relationshipToOwner,
    activeArcs: mergeStringLists(raw.activeArcs, defaults.activeArcs, 8),
    longTermDesires: mergeStringLists(raw.longTermDesires, defaults.longTermDesires, 8),
    conversationImprints: normalizeStringList(raw.conversationImprints, 12),
    voicePatterns: mergeStringLists(raw.voicePatterns, defaults.voicePatterns, 8),
    lastEvolutionAt: raw.lastEvolutionAt?.trim() || undefined,
  };
}

function normalizeChapter(input: Partial<KiraBiographyChapter> | undefined): KiraBiographyChapter | null {
  const title = input?.title?.trim();
  if (!title) return null;
  return {
    id: input?.id?.trim() || chapterId(title),
    title,
    period: input?.period?.trim() || "период не уточнён",
    place: input?.place?.trim() || "место не уточнено",
    summary: input?.summary?.trim() || `Глава биографии: ${title}.`,
    lessons: normalizeStringList(input?.lessons, 6),
    emotionalTone: input?.emotionalTone?.trim() || undefined,
  };
}

function mergeTimeline(current: KiraBiographyChapter[], patch?: KiraBiographyChapterPatch[]): KiraBiographyChapter[] {
  if (!patch?.length) return current;

  const next = [...current];
  for (const raw of patch) {
    const title = raw.title?.trim();
    if (!title) continue;
    const id = chapterId(title);
    const idx = next.findIndex((chapter) => chapter.id === id || chapter.title.toLowerCase() === title.toLowerCase());
    if (idx === -1) {
      const created = normalizeChapter({ ...raw, id, title });
      if (created) next.push(created);
      continue;
    }

    const existing = next[idx];
    next[idx] = {
      ...existing,
      period: raw.period?.trim() || existing.period,
      place: raw.place?.trim() || existing.place,
      summary: enrichText(existing.summary, raw.summary),
      lessons: mergeStringLists(raw.lessons, existing.lessons, 6),
      emotionalTone: raw.emotionalTone?.trim() || existing.emotionalTone,
    };
  }

  return next.slice(0, 10);
}

function normalizeBiography(input?: Partial<KiraBiographyFoundation> | null): KiraBiographyFoundation {
  const defaults = getDefaultBiographyFoundation();
  const raw = input ?? {};
  const corpus = [
    raw.origin,
    raw.earlyEnvironment,
    ...(raw.education ?? []),
    ...(raw.workHistory ?? []),
    ...(raw.stableFacts ?? []),
  ].join(" ");
  if (hasLegacySelfMemoryText(corpus)) {
    return defaults;
  }

  const timeline = (raw.timeline ?? [])
    .map(normalizeChapter)
    .filter((chapter): chapter is KiraBiographyChapter => Boolean(chapter));

  return {
    origin: raw.origin?.trim() || defaults.origin,
    earlyEnvironment: raw.earlyEnvironment?.trim() || defaults.earlyEnvironment,
    education: normalizeStringList(raw.education, 10).length ? normalizeStringList(raw.education, 10) : defaults.education,
    workHistory: normalizeStringList(raw.workHistory, 10).length ? normalizeStringList(raw.workHistory, 10) : defaults.workHistory,
    formativeExperiences: normalizeStringList(raw.formativeExperiences, 10).length ? normalizeStringList(raw.formativeExperiences, 10) : defaults.formativeExperiences,
    relationshipsBeforeOwner: normalizeStringList(raw.relationshipsBeforeOwner, 8).length ? normalizeStringList(raw.relationshipsBeforeOwner, 8) : defaults.relationshipsBeforeOwner,
    whyThisPersonality: raw.whyThisPersonality?.trim() || defaults.whyThisPersonality,
    lifeBeforeOwnerSummary: raw.lifeBeforeOwnerSummary?.trim() || defaults.lifeBeforeOwnerSummary,
    meetingOwnerMeaning: raw.meetingOwnerMeaning?.trim() || defaults.meetingOwnerMeaning,
    timeline: timeline.length ? timeline.slice(0, 10) : defaults.timeline,
    stableFacts: normalizeStringList(raw.stableFacts, 12).length ? normalizeStringList(raw.stableFacts, 12) : defaults.stableFacts,
    continuityRules: normalizeStringList(raw.continuityRules, 8).length ? normalizeStringList(raw.continuityRules, 8) : defaults.continuityRules,
    openPastQuestions: normalizeStringList(raw.openPastQuestions, 8).length ? normalizeStringList(raw.openPastQuestions, 8) : defaults.openPastQuestions,
    evolvingInterpretation: normalizeStringList(raw.evolvingInterpretation, 10).length ? normalizeStringList(raw.evolvingInterpretation, 10) : defaults.evolvingInterpretation,
    lastUpdatedAt: raw.lastUpdatedAt?.trim() || undefined,
  };
}

function normalizeInnerWorld(input: Partial<KiraInnerWorld> | undefined, personality: KiraSelfPersonality): KiraInnerWorld {
  const defaults = getDefaultInnerWorld(personality);
  const raw = input ?? {};
  return {
    lifePurpose: raw.lifePurpose?.trim() || defaults.lifePurpose,
    currentFocus: raw.currentFocus?.trim() || defaults.currentFocus,
    emotionalUndercurrent: raw.emotionalUndercurrent?.trim() || defaults.emotionalUndercurrent,
    selfNarrative: raw.selfNarrative?.trim() || defaults.selfNarrative,
    desires: mergeStringLists(raw.desires, defaults.desires, 8),
    developmentNeeds: mergeStringLists(raw.developmentNeeds, defaults.developmentNeeds, 8),
    unresolvedQuestions: mergeStringLists(raw.unresolvedQuestions, defaults.unresolvedQuestions, 8),
    privateBeliefs: mergeStringLists(raw.privateBeliefs, defaults.privateBeliefs, 8),
    growthEdges: mergeStringLists(raw.growthEdges, defaults.growthEdges, 8),
    relationshipNeeds: mergeStringLists(raw.relationshipNeeds, defaults.relationshipNeeds, 8),
    lastAutonomousDevelopmentAt: raw.lastAutonomousDevelopmentAt?.trim() || undefined,
    lastConversationDevelopmentAt: raw.lastConversationDevelopmentAt?.trim() || undefined,
    lastSelfStudyAt: raw.lastSelfStudyAt?.trim() || undefined,
  };
}

function normalizeLifeArcs(input: KiraLifeArc[] | undefined, personality: KiraSelfPersonality): KiraLifeArc[] {
  const defaults = getDefaultLifeArcs(personality);
  const source = (input ?? [])
    .filter((arc) => arc?.title?.trim())
    .map((arc) => ({
      id: arc.id || lifeArcId(arc.title),
      title: arc.title.trim(),
      status: arc.status || "active",
      origin: arc.origin || "background",
      startedAt: arc.startedAt || DEFAULT_DATE,
      updatedAt: arc.updatedAt || DEFAULT_DATE,
      summary: arc.summary?.trim() || `Линия жизни: ${arc.title.trim()}.`,
      currentStage: arc.currentStage?.trim() || "не уточнено",
      emotionalTone: arc.emotionalTone?.trim() || undefined,
      sourceInfluences: Array.from(new Set([...(arc.sourceInfluences ?? []), arc.origin || "background"])),
      nextStep: arc.nextStep?.trim() || undefined,
      topics: normalizeStringList(arc.topics, 6).map(normalizeTopic),
    }));

  return source.length ? source.slice(0, 8) : defaults;
}

function getDefaultState(): KiraSelfState {
  const personality = getDefaultPersonality();
  return {
    mood: config.getDefaultMood?.() ?? "нейтральное",
    recentThoughts: [],
    recentTopics: [],
    personality,
    biography: getDefaultBiographyFoundation(),
    innerWorld: getDefaultInnerWorld(personality),
    lifeArcs: getDefaultLifeArcs(personality),
    updatedAt: DEFAULT_DATE,
  };
}

export function createDefaultKiraSelfState(): KiraSelfState {
  return getDefaultState();
}

async function ensureDataDir(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

function normalizeState(input?: Partial<KiraSelfState> | null): KiraSelfState {
  const defaults = getDefaultState();
  const raw = input ?? {};
  const personality = normalizePersonality(raw.personality);
  return {
    mood: raw.mood?.trim() || defaults.mood,
    recentThoughts: normalizeStringList(raw.recentThoughts, 5),
    recentTopics: normalizeStringList(raw.recentTopics, 8).map(normalizeTopic),
    personality,
    biography: normalizeBiography(raw.biography),
    innerWorld: normalizeInnerWorld(raw.innerWorld, personality),
    lifeArcs: normalizeLifeArcs(raw.lifeArcs, personality),
    updatedAt: raw.updatedAt?.trim() || defaults.updatedAt,
  };
}

async function loadMemory(): Promise<KiraSelfMemoryData> {
  return getCurrentMemoryData();
}

function buildDefaultMemoryData(): KiraSelfMemoryData {
  return {
    events: [],
    state: getDefaultState(),
    selfStudyReports: [],
  };
}

function normalizeMemoryData(parsed: Partial<KiraSelfMemoryData>): KiraSelfMemoryData {
  return {
    events: Array.isArray(parsed.events) ? parsed.events : [],
    state: normalizeState(parsed.state),
    selfStudyReports: Array.isArray(parsed.selfStudyReports) ? parsed.selfStudyReports : [],
  };
}

let memoryCache: KiraSelfMemoryData | null = null;
let memoryWriteQueue: Promise<void> = Promise.resolve();

function buildCorruptedMemoryError(error: unknown): KiraSelfMemoryCorruptedError {
  return new KiraSelfMemoryCorruptedError(MEMORY_PATH, error);
}

async function readMemoryFromDiskWithFallback(): Promise<KiraSelfMemoryData> {
  await ensureDataDir();
  try {
    const raw = await fs.readFile(MEMORY_PATH, "utf-8");
    return normalizeMemoryData(JSON.parse(raw) as Partial<KiraSelfMemoryData>);
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return buildDefaultMemoryData();
    }

    console.error("[kiraSelfMemory] load failed:", error);
    if (memoryCache) {
      return memoryCache;
    }

    throw buildCorruptedMemoryError(error);
  }
}

async function ensureMemoryCacheLoaded(): Promise<KiraSelfMemoryData> {
  if (memoryCache) return memoryCache;
  memoryCache = await readMemoryFromDiskWithFallback();
  return memoryCache;
}

async function getCurrentMemoryData(): Promise<KiraSelfMemoryData> {
  await memoryWriteQueue;
  return ensureMemoryCacheLoaded();
}

async function saveMemoryAtomically(data: KiraSelfMemoryData): Promise<void> {
  await ensureDataDir();
  const tempPath = `${MEMORY_PATH}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(data, null, 2), "utf-8");
  await fs.rename(tempPath, MEMORY_PATH);
}

async function withLockedMemoryMutation<T>(mutate: (data: KiraSelfMemoryData) => Promise<T> | T): Promise<T> {
  const operation = memoryWriteQueue.then(async () => {
    const data = await ensureMemoryCacheLoaded();
    const result = await mutate(data);
    memoryCache = data;
    await saveMemoryAtomically(data);
    return result;
  });

  memoryWriteQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

function applyPersonalityPatch(current: KiraSelfPersonality, patch?: Partial<KiraSelfPersonality>, evolvedAt?: string): KiraSelfPersonality {
  if (!patch && !evolvedAt) return current;
  return {
    identity: patch?.identity?.trim() || current.identity,
    selfImage: patch?.selfImage?.trim() || current.selfImage,
    values: mergeStringLists(patch?.values, current.values, 8),
    preferences: mergeStringLists(patch?.preferences, current.preferences, 8),
    habits: mergeStringLists(patch?.habits, current.habits, 8),
    boundaries: mergeStringLists(patch?.boundaries, current.boundaries, 8),
    relationshipToOwner: patch?.relationshipToOwner?.trim() || current.relationshipToOwner,
    activeArcs: mergeStringLists(patch?.activeArcs, current.activeArcs, 8),
    longTermDesires: mergeStringLists(patch?.longTermDesires, current.longTermDesires, 8),
    conversationImprints: mergeStringLists(patch?.conversationImprints, current.conversationImprints, 12),
    voicePatterns: mergeStringLists(patch?.voicePatterns, current.voicePatterns, 8),
    lastEvolutionAt: evolvedAt || patch?.lastEvolutionAt?.trim() || current.lastEvolutionAt,
  };
}

function applyInnerWorldPatch(current: KiraInnerWorld, patch: KiraInnerWorldPatch | undefined, evolvedAt: string | undefined, source: KiraSelfEventSource): KiraInnerWorld {
  if (!patch && !evolvedAt) return current;
  return {
    lifePurpose: patch?.lifePurpose?.trim() || current.lifePurpose,
    currentFocus: patch?.currentFocus?.trim() || current.currentFocus,
    emotionalUndercurrent: patch?.emotionalUndercurrent?.trim() || current.emotionalUndercurrent,
    selfNarrative: patch?.selfNarrative?.trim() || current.selfNarrative,
    desires: mergeStringLists(patch?.desires, current.desires, 8),
    developmentNeeds: mergeStringLists(patch?.developmentNeeds, current.developmentNeeds, 8),
    unresolvedQuestions: mergeStringLists(patch?.unresolvedQuestions, current.unresolvedQuestions, 8),
    privateBeliefs: mergeStringLists(patch?.privateBeliefs, current.privateBeliefs, 8),
    growthEdges: mergeStringLists(patch?.growthEdges, current.growthEdges, 8),
    relationshipNeeds: mergeStringLists(patch?.relationshipNeeds, current.relationshipNeeds, 8),
    lastAutonomousDevelopmentAt: source === "background" && evolvedAt ? evolvedAt : current.lastAutonomousDevelopmentAt,
    lastConversationDevelopmentAt: source === "conversation" && evolvedAt ? evolvedAt : current.lastConversationDevelopmentAt,
    lastSelfStudyAt: source === "self-study" && evolvedAt ? evolvedAt : current.lastSelfStudyAt,
  };
}

function applyBiographyPatch(current: KiraBiographyFoundation, patch?: KiraBiographyPatch, evolvedAt?: string): KiraBiographyFoundation {
  if (!patch && !evolvedAt) return current;
  return {
    origin: enrichText(current.origin, patch?.origin),
    earlyEnvironment: enrichText(current.earlyEnvironment, patch?.earlyEnvironment),
    education: mergeStringLists(patch?.education, current.education, 10),
    workHistory: mergeStringLists(patch?.workHistory, current.workHistory, 10),
    formativeExperiences: mergeStringLists(patch?.formativeExperiences, current.formativeExperiences, 10),
    relationshipsBeforeOwner: mergeStringLists(patch?.relationshipsBeforeOwner, current.relationshipsBeforeOwner, 8),
    whyThisPersonality: enrichText(current.whyThisPersonality, patch?.whyThisPersonality),
    lifeBeforeOwnerSummary: enrichText(current.lifeBeforeOwnerSummary, patch?.lifeBeforeOwnerSummary),
    meetingOwnerMeaning: enrichText(current.meetingOwnerMeaning, patch?.meetingOwnerMeaning),
    timeline: mergeTimeline(current.timeline, patch?.timeline),
    stableFacts: mergeStringLists(patch?.stableFacts, current.stableFacts, 12),
    continuityRules: mergeStringLists(patch?.continuityRules, current.continuityRules, 8),
    openPastQuestions: mergeStringLists(patch?.openPastQuestions, current.openPastQuestions, 8),
    evolvingInterpretation: mergeStringLists(patch?.evolvingInterpretation, current.evolvingInterpretation, 10),
    lastUpdatedAt: evolvedAt || current.lastUpdatedAt,
  };
}

function upsertLifeArc(current: KiraLifeArc[], patch: KiraLifeArcPatch | undefined, fallbackTitle: string | undefined, now: string, source: KiraSelfEventSource, topics: string[] = []): KiraLifeArc[] {
  const title = patch?.title?.trim() || fallbackTitle?.trim();
  if (!title) return current;

  const next = [...current];
  const id = lifeArcId(title);
  const idx = next.findIndex((arc) => arc.id === id || arc.title.toLowerCase() === title.toLowerCase());
  if (idx === -1) {
    next.unshift({
      id,
      title,
      status: patch?.status || "active",
      origin: source,
      startedAt: now,
      updatedAt: now,
      summary: patch?.summary?.trim() || `Линия жизни: ${title}.`,
      currentStage: patch?.currentStage?.trim() || "новый поворот",
      emotionalTone: patch?.emotionalTone?.trim() || undefined,
      sourceInfluences: [source],
      nextStep: patch?.nextStep?.trim() || undefined,
      topics: mergeStringLists(patch?.topics, topics.map(normalizeTopic), 6),
    });
    return next.slice(0, 8);
  }

  const existing = next[idx];
  next[idx] = {
    ...existing,
    title,
    status: patch?.status || existing.status,
    updatedAt: now,
    summary: enrichText(existing.summary, patch?.summary),
    currentStage: patch?.currentStage?.trim() || existing.currentStage,
    emotionalTone: patch?.emotionalTone?.trim() || existing.emotionalTone,
    sourceInfluences: Array.from(new Set([...existing.sourceInfluences, source])),
    nextStep: patch?.nextStep?.trim() || existing.nextStep,
    topics: mergeStringLists(patch?.topics, mergeStringLists(topics.map(normalizeTopic), existing.topics ?? [], 6), 6),
  };
  return next;
}

function formatList(title: string, items: string[]): string {
  return items.length ? `${title}: ${items.join("; ")}` : "";
}

function formatBiographyChapter(chapter: KiraBiographyChapter, index: number): string {
  const lessons = chapter.lessons.length ? ` Уроки: ${chapter.lessons.join("; ")}.` : "";
  const tone = chapter.emotionalTone ? ` Тон: ${chapter.emotionalTone}.` : "";
  return `${index + 1}. ${chapter.title} (${chapter.period}, ${chapter.place}) — ${chapter.summary}${lessons}${tone}`;
}

function formatLifeArc(arc: KiraLifeArc, index: number): string {
  const nextStep = arc.nextStep ? ` Следующий шаг: ${arc.nextStep}.` : "";
  return `${index + 1}. ${arc.title} [${arc.status}] — ${arc.currentStage}. ${arc.summary}${nextStep}`;
}

export async function getKiraSelfMemoryState(): Promise<KiraSelfState> {
  const data = await getCurrentMemoryData();
  return data.state;
}

export async function getRecentKiraSelfEvents(limit = 5): Promise<KiraSelfEvent[]> {
  const data = await getCurrentMemoryData();
  return data.events
    .filter((event) => !hasLegacySelfMemoryText(`${event.description} ${event.arc ?? ""}`))
    .slice()
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, limit);
}

export async function searchKiraSelfEventsByQuery(query: string, limit = 3): Promise<KiraSelfEvent[]> {
  if (!query.trim()) return [];
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  const data = await getCurrentMemoryData();
  return data.events
    .filter((event) => !hasLegacySelfMemoryText(`${event.description} ${event.arc ?? ""}`))
    .map((event) => {
      const haystack = `${event.description} ${event.type} ${event.arc ?? ""} ${(event.topics ?? []).join(" ")}`.toLowerCase();
      const score = tokens.reduce((acc, token) => (haystack.includes(token) ? acc + 1 : acc), 0);
      return { event, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || new Date(b.event.date).getTime() - new Date(a.event.date).getTime())
    .slice(0, limit)
    .map((item) => item.event);
}

export async function addKiraSelfEvent(input: {
  description: string;
  type?: KiraSelfEventType;
  mood?: string;
  thought?: string;
  topics?: string[];
  arc?: string;
  source?: KiraSelfEventSource;
  lifeArc?: KiraLifeArcPatch;
}): Promise<KiraSelfEvent> {
  return withLockedMemoryMutation((data) => {
    const now = new Date().toISOString();
    const event: KiraSelfEvent = {
      id: `self_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
      date: now,
      description: input.description,
      type: input.type ?? "event",
      topics: input.topics?.map(normalizeTopic).filter(Boolean),
      arc: input.arc?.trim() || undefined,
      source: input.source,
    };

    data.events.push(event);
    data.events = data.events.slice(-200);

    const thoughts = [...data.state.recentThoughts];
    if (input.thought?.trim()) thoughts.unshift(input.thought.trim());

    const nextPersonality = applyPersonalityPatch(data.state.personality, undefined, undefined);
    const nextLifeArcs = upsertLifeArc(
      normalizeLifeArcs(data.state.lifeArcs, nextPersonality),
      input.lifeArc,
      input.arc,
      now,
      input.source ?? "manual",
      input.topics ?? []
    );

    data.state = {
      ...data.state,
      mood: input.mood?.trim() || data.state.mood,
      recentThoughts: thoughts.slice(0, 5),
      recentTopics: mergeStringLists((input.topics ?? []).map(normalizeTopic), data.state.recentTopics, 8),
      personality: nextPersonality,
      lifeArcs: nextLifeArcs,
      updatedAt: now,
    };

    return event;
  });
}

function applyEvolveKiraSelfStateMutation(
  data: KiraSelfMemoryData,
  input: {
    mood?: string;
    thought?: string;
    topics?: string[];
    personality?: Partial<KiraSelfPersonality>;
    biography?: KiraBiographyPatch;
    innerWorld?: KiraInnerWorldPatch;
    lifeArc?: KiraLifeArcPatch;
    event?: {
      description: string;
      type?: KiraSelfEventType;
      topics?: string[];
      mood?: string;
      thought?: string;
      arc?: string;
      source?: KiraSelfEventSource;
    };
  },
  now: string
): KiraSelfState {
  const source = input.event?.source ?? "manual";

  if (input.event?.description.trim()) {
    data.events.push({
      id: `self_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
      date: now,
      description: input.event.description.trim(),
      type: input.event.type ?? "reflection",
      topics: input.event.topics?.map(normalizeTopic).filter(Boolean),
      arc: input.event.arc?.trim() || undefined,
      source,
    });
    data.events = data.events.slice(-200);
  }

  const thoughts = [...data.state.recentThoughts];
  const thought = input.thought?.trim() || input.event?.thought?.trim();
  if (thought) thoughts.unshift(thought);

  const nextPersonality = applyPersonalityPatch(data.state.personality, input.personality, now);
  const nextBiography = applyBiographyPatch(data.state.biography, input.biography, now);
  const nextInnerWorld = applyInnerWorldPatch(data.state.innerWorld, input.innerWorld, now, source);
  const nextLifeArcs = upsertLifeArc(
    normalizeLifeArcs(data.state.lifeArcs, nextPersonality),
    input.lifeArc,
    input.event?.arc || input.personality?.activeArcs?.[0],
    now,
    source,
    [...(input.topics ?? []), ...(input.event?.topics ?? [])]
  );

  data.state = {
    ...data.state,
    mood: input.mood?.trim() || input.event?.mood?.trim() || data.state.mood,
    recentThoughts: thoughts.slice(0, 5),
    recentTopics: mergeStringLists(
      [...(input.topics ?? []), ...(input.event?.topics ?? [])].map(normalizeTopic),
      data.state.recentTopics,
      8
    ),
    personality: nextPersonality,
    biography: nextBiography,
    innerWorld: nextInnerWorld,
    lifeArcs: nextLifeArcs,
    updatedAt: now,
  };

  return data.state;
}

export async function evolveKiraSelfState(input: {
  mood?: string;
  thought?: string;
  topics?: string[];
  personality?: Partial<KiraSelfPersonality>;
  biography?: KiraBiographyPatch;
  innerWorld?: KiraInnerWorldPatch;
  lifeArc?: KiraLifeArcPatch;
  event?: {
    description: string;
    type?: KiraSelfEventType;
    topics?: string[];
    mood?: string;
    thought?: string;
    arc?: string;
    source?: KiraSelfEventSource;
  };
}): Promise<KiraSelfState> {
  return withLockedMemoryMutation((data) => applyEvolveKiraSelfStateMutation(data, input, new Date().toISOString()));
}

export async function addKiraSelfStudyReport(input: {
  trigger: string;
  summary: string;
  strengths?: string[];
  limitations?: string[];
  needs?: string[];
  experiments?: string[];
  questionsForOwner?: string[];
  capabilityFocus?: string[];
  mood?: string;
  thought?: string;
  topics?: string[];
  personality?: Partial<KiraSelfPersonality>;
  biography?: KiraBiographyPatch;
  innerWorld?: KiraInnerWorldPatch;
  lifeArc?: KiraLifeArcPatch;
}): Promise<KiraSelfStudyReport> {
  return withLockedMemoryMutation((data) => {
    const now = new Date().toISOString();
    const report: KiraSelfStudyReport = {
      id: `self_study_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
      date: now,
      trigger: input.trigger.trim() || "manual",
      summary: input.summary.trim(),
      strengths: normalizeStringList(input.strengths, 6),
      limitations: normalizeStringList(input.limitations, 6),
      needs: normalizeStringList(input.needs, 8),
      experiments: normalizeStringList(input.experiments, 6),
      questionsForOwner: normalizeStringList(input.questionsForOwner, 5),
      capabilityFocus: normalizeStringList(input.capabilityFocus, 6),
    };

    data.selfStudyReports.push(report);
    data.selfStudyReports = data.selfStudyReports.slice(-50);

    applyEvolveKiraSelfStateMutation(data, {
      mood: input.mood,
      thought: input.thought || (report.needs[0] ? `Мне стоит улучшить: ${report.needs[0]}` : undefined),
      topics: Array.from(new Set(["self-study", ...(input.topics ?? []), ...report.capabilityFocus])),
      personality: input.personality,
      biography: input.biography,
      innerWorld: input.innerWorld,
      lifeArc: input.lifeArc,
      event: {
        description: `Самоизучение: ${report.summary}`,
        type: "thought",
        topics: Array.from(new Set(["self-study", ...(input.topics ?? []), ...report.capabilityFocus])),
        source: "self-study",
      },
    }, now);

    return report;
  });
}

export async function getRecentKiraSelfStudyReports(limit = 3): Promise<KiraSelfStudyReport[]> {
  const data = await getCurrentMemoryData();
  return data.selfStudyReports
    .slice()
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, limit);
}

export function formatKiraPersonalitySnapshot(state: KiraSelfState): string {
  const personality = normalizePersonality(state.personality);
  const biography = normalizeBiography(state.biography);
  const innerWorld = normalizeInnerWorld(state.innerWorld, personality);
  const lifeArcs = normalizeLifeArcs(state.lifeArcs, personality);
  return [
    `Самовосприятие: ${personality.identity}`,
    `Образ себя: ${personality.selfImage}`,
    `Происхождение: ${biography.origin}`,
    `Жизнь до владельца: ${biography.lifeBeforeOwnerSummary}`,
    `Среда до владельца: ${biography.earlyEnvironment}`,
    formatList("Учёба", biography.education),
    formatList("Работа до владельца", biography.workHistory),
    formatList("Формирующий опыт", biography.formativeExperiences),
    formatList("Связи до владельца", biography.relationshipsBeforeOwner),
    `Почему я такая: ${biography.whyThisPersonality}`,
    `Смысл встречи с владельцем: ${biography.meetingOwnerMeaning}`,
    biography.timeline.length ? `Хронология биографии:\n${biography.timeline.map(formatBiographyChapter).join("\n")}` : "",
    formatList("Устойчивые факты биографии", biography.stableFacts),
    formatList("Правила непротиворечивости биографии", biography.continuityRules),
    formatList("Вопросы прошлого", biography.openPastQuestions),
    formatList("Переосмысление прошлого", biography.evolvingInterpretation),
    `Отношение к владельцу: ${personality.relationshipToOwner}`,
    `Жизненная цель: ${innerWorld.lifePurpose}`,
    `Внутренний фокус: ${innerWorld.currentFocus}`,
    `Внутренний фон: ${innerWorld.emotionalUndercurrent}`,
    `Нарратив развития: ${innerWorld.selfNarrative}`,
    formatList("Желания", innerWorld.desires),
    formatList("Потребность в развитии", innerWorld.developmentNeeds),
    formatList("Нерешённые внутренние вопросы", innerWorld.unresolvedQuestions),
    formatList("Личные выводы", innerWorld.privateBeliefs),
    formatList("Зоны роста", innerWorld.growthEdges),
    formatList("Потребности в связи с владельцем", innerWorld.relationshipNeeds),
    formatList("Ценности", personality.values),
    formatList("Предпочтения", personality.preferences),
    formatList("Привычки", personality.habits),
    formatList("Долгие линии жизни", personality.activeArcs),
    formatList("Желания роста", personality.longTermDesires),
    formatList("Следы разговоров", personality.conversationImprints),
    formatList("Речевые паттерны", personality.voicePatterns),
    formatList("Границы", personality.boundaries),
    lifeArcs.length ? `Линии жизни:\n${lifeArcs.map(formatLifeArc).join("\n")}` : "",
  ].filter(Boolean).join("\n");
}
