import { createHash } from 'crypto';
import { InlineKeyboard } from 'grammy';
import type { Reminder } from '../reminder';
import { ReminderStatus, type RecurrenceRule } from '../types/reminderTypes';
import { BotContext } from '../types';
import { USER_TIMEZONE } from '../constants';
import { ReminderRegistry } from '../stores/ReminderRegistry';
import { targetChatHumanLabel } from './reminderTargetNotification';
import { esc, heading, list, paragraph, blockquote, RichBlock } from './richMessage';

export const REMINDERS_PAGE_SIZE = 8;

export type ReminderListFilter = 'all' | 'attention' | 'today' | 'week' | 'later' | 'recurring';

export interface ReminderPanelOrigin {
    filter: ReminderListFilter;
    page: number;
}

export interface ReminderListStats {
    total: number;
    attention: number;
    today: number;
    week: number;
    later: number;
    recurring: number;
}

export interface ReminderOpenCommand {
    code: string;
    filter: ReminderListFilter;
    page: number;
    botUsername?: string;
}

/** В приватном чате панель может безопасно показывать выбранный через пикер чат. */
export function getActiveReminders(ctx: BotContext): Reminder[] {
    const viewedChatId = ctx.chat?.type === 'private' ? ctx.session.viewingRemindersInChat : undefined;
    const chatId = viewedChatId ?? ctx.chat?.id;
    if (!chatId) return [];
    return ReminderRegistry.getInstance().getActiveByChatId(chatId);
}

export interface RichCard {
    blocks: RichBlock[];
    keyboard: InlineKeyboard;
}

export interface ReminderListView extends RichCard {
    page: number;
    totalPages: number;
    filteredReminders: Reminder[];
}

export function buildChatPicker(
    chats: Array<{ chatId: number; title: string; count: number }>,
): RichCard {
    const blocks: RichBlock[] = [
        heading('📋 Активные напоминания по чатам', 3),
        list(chats.map((chat) => `${esc(chat.title)} — <b>${chat.count}</b>`)),
        paragraph('Выбери чат:'),
    ];
    const keyboard = new InlineKeyboard();
    chats.forEach((chat, index) => {
        keyboard.text(`${chat.title} (${chat.count})`, `reminder_chat_${chat.chatId}`);
        if (index < chats.length - 1) keyboard.row();
    });
    return { blocks, keyboard };
}

const DAY_NAMES = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const FILTER_CODE: Record<ReminderListFilter, string> = {
    all: 'a',
    attention: 'x',
    today: 't',
    week: 'w',
    later: 'l',
    recurring: 'r',
};
const CODE_FILTER = Object.fromEntries(
    Object.entries(FILTER_CODE).map(([filter, code]) => [code, filter]),
) as Record<string, ReminderListFilter>;

function recurrenceLabel(rule: RecurrenceRule): string {
    switch (rule.type) {
        case 'hourly':
            return rule.interval === 1 ? '🔄 Каждый час' : `🔄 Каждые ${rule.interval} ч`;
        case 'daily':
            return rule.interval === 1 ? '🔄 Каждый день' : `🔄 Каждые ${rule.interval} дн`;
        case 'weekly':
            if (rule.daysOfWeek && rule.daysOfWeek.length > 0) {
                const days = rule.daysOfWeek.map(d => DAY_NAMES[d]).join(', ');
                return `🔄 Каждую неделю (${days})`;
            }
            return rule.interval === 1 ? '🔄 Каждую неделю' : `🔄 Каждые ${rule.interval} нед`;
        case 'monthly':
            return rule.interval === 1 ? '🔄 Каждый месяц' : `🔄 Каждые ${rule.interval} мес`;
        case 'yearly':
            return '🔄 Каждый год';
    }
}

function statusLabel(status?: ReminderStatus): string {
    switch (status) {
        case ReminderStatus.Postponed: return '⏰ Отложено';
        case ReminderStatus.Sent:      return '🔔 Ожидает ответа';
        case ReminderStatus.Expired:   return '⚠️ Просрочено';
        default:                       return '⏳ Запланировано';
    }
}

function isAttention(reminder: Reminder): boolean {
    return reminder.status === ReminderStatus.Sent || reminder.status === ReminderStatus.Expired;
}

function zonedDayNumber(date: Date): number {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: USER_TIMEZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(date);
    const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find(part => part.type === type)?.value);
    return Math.floor(Date.UTC(value('year'), value('month') - 1, value('day')) / 86_400_000);
}

function relativeDay(reminder: Reminder, now: Date): number {
    return zonedDayNumber(new Date(reminder.dueDate)) - zonedDayNumber(now);
}

function panelSort(a: Reminder, b: Reminder): number {
    const attentionDelta = Number(isAttention(b)) - Number(isAttention(a));
    if (attentionDelta !== 0) return attentionDelta;
    if (a.status === ReminderStatus.Expired && b.status !== ReminderStatus.Expired) return -1;
    if (b.status === ReminderStatus.Expired && a.status !== ReminderStatus.Expired) return 1;
    return new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime();
}

export function getReminderListStats(reminders: Reminder[], now = new Date()): ReminderListStats {
    const stats: ReminderListStats = { total: reminders.length, attention: 0, today: 0, week: 0, later: 0, recurring: 0 };
    for (const reminder of reminders) {
        if (reminder.recurrence) stats.recurring += 1;
        if (isAttention(reminder)) {
            stats.attention += 1;
            continue;
        }
        const day = relativeDay(reminder, now);
        if (day <= 0) stats.today += 1;
        else if (day <= 7) stats.week += 1;
        else stats.later += 1;
    }
    return stats;
}

export function filterReminders(
    reminders: Reminder[],
    filter: ReminderListFilter,
    now = new Date(),
): Reminder[] {
    return reminders.filter(reminder => {
        if (filter === 'all') return true;
        if (filter === 'attention') return isAttention(reminder);
        if (filter === 'recurring') return !!reminder.recurrence;
        if (isAttention(reminder)) return false;
        const day = relativeDay(reminder, now);
        if (filter === 'today') return day <= 0;
        if (filter === 'week') return day > 0 && day <= 7;
        return day > 7;
    }).sort(panelSort);
}

function reminderHash(id: string): string {
    return createHash('sha256').update(id).digest('hex');
}

export function getReminderCommandCode(reminder: Reminder, reminders: Reminder[]): string {
    const hash = reminderHash(reminder.id);
    const hashes = reminders.map(value => ({ id: value.id, hash: reminderHash(value.id) }));
    for (let length = 10; length <= 20; length += 1) {
        const prefix = hash.slice(0, length);
        if (hashes.filter(value => value.hash.startsWith(prefix)).every(value => value.id === reminder.id)) {
            return prefix;
        }
    }
    return hash.slice(0, 20);
}

export function resolveReminderCommandCode(reminders: Reminder[], code: string): Reminder | undefined {
    const matches = reminders.filter(reminder => reminderHash(reminder.id).startsWith(code));
    return matches.length === 1 ? matches[0] : undefined;
}

/** Короткая ссылка для callback_data; старые кнопки с полным ID продолжают поддерживаться. */
function reminderCallbackRef(reminder: Reminder): string {
    return `~${reminderHash(reminder.id).slice(0, 20)}`;
}

export function resolveReminderCallbackRef(reminders: Reminder[], ref: string): Reminder | undefined {
    if (!ref.startsWith('~')) return reminders.find(reminder => reminder.id === ref);
    const code = ref.slice(1);
    if (!/^[a-f0-9]{20}$/i.test(code)) return undefined;
    return resolveReminderCommandCode(reminders, code);
}

export function buildReminderOpenCommand(
    reminder: Reminder,
    allReminders: Reminder[],
    origin: ReminderPanelOrigin,
    botUsername?: string,
): string {
    const code = getReminderCommandCode(reminder, allReminders);
    const page = Math.max(0, Math.floor(origin.page)).toString(36).slice(0, 6);
    const mention = botUsername ? `@${botUsername.replace(/^@/, '')}` : '';
    return `/r_${code}_${FILTER_CODE[origin.filter]}_${page}${mention}`;
}

export function parseReminderOpenCommand(text: string): ReminderOpenCommand | undefined {
    const match = text.trim().match(/^\/r_([a-f0-9]{10,20})_([a-z])_([a-z0-9]{1,6})(?:@([a-z0-9_]+))?$/i);
    if (!match) return undefined;
    const filter = CODE_FILTER[match[2].toLowerCase()];
    const page = Number.parseInt(match[3], 36);
    if (!filter || !Number.isSafeInteger(page) || page < 0) return undefined;
    return { code: match[1].toLowerCase(), filter, page, botUsername: match[4] };
}

function callbackOriginSuffix(origin?: ReminderPanelOrigin): string {
    if (!origin) return '';
    const page = Math.max(0, Math.floor(origin.page)).toString(36);
    return `:p:${FILTER_CODE[origin.filter]}:${page}`;
}

export function parseReminderPanelOrigin(value: string): { value: string; origin?: ReminderPanelOrigin } {
    const compactMatch = value.match(/^(.*):p:([axtwlr]):([a-z0-9]+)$/i);
    if (compactMatch) {
        const filter = CODE_FILTER[compactMatch[2].toLowerCase()];
        const page = Number.parseInt(compactMatch[3], 36);
        if (filter && Number.isSafeInteger(page) && page >= 0) {
            return { value: compactMatch[1], origin: { filter, page } };
        }
    }
    const match = value.match(/^(.*):p:(all|attention|today|week|later|recurring):(\d+)$/);
    if (!match) return { value };
    return {
        value: match[1],
        origin: { filter: match[2] as ReminderListFilter, page: Number(match[3]) },
    };
}

/** Собирает одну карточку. origin сохраняет фильтр и страницу панели. */
export function buildReminderCard(
    reminders: Reminder[],
    index: number,
    showBackToChats = false,
    origin?: ReminderPanelOrigin,
): RichCard {
    const safeIndex = Math.max(0, Math.min(index, reminders.length - 1));
    const r = reminders[safeIndex];
    const total = reminders.length;
    const num = safeIndex + 1;

    const dueTime = new Date(r.dueDate).toLocaleString('ru-RU', {
        timeZone: USER_TIMEZONE,
        day: 'numeric',
        month: 'long',
        hour: 'numeric',
        minute: 'numeric',
    });

    const body = r.displayText || r.text;
    const metaItems: string[] = [`🗓 ${esc(dueTime)}`, `📌 ${statusLabel(r.status)}`];
    if (r.recurrence) metaItems.push(recurrenceLabel(r.recurrence));
    const target = targetChatHumanLabelSafe(r);
    if (target) metaItems.push(`📨 ${target}`);

    const blocks: RichBlock[] = [
        heading(`📋 Напоминание ${num} из ${total}`, 3),
        blockquote(esc(body)),
        list(metaItems),
    ];

    const suffix = callbackOriginSuffix(origin);
    const reminderRef = reminderCallbackRef(r);
    const firstCb = safeIndex > 0 ? `reminders_card_0${suffix}` : 'reminders_nav_noop';
    const prevCb = safeIndex > 0 ? `reminders_card_${safeIndex - 1}${suffix}` : 'reminders_nav_noop';
    const nextCb = safeIndex < total - 1 ? `reminders_card_${safeIndex + 1}${suffix}` : 'reminders_nav_noop';
    const lastCb = safeIndex < total - 1 ? `reminders_card_${total - 1}${suffix}` : 'reminders_nav_noop';
    const keyboard = new InlineKeyboard()
        .text('✅ Выполнено', `reminder_complete_${reminderRef}${suffix}`)
        .text('⏰ Отложить', `reminder_postpone_${reminderRef}${suffix}`)
        .row()
        .text('✏️ Изменить', `reminder_edit_${reminderRef}${suffix}`)
        .row()
        .text('❌ Отменить', `reminder_cancel_${reminderRef}${suffix}`)
        .row()
        .text(safeIndex > 0 ? '⏮' : '·', firstCb)
        .text(safeIndex > 0 ? '◀️' : '·', prevCb)
        .text(`${num} из ${total}`, 'reminders_nav_noop')
        .text(safeIndex < total - 1 ? '▶️' : '·', nextCb)
        .text(safeIndex < total - 1 ? '⏭' : '·', lastCb);

    const listPage = origin?.page ?? Math.floor(safeIndex / REMINDERS_PAGE_SIZE);
    const listFilter = origin?.filter ?? 'all';
    keyboard.row().text('📋 К списку', `reminders_page_${listFilter}_${listPage}`);
    if (showBackToChats) keyboard.row().text('↩️ К чатам', 'reminder_chat_back');
    return { blocks, keyboard };
}

function targetChatHumanLabelSafe(reminder: Reminder): string {
    if (!reminder.targetChat) return '';
    const target = targetChatHumanLabel(reminder.targetChat);
    const suffix = reminder.targetChatNotifyStatus === 'enabled'
        ? ' (оповестить)'
        : reminder.targetChatNotifyStatus === 'disabled'
            ? ' (только тебе)'
            : ' (ждёт выбора)';
    return `${esc(target)}${suffix}`;
}

export function buildPostponeKeyboard(reminder: Reminder, origin?: ReminderPanelOrigin): InlineKeyboard {
    const suffix = callbackOriginSuffix(origin);
    const reminderRef = reminderCallbackRef(reminder);
    const cb = (choice: string) => `postpone_${reminderRef}_${choice}${suffix}`;
    return new InlineKeyboard()
        .text('15 минут', cb('15'))
        .text('30 минут', cb('30'))
        .row()
        .text('1 час', cb('60'))
        .text('3 часа', cb('180'))
        .row()
        .text('Вечер', cb('evening'))
        .text('Завтра', cb('tomorrow'))
        .row()
        .text('Неделю', cb('week'))
        .text('✏️ Своё время', cb('custom'))
        .row()
        .text('↩️ Назад', cb('back'));
}

function truncateListText(value: string, limit = 90): string {
    const normalized = value.replace(/\s+/g, ' ').trim();
    const chars = Array.from(normalized);
    return chars.length <= limit ? normalized : `${chars.slice(0, limit - 1).join('')}…`;
}

function compactDueLabel(reminder: Reminder, now: Date): string {
    const due = new Date(reminder.dueDate);
    const day = relativeDay(reminder, now);
    const time = due.toLocaleTimeString('ru-RU', { timeZone: USER_TIMEZONE, hour: '2-digit', minute: '2-digit' });
    if (day === 0) return `Сегодня, ${time}`;
    if (day === 1) return `Завтра, ${time}`;
    return due.toLocaleString('ru-RU', {
        timeZone: USER_TIMEZONE,
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
    }).replace('.', '');
}

function addFilterButtons(keyboard: InlineKeyboard, stats: ReminderListStats, active: ReminderListFilter): void {
    const button = (filter: ReminderListFilter, label: string, count: number) => {
        const prefix = filter === active ? '• ' : '';
        keyboard.text(`${prefix}${label} ${count}`, filter === active ? 'reminders_nav_noop' : `reminders_filter_${filter}`);
    };
    button('all', 'Все', stats.total);
    button('attention', '⚠️', stats.attention);
    button('today', 'Сегодня', stats.today);
    keyboard.row();
    button('week', '7 дней', stats.week);
    button('later', 'Позже', stats.later);
    button('recurring', '🔁', stats.recurring);
}

function pageWindow(page: number, totalPages: number): number[] {
    return [...new Set([0, page - 1, page, page + 1, totalPages - 1])]
        .filter(value => value >= 0 && value < totalPages)
        .sort((a, b) => a - b);
}

export function buildRemindersList(
    reminders: Reminder[],
    options: {
        filter?: ReminderListFilter;
        page?: number;
        botUsername?: string;
        now?: Date;
        showBackToChats?: boolean;
    } = {},
): ReminderListView {
    const filter = options.filter ?? 'all';
    const now = options.now ?? new Date();
    const sortedAll = [...reminders].sort(panelSort);
    const stats = getReminderListStats(sortedAll, now);
    const filtered = filterReminders(sortedAll, filter, now);
    const totalPages = Math.max(1, Math.ceil(filtered.length / REMINDERS_PAGE_SIZE));
    const page = Math.max(0, Math.min(Math.floor(options.page ?? 0), totalPages - 1));
    const pageItems = filtered.slice(page * REMINDERS_PAGE_SIZE, (page + 1) * REMINDERS_PAGE_SIZE);
    const origin: ReminderPanelOrigin = { filter, page };

    const filterNames: Record<ReminderListFilter, string> = {
        all: 'все',
        attention: 'требуют решения',
        today: 'сегодня',
        week: 'ближайшие 7 дней',
        later: 'позже',
        recurring: 'повторяются',
    };
    const blocks: RichBlock[] = [
        heading(`📋 Напоминания · ${stats.total}`, 3),
        paragraph(`⚠️ Требуют решения: <b>${stats.attention}</b> · Сегодня: <b>${stats.today}</b> · 7 дней: <b>${stats.week}</b> · Позже: <b>${stats.later}</b> · 🔁 <b>${stats.recurring}</b>`),
        paragraph(`Фильтр: <b>${filterNames[filter]}</b>${filtered.length > 0 ? ` · страница ${page + 1} из ${totalPages}` : ''}`),
    ];

    if (pageItems.length === 0) {
        blocks.push(paragraph('В этой категории пока нет напоминаний.'));
    } else {
        blocks.push(list(pageItems.map((reminder, index) => {
            const number = page * REMINDERS_PAGE_SIZE + index + 1;
            return `<b>${number}.</b> ${esc(compactDueLabel(reminder, now))} · ${statusLabel(reminder.status)}\n${esc(truncateListText(reminder.displayText || reminder.text))}`;
        })));
    }

    const keyboard = new InlineKeyboard();
    addFilterButtons(keyboard, stats, filter);
    for (let index = 0; index < pageItems.length; index += 2) {
        keyboard.row();
        const firstIndex = page * REMINDERS_PAGE_SIZE + index;
        keyboard.text(
            `${firstIndex + 1} · Открыть`,
            `reminders_card_${firstIndex}${callbackOriginSuffix(origin)}`,
        );
        const secondIndex = firstIndex + 1;
        if (index + 1 < pageItems.length) {
            keyboard.text(
                `${secondIndex + 1} · Открыть`,
                `reminders_card_${secondIndex}${callbackOriginSuffix(origin)}`,
            );
        }
    }
    if (totalPages > 1) {
        keyboard.row()
            .text('⏮', page > 0 ? `reminders_page_${filter}_0` : 'reminders_nav_noop')
            .text('◀', page > 0 ? `reminders_page_${filter}_${page - 1}` : 'reminders_nav_noop')
            .text(`${page + 1}/${totalPages}`, 'reminders_nav_noop')
            .text('▶', page + 1 < totalPages ? `reminders_page_${filter}_${page + 1}` : 'reminders_nav_noop')
            .text('⏭', page + 1 < totalPages ? `reminders_page_${filter}_${totalPages - 1}` : 'reminders_nav_noop')
            .row();
        for (const target of pageWindow(page, totalPages)) {
            keyboard.text(
                target === page ? `• ${target + 1}` : String(target + 1),
                target === page ? 'reminders_nav_noop' : `reminders_page_${filter}_${target}`,
            );
        }
    }
    if (options.showBackToChats) keyboard.row().text('↩️ К чатам', 'reminder_chat_back');
    return { blocks, keyboard, page, totalPages, filteredReminders: filtered };
}
