import { devLog } from "./utils";

/**
 * Класс для отслеживания ответов на сообщения
 */
export class MessageTracker {
    private static instance: MessageTracker;
    private trackedMessages: Map<number, { contactId: number, originalChatId: number, timestamp: Date }>;

    private constructor() {
        this.trackedMessages = new Map();
    }

    /**
     * Получает экземпляр класса MessageTracker (синглтон)
     * @returns Экземпляр MessageTracker
     */
    public static getInstance(): MessageTracker {
        if (!MessageTracker.instance) {
            MessageTracker.instance = new MessageTracker();
        }
        return MessageTracker.instance;
    }

    /**
     * Добавляет сообщение для отслеживания ответа
     * @param messageId ID сообщения
     * @param contactId ID контакта
     * @param originalChatId ID чата для уведомления
     */
    public trackMessage(messageId: number, contactId: number, originalChatId: number): void {
        this.trackedMessages.set(messageId, {
            contactId,
            originalChatId,
            timestamp: new Date()
        });
        devLog(`Установлено отслеживание ответа на сообщение ${messageId} от контакта ${contactId}`);
    }

    /**
     * Проверяет, отслеживается ли сообщение
     * @param messageId ID сообщения
     * @returns Информация об отслеживаемом сообщении или undefined
     */
    public getTrackedMessageInfo(messageId: number): { contactId: number, originalChatId: number, timestamp: Date } | undefined {
        return this.trackedMessages.get(messageId);
    }

    /**
     * Проверяет, есть ли отслеживаемые сообщения для указанного контакта
     * @param contactId ID контакта
     * @returns Информация о последнем отслеживаемом сообщении или undefined
     */
    public getLatestTrackedMessageForContact(contactId: number): { messageId: number, originalChatId: number, timestamp: Date } | undefined {
        let latestMessageId: number | null = null;
        let latestTimestamp: Date | null = null;
        let originalChatId: number | null = null;

        // Ищем самое новое сообщение для данного контакта
        for (const [messageId, info] of this.trackedMessages.entries()) {
            if (info.contactId === contactId && (!latestTimestamp || info.timestamp > latestTimestamp)) {
                latestMessageId = messageId;
                latestTimestamp = info.timestamp;
                originalChatId = info.originalChatId;
            }
        }

        if (latestMessageId !== null && latestTimestamp !== null && originalChatId !== null) {
            return {
                messageId: latestMessageId,
                originalChatId,
                timestamp: latestTimestamp
            };
        }

        return undefined;
    }

    /**
     * Удаляет сообщение из отслеживаемых
     * @param messageId ID сообщения
     * @returns true если сообщение было удалено, false если его не было
     */
    public stopTracking(messageId: number): boolean {
        return this.trackedMessages.delete(messageId);
    }

    /**
     * Очищает старые отслеживаемые сообщения
     * @param hours Количество часов, после которых сообщение считается устаревшим
     * @returns Количество удаленных сообщений
     */
    public cleanupOldMessages(hours: number = 24): number {
        const cutoffTime = new Date();
        cutoffTime.setHours(cutoffTime.getHours() - hours);

        let count = 0;
        for (const [messageId, info] of this.trackedMessages.entries()) {
            if (info.timestamp < cutoffTime) {
                this.trackedMessages.delete(messageId);
                count++;
            }
        }

        if (count > 0) {
            devLog(`Очищено ${count} устаревших отслеживаемых сообщений`);
        }

        return count;
    }
}

// Настраиваем периодическую очистку старых отслеживаемых сообщений
export function setupMessageTrackerCleanup(): void {
    // Очищаем устаревшие сообщения каждые 6 часов
    setInterval(() => {
        MessageTracker.getInstance().cleanupOldMessages(24);
    }, 6 * 60 * 60 * 1000);
}

// Инициализируем очистку
setupMessageTrackerCleanup();