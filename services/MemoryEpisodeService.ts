import { v4 as uuidv4 } from 'uuid';
import { BotContext, MemoryEpisode, MemorySourceMessage, MessageHistory, WorkingMemoryState } from '../types';
import { PREDEFINED_DOMAINS } from '../constants/domains';
import { getVectorService } from './VectorServiceFactory';
import { config } from '../config';
import openai from '../openai';
import { devLog, parseLLMJson } from '../utils';

const EPISODE_DOMAIN = PREDEFINED_DOMAINS.GENERAL;
const EPISODE_TAG = 'memory-episode';
const MAX_EPISODE_MESSAGES = 12;

interface EpisodeLLMResult {
    summary?: string;
    participants?: string[];
    entities?: string[];
    domains?: string[];
    emotion?: string;
    salience?: number;
}

interface WorkingMemoryLLMResult {
    summary?: string;
    activeTopics?: string[];
    activeEntities?: string[];
    openLoops?: string[];
    userMood?: string;
    lastUserIntent?: string;
}

function botId(): string {
    return process.env.BOT_ID || config.botUsername?.toLowerCase() || 'kira-mind-bot';
}

function asSourceMessages(messages: MessageHistory[]): MemorySourceMessage[] {
    return messages.slice(-MAX_EPISODE_MESSAGES).map((m) => ({
        role: m.role,
        content: m.content,
        timestamp: m.timestamp instanceof Date ? m.timestamp : new Date(m.timestamp),
    }));
}

function normalizeDomains(domains: unknown): string[] {
    const allowed = new Set(Object.values(PREDEFINED_DOMAINS));
    const values = Array.isArray(domains) ? domains : [];
    const normalized = values
        .map((d) => String(d).trim().toLowerCase())
        .filter((d) => allowed.has(d as any));
    return [...new Set(normalized)].slice(0, 5);
}

function normalizeStringList(values: unknown, limit: number): string[] {
    if (!Array.isArray(values)) return [];
    return [...new Set(
        values
            .map((v) => String(v).trim())
            .filter((v) => v.length > 0 && v.length <= 80)
    )].slice(0, limit);
}

function clamp01(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.min(1, Math.max(0, value))
        : fallback;
}

function fallbackEpisodeSummary(messages: MemorySourceMessage[]): string {
    const userMessages = messages.filter((m) => m.role === 'user').map((m) => m.content.trim());
    const first = userMessages[0] ?? messages[0]?.content ?? '';
    const last = userMessages[userMessages.length - 1] ?? messages[messages.length - 1]?.content ?? '';
    const summary = first === last ? first : `${first} / ${last}`;
    return summary.slice(0, 260) || 'Короткий эпизод разговора без явного содержания.';
}

function formatEpisodeContent(episode: MemoryEpisode): string {
    const parts = [
        `[ЭПИЗОД ПАМЯТИ: ${episode.id}]`,
        `Когда: ${episode.startTime.toISOString()} — ${episode.endTime.toISOString()}`,
        `Кратко: ${episode.summary}`,
        episode.participants.length ? `Участники: ${episode.participants.join(', ')}` : '',
        episode.entities.length ? `Сущности: ${episode.entities.join(', ')}` : '',
        episode.domains.length ? `Домены: ${episode.domains.join(', ')}` : '',
        episode.emotion ? `Эмоциональный фон: ${episode.emotion}` : '',
    ].filter(Boolean);
    return parts.join('\n');
}

async function analyzeEpisode(messages: MemorySourceMessage[]): Promise<EpisodeLLMResult> {
    const dialogue = messages
        .map((m, i) => `${i + 1}. ${m.role === 'user' ? 'Пользователь' : 'Бот'}: ${m.content.slice(0, 700)}`)
        .join('\n');

    try {
        const resp = await openai.chat.completions.create({
            model: 'gpt-5.4-nano',
            messages: [
                {
                    role: 'system',
                    content: 'Ты выделяешь эпизодическую память из короткого диалога. Отвечай только валидным JSON.',
                },
                {
                    role: 'user',
                    content: `Диалог:
${dialogue}

Сожми это не как список фактов, а как человеческий эпизод: что происходило, кто/что упоминалось, почему это может быть важно позже.

JSON:
{
  "summary": "1-2 предложения, конкретная сцена разговора",
  "participants": ["Пользователь", "Кира", "имена людей если были"],
  "entities": ["люди, места, проекты, события"],
  "domains": ["work|health|family|finance|education|hobbies|travel|social|home|personal|entertainment|general"],
  "emotion": "краткий эмоциональный фон или neutral",
  "salience": 0.0-1.0
}`,
                },
            ],
            temperature: 0.3,
        });

        return parseLLMJson<EpisodeLLMResult>(resp.choices[0]?.message?.content || '') ?? {};
    } catch (e) {
        devLog('MemoryEpisodeService: episode LLM failed', e);
        return {};
    }
}

export async function createMemoryEpisode(
    ctx: BotContext,
    messages: MessageHistory[],
    tags: string[] = []
): Promise<MemoryEpisode | null> {
    const userId = ctx.from?.id;
    if (!userId || messages.length === 0) return null;

    const sourceMessages = asSourceMessages(messages);
    if (sourceMessages.length === 0) return null;

    const startTime = sourceMessages[0].timestamp;
    const endTime = sourceMessages[sourceMessages.length - 1].timestamp;
    const analyzed = await analyzeEpisode(sourceMessages);
    const domains = normalizeDomains(analyzed.domains);
    if (domains.length === 0) domains.push(PREDEFINED_DOMAINS.GENERAL);

    const episode: MemoryEpisode = {
        id: uuidv4(),
        userId: String(userId),
        botId: botId(),
        chatId: ctx.chat?.id != null ? String(ctx.chat.id) : undefined,
        summary: String(analyzed.summary || fallbackEpisodeSummary(sourceMessages)).trim().slice(0, 600),
        startTime,
        endTime,
        timestamp: new Date(),
        participants: normalizeStringList(analyzed.participants, 8),
        entities: normalizeStringList(analyzed.entities, 12),
        domains,
        emotion: analyzed.emotion ? String(analyzed.emotion).trim().slice(0, 80) : undefined,
        salience: clamp01(analyzed.salience, 0.55),
        sourceMessages,
        tags: [...new Set([EPISODE_TAG, ...tags])],
    };

    const svc = getVectorService();
    if (!svc) return episode;

    try {
        await svc.saveMemory({
            content: formatEpisodeContent(episode),
            domain: EPISODE_DOMAIN,
            timestamp: episode.timestamp,
            importance: Math.max(0.55, episode.salience),
            tags: [
                EPISODE_TAG,
                ...episode.domains.map((d) => `episode_domain:${d}`),
                ...tags,
            ],
            userId: String(userId),
            botId: episode.botId,
            isAnchor: episode.salience >= 0.82 || undefined,
            confidence: 0.75,
            lastAccessedAt: episode.timestamp,
            memoryKind: 'episode',
            strength: Math.min(1, 0.55 + episode.salience * 0.35),
            vividness: Math.min(1, 0.45 + episode.salience * 0.35),
            specificity: Math.min(1, 0.35 + episode.entities.length * 0.04 + episode.participants.length * 0.03),
            sourceEpisodeId: episode.id,
            sourceContext: episode.summary,
            extractionMethod: 'episode',
            subject: 'user',
            status: 'active',
            confirmationCount: 1,
            lastConfirmedAt: episode.timestamp,
        });
        devLog('Memory episode saved:', episode.id, episode.summary.slice(0, 80));
    } catch (e) {
        devLog('MemoryEpisodeService: save episode failed', e);
    }

    return episode;
}

export async function updateWorkingMemoryFromMessages(
    ctx: BotContext,
    messages: MessageHistory[],
    episode?: MemoryEpisode | null
): Promise<WorkingMemoryState | undefined> {
    if (!ctx.session || messages.length === 0) return ctx.session?.workingMemory;

    const previous = ctx.session.workingMemory;
    const sourceMessages = asSourceMessages(messages);
    const dialogue = sourceMessages
        .map((m) => `${m.role === 'user' ? 'Пользователь' : 'Бот'}: ${m.content.slice(0, 400)}`)
        .join('\n');

    try {
        const resp = await openai.chat.completions.create({
            model: 'gpt-5.4-nano',
            messages: [
                { role: 'system', content: 'Ты обновляешь краткую рабочую память ассистента. Отвечай только JSON.' },
                {
                    role: 'user',
                    content: `Предыдущая рабочая память:
${previous ? JSON.stringify(previous) : 'нет'}

Новый фрагмент диалога:
${dialogue}

${episode ? `Эпизод: ${episode.summary}` : ''}

Обнови рабочую память. Это краткая текущая ситуация, не долговременная биография.
JSON:
{
  "summary": "одно короткое резюме текущего контекста",
  "activeTopics": ["до 5 тем"],
  "activeEntities": ["до 8 людей/мест/проектов"],
  "openLoops": ["до 5 нерешённых вопросов, обещаний или ожиданий"],
  "userMood": "если ясно",
  "lastUserIntent": "если ясно"
}`,
                },
            ],
            temperature: 0.2,
        });

        const data = parseLLMJson<WorkingMemoryLLMResult>(resp.choices[0]?.message?.content || '') ?? {};
        const next: WorkingMemoryState = {
            summary: String(data.summary || episode?.summary || previous?.summary || '').trim().slice(0, 700),
            activeTopics: normalizeStringList(data.activeTopics, 5),
            activeEntities: normalizeStringList(data.activeEntities, 8),
            openLoops: normalizeStringList(data.openLoops, 5),
            userMood: data.userMood ? String(data.userMood).trim().slice(0, 80) : previous?.userMood,
            lastUserIntent: data.lastUserIntent ? String(data.lastUserIntent).trim().slice(0, 120) : previous?.lastUserIntent,
            lastUpdatedAt: new Date(),
        };
        ctx.session.workingMemory = next;
        return next;
    } catch (e) {
        devLog('MemoryEpisodeService: working memory update failed', e);
        if (episode) {
            ctx.session.workingMemory = {
                summary: episode.summary,
                activeTopics: episode.domains,
                activeEntities: episode.entities,
                openLoops: previous?.openLoops ?? [],
                userMood: episode.emotion ?? previous?.userMood,
                lastUserIntent: previous?.lastUserIntent,
                lastUpdatedAt: new Date(),
            };
        }
        return ctx.session.workingMemory;
    }
}
