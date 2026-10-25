import { randomUUID } from 'crypto';
import { reminderAgent } from '../../agents/reminderAgent';
import { ReminderRegistry } from '../../stores/ReminderRegistry';
import { cancelReminder, rescheduleReminder } from '../../reminder';
import { ReminderRepository } from '../../services/ReminderRepository';
import { syncReminderMemoryMutation } from '../../services/ReminderMemorySync';
import type { ProcessingResult, ReminderCreationDetails } from '../../orchestrator';
import type { RecurrenceRule, ReminderTargetChat } from '../../types/reminderTypes';
import { objectSchema, textSchema } from './registry';
import type { ToolContext, ToolDefinition, ToolOutput } from './types';

async function commit(result: ProcessingResult, context: ToolContext): Promise<ToolOutput> {
    const { saveRemindersFromResult } = await import('../../handlers/shared');
    await saveRemindersFromResult(context.ctx, result);
    result.remindersPersisted = true;
    return {
        status: result.reminderCreated ? (result.keyboard ? 'needs_input' : 'ok') : 'failed',
        summary: result.responseText,
        data: { reminders: result.reminderDetailsList ?? [], failures: result.reminderCreationFailures ?? [] },
        result,
    };
}

const recurrence = objectSchema({
    type: { type: 'string', enum: ['hourly', 'daily', 'weekly', 'monthly', 'yearly'] },
    interval: { type: 'integer', minimum: 1, maximum: 365 },
    daysOfWeek: { type: 'array', maxItems: 7, items: { type: 'integer', minimum: 0, maximum: 6 } },
}, ['type', 'interval']);

export function reminderTools(): ToolDefinition[] {
    return [
        {
            name: 'reminders.list', skill: 'reminders', effect: 'read', ownerOnly: true,
            description: 'Получить активные напоминания текущего чата с их ID. Перед изменением выбери точный ID.',
            inputSchema: objectSchema({}),
            async execute(_, context) {
                const reminders = ReminderRegistry.getInstance().getActiveByChatId(context.ctx.chat!.id);
                return { status: 'ok', summary: `Активных напоминаний: ${reminders.length}`, data: reminders.map(r => ({ id: r.id, text: r.text, dueAt: r.dueDate, recurrence: r.recurrence })) };
            },
        },
        {
            name: 'reminders.create', skill: 'reminders', effect: 'state', ownerOnly: true,
            description: 'Создать одно напоминание с точным будущим временем ISO 8601 и offset. Для нескольких вызови несколько раз. Не создаёт регулярную AI-задачу.',
            inputSchema: objectSchema({ text: textSchema('Дословная задача пользователя'), dueAt: textSchema('Будущая дата ISO 8601 с offset'), recurrence,
                targetType: { type: 'string', enum: ['contact', 'group'] }, target: textSchema('Явно указанный адресат; его уведомление требует отдельного согласия'),
            }, ['text', 'dueAt']),
            async execute(args, context) {
                const raw = String(args.dueAt);
                const dueDate = new Date(raw);
                if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(raw) || !Number.isFinite(dueDate.getTime()) || dueDate.getTime() <= Date.now()) {
                    return { status: 'failed', summary: 'Время должно быть в будущем и содержать часовой пояс. Уточни дату.' };
                }
                if (Boolean(args.targetType) !== Boolean(args.target)) return { status: 'failed', summary: 'Укажи и тип, и название адресата.' };
                const targetChat: ReminderTargetChat | undefined = args.targetType === 'group'
                    ? { type: 'group', groupName: String(args.target) }
                    : args.targetType === 'contact' ? { type: 'contact', contactQuery: String(args.target) } : undefined;
                const details: ReminderCreationDetails = { id: randomUUID(), text: String(args.text), dueDate, exactTimeSpecified: true, recurrence: args.recurrence as RecurrenceRule | undefined, targetChat };
                return commit({ responseText: '', reminderCreated: true, reminderDetails: details }, context);
            },
        },
        {
            name: 'reminders.request', skill: 'reminders', effect: 'state', ownerOnly: true,
            description: 'Разобрать явную просьбу создать напоминания со сложным расписанием или временем по умолчанию. Использовать только для создания, не для переноса или отмены.',
            inputSchema: objectSchema({ request: textSchema('Просьба пользователя создать напоминание') }),
            async execute(args, context) {
                return commit(await reminderAgent(String(args.request), context.isForwarded, context.forwardFrom, context.messageHistory, context.memoryContext), context);
            },
        },
        {
            name: 'reminders.update', skill: 'reminders', effect: 'state', ownerOnly: true,
            description: 'Изменить найденное напоминание по ID. Сохраняет повторение и адресата.',
            inputSchema: objectSchema({ id: textSchema('ID из reminders.list'), text: textSchema('Новый текст'), dueAt: textSchema('Новое будущее время ISO 8601 с offset') }, ['id']),
            async execute(args, context) {
                const existing = ReminderRegistry.getInstance().getActiveByChatId(context.ctx.chat!.id).find(r => r.id === args.id);
                if (!existing) return { status: 'failed', summary: 'Напоминание этого чата не найдено.' };
                if (!args.text && !args.dueAt) return { status: 'failed', summary: 'Нет изменений.' };
                const dueDate = args.dueAt ? new Date(String(args.dueAt)) : existing.dueDate;
                if (args.dueAt && (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(String(args.dueAt)) || !Number.isFinite(dueDate.getTime()) || dueDate.getTime() <= Date.now())) return { status: 'failed', summary: 'Новое время должно быть будущим ISO 8601 с offset.' };
                const updated = { ...existing, dueDate, text: args.text ? String(args.text) : existing.text, displayText: args.text ? String(args.text) : existing.displayText };
                await ReminderRepository.update(updated);
                ReminderRegistry.getInstance().add(updated);
                rescheduleReminder(updated);
                if (context.ctx.session.reminders) context.ctx.session.reminders = context.ctx.session.reminders.map(reminder => reminder.id === updated.id ? updated : reminder);
                await syncReminderMemoryMutation(context.ctx, existing, updated, 'update').catch(() => undefined);
                return { status: 'ok', summary: 'Напоминание изменено.', data: { id: updated.id, text: updated.text, dueAt: updated.dueDate }, result: { responseText: `Напоминание изменено: ${updated.text}.` } };
            },
        },
        {
            name: 'reminders.cancel', skill: 'reminders', effect: 'state', ownerOnly: true,
            description: 'Отменить конкретное напоминание текущего чата по ID. Для нескольких нужны отдельные выбранные ID.',
            inputSchema: objectSchema({ id: textSchema('ID из reminders.list') }),
            async execute(args, context) {
                const reminder = ReminderRegistry.getInstance().getActiveByChatId(context.ctx.chat!.id).find(r => r.id === args.id);
                if (!reminder) return { status: 'failed', summary: 'Напоминание этого чата не найдено.' };
                const cancelled = await cancelReminder(reminder.id);
                if (!cancelled) return { status: 'failed', summary: 'Не удалось подтвердить отмену.' };
                ReminderRegistry.getInstance().remove(reminder.id);
                if (context.ctx.session.reminders) context.ctx.session.reminders = context.ctx.session.reminders.filter(item => item.id !== reminder.id);
                await syncReminderMemoryMutation(context.ctx, reminder, reminder, 'cancel').catch(() => undefined);
                return { status: 'ok', summary: `Отменено: ${reminder.text}`, data: { id: reminder.id }, result: { responseText: `Напоминание отменено: ${reminder.text}.` } };
            },
        },
    ];
}
