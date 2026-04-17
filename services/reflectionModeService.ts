/**
 * Reflection Mode — режим фоновой рефлексии и накопления знаний.
 *
 * Работает как фоновый наблюдатель: каждое новое входящее сообщение в личных
 * чатах Telegram попадает в буфер. Планировщик периодически проверяет буферы
 * и запускает двухэтапный анализ:
 *
 *   1. Pre-screen (gpt-5-nano, ~150 токенов): есть ли в батче что-то стоящее?
 *   2. Полное извлечение (gpt-5.4): только если pre-screen ответил YES.
 *
 * Гарантии отсутствия повторного анализа:
 *  - Timestamp последнего проанализированного сообщения персистируется в БД.
 *  - После рестарта бот фильтрует ранее проанализированные сообщения по этому timestamp.
 *  - In-memory кеш (`chatLastAnalyzedMap`) исключает дубли без обращения к БД.
 *
 * Контекстный анализ:
 *  - К новым сообщениям добавляется контекст: последние N сообщений из MessageStore
 *    (которые были до батча), помеченные как "[контекст]".
 *  - Это позволяет LLM понимать о чём идёт речь даже при коротких батчах.
 *
 * Экономия токенов:
 *  - Pre-filter: сообщения < 8 символов, чистые emoji/знаки — в корзину.
 *  - Батчинг: от 5 сообщений или через 30 мин.
 *  - Rate-limit: не более 6 полных анализов в час.
 */

import { Bot } from 'grammy';
import { BotContext } from '../types';
import { config } from '../config';
import { runAnalyzeConversationAgent } from '../agents/analyzeConversationAgent';
import { saveMemory, searchAllDomainsMemories } from '../utils/enhancedDomainMemory';
import { getSetting, setSetting } from './botSettingsService';
import { devLog, parseLLMJson } from '../utils';
import openai from '../openai';
import { getProactiveChatId } from '../utils/allowedUserChatStore';
import { MessageStore } from '../stores/MessageStore';

// ── Настройки ─────────────────────────────────────────────────────────────────

const SETTING_KEY = 'reflection_mode_enabled';
/** Ключ в bot_settings для хранения timestamp последнего проанализированного сообщения */
const LAST_ANALYZED_KEY_PREFIX = 'reflection_last_analyzed:';
/** Fix 4: Ключ для хранения домена/типа чата */
const CHAT_DOMAIN_KEY_PREFIX = 'reflection_chat_domain:';
/** Fix 6: Ключ для хранения EMA yield rate чата */
const YIELD_KEY_PREFIX = 'reflection_yield:';
/** Fix 5: Ключи для кумулятивной статистики */
const STATS_TOTAL_ANALYSES_KEY = 'reflection_stats_total_analyses';
const STATS_TOTAL_SAVED_KEY = 'reflection_stats_total_saved';
const STATS_LAST_ACTIVITY_KEY = 'reflection_stats_last_activity';

const BATCH_MIN_MESSAGES = 5;
const BATCH_MAX_AGE_MS = 30 * 60 * 1000;
const MAX_BUFFER_SIZE = 50;
const HOURLY_ANALYSIS_LIMIT = 6;
const PRESCREEN_MAX_MESSAGES = 20;
const MIN_TEXT_LENGTH = 8;
const MIN_IMPORTANCE = 0.3;
/** Сколько предыдущих сообщений из MessageStore добавляем как контекст */
const CONTEXT_MAX_MESSAGES = 15;
/** Пауза между сообщениями, после которой считаем сессию завершённой */
const SESSION_GAP_MS = 2 * 60 * 60 * 1000; // 2 часа
/** Fix 6: EMA alpha для yield rate */
const YIELD_ALPHA = 0.4;
const DEFAULT_YIELD = 2.0;
/** Минимальная пауза между triage-вызовами для одного чата */
const TRIAGE_COOLDOWN_MS = 2 * 60 * 1000; // 2 минуты

// ── Типы ─────────────────────────────────────────────────────────────────────

interface BufferedMessage {
    /** Имя отправителя или "Я" для исходящих */
    senderName: string;
    text: string;
    date: Date;
    /** true = исходящее сообщение от владельца бота */
    isOwn: boolean;
}

interface ChatBuffer {
    chatTitle: string;
    messages: BufferedMessage[];
    /** Когда в последний раз запускался processBuffers для этого чата */
    lastAnalyzedAt: Date | null;
    /** Timestamp последнего сообщения, которое было успешно проанализировано */
    lastAnalyzedMessageAt: Date | null;
    enqueuedAt: Date;
    /** Когда пришло последнее сообщение — для детектирования конца сессии */
    lastMessageAt: Date | null;
    /** Сообщение с ключевым словом жизненного события — анализировать немедленно */
    highPriority: boolean;
}

// ── Состояние модуля ──────────────────────────────────────────────────────────

const chatBuffers = new Map<string, ChatBuffer>();

/**
 * Per-chat кеш последнего проанализированного сообщения (персистируется в БД).
 * Используется в queueMessage для синхронной фильтрации уже-обработанных сообщений.
 */
const chatLastAnalyzedMap = new Map<string, Date>();

/** Fix 4: Кеш домена/типа чата (персистируется в БД) */
const chatDomainMap = new Map<string, string>();

/** Fix 6: Кеш EMA yield rate (факты/батч) per chat (персистируется в БД) */
const chatYieldRateMap = new Map<string, number>();

/** Timestamp последнего triage-вызова per chat — для дебаунсинга */
const chatLastTriageAt = new Map<string, number>();

/** Чаты с ботами — никогда не анализируем */
const botChatIds = new Set<string>();

let enabled = true;
let analysesThisHour = 0;
let hourWindowStart = Date.now();

// Fix 5: Session metrics (сбрасываются при рестарте)
let prescreenTotal = 0;
let prescreenPassed = 0;
let savedThisSession = 0;

// Fix 5: Cumulative persisted metrics
let totalAnalyses = 0;
let totalFactsSaved = 0;
let lastActivityAt: Date | null = null;

// ── Инициализация ─────────────────────────────────────────────────────────────

export async function initReflectionMode(): Promise<void> {
    try {
        const stored = await getSetting(SETTING_KEY, 'true');
        enabled = stored === 'true';
        console.log(`[reflection] Initialized: ${enabled ? 'ON' : 'OFF'}`);
    } catch {
        enabled = true;
        console.log('[reflection] Could not load setting, defaulting to ON');
    }

    // Fix 5: Загружаем кумулятивную статистику
    try {
        const [ta, ts, la] = await Promise.all([
            getSetting(STATS_TOTAL_ANALYSES_KEY, '0'),
            getSetting(STATS_TOTAL_SAVED_KEY, '0'),
            getSetting(STATS_LAST_ACTIVITY_KEY, '0'),
        ]);
        totalAnalyses = parseInt(ta, 10) || 0;
        totalFactsSaved = parseInt(ts, 10) || 0;
        const laTs = parseInt(la, 10);
        lastActivityAt = laTs > 0 ? new Date(laTs) : null;
        devLog(`[reflection] Stats loaded: analyses=${totalAnalyses}, saved=${totalFactsSaved}`);
    } catch {
        devLog('[reflection] Could not load cumulative stats');
    }
}

// ── Публичный API ─────────────────────────────────────────────────────────────

export function isReflectionModeEnabled(): boolean {
    return enabled;
}

/**
 * Помечает чат как бот-чат — все сообщения из него будут игнорироваться.
 * Вызывается из readMessagesAgent при обнаружении входящего сообщения от бота.
 */
export function markChatAsBot(chatId: string): void {
    if (!botChatIds.has(chatId)) {
        botChatIds.add(chatId);
        // Удаляем буфер если он уже успел накопиться
        chatBuffers.delete(chatId);
        devLog(`[reflection] Chat ${chatId} marked as bot — excluded from reflection`);
    }
}

export async function setReflectionModeEnabled(value: boolean): Promise<void> {
    enabled = value;
    await setSetting(SETTING_KEY, String(value));
    if (!value) chatBuffers.clear();
    devLog(`[reflection] Mode set to: ${value ? 'ON' : 'OFF'}`);
}

/**
 * Добавляет сообщение (входящее или исходящее) в буфер для последующего анализа.
 * Вызывается синхронно — не блокирует обработку сообщений.
 *
 * @param isOwn true = исходящее сообщение от владельца бота
 */
export function queueMessage(
    chatId: string,
    senderName: string,
    text: string,
    date: Date,
    isOwn = false
): void {
    if (!enabled) return;
    if (botChatIds.has(chatId)) return;

    const trimmed = text?.trim();
    if (!trimmed || trimmed.length < MIN_TEXT_LENGTH) return;
    // Для исходящих не фильтруем по emoji — владелец может писать важные вещи коротко
    if (!isOwn && /^[\p{Emoji}\p{P}\d\s]+$/u.test(trimmed)) return;

    // Синхронная проверка: сообщение уже было проанализировано?
    const lastAt = chatLastAnalyzedMap.get(chatId);
    if (lastAt && date <= lastAt) {
        devLog(`[reflection] Skip already-analyzed msg from "${senderName}" (${date.toISOString()} <= ${lastAt.toISOString()})`);
        return;
    }

    if (!chatBuffers.has(chatId)) {
        chatBuffers.set(chatId, {
            chatTitle: isOwn ? senderName : senderName, // будет перезаписан входящим
            messages: [],
            lastAnalyzedAt: null,
            lastAnalyzedMessageAt: null,
            enqueuedAt: new Date(),
            lastMessageAt: null,
            highPriority: false,
        });
    }

    const buf = chatBuffers.get(chatId)!;
    // Имя чата берём от собеседника, не от себя
    if (!isOwn) buf.chatTitle = senderName;
    buf.lastMessageAt = date;
    buf.messages.push({ senderName: isOwn ? (config.ownerName || 'Я') : senderName, text: trimmed, date, isOwn });

    // Асинхронный LLM-triage жизненных событий (fire-and-forget, дебаунс 2 мин)
    scheduleAsyncTriage(chatId, senderName, trimmed);

    if (buf.messages.length > MAX_BUFFER_SIZE) {
        buf.messages.splice(0, buf.messages.length - MAX_BUFFER_SIZE);
    }
}

/**
 * Запускает LLM-triage конкретного сообщения с дебаунсом TRIAGE_COOLDOWN_MS per chat.
 * Fire-and-forget — не блокирует queueMessage.
 */
function scheduleAsyncTriage(chatId: string, senderName: string, text: string): void {
    if (text.length < 20) return; // слишком короткое — не стоит тратить токены
    const now = Date.now();
    const lastTriage = chatLastTriageAt.get(chatId) ?? 0;
    if (now - lastTriage < TRIAGE_COOLDOWN_MS) return;
    chatLastTriageAt.set(chatId, now);
    triageForHighPriority(chatId, senderName, text).catch(() => { /* ignore */ });
}

/**
 * Определяет через gpt-5-nano, является ли сообщение жизненно важным событием.
 * Если да — помечает буфер как highPriority для немедленного анализа.
 */
async function triageForHighPriority(chatId: string, senderName: string, text: string): Promise<void> {
    const buf = chatBuffers.get(chatId);
    if (!buf || buf.highPriority) return;

    const prompt = `Сообщение от "${senderName}": "${text}"

Является ли это жизненно важным событием, требующим немедленного запоминания?
Примеры ДА: увольнение, переезд, свадьба, развод, беременность, смерть близкого, серьёзный диагноз, операция, крупная покупка, оффер на работу, повышение.
Примеры НЕТ: обычный разговор, планы на вечер, мелкие новости, реакции.

JSON: {"urgent": true/false}`;

    try {
        const resp = await openai.chat.completions.create({
            model: 'gpt-5-nano',
            messages: [
                { role: 'system', content: 'Отвечай только валидным JSON.' },
                { role: 'user', content: prompt },
            ],
            temperature: 0,
            max_tokens: 15,
        });
        const raw = resp.choices[0]?.message?.content?.trim() || '';
        const data = parseLLMJson<{ urgent?: boolean }>(raw);
        if (data?.urgent === true) {
            // Перепроверяем — буфер мог быть уже обработан пока шёл запрос
            const currentBuf = chatBuffers.get(chatId);
            if (currentBuf) {
                currentBuf.highPriority = true;
                devLog(`[reflection] LLM triage: HIGH PRIORITY from "${senderName}": ${text.slice(0, 80)}`);
            }
        }
    } catch {
        // Ignore — triage не критичен, основной анализ всё равно произойдёт по таймеру
    }
}

export function getBufferStats(): { totalChats: number; totalMessages: number; analysesThisHour: number } {
    let totalMessages = 0;
    for (const buf of chatBuffers.values()) totalMessages += buf.messages.length;
    resetHourWindowIfNeeded();
    return { totalChats: chatBuffers.size, totalMessages, analysesThisHour };
}

/** Fix 5: Расширенная статистика для /reflection команды */
export function getReflectionStats(): {
    totalChats: number;
    totalMessages: number;
    analysesThisHour: number;
    prescreenTotal: number;
    prescreenPassed: number;
    savedThisSession: number;
    totalAnalyses: number;
    totalFactsSaved: number;
    lastActivityAt: Date | null;
} {
    let totalMessages = 0;
    for (const buf of chatBuffers.values()) totalMessages += buf.messages.length;
    resetHourWindowIfNeeded();
    return {
        totalChats: chatBuffers.size,
        totalMessages,
        analysesThisHour,
        prescreenTotal,
        prescreenPassed,
        savedThisSession,
        totalAnalyses,
        totalFactsSaved,
        lastActivityAt,
    };
}

/**
 * Основной цикл обработки буферов — вызывается планировщиком каждые 5 минут.
 */
export async function processBuffers(bot: Bot<BotContext>): Promise<void> {
    if (!enabled) return;
    resetHourWindowIfNeeded();

    if (analysesThisHour >= HOURLY_ANALYSIS_LIMIT) {
        devLog(`[reflection] Hourly limit (${analysesThisHour}/${HOURLY_ANALYSIS_LIMIT})`);
        return;
    }

    // Fix 6: Сортируем чаты по yield rate (самые «урожайные» — первыми)
    const entries = [...chatBuffers.entries()].sort(([idA], [idB]) => {
        const yA = chatYieldRateMap.get(idA) ?? DEFAULT_YIELD;
        const yB = chatYieldRateMap.get(idB) ?? DEFAULT_YIELD;
        return yB - yA;
    });

    for (const [chatId, buf] of entries) {
        if (analysesThisHour >= HOURLY_ANALYSIS_LIMIT) break;
        if (!isBufferReady(buf)) continue;

        const batch = [...buf.messages];
        buf.messages = [];
        buf.lastAnalyzedAt = new Date();
        buf.enqueuedAt = new Date();
        buf.highPriority = false;

        await analyzeBatch(bot, chatId, buf, batch);
    }
}

// ── Внутренняя логика ─────────────────────────────────────────────────────────

function resetHourWindowIfNeeded(): void {
    const now = Date.now();
    if (now - hourWindowStart >= 60 * 60 * 1000) {
        hourWindowStart = now;
        analysesThisHour = 0;
    }
}

function isBufferReady(buf: ChatBuffer): boolean {
    if (buf.messages.length === 0) return false;
    const now = Date.now();

    // Fix 3: Немедленный анализ при жизненно важном событии
    if (buf.highPriority) return true;

    // Fix 2: Конец разговорной сессии — пауза > 2 часов после последнего сообщения
    if (buf.lastMessageAt && now - buf.lastMessageAt.getTime() >= SESSION_GAP_MS) return true;

    const hasEnoughMessages = buf.messages.length >= BATCH_MIN_MESSAGES;
    const refTime = buf.lastAnalyzedAt?.getTime() ?? buf.enqueuedAt.getTime();
    const isOldEnough = now - refTime >= BATCH_MAX_AGE_MS;
    return hasEnoughMessages || isOldEnough;
}

/**
 * Загружает timestamp последнего проанализированного сообщения из БД (с in-memory кешем).
 * Вызывается один раз для чата при первом анализе после рестарта.
 */
async function loadLastAnalyzedMessageAt(chatId: string): Promise<Date | null> {
    // В памяти уже есть — используем
    if (chatLastAnalyzedMap.has(chatId)) return chatLastAnalyzedMap.get(chatId)!;

    try {
        const stored = await getSetting(`${LAST_ANALYZED_KEY_PREFIX}${chatId}`, '0');
        const ts = parseInt(stored, 10);
        if (ts > 0) {
            const date = new Date(ts);
            chatLastAnalyzedMap.set(chatId, date);
            return date;
        }
    } catch {
        // Ignore DB error, treat as no prior analysis
    }
    return null;
}

/**
 * Сохраняет timestamp последнего проанализированного сообщения в БД и кеш.
 */
async function saveLastAnalyzedMessageAt(chatId: string, date: Date): Promise<void> {
    chatLastAnalyzedMap.set(chatId, date);
    await setSetting(`${LAST_ANALYZED_KEY_PREFIX}${chatId}`, String(date.getTime()));
}

function formatForPrescreen(messages: BufferedMessage[]): string {
    return messages
        .slice(-PRESCREEN_MAX_MESSAGES)
        .map(m => {
            const time = m.date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
            return `[${time}] ${m.senderName}: ${m.text}`;
        })
        .join('\n');
}

type EmotionTag = 'neutral' | 'stress' | 'conflict' | 'grief' | 'joy' | 'anxiety';

interface PrescreenResult {
    useful: boolean;
    emotion: EmotionTag;
}

async function prescreen(chatTitle: string, messages: BufferedMessage[]): Promise<PrescreenResult> {
    const snippet = formatForPrescreen(messages);
    const ownerName = config.ownerName || 'пользователь';
    const prompt = `Сообщения от "${chatTitle}" к ${ownerName}:

${snippet}

Есть ли здесь факты, заслуживающие запоминания?
ЗАСЛУЖИВАЮТ: работа, планы, переезд, здоровье, финансы, отношения, события, решения, предпочтения.
НЕ ЗАСЛУЖИВАЮТ: "ок", "понял", приветствия, реакции, мелкий чат.

Определи эмоциональный тон переписки: neutral / stress / conflict / grief / joy / anxiety.

JSON: {"useful": true/false, "emotion": "neutral|stress|conflict|grief|joy|anxiety"}`;

    try {
        const resp = await openai.chat.completions.create({
            model: 'gpt-5-nano',
            messages: [
                { role: 'system', content: 'Отвечай только валидным JSON.' },
                { role: 'user', content: prompt },
            ],
            temperature: 0,
            max_tokens: 30,
        });
        const text = resp.choices[0]?.message?.content?.trim() || '';
        const data = parseLLMJson<{ useful?: boolean; emotion?: string }>(text);
        const emotion = (data?.emotion as EmotionTag) || 'neutral';
        // Stress/conflict/grief — всегда полезны для анализа даже если LLM не пометил как useful
        const forceUseful = ['stress', 'conflict', 'grief', 'anxiety'].includes(emotion);
        return { useful: data?.useful === true || forceUseful, emotion };
    } catch {
        return { useful: false, emotion: 'neutral' };
    }
}

/**
 * Получает контекст из MessageStore: последние N сообщений ДО начала батча.
 * Позволяет LLM понять тему разговора даже при коротком батче.
 */
function getContextMessages(chatId: string, beforeDate: Date): BufferedMessage[] {
    const messageStore = MessageStore.getInstance();
    // MessageStore возвращает сообщения отсортированными от новых к старым
    const stored = messageStore.getMessages(chatId);
    const ownerLabel = config.ownerName || 'Я';
    return stored
        .filter(m => m.date < beforeDate)
        .slice(0, CONTEXT_MAX_MESSAGES)
        .reverse()
        .map(m => ({
            // Исходящие помечаем именем владельца ("Я" / Дмитрий), входящие — именем контакта
            senderName: m.isOwn ? ownerLabel : m.senderName,
            text: m.text,
            date: m.date,
            isOwn: !!m.isOwn,
        }));
}

/**
 * Разбивает массив сообщений на сессии по временному разрыву (≥ sessionGapMs).
 * Возвращает сессии от старых к новым.
 */
function splitIntoSessions(messages: BufferedMessage[], sessionGapMs = 60 * 60 * 1000): BufferedMessage[][] {
    if (messages.length === 0) return [];
    const sessions: BufferedMessage[][] = [];
    let current: BufferedMessage[] = [messages[0]];
    for (let i = 1; i < messages.length; i++) {
        const gap = messages[i].date.getTime() - messages[i - 1].date.getTime();
        if (gap >= sessionGapMs) {
            sessions.push(current);
            current = [];
        }
        current.push(messages[i]);
    }
    sessions.push(current);
    return sessions;
}

/**
 * Fix 4: Классифицирует чат по домену и типу отношений.
 * Результат кешируется в памяти и персистируется в БД.
 * Пример: "work/коллега", "personal/друг", "family/брат"
 */
async function classifyChat(chatId: string, chatTitle: string, messages: BufferedMessage[]): Promise<string> {
    // Используем кеш
    if (chatDomainMap.has(chatId)) return chatDomainMap.get(chatId)!;

    // Пробуем загрузить из БД
    try {
        const stored = await getSetting(`${CHAT_DOMAIN_KEY_PREFIX}${chatId}`, '');
        if (stored) {
            chatDomainMap.set(chatId, stored);
            return stored;
        }
    } catch { /* ignore */ }

    // Классифицируем через LLM
    const snippet = messages
        .slice(-10)
        .map(m => `${m.senderName}: ${m.text}`)
        .join('\n');
    const prompt = `Чат с "${chatTitle}". Примеры сообщений:\n${snippet}\n\nОпредели домен (work/personal/family/health/finance/general) и тип отношений (коллега/друг/партнёр/родственник/знакомый/другое).\nJSON: {"domain": "...", "relationship": "..."}`;

    try {
        const resp = await openai.chat.completions.create({
            model: 'gpt-5-nano',
            messages: [
                { role: 'system', content: 'Отвечай только валидным JSON.' },
                { role: 'user', content: prompt },
            ],
            temperature: 0,
            max_tokens: 30,
        });
        const text = resp.choices[0]?.message?.content?.trim() || '';
        const data = parseLLMJson<{ domain?: string; relationship?: string }>(text);
        const domain = data?.domain || 'general';
        const relationship = data?.relationship || 'другое';
        const result = `${domain}/${relationship}`;
        chatDomainMap.set(chatId, result);
        await setSetting(`${CHAT_DOMAIN_KEY_PREFIX}${chatId}`, result);
        devLog(`[reflection] Chat "${chatTitle}" classified as: ${result}`);
        return result;
    } catch {
        const fallback = 'general/другое';
        chatDomainMap.set(chatId, fallback);
        return fallback;
    }
}

/**
 * Fix 6: Загружает yield rate чата из БД (если нет в кеше).
 */
async function loadYieldRate(chatId: string): Promise<number> {
    if (chatYieldRateMap.has(chatId)) return chatYieldRateMap.get(chatId)!;
    try {
        const stored = await getSetting(`${YIELD_KEY_PREFIX}${chatId}`, '');
        if (stored) {
            const val = parseFloat(stored);
            if (!isNaN(val)) {
                chatYieldRateMap.set(chatId, val);
                return val;
            }
        }
    } catch { /* ignore */ }
    chatYieldRateMap.set(chatId, DEFAULT_YIELD);
    return DEFAULT_YIELD;
}

/**
 * Fix 6: Обновляет EMA yield rate для чата и сохраняет в БД.
 * @param savedCount — количество сохранённых фактов в этом батче
 */
async function updateYieldRate(chatId: string, savedCount: number): Promise<void> {
    const prev = await loadYieldRate(chatId);
    const updated = YIELD_ALPHA * savedCount + (1 - YIELD_ALPHA) * prev;
    chatYieldRateMap.set(chatId, updated);
    try {
        await setSetting(`${YIELD_KEY_PREFIX}${chatId}`, String(updated));
    } catch { /* ignore */ }
    devLog(`[reflection] Yield rate for ${chatId}: ${prev.toFixed(2)} → ${updated.toFixed(2)}`);
}

function makeFakeCtx(): BotContext {
    return {
        from: { id: config.allowedUserId },
        session: {},
    } as unknown as BotContext;
}

/**
 * Полный анализ батча:
 *  1. Фильтрует сообщения — только новее последнего проанализированного (по persistent timestamp).
 *  2. Добавляет контекст из MessageStore для понимания темы разговора.
 *  3. Pre-screen → extraction → save → notify.
 *  4. Обновляет persistent timestamp в БД.
 */
async function analyzeBatch(
    bot: Bot<BotContext>,
    chatId: string,
    buf: ChatBuffer,
    allMessages: BufferedMessage[]
): Promise<void> {
    try {
        // ── Шаг 1: Фильтрация уже проанализированных ────────────────────────
        const lastAt = await loadLastAnalyzedMessageAt(chatId);
        const newMessages = lastAt
            ? allMessages.filter(m => m.date > lastAt)
            : allMessages;

        if (newMessages.length === 0) {
            devLog(`[reflection] No new messages for "${buf.chatTitle}" since ${lastAt?.toISOString() ?? 'ever'}`);
            return;
        }

        devLog(`[reflection] ${newMessages.length} new msgs (${allMessages.length - newMessages.length} filtered) from "${buf.chatTitle}"`);

        // ── Шаг 1.5: Sub-session splitting — берём только последнюю сессию ─
        // Если в буфере накопилось несколько разговорных сессий (разрывы ≥ 1ч),
        // анализируем только самую последнюю завершённую сессию.
        const sessions = splitIntoSessions(newMessages);
        const sessionToAnalyze = sessions[sessions.length - 1];
        if (sessions.length > 1) {
            devLog(`[reflection] ${sessions.length} sub-sessions detected, analyzing latest (${sessionToAnalyze.length} msgs)`);
        }

        // ── Шаг 2: Pre-screen ────────────────────────────────────────────────
        prescreenTotal++;
        const { useful, emotion } = await prescreen(buf.chatTitle, sessionToAnalyze);
        if (!useful) {
            devLog(`[reflection] Pre-screen: not useful — "${buf.chatTitle}"`);
            // Помечаем как проанализированные, чтобы не проверять повторно
            const lastMsgDate = newMessages[newMessages.length - 1].date;
            await saveLastAnalyzedMessageAt(chatId, lastMsgDate);
            buf.lastAnalyzedMessageAt = lastMsgDate;
            await updateYieldRate(chatId, 0);
            return;
        }

        prescreenPassed++;
        devLog(`[reflection] Pre-screen: USEFUL (emotion=${emotion}) — extracting from "${buf.chatTitle}"`);
        analysesThisHour++;

        // ── Шаг 3: Формируем текст переписки с контекстом и доменом ────────
        const ctx = makeFakeCtx();
        const chatDomain = await classifyChat(chatId, buf.chatTitle, sessionToAnalyze);
        const contextMessages = getContextMessages(chatId, sessionToAnalyze[0].date);

        let convText = `[домен чата: ${chatDomain}]\n`;

        // Если эмоциональный тон нейтральный — не упоминаем, иначе добавляем подсказку
        if (emotion !== 'neutral') {
            const emotionLabels: Record<string, string> = {
                stress: 'стресс/напряжение',
                conflict: 'конфликт/напряжённость',
                grief: 'горе/потеря',
                anxiety: 'тревога/беспокойство',
                joy: 'радость/позитивное событие',
            };
            convText += `[эмоциональный тон: ${emotionLabels[emotion] ?? emotion} — обрати особое внимание]\n`;
        }

        if (contextMessages.length > 0) {
            const ctxLines = contextMessages
                .map(m => `[${m.date.toLocaleString('ru-RU')}] ${m.senderName}: ${m.text}`)
                .join('\n');
            convText += `[контекст предыдущей переписки — не анализировать, только для понимания темы]\n${ctxLines}\n\n`;
        }

        // ── Шаг 3.5: Контекст из долговременной памяти о контакте ──────────
        // Загружаем существующие факты о контакте из Qdrant, чтобы LLM:
        //   - не дублировал уже известное
        //   - мог точнее определить что изменилось / обновилось
        try {
            const existingFacts = await searchAllDomainsMemories(ctx, `${buf.chatTitle}`, 8);
            if (existingFacts.length > 0) {
                const factsBlock = existingFacts
                    .map(f => `• ${f.content}`)
                    .join('\n');
                convText += `[известные факты о контакте «${buf.chatTitle}» — не повторять, только учитывать при анализе; выделяй изменения и обновления]\n${factsBlock}\n\n`;
            }
        } catch {
            // Если Qdrant недоступен — продолжаем без контекста
        }

        convText += `[новые сообщения для анализа]\n`;
        convText += sessionToAnalyze
            .map(m => `[${m.date.toLocaleString('ru-RU')}] ${m.senderName}: ${m.text}`)
            .join('\n');

        const startDate = sessionToAnalyze[0].date;
        const endDate = sessionToAnalyze[sessionToAnalyze.length - 1].date;

        // ── Шаг 4: Извлечение фактов ─────────────────────────────────────────
        const facts = await runAnalyzeConversationAgent(convText, buf.chatTitle, startDate, endDate);
        const eligible = facts.filter(f => f.importance >= MIN_IMPORTANCE);

        // Обновляем persistent timestamp независимо от того, найдены факты или нет
        const lastMsgDate = newMessages[newMessages.length - 1].date;
        await saveLastAnalyzedMessageAt(chatId, lastMsgDate);
        buf.lastAnalyzedMessageAt = lastMsgDate;

        // Fix 5: Обновляем кумулятивную статистику
        totalAnalyses++;
        lastActivityAt = new Date();
        await Promise.all([
            setSetting(STATS_TOTAL_ANALYSES_KEY, String(totalAnalyses)),
            setSetting(STATS_LAST_ACTIVITY_KEY, String(lastActivityAt.getTime())),
        ]).catch(() => { /* ignore */ });

        if (eligible.length === 0) {
            devLog(`[reflection] No eligible facts from "${buf.chatTitle}"`);
            await updateYieldRate(chatId, 0);
            return;
        }

        // ── Шаг 5: Сохранение ────────────────────────────────────────────────
        devLog(`[reflection] Saving ${eligible.length} facts from "${buf.chatTitle}"`);
        let savedCount = 0;

        for (const fact of eligible) {
            const isContactFact = fact.subject === 'contact';
            const contactName = fact.contactName ?? buf.chatTitle;
            const content = isContactFact ? `[${contactName}] ${fact.content}` : fact.content;
            const tags = isContactFact
                ? [...fact.tags, `contact:${contactName}`, 'reflection']
                : [...fact.tags, 'reflection'];
            await saveMemory(ctx, fact.domain, content, fact.importance, tags);
            savedCount++;
        }

        // Fix 5: Обновляем счётчики сохранённых фактов
        savedThisSession += savedCount;
        totalFactsSaved += savedCount;
        await setSetting(STATS_TOTAL_SAVED_KEY, String(totalFactsSaved)).catch(() => { /* ignore */ });

        // Fix 6: Обновляем yield rate
        await updateYieldRate(chatId, savedCount);

        devLog(`[reflection] Saved ${savedCount} facts from "${buf.chatTitle}"`);

        // ── Шаг 6: Уведомление владельца ─────────────────────────────────────
        const proactiveChatId = await getProactiveChatId();
        if (proactiveChatId && savedCount > 0) {
            const factLines = eligible
                .slice(0, 5)
                .map(f => `• ${f.content}`)
                .join('\n');
            const more = eligible.length > 5 ? `\n…и ещё ${eligible.length - 5}` : '';
            const emotionSuffix: Record<string, string> = {
                stress: ' ⚠️ (стресс)',
                conflict: ' ⚠️ (конфликт)',
                grief: ' 💙 (горе)',
                anxiety: ' ⚠️ (тревога)',
                joy: ' 🎉 (радость)',
            };
            const emotionNote = emotion !== 'neutral' ? (emotionSuffix[emotion] ?? '') : '';
            await bot.api.sendMessage(
                proactiveChatId,
                `🧠 Рефлексия: нашла ${savedCount} факт(ов) в переписке с «${buf.chatTitle}»${emotionNote}\n${factLines}${more}`
            );
        }
    } catch (e) {
        console.error(`[reflection] Error analyzing batch from "${buf.chatTitle}":`, e);
    }
}
