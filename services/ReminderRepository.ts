import { AppDataSource } from '../data-source';
import { ReminderEntity } from '../entity/ReminderEntity';
import { Reminder, ReminderStatus } from '../reminder';

function toEntity(r: Reminder): ReminderEntity {
    const e = new ReminderEntity();
    e.id = r.id;
    e.text = r.text;
    e.displayText = r.displayText;
    e.dueDate = new Date(r.dueDate);
    e.chatId = r.chatId;
    e.status = r.status ?? ReminderStatus.Pending;
    e.messageId = r.messageId;
    e.remindAgainAt = r.remindAgainAt ? new Date(r.remindAgainAt) : undefined;
    e.createdAt = new Date(r.createdAt);
    e.targetChat = r.targetChat;
    e.chatTitle = r.chatTitle;
    e.recurrence = r.recurrence;
    e.postponeCount = r.postponeCount ?? 0;
    return e;
}

function fromEntity(e: ReminderEntity): Reminder {
    return {
        id: e.id,
        text: e.text,
        displayText: e.displayText ?? undefined,
        dueDate: new Date(e.dueDate),
        chatId: Number(e.chatId),
        status: e.status as ReminderStatus,
        messageId: e.messageId ?? undefined,
        remindAgainAt: e.remindAgainAt ? new Date(e.remindAgainAt) : undefined,
        createdAt: new Date(e.createdAt),
        targetChat: e.targetChat ?? undefined,
        chatTitle: e.chatTitle ?? undefined,
        recurrence: e.recurrence ?? undefined,
        postponeCount: e.postponeCount ?? 0,
    };
}

function repo() {
    return AppDataSource.getRepository(ReminderEntity);
}

export const ReminderRepository = {
    async save(reminder: Reminder): Promise<void> {
        await repo().save(toEntity(reminder));
    },

    async update(reminder: Reminder): Promise<void> {
        await repo().save(toEntity(reminder));
    },

    async delete(id: string): Promise<void> {
        await repo().delete(id);
    },

    /** Загружает напоминания, которые должны остаться активными после перезапуска */
    async loadActive(): Promise<Reminder[]> {
        const entities = await repo().find({
            where: [
                { status: ReminderStatus.Pending },
                { status: ReminderStatus.Postponed },
                { status: ReminderStatus.Sent },
                { status: ReminderStatus.Expired },
            ],
        });
        return entities.map(fromEntity);
    },

    /** @deprecated Используй loadActive: сработавшие напоминания тоже должны восстанавливаться. */
    async loadPending(): Promise<Reminder[]> {
        const entities = await repo().find({
            where: [
                { status: ReminderStatus.Pending },
                { status: ReminderStatus.Postponed },
            ],
        });
        return entities.map(fromEntity);
    },
};
