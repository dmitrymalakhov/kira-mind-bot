import * as fs from "fs/promises";
import * as path from "path";
import { config } from "../config";

export type KiraSelfEventType = "mood" | "activity" | "thought" | "event";

export interface KiraSelfEvent {
  id: string;
  date: string;
  description: string;
  type: KiraSelfEventType;
  topics?: string[];
}

export interface KiraSelfState {
  mood: string;
  recentThoughts: string[];
  recentTopics: string[];
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

const DATA_DIR = path.join(__dirname, "..", "data");
const PROFILE = process.env.ASSISTANT_PROFILE || "KiraMindBot";
const MEMORY_PATH = path.join(DATA_DIR, `${PROFILE}-self-memory.json`);

function getDefaultState(): KiraSelfState {
  const mood = config.getDefaultMood?.() ?? "нейтральное";
  return {
    mood,
    recentThoughts: [],
    recentTopics: [],
    updatedAt: new Date(0).toISOString(),
  };
}

async function ensureDataDir(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function loadMemory(): Promise<KiraSelfMemoryData> {
  await ensureDataDir();

  try {
    const raw = await fs.readFile(MEMORY_PATH, "utf-8");
    const parsed = JSON.parse(raw) as Partial<KiraSelfMemoryData>;

    return {
      events: Array.isArray(parsed.events) ? parsed.events : [],
      state: parsed.state ? { ...getDefaultState(), ...parsed.state } : { ...getDefaultState() },
      selfStudyReports: Array.isArray(parsed.selfStudyReports) ? parsed.selfStudyReports : [],
    };
  } catch (error) {
    return {
      events: [],
      state: { ...getDefaultState() },
      selfStudyReports: [],
    };
  }
}

async function saveMemory(data: KiraSelfMemoryData): Promise<void> {
  await ensureDataDir();
  await fs.writeFile(MEMORY_PATH, JSON.stringify(data, null, 2), "utf-8");
}

function normalizeTopic(value: string): string {
  return value.trim().toLowerCase();
}

export async function getKiraSelfMemoryState(): Promise<KiraSelfState> {
  const data = await loadMemory();
  return data.state;
}

export async function getRecentKiraSelfEvents(limit: number = 5): Promise<KiraSelfEvent[]> {
  const data = await loadMemory();
  return data.events
    .slice()
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, limit);
}

export async function searchKiraSelfEventsByQuery(query: string, limit: number = 3): Promise<KiraSelfEvent[]> {
  if (!query.trim()) {
    return [];
  }

  const queryTokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  const data = await loadMemory();

  const ranked = data.events
    .map((event) => {
      const haystack = `${event.description} ${event.type}`.toLowerCase();
      const score = queryTokens.reduce((acc, token) => (haystack.includes(token) ? acc + 1 : acc), 0);
      return { event, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || new Date(b.event.date).getTime() - new Date(a.event.date).getTime())
    .slice(0, limit)
    .map((item) => item.event);

  return ranked;
}

export async function addKiraSelfEvent(input: {
  description: string;
  type?: KiraSelfEventType;
  mood?: string;
  thought?: string;
  topics?: string[];
}): Promise<KiraSelfEvent> {
  const data = await loadMemory();

  const event: KiraSelfEvent = {
    id: `self_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
    date: new Date().toISOString(),
    description: input.description,
    type: input.type ?? "event",
    topics: input.topics?.map(normalizeTopic).filter(Boolean),
  };

  data.events.push(event);
  data.events = data.events.slice(-200);

  const nextThoughts = [...data.state.recentThoughts];
  if (input.thought?.trim()) {
    nextThoughts.unshift(input.thought.trim());
  }

  data.state = {
    mood: input.mood?.trim() || data.state.mood,
    recentThoughts: nextThoughts.slice(0, 5),
    recentTopics: Array.from(
      new Set([...(input.topics ?? []).map(normalizeTopic), ...data.state.recentTopics.map(normalizeTopic)])
    )
      .filter(Boolean)
      .slice(0, 8),
    updatedAt: new Date().toISOString(),
  };

  await saveMemory(data);
  return event;
}

function normalizeStringList(values: string[] | undefined, limit: number): string[] {
  return (values ?? [])
    .map((value) => String(value).trim())
    .filter(Boolean)
    .slice(0, limit);
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
}): Promise<KiraSelfStudyReport> {
  const data = await loadMemory();
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

  const event: KiraSelfEvent = {
    id: `self_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
    date: now,
    description: `Самоизучение: ${report.summary}`,
    type: "thought",
    topics: Array.from(new Set(["self-study", ...(input.topics ?? []), ...report.capabilityFocus].map(normalizeTopic)))
      .filter(Boolean)
      .slice(0, 8),
  };
  data.events.push(event);
  data.events = data.events.slice(-200);

  const nextThoughts = [...data.state.recentThoughts];
  if (input.thought?.trim()) {
    nextThoughts.unshift(input.thought.trim());
  } else if (report.needs[0]) {
    nextThoughts.unshift(`Мне стоит улучшить: ${report.needs[0]}`);
  }

  data.state = {
    mood: input.mood?.trim() || data.state.mood,
    recentThoughts: nextThoughts.slice(0, 5),
    recentTopics: Array.from(
      new Set([...(event.topics ?? []), ...data.state.recentTopics.map(normalizeTopic)])
    )
      .filter(Boolean)
      .slice(0, 8),
    updatedAt: now,
  };

  await saveMemory(data);
  return report;
}

export async function getRecentKiraSelfStudyReports(limit: number = 3): Promise<KiraSelfStudyReport[]> {
  const data = await loadMemory();
  return data.selfStudyReports
    .slice()
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, limit);
}
