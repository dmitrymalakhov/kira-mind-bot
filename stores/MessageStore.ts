import { devLog } from "../utils";

// Структура для хранения сообщений
export interface StoredMessage {
    id: number;
    senderId: string | number;
    senderName: string;
    senderUsername?: string; // Username отправителя
    text: string;
    date: Date;
    isRead: boolean;
    isBot: boolean; // Флаг для ботов
}

// Хранилище для сообщений
export class MessageStore {
    private static instance: MessageStore;
    private messages: Map<string, StoredMessage[]> = new Map();
    private hasNewUnreadMessages: boolean = false;

    private constructor() { }

    public static getInstance(): MessageStore {
        if (!MessageStore.instance) {
            MessageStore.instance = new MessageStore();
        }

        return MessageStore.instance;
    }

    // Добавление нового сообщения
    addMessage(chatId: string, message: StoredMessage): void {
        // Проверяем, не является ли отправитель ботом
        if (message.isBot) {
            devLog(`Игнорируем сообщение от бота: ${message.senderName}`);
            return; // Пропускаем сообщения от ботов
        }

        if (!this.messages.has(chatId)) {
            this.messages.set(chatId, []);
        }

        // Проверяем, существует ли сообщение с таким ID
        const existingMessageIndex = this.messages.get(chatId)!.findIndex(msg => msg.id === message.id);

        if (existingMessageIndex >= 0) {
            // Если сообщение существует, обновляем его, сохраняя статус прочтения
            const isRead = this.messages.get(chatId)![existingMessageIndex].isRead;
            this.messages.get(chatId)![existingMessageIndex] = { ...message, isRead };
        } else {
            // Если новое сообщение, добавляем его
            this.messages.get(chatId)!.push(message);

            // Устанавливаем флаг новых непрочитанных сообщений
            if (!message.isRead) {
                this.hasNewUnreadMessages = true;
            }
        }

        // Сортируем сообщения по дате (от новых к старым)
        this.messages.get(chatId)!.sort((a, b) => b.date.getTime() - a.date.getTime());
    }

    // Получение сообщений для чата
    getMessages(chatId: string): StoredMessage[] {
        return this.messages.get(chatId) || [];
    }

    // Проверка наличия новых непрочитанных сообщений
    hasUnreadMessages(): boolean {
        return this.hasNewUnreadMessages;
    }

    // Получение всех непрочитанных сообщений
    getUnreadMessages(): { chatId: string, messages: StoredMessage[] }[] {
        const result: { chatId: string, messages: StoredMessage[] }[] = [];

        this.messages.forEach((messages, chatId) => {
            const unreadMessages = messages.filter(msg => !msg.isRead);
            if (unreadMessages.length > 0) {
                result.push({
                    chatId,
                    messages: unreadMessages
                });
            }
        });

        return result;
    }

    // Отметка сообщений как прочитанных
    markAsRead(chatId: string): void {
        const messages = this.messages.get(chatId);
        if (messages) {
            let changedStatus = false;

            messages.forEach(msg => {
                if (!msg.isRead) {
                    msg.isRead = true;
                    changedStatus = true;
                }
            });

            // Проверяем, есть ли еще непрочитанные сообщения в других чатах
            if (changedStatus) {
                this.updateUnreadMessagesFlag();
            }
        }
    }

    // Отметка всех сообщений как прочитанных
    markAllAsRead(): void {
        let hasChanged = false;

        this.messages.forEach((messages, chatId) => {
            messages.forEach(msg => {
                if (!msg.isRead) {
                    msg.isRead = true;
                    hasChanged = true;
                }
            });
        });

        if (hasChanged) {
            this.hasNewUnreadMessages = false;
        }
    }

    // Полная очистка хранилища
    clear(): void {
        this.messages.clear();
        this.hasNewUnreadMessages = false;
    }

    // Обновление флага наличия непрочитанных сообщений
    private updateUnreadMessagesFlag(): void {
        this.hasNewUnreadMessages = false;

        this.messages.forEach((messages) => {
            if (messages.some(msg => !msg.isRead)) {
                this.hasNewUnreadMessages = true;
            }
        });
    }

    // Очистка старых сообщений (старше N дней)
    cleanupOldMessages(daysToKeep: number = 7): void {
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

        this.messages.forEach((messages, chatId) => {
            const filteredMessages = messages.filter(msg => msg.date >= cutoffDate);
            this.messages.set(chatId, filteredMessages);
        });

        // Обновляем флаг наличия непрочитанных сообщений
        this.updateUnreadMessagesFlag();
    }

    // Получение последних сообщений за определенный период
    getRecentMessages(hours: number = 24): { chatId: string, messages: StoredMessage[] }[] {
        const result: { chatId: string, messages: StoredMessage[] }[] = [];
        const cutoffDate = new Date();
        cutoffDate.setHours(cutoffDate.getHours() - hours);

        this.messages.forEach((messages, chatId) => {
            const recentMessages = messages.filter(msg => msg.date >= cutoffDate && !msg.isBot);
            if (recentMessages.length > 0) {
                result.push({
                    chatId,
                    messages: recentMessages
                });
            }
        });

        return result;
    }
}
