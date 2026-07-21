import { InlineKeyboard } from 'grammy';
import { Reminder, ReminderStatus, RecurrenceRule } from '../reminder';
import { BotContext } from '../types';
import { USER_TIMEZONE } from '../constants';
import { ReminderRegistry } from '../stores/ReminderRegistry';
import { targetChatHumanLabel } from './reminderTargetNotification';
import { esc, heading, list, paragraph, blockquote, RichBlock } from './richMessage';

/**
 * Возвращает активные напоминания для текущего чата.
 * Если в сессии выставлен viewingRemindersInChat — возвращает напоминания того чата
 * (кросс-чатовый просмотр из приватного чата).
 */
export function getActiveReminders(ctx: BotContext): Reminder[] {
    const chatId = ctx.session.viewingRemindersInChat ?? ctx.chat?.id;
    if (!chatId) return [];
    return ReminderRegistry.getInstance().getActiveByChatId(chatId);
}

export interface RichCard {
    blocks: RichBlock[];
    keyboard: InlineKeyboard;
}

/**
 * Строит блоки и клавиатуру пикера чатов с активными напоминаниями.
 */
export function buildChatPicker(
    chats: Array<{ chatId: number; title: string; count: number }>
): RichCard {
    const items = chats.map(c => `${esc(c.title)} — <b>${c.count}</b> напом.`);
    const blocks: RichBlock[] = [
        heading('📋 Активные напоминания по чатам', 3),
        list(items),
        paragraph('Выбери чат:'),
    ];
    const keyboard = new InlineKeyboard();
    for (const c of chats) {
        keyboard.text(`${c.title} (${c.count})`, `reminder_chat_${c.chatId}`).row();
    }
    return { blocks, keyboard };
}

const DAY_NAMES = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

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

/**
 * Собирает блоки и клавиатуру одной карточки напоминания.
 * showBackToChats=true добавляет кнопку «↩️ К чатам» (для кросс-чатового просмотра из приватного).
 */
export function buildReminderCard(
    reminders: Reminder[],
    index: number,
    showBackToChats = false
): RichCard {
    const r = reminders[index];
    const total = reminders.length;
    const num = index + 1;

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

    const prevCb = index > 0       ? `reminders_nav_${index - 1}` : 'reminders_nav_noop';
    const nextCb = index < total-1 ? `reminders_nav_${index + 1}` : 'reminders_nav_noop';
    const prevBtn = index > 0       ? '◀️' : '·';
    const nextBtn = index < total-1 ? '▶️' : '·';

    const keyboard = new InlineKeyboard()
        .text('✅ Выполнено', `reminder_complete_${r.id}`)
        .text('⏰ Отложить',  `reminder_postpone_${r.id}`)
        .row()
        .text('✏️ Изменить', `reminder_edit_${r.id}`)
        .row()
        .text('❌ Отменить',  `reminder_cancel_${r.id}`)
        .row()
        .text(prevBtn,       prevCb)
        .text(`${num} из ${total}`, 'reminders_nav_noop')
        .text(nextBtn,       nextCb)
        .row()
        .text('📄 Список', `reminders_list_${index}`);

    if (showBackToChats) {
        keyboard.row().text('↩️ К чатам', 'reminder_chat_back');
    }

    return { blocks, keyboard };
}

/**
 * Безопасная (экранированная) версия targetChatHumanLabel для rich-вывода.
 * Возвращает пустую строку, если адресата нет.
 */
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

/**
 * Клавиатура выбора времени откладывания — показывается прямо в том же сообщении.
 */
export function buildPostponeKeyboard(reminderId: string): InlineKeyboard {
    return new InlineKeyboard()
        .text('15 минут', `postpone_${reminderId}_15`)
        .text('30 минут', `postpone_${reminderId}_30`)
        .row()
        .text('1 час',    `postpone_${reminderId}_60`)
        .text('3 часа',   `postpone_${reminderId}_180`)
        .row()
        .text('Вечер',    `postpone_${reminderId}_evening`)
        .text('Завтра',   `postpone_${reminderId}_tomorrow`)
        .row()
        .text('Неделю',   `postpone_${reminderId}_week`)
        .text('✏️ Своё время', `postpone_${reminderId}_custom`)
        .row()
        .text('↩️ Назад', `postpone_${reminderId}_back`);
}

/**
 * Блоки и клавиатура для отображения всех напоминаний списком.
 */
export function buildRemindersList(
    reminders: Reminder[],
    returnIndex = 0
): RichCard {
    const items = reminders.map((r, i) => {
        const dueTime = new Date(r.dueDate).toLocaleString('ru-RU', {
            timeZone: USER_TIMEZONE,
            day: 'numeric',
            month: 'long',
            hour: 'numeric',
            minute: 'numeric',
        });
        const metaParts = [`🗓 ${esc(dueTime)}`, `📌 ${statusLabel(r.status)}`];
        if (r.recurrence) metaParts.push(recurrenceLabel(r.recurrence));
        if (r.targetChat) metaParts.push(`📨 ${esc(targetChatHumanLabel(r.targetChat))}`);
        const meta = metaParts.join(' · ');
        return `<b>${i + 1}.</b> ${esc(r.displayText || r.text)}\n${meta}`;
    });
    const blocks: RichBlock[] = [
        heading(`📋 Все напоминания (${reminders.length})`, 3),
        list(items),
    ];
    const safeReturnIndex = Math.max(0, Math.min(returnIndex, reminders.length - 1));
    const keyboard = new InlineKeyboard().text('◀️ К карточкам', `reminders_nav_${safeReturnIndex}`);
    return { blocks, keyboard };
}
