import { BotContext, MemoryEntry, SearchResult } from '../types';
import { USER_TIMEZONE } from '../constants';
import { ReminderRegistry } from '../stores/ReminderRegistry';
import { ReminderStatus } from '../types/reminderTypes';
import type { Reminder } from '../reminder';
import { getRecentMemories, searchAllDomainsMemories } from './enhancedDomainMemory';
import { devLog } from '../utils';
import { buildReminderSourceTag } from './enhancedDomainMemory';
import { reminderMemoryMatchesReminderText } from '../services/ReminderMemorySync';

const WORD_START = String.raw`(?:^|[^\p{L}\p{N}_])`;
const WORD_END = String.raw`(?=$|[^\p{L}\p{N}_])`;
const TODAY_RE = new RegExp(`${WORD_START}(?:сегодня|сегодняшн\\p{L}*|на\\s+сегодня|today)${WORD_END}`, 'iu');
const IMPORTANT_RE = /(?:важн|план|дел[ао]?|задач|событ|встреч|созвон|звон|дедлайн|срок|напомин|расписан|календар|предстоит|надо|нужно|обязател|есть\s+ли\s+(?:что|что-то|что-нибудь)|что\s+у\s+меня|что\s+.*на\s+сегодня|anything\s+important|agenda|schedule|plans?)/iu;
const LIVE_CHAT_CHECK_RE = /(?:проверь|прочитай|изучи|проанализируй|посмотри)(?:\s+\S+){0,5}\s+(?:переписк|сообщен|чат|чаты|групп)/iu;
const PROSPECTIVE_TEXT_RE = /(?:дедлайн|срок|надо|нужно|предстоит|встреч|созвон|звонок|запланирован|планир|собира|обещал|договорил|ожида|не\s+забыть|важно|событи)/iu;
const SYNTHETIC_TAGS = new Set(['memory-episode', 'memory-chapter', 'memory-schema', 'sleep_open_loop_index', 'sleep_uncertainty_index']);

type TodayMemory = Pick<SearchResult, 'id' | 'content' | 'domain' | 'timestamp' | 'importance' | 'tags'> &
    Partial<Pick<SearchResult, 'confidence' | 'expiresAt' | 'memoryKind' | 'validFrom' | 'validTo' | 'status' | 'sourceContext'>>;

interface TodayMemoryItem {
    memory: TodayMemory;
    score: number;
    reason: string;
}

interface ZonedDay {
    key: string;
    label: string;
    shortDate: string;
    day: number;
    month: number;
    year: number;
}

const RU_MONTHS_GENITIVE = [
    'января',
    'февраля',
    'марта',
    'апреля',
    'мая',
    'июня',
    'июля',
    'августа',
    'сентября',
    'октября',
    'ноября',
    'декабря',
];

export function isTodayImportanceRequest(message: string): boolean {
    const normalized = message.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!normalized) return false;
    if (!TODAY_RE.test(normalized)) return false;
    if (LIVE_CHAT_CHECK_RE.test(normalized)) return false;
    return IMPORTANT_RE.test(normalized);
}

function getZonedParts(date: Date, timeZone: string): { day: number; month: number; year: number } {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone,
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
    }).formatToParts(date);
    const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
    return {
        day: get('day'),
        month: get('month'),
        year: get('year'),
    };
}

function dateKeyFromParts(parts: { day: number; month: number; year: number }): string {
    return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function getZonedDay(date: Date, timeZone: string): ZonedDay {
    const parts = getZonedParts(date, timeZone);
    const key = dateKeyFromParts(parts);
    return {
        ...parts,
        key,
        label: date.toLocaleDateString('ru-RU', {
            timeZone,
            weekday: 'long',
            day: 'numeric',
            month: 'long',
            year: 'numeric',
        }),
        shortDate: `${String(parts.day).padStart(2, '0')}.${String(parts.month).padStart(2, '0')}.${parts.year}`,
    };
}

function zonedDateKey(date: Date | undefined, timeZone: string): string | undefined {
    if (!date) return undefined;
    const parsed = date instanceof Date ? date : new Date(date);
    if (!Number.isFinite(parsed.getTime())) return undefined;
    return dateKeyFromParts(getZonedParts(parsed, timeZone));
}

function isSameZonedDay(date: Date | undefined, day: ZonedDay, timeZone: string): boolean {
    return zonedDateKey(date, timeZone) === day.key;
}

function addDays(date: Date, days: number): Date {
    return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function getReminderScope(ctx: BotContext): Reminder[] {
    const registry = ReminderRegistry.getInstance();
    if (ctx.chat?.type !== 'private') {
        return ctx.chat?.id ? registry.getActiveByChatId(ctx.chat.id) : [];
    }

    const byId = new Map<string, Reminder>();
    for (const chat of registry.getChatsWithActive()) {
        for (const reminder of registry.getActiveByChatId(chat.chatId)) {
            byId.set(reminder.id, reminder);
        }
    }
    if (ctx.chat?.id) {
        for (const reminder of registry.getActiveByChatId(ctx.chat.id)) {
            byId.set(reminder.id, reminder);
        }
    }
    return [...byId.values()];
}

function getTodayReminders(ctx: BotContext, day: ZonedDay, timeZone: string): Reminder[] {
    return getReminderScope(ctx)
        .filter((reminder) => isSameZonedDay(new Date(reminder.dueDate), day, timeZone))
        .sort((a, b) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime());
}

function reminderStatusLabel(reminder: Reminder, now: Date): string {
    if (reminder.status === ReminderStatus.Sent) return 'уже сработало';
    if (reminder.status === ReminderStatus.Expired) return 'просрочено';
    if (new Date(reminder.dueDate).getTime() < now.getTime()) return 'уже наступило';
    return '';
}

function formatReminderLine(reminder: Reminder, now: Date, timeZone: string): string {
    const due = new Date(reminder.dueDate);
    const time = due.toLocaleTimeString('ru-RU', {
        timeZone,
        hour: '2-digit',
        minute: '2-digit',
    });
    const status = reminderStatusLabel(reminder, now);
    const chat = reminder.chatTitle ? ` [${reminder.chatTitle}]` : '';
    const recurrence = reminder.recurrence ? ' [повторяется]' : '';
    const target = reminder.targetChat
        ? reminder.targetChat.type === 'group'
            ? ` [адресат: группа ${reminder.targetChat.groupName}]`
            : ` [адресат: ${reminder.targetChat.contactQuery}]`
        : '';
    return `- ${time}${status ? ` (${status})` : ''}${chat}: ${reminder.displayText || reminder.text}${recurrence}${target}`;
}

function statusFromTags(tags: string[] | undefined): string | undefined {
    const tag = (tags ?? []).find((value) => String(value).startsWith('status:'));
    return tag ? String(tag).replace('status:', '') : undefined;
}

function memoryStatus(memory: TodayMemory): string {
    return memory.status || statusFromTags(memory.tags) || 'active';
}

function isSyntheticMemory(memory: TodayMemory): boolean {
    if (memory.content.startsWith('[ЭПИЗОД ПАМЯТИ:') || memory.content.startsWith('[ГЛАВА ПАМЯТИ:') || memory.content.startsWith('[МОДЕЛЬ ПАМЯТИ:')) {
        return true;
    }
    return (memory.tags ?? []).some((tag) => SYNTHETIC_TAGS.has(String(tag)));
}

function rangeRelation(memory: TodayMemory, day: ZonedDay, timeZone: string): string | null {
    const fromKey = zonedDateKey(memory.validFrom, timeZone);
    const toKey = zonedDateKey(memory.validTo, timeZone);

    if (fromKey === day.key) return 'начинается сегодня';
    if (toKey === day.key) return 'срок/окончание сегодня';
    if (fromKey && toKey && fromKey <= day.key && toKey >= day.key) return 'актуально сегодня';
    return null;
}

function contentMentionsTodayDate(content: string, day: ZonedDay): boolean {
    const escapedMonth = RU_MONTHS_GENITIVE[day.month - 1]?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') ?? '';
    const dd = String(day.day).padStart(2, '0');
    const mm = String(day.month).padStart(2, '0');
    const yy = String(day.year).slice(2);
    const patterns = [
        new RegExp(`\\b${day.year}-${mm}-${dd}\\b`, 'u'),
        new RegExp(`\\b${dd}[./-]${mm}(?:[./-](?:${day.year}|${yy}))?\\b`, 'u'),
        new RegExp(`\\b${day.day}\\s+${escapedMonth}(?:\\s+${day.year})?\\b`, 'iu'),
    ];
    return patterns.some((pattern) => pattern.test(content));
}

function relativeTemporalMatch(memory: TodayMemory, now: Date, day: ZonedDay, timeZone: string): string | null {
    const content = memory.content.toLowerCase();
    const savedToday = isSameZonedDay(memory.timestamp, day, timeZone);
    const savedYesterday = zonedDateKey(memory.timestamp, timeZone) === zonedDateKey(addDays(now, -1), timeZone);

    if (savedToday && new RegExp(`${WORD_START}(?:сегодня|сегодняшн\\p{L}*)${WORD_END}`, 'iu').test(content)) {
        return 'воспоминание от сегодня с явной привязкой "сегодня"';
    }
    if (savedYesterday && new RegExp(`${WORD_START}(?:завтра|завтрашн\\p{L}*)${WORD_END}`, 'iu').test(content)) {
        return 'вчерашнее воспоминание про завтра';
    }
    return null;
}

function hasProspectiveSignal(memory: TodayMemory): boolean {
    const kind = memory.memoryKind ?? '';
    if (['goal', 'open_loop', 'promise', 'prospective', 'event'].includes(kind)) return true;
    if (memoryStatus(memory) === 'planned') return true;
    if ((memory.importance ?? 0.5) >= 0.72) return true;
    return PROSPECTIVE_TEXT_RE.test(memory.content);
}

function extractReminderId(tags: string[] | undefined): string | undefined {
    const tag = (tags ?? []).find((value) => String(value).startsWith(buildReminderSourceTag('')));
    return tag ? String(tag).slice(buildReminderSourceTag('').length) : undefined;
}

function normalizeReminderText(value: string): string {
    return value
        .toLowerCase()
        .replace(/["«»“”'.,:;!?()[\]{}]/g, ' ')
        .replace(/\b(?:напоминание|встреча|созвон|сегодня|завтра|через|нужно|надо|дедлайн)\b/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function contentTimeLabel(content: string): string | null {
    const match = content.match(/\b(\d{1,2}[:.]\d{2})\b/u);
    return match?.[1]?.replace('.', ':') ?? null;
}

function reminderTimeLabel(reminder: Reminder, timeZone: string): string {
    return new Date(reminder.dueDate).toLocaleTimeString('ru-RU', {
        timeZone,
        hour: '2-digit',
        minute: '2-digit',
    });
}

function findReminderConflict(memory: TodayMemory, reminders: Reminder[], day: ZonedDay, timeZone: string): string | null {
    const reminderId = extractReminderId(memory.tags);
    if (reminderId) {
        const linkedReminder = reminders.find((reminder) => reminder.id === reminderId);
        if (!linkedReminder) {
            return 'связанное напоминание больше не активно';
        }
        if (!isSameZonedDay(new Date(linkedReminder.dueDate), day, timeZone)) {
            return 'связанное напоминание перенесено на другую дату';
        }
        const memoryTime = contentTimeLabel(memory.content);
        if (memoryTime && memoryTime !== reminderTimeLabel(linkedReminder, timeZone)) {
            return 'связанное напоминание перенесено на другое время';
        }
        return null;
    }

    if (memoryStatus(memory) !== 'planned' && !(memory.tags ?? []).includes('temporal_scope:future_plan')) {
        return null;
    }

    if (!normalizeReminderText(memory.content)) return null;

    for (const reminder of reminders) {
        const reminderText = normalizeReminderText(reminder.displayText || reminder.text);
        if (!reminderText) continue;
        if (!reminderMemoryMatchesReminderText(memory, reminderText)) continue;
        if (!isSameZonedDay(new Date(reminder.dueDate), day, timeZone)) {
            return 'похожее напоминание перенесено на другую дату';
        }
        const memoryTime = contentTimeLabel(memory.content);
        if (memoryTime && memoryTime !== reminderTimeLabel(reminder, timeZone)) {
            return 'похожее напоминание перенесено на другое время';
        }
    }

    return null;
}

export const todayImportanceTestUtils = {
    findReminderConflict,
};

function scoreTodayMemory(memory: TodayMemory, now: Date, day: ZonedDay, timeZone: string, reminders: Reminder[]): TodayMemoryItem | null {
    const status = memoryStatus(memory);
    if (status === 'expired' || status === 'superseded' || status === 'done') return null;

    const relation = rangeRelation(memory, day, timeZone);
    const exactContentDate = contentMentionsTodayDate(memory.content, day);
    const relativeMatch = relativeTemporalMatch(memory, now, day, timeZone);
    const expiresToday = isSameZonedDay(memory.expiresAt, day, timeZone);

    if (!relation && !exactContentDate && !relativeMatch && !expiresToday) return null;

    const synthetic = isSyntheticMemory(memory);
    const prospective = hasProspectiveSignal(memory);
    if (synthetic && !/Открытые линии:|дедлайн|срок|предстоит|нужно|надо|важн/iu.test(memory.content)) return null;
    if (!prospective && !exactContentDate && !relativeMatch && relation === 'актуально сегодня') return null;
    const reminderConflict = findReminderConflict(memory, reminders, day, timeZone);
    if (reminderConflict) return null;

    let score = memory.importance ?? 0.5;
    if (relation === 'срок/окончание сегодня') score += 0.55;
    else if (relation === 'начинается сегодня') score += 0.48;
    else if (relation === 'актуально сегодня') score += 0.30;
    if (exactContentDate) score += 0.35;
    if (relativeMatch) score += 0.28;
    if (expiresToday) score += 0.25;
    if (status === 'planned') score += 0.15;
    if (['open_loop', 'promise', 'prospective'].includes(memory.memoryKind ?? '')) score += 0.12;

    const reason = [relation, exactContentDate ? `упомянута дата ${day.shortDate}` : '', relativeMatch, expiresToday ? 'expiresAt сегодня' : '']
        .filter(Boolean)
        .join('; ');
    return { memory, score, reason: reason || 'есть привязка к сегодняшнему дню' };
}

function normalizeMemory(memory: MemoryEntry | SearchResult): TodayMemory {
    return {
        id: memory.id,
        content: memory.content,
        domain: memory.domain,
        timestamp: new Date(memory.timestamp),
        importance: memory.importance,
        tags: memory.tags ?? [],
        confidence: memory.confidence,
        expiresAt: memory.expiresAt ? new Date(memory.expiresAt) : undefined,
        memoryKind: memory.memoryKind,
        validFrom: memory.validFrom ? new Date(memory.validFrom) : undefined,
        validTo: memory.validTo ? new Date(memory.validTo) : undefined,
        status: memory.status,
        sourceContext: memory.sourceContext,
    };
}

async function loadMemoryCandidates(ctx: BotContext, day: ZonedDay): Promise<TodayMemory[]> {
    const queries = [
        `что важного сегодня ${day.shortDate}`,
        `планы на сегодня дедлайн встреча событие ${day.shortDate}`,
        `сегодня ${day.label} нужно сделать`,
        `${day.shortDate} дедлайн встреча созвон`,
    ];

    const [recent, ...searchGroups] = await Promise.all([
        getRecentMemories(ctx, 800),
        ...queries.map((query) => searchAllDomainsMemories(ctx, query, 8).catch(() => [])),
    ]);

    const byId = new Map<string, TodayMemory>();
    for (const memory of recent) {
        const normalized = normalizeMemory(memory);
        byId.set(normalized.id, normalized);
    }
    for (const group of searchGroups) {
        for (const memory of group) {
            const normalized = normalizeMemory(memory);
            byId.set(normalized.id, { ...byId.get(normalized.id), ...normalized });
        }
    }
    return [...byId.values()];
}

function compactContent(content: string, limit = 360): string {
    const clean = content
        .replace(/\n+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return clean.length <= limit ? clean : `${clean.slice(0, limit - 3)}...`;
}

function formatMemoryLine(item: TodayMemoryItem): string {
    const memory = item.memory;
    const confidence = typeof memory.confidence === 'number' ? `, confidence ${memory.confidence.toFixed(2)}` : '';
    const kind = memory.memoryKind ? `, тип ${memory.memoryKind}` : '';
    const status = memoryStatus(memory) !== 'active' ? `, статус ${memoryStatus(memory)}` : '';
    return `- ${compactContent(memory.content)} [${memory.domain}; ${item.reason}; importance ${(memory.importance ?? 0.5).toFixed(2)}${confidence}${kind}${status}]`;
}

async function getTodayMemoryItems(ctx: BotContext, now: Date, day: ZonedDay, timeZone: string, reminders: Reminder[]): Promise<TodayMemoryItem[]> {
    if (!ctx.from?.id) return [];
    const candidates = await loadMemoryCandidates(ctx, day);
    const byId = new Map<string, TodayMemoryItem>();
    for (const memory of candidates) {
        const item = scoreTodayMemory(memory, now, day, timeZone, reminders);
        if (!item) continue;
        const existing = byId.get(memory.id);
        if (!existing || item.score > existing.score) {
            byId.set(memory.id, item);
        }
    }
    return [...byId.values()]
        .sort((a, b) => b.score - a.score)
        .slice(0, 10);
}

export async function buildTodayImportanceContext(ctx: BotContext, message: string, timeZone = USER_TIMEZONE): Promise<string> {
    if (!isTodayImportanceRequest(message)) return '';
    if (ctx.chat?.type !== 'private') return '';

    const now = new Date();
    const day = getZonedDay(now, timeZone);
    const reminders = getTodayReminders(ctx, day, timeZone);
    const reminderScope = getReminderScope(ctx);
    let memoryItems: TodayMemoryItem[] = [];
    try {
        memoryItems = await getTodayMemoryItems(ctx, now, day, timeZone, reminderScope);
    } catch (error) {
        devLog('Today importance memory lookup failed:', error);
    }

    const reminderLines = reminders.length
        ? reminders.map((reminder) => formatReminderLine(reminder, now, timeZone)).join('\n')
        : '- Активных напоминаний на сегодня нет.';
    const memoryLines = memoryItems.length
        ? memoryItems.map(formatMemoryLine).join('\n')
        : '- В долговременной памяти нет конкретных планов, дедлайнов или событий с привязкой к сегодняшней дате.';

    return [
        `Сводка важного на сегодня (${day.label}, часовой пояс ${timeZone}).`,
        'Источники: активные напоминания и долговременная память, включая сохранённые факты из изученных переписок.',
        '',
        'Активные напоминания на сегодня:',
        reminderLines,
        '',
        'Планы, события и открытые линии из памяти на сегодня:',
        memoryLines,
        '',
        'Правила ответа: сначала назови точные напоминания, затем пункты из памяти. Не придумывай календарь, встречи или сообщения. Не утверждай, что текущие Telegram-чаты проверены, если в контексте нет результата readMessages.',
    ].join('\n');
}
