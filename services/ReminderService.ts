import type { BotContext } from '../types';
import type { Reminder } from '../reminder';
import { ReminderStatus, getBotRef, scheduleReminder } from '../reminder';
import type { ReminderCreationDetails } from '../orchestrator';
import { ReminderRepository } from './ReminderRepository';
import { ReminderRegistry } from '../stores/ReminderRegistry';
import { createOrRefreshReminderMemory } from './ReminderMemorySync';
import { buildDefaultTargetReminderMessage } from '../utils/reminderTargetNotification';

export interface ReminderServiceDependencies {
    save(reminder: Reminder): Promise<void>;
    register(reminder: Reminder): void;
    schedule(reminder: Reminder): void;
    syncMemory(ctx: BotContext, reminder: Reminder): Promise<void>;
}

function defaultDependencies(): ReminderServiceDependencies {
    return {
        save: (reminder) => ReminderRepository.save(reminder),
        register: (reminder) => ReminderRegistry.getInstance().add(reminder),
        schedule: (reminder) => {
            const bot = getBotRef();
            if (bot) scheduleReminder(bot, reminder);
        },
        syncMemory: (ctx, reminder) => createOrRefreshReminderMemory(ctx, reminder),
    };
}

/**
 * Единая точка создания напоминания из интерактивного reminder-flow.
 * Сначала подтверждает запись в PostgreSQL и только затем публикует напоминание
 * в session/registry и регистрирует таймер.
 */
export class ReminderService {
    constructor(private readonly dependencies: ReminderServiceDependencies = defaultDependencies()) {}

    async createReminder(ctx: BotContext, details: ReminderCreationDetails): Promise<Reminder> {
        if (!ctx.chat) throw new Error('ReminderService: chat is unavailable');

        const chatType = ctx.chat.type;
        const chatTitle = chatType === 'group' || chatType === 'supergroup'
            ? `👥 ${(ctx.chat as { title?: string }).title ?? 'Группа'}`
            : undefined;
        const reminder: Reminder = {
            id: details.id,
            text: details.text,
            displayText: details.reminderMessage,
            dueDate: new Date(details.dueDate),
            chatId: ctx.chat.id,
            status: ReminderStatus.Pending,
            createdAt: new Date(),
            targetChat: details.targetChat,
            targetDisplayText: details.targetReminderMessage
                || (details.targetChat ? buildDefaultTargetReminderMessage(details.text) : undefined),
            targetChatNotifyStatus: details.targetChat ? 'pending' : undefined,
            chatTitle,
            recurrence: details.recurrence,
        };

        await this.dependencies.save(reminder);

        if (!Array.isArray(ctx.session.reminders)) ctx.session.reminders = [];
        ctx.session.reminders.push(reminder);
        this.dependencies.register(reminder);
        this.dependencies.schedule(reminder);

        await this.dependencies.syncMemory(ctx, reminder).catch((error) => {
            console.error('[reminder] memory sync failed on create:', error);
        });

        console.info(
            `[reminder] event=created id=${reminder.id} chatId=${reminder.chatId} due=${new Date(reminder.dueDate).toISOString()}`
            + (chatTitle ? ` chat="${chatTitle}"` : '')
            + (details.targetChat ? ` target=${details.targetChat.type}` : ''),
        );
        return reminder;
    }
}

export const reminderService = new ReminderService();
