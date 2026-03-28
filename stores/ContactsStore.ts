import { TelegramClient } from "telegram";
import { Api } from "telegram";
import { get as levenshtein } from "fast-levenshtein";
import { DoubleMetaphone, JaroWinklerDistance } from "natural";
import { transliterate as toLatin } from "transliteration";
import { devLog } from "../utils";
import openai from "../openai";

// Интерфейс для хранения информации о контакте
export interface Contact {
    id: number;
    username?: string;
    firstName: string;
    lastName?: string;
    phone?: string;
    notes?: string;
    lastInteraction?: Date;
    isFavorite?: boolean;
    tags?: string[];
}

// Обновляем интерфейс для запланированного сообщения
export interface ScheduledMessage {
    id: number;
    contactId: number;
    text: string;
    scheduledTime: Date;
    status: 'pending' | 'sent' | 'failed' | 'cancelled';
    createdAt: Date;
    messageId?: number; // ID сообщения в Telegram после отправки
    notifyOnReply?: boolean; // Флаг для уведомления о получении ответа
    originalChatId?: number | null; // ID чата, куда нужно пересылать ответ
}


/**
 * Класс для хранения и управления контактами и запланированными сообщениями
 */
export class ContactsStore {
    private static instance: ContactsStore;
    private contacts: Map<number, Contact> = new Map();
    private scheduledMessages: ScheduledMessage[] = [];
    private nextMessageId: number = 1;
    private isInitialized: boolean = false;
    private dm = new DoubleMetaphone();

    private constructor() {
        // Приватный конструктор для синглтона
    }

    /**
     * Получить экземпляр класса ContactsStore (синглтон)
     * @returns Экземпляр ContactsStore
     */
    public static getInstance(): ContactsStore {
        if (!ContactsStore.instance) {
            ContactsStore.instance = new ContactsStore();
        }
        return ContactsStore.instance;
    }

    /**
     * Проверяет, инициализировано ли хранилище
     * @returns true, если хранилище инициализировано
     */
    public isReady(): boolean {
        return this.isInitialized;
    }

    /**
     * Добавляет или обновляет контакт в хранилище
     * @param contact Контакт для сохранения
     * @returns Сохраненный контакт
     */
    public saveContact(contact: Contact): Contact {
        this.contacts.set(contact.id, contact);
        return contact;
    }

    /**
     * Получает контакт по ID
     * @param id ID контакта
     * @returns Контакт или undefined, если не найден
     */
    public getContact(id: number): Contact | undefined {
        return this.contacts.get(id);
    }

    /**
     * Получает все контакты
     * @returns Массив всех контактов
     */
    public getAllContacts(): Contact[] {
        return Array.from(this.contacts.values());
    }

    /**
     * Получает избранные контакты
     * @returns Массив избранных контактов
     */
    public getFavoriteContacts(): Contact[] {
        return Array.from(this.contacts.values()).filter(contact => contact.isFavorite);
    }

    private normalize(s: string): string {
        return toLatin(s)          // кириллицу → латиницу
            .normalize("NFD")        // разделяем диакриты
            .replace(/[\u0300-\u036f]/g, "") // убираем их
            .trim().toLowerCase();
    }

    /** 2) Фонотический код через Double Metaphone */
    private phoneticCode(s: string): string {
        const norm = this.normalize(s);
        const codes = this.dm.process(norm);
        return Array.isArray(codes) && codes[0] ? codes[0] : "";
    }

    /**
     * Поиск: для каждого контакта считаем
     *   – фонетическую дистанцию (0 если коды совпали, иначе 1),
     *   – Jaro–Winkler similarity (0…1 → чем ближе к 1, тем лучше),
     *   – Левенштейн (обычная edit-distance).
     * И комбинируем в единый score.
     */
    public searchContactsByName(query: string, limit: number = 5): Contact[] {
        const tokens = query.split(/\s+/).filter(Boolean);
        const allContacts = Array.from(this.contacts.values());

        // Функция для расчёта score по одному полю
        const calcScore = (qNorm: string, qPhon: string, name: string) => {
            const nNorm = this.normalize(name);
            const phonDist = this.phoneticCode(name) === qPhon ? 0 : 1;
            const jwSim = JaroWinklerDistance(qNorm, nNorm);
            const jwDist = 1 - jwSim;
            const levDist = levenshtein(qNorm, nNorm);
            return phonDist * 0.2 + jwDist * 1 + levDist * 0.1;
        };

        let scored: { contact: Contact; score: number }[];

        if (tokens.length >= 2) {
            // Имя + фамилия
            const [firstQ, lastQ] = tokens;
            const firstNorm = this.normalize(firstQ);
            const lastNorm = this.normalize(lastQ);
            const firstPhon = this.phoneticCode(firstQ);
            const lastPhon = this.phoneticCode(lastQ);

            scored = allContacts.map(contact => {
                const fn = contact.firstName || "";
                const ln = contact.lastName || "";
                const scoreFirst = calcScore(firstNorm, firstPhon, fn);
                const scoreLast = calcScore(lastNorm, lastPhon, ln);
                const combined = scoreFirst * 0.6 + scoreLast * 0.4;
                return { contact, score: combined };
            });
        } else {
            // Одиночное имя/ник
            const qNorm = this.normalize(query);
            const qPhon = this.phoneticCode(query);

            scored = allContacts.map(contact => {
                const names = [contact.firstName, contact.lastName || "", contact.username || ""];
                let best = Infinity;
                for (const name of names) {
                    const score = calcScore(qNorm, qPhon, name);
                    if (score < best) best = score;
                }
                return { contact, score: best };
            });
        }

        return scored
            .sort((a, b) => a.score - b.score)
            .slice(0, limit)
            .map(item => item.contact);
    }

    public async searchContactByName(query: string): Promise<Contact | null | undefined> {
        const contacts = this.searchContactsByName(query);

        let contact: Contact | null | undefined = null;

        if (contacts.length > 1) {
            devLog("sendMessagesAgent", "Найдено несколько контактов:", contacts.length, contacts);

            const systemMessage = `Ты — аналитический помощник который умеет находить контакты`;

            const userMessage = `Найди контакт по запросу и верни его id. ВАЖНО! Отвечай только цифрой.` +
                `Запрос: "${query}"\n` +
                `Список контактов: ${JSON.stringify(contacts)}`;

            devLog("sendMessagesAgent", "Отправляем запрос к OpenAI для выбора контакта");

            // Запрос к OpenAI
            const response = await openai.chat.completions.create({
                model: 'gpt-5-nano',
                messages: [
                    { role: 'system', content: systemMessage },
                    { role: 'user', content: userMessage }
                ],
                temperature: 1,
            });

            devLog("sendMessagesAgent", "Получен ответ от OpenAI:", response.choices[0]?.message?.content);

            if (response.choices[0]?.message?.content) {
                const userId = response.choices[0].message.content.trim();
                devLog("sendMessagesAgent", "Определен ID контакта:", userId);
                contact = contacts.find(c => Number(c.id) === Number(userId));
                devLog("sendMessagesAgent", "Результат поиска контакта по ID:", contact ? "Найден" : "Не найден");
            }
        } else if (contacts.length === 1) {
            devLog("sendMessagesAgent", "Найден один контакт");
            contact = contacts[0];
        } else {
            devLog("sendMessagesAgent", "Контакты не найдены");
        }

        return contact;
    }
    /**
     * Получает контакты по тегу
     * @param tag Тег для фильтрации
     * @returns Массив контактов с указанным тегом
     */
    public getContactsByTag(tag: string): Contact[] {
        return Array.from(this.contacts.values()).filter(contact =>
            contact.tags && contact.tags.includes(tag)
        );
    }

    /**
     * Поиск контактов по имени, фамилии, юзернейму или телефону
     * @param query Строка для поиска
     * @returns Массив найденных контактов
     */
    // public async searchContact(query: string): Promise<Contact | null> {
    //     // Системное сообщение для ИИ
    //     const systemMessage = `Ты — аналитический помощник который умеет находить контакты`;

    //     // Формируем пользовательское сообщение, включая запрос и список контактов в виде JSON
    //     const userMessage = `Найди контакт по запросу и верни его id в виде цифры` +
    //         `Запрос: "${query}"\n` +
    //         `Список контактов: ${JSON.stringify(this.contacts)}`;

    //     // Запрос к OpenAI
    //     const response = await openai.chat.completions.create({
    //         model: 'gpt-5-nano',
    //         messages: [
    //             { role: 'system', content: systemMessage },
    //             { role: 'user', content: userMessage }
    //         ],
    //         temperature: 0.3,
    //     });

    //     // Выделяем текстовый контент ответа
    //     const id = this.getContact(Number(response.choices?.[0]?.message?.content));
    //     if (!id) {
    //         return null;
    //     }

    //     return id;
    // }


    /**
     * Удаляет контакт из хранилища
     * @param id ID контакта
     * @returns true, если контакт успешно удален
     */
    public deleteContact(id: number): boolean {
        return this.contacts.delete(id);
    }

    /**
     * Добавляет тег к контакту
     * @param contactId ID контакта
     * @param tag Тег для добавления
     * @returns true, если операция успешна
     */
    public addTagToContact(contactId: number, tag: string): boolean {
        const contact = this.contacts.get(contactId);
        if (!contact) {
            return false;
        }

        if (!contact.tags) {
            contact.tags = [];
        }

        if (!contact.tags.includes(tag)) {
            contact.tags.push(tag);
            this.contacts.set(contactId, contact);
        }

        return true;
    }

    /**
     * Удаляет тег из контакта
     * @param contactId ID контакта
     * @param tag Тег для удаления
     * @returns true, если операция успешна
     */
    public removeTagFromContact(contactId: number, tag: string): boolean {
        const contact = this.contacts.get(contactId);
        if (!contact || !contact.tags) {
            return false;
        }

        const index = contact.tags.indexOf(tag);
        if (index !== -1) {
            contact.tags.splice(index, 1);
            this.contacts.set(contactId, contact);
            return true;
        }

        return false;
    }

    /**
     * Переключает статус избранного для контакта
     * @param contactId ID контакта
     * @returns true, если операция успешна и новый статус избранного
     */
    public toggleFavorite(contactId: number): { success: boolean, isFavorite?: boolean } {
        const contact = this.contacts.get(contactId);
        if (!contact) {
            return { success: false };
        }

        contact.isFavorite = !contact.isFavorite;
        this.contacts.set(contactId, contact);

        return { success: true, isFavorite: contact.isFavorite };
    }

    /**
     * Обновляет заметки для контакта
     * @param contactId ID контакта
     * @param notes Новые заметки
     * @returns true, если операция успешна
     */
    public updateContactNotes(contactId: number, notes: string): boolean {
        const contact = this.contacts.get(contactId);
        if (!contact) {
            return false;
        }

        contact.notes = notes;
        this.contacts.set(contactId, contact);

        return true;
    }

    /**
     * Обновляет время последнего взаимодействия с контактом
     * @param contactId ID контакта
     * @param time Время взаимодействия (по умолчанию - текущее время)
     * @returns true, если операция успешна
     */
    public updateLastInteraction(contactId: number, time: Date = new Date()): boolean {
        const contact = this.contacts.get(contactId);
        if (!contact) {
            return false;
        }

        contact.lastInteraction = time;
        this.contacts.set(contactId, contact);

        return true;
    }

    /**
     * Очищает все контакты из хранилища
     */
    public clearAllContacts(): void {
        this.contacts.clear();
        this.isInitialized = false;
    }

    /**
     * Синхронизирует контакты из учетной записи Telegram
     * @param client Инициализированный клиент Telegram
     * @returns Количество синхронизированных контактов
     */
    public async syncContactsFromTelegram(client: TelegramClient): Promise<number> {
        try {
            // Получаем список контактов пользователя через TelegramClient
            const contacts = await client.invoke(new Api.contacts.GetContacts({}));
            let syncedCount = 0;

            // Проверяем, является ли результат экземпляром Api.contacts.Contacts
            if (contacts instanceof Api.contacts.Contacts) {
                // Перед синхронизацией сохраняем текущие заметки, теги и статусы избранного
                const existingNotes = new Map<number, string>();
                const existingTags = new Map<number, string[]>();
                const existingFavorites = new Map<number, boolean>();

                this.contacts.forEach((contact, id) => {
                    if (contact.notes) existingNotes.set(id, contact.notes);
                    if (contact.tags) existingTags.set(id, [...contact.tags]);
                    if (contact.isFavorite) existingFavorites.set(id, true);
                });

                // Очищаем текущие контакты
                this.contacts.clear();

                // Добавляем контакты в хранилище
                contacts.users.forEach((user: any) => {
                    if (user.id) {
                        const contactId = Number(user.id);

                        this.saveContact({
                            id: contactId,
                            username: user.username || undefined,
                            firstName: user.firstName || user.username || 'Unknown',
                            lastName: user.lastName || undefined,
                            phone: user.phone || undefined,
                            lastInteraction: new Date(),
                            notes: existingNotes.get(contactId),
                            tags: existingTags.get(contactId),
                            isFavorite: existingFavorites.get(contactId) || false
                        });

                        syncedCount++;
                    }
                });

                this.isInitialized = true;
            }

            return syncedCount;
        } catch (error) {
            console.error('Error syncing contacts from Telegram:', error);
            throw error;
        }
    }

    /**
     * Создает запланированное сообщение
     * @param contactId ID контакта
     * @param text Текст сообщения
     * @param scheduledTime Время отправки
     * @returns Созданное запланированное сообщение
     */
    public scheduleMessage(
        contactId: number,
        text: string,
        scheduledTime: Date,
        notifyOnReply: boolean = false,
        originalChatId: number | null = null
    ): ScheduledMessage {
        const message: ScheduledMessage = {
            id: this.nextMessageId++,
            contactId,
            text,
            scheduledTime,
            status: 'pending',
            createdAt: new Date(),
            notifyOnReply,
            originalChatId
        };

        this.scheduledMessages.push(message);
        return message;
    }

    /**
     * Получает запланированное сообщение по ID
     * @param id ID запланированного сообщения
     * @returns Запланированное сообщение или undefined
     */
    public getScheduledMessage(id: number): ScheduledMessage | undefined {
        return this.scheduledMessages.find(msg => msg.id === id);
    }

    /**
     * Получает все запланированные сообщения
     * @returns Массив всех запланированных сообщений
     */
    public getAllScheduledMessages(): ScheduledMessage[] {
        return [...this.scheduledMessages];
    }

    /**
     * Получает запланированные сообщения для контакта
     * @param contactId ID контакта
     * @param status Опциональный статус для фильтрации
     * @returns Массив запланированных сообщений
     */
    public getScheduledMessagesForContact(
        contactId: number,
        status?: 'pending' | 'sent' | 'failed' | 'cancelled'
    ): ScheduledMessage[] {
        return this.scheduledMessages.filter(msg =>
            msg.contactId === contactId &&
            (status ? msg.status === status : true)
        );
    }

    /**
     * Получает ожидающие отправки сообщения
     * @returns Массив ожидающих отправки сообщений
     */
    public getPendingMessages(): ScheduledMessage[] {
        return this.scheduledMessages.filter(msg => msg.status === 'pending');
    }

    /**
     * Обновляет статус запланированного сообщения
     * @param id ID запланированного сообщения
     * @param status Новый статус
     * @returns true, если операция успешна
     */
    public updateMessageStatus(id: number, status: 'pending' | 'sent' | 'failed' | 'cancelled'): boolean {
        const messageIndex = this.scheduledMessages.findIndex(msg => msg.id === id);
        if (messageIndex !== -1) {
            this.scheduledMessages[messageIndex].status = status;
            return true;
        }
        return false;
    }

    /**
     * Обновляет ID сообщения в Telegram после отправки
     * @param id ID запланированного сообщения
     * @param messageId ID сообщения в Telegram
     * @returns true, если операция успешна
     */
    public updateMessageId(id: number, messageId: number): boolean {
        const messageIndex = this.scheduledMessages.findIndex(msg => msg.id === id);
        if (messageIndex !== -1) {
            this.scheduledMessages[messageIndex].messageId = messageId;
            return true;
        }
        return false;
    }

    /**
     * Отменяет запланированное сообщение
     * @param id ID запланированного сообщения
     * @returns true, если операция успешна
     */
    public cancelScheduledMessage(id: number): boolean {
        return this.updateMessageStatus(id, 'cancelled');
    }

    /**
     * Очищает историю отправленных и отмененных сообщений старше указанного периода
     * @param days Количество дней для хранения (по умолчанию 30)
     * @returns Количество удаленных записей
     */
    public cleanupOldMessages(days: number = 30): number {
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - days);

        const initialCount = this.scheduledMessages.length;

        // Оставляем только сообщения, которые еще ожидают отправки или созданы после даты отсечения
        this.scheduledMessages = this.scheduledMessages.filter(msg =>
            msg.status === 'pending' || msg.createdAt >= cutoffDate
        );

        return initialCount - this.scheduledMessages.length;
    }

    /**
     * Сериализует хранилище для сохранения
     * @returns Строка JSON представления хранилища
     */
    public serialize(): string {
        const data = {
            contacts: Array.from(this.contacts.entries()),
            scheduledMessages: this.scheduledMessages,
            nextMessageId: this.nextMessageId,
            isInitialized: this.isInitialized
        };

        return JSON.stringify(data);
    }

    /**
     * Десериализует и загружает хранилище из строки JSON
     * @param serialized Строка JSON представления хранилища
     * @returns true, если операция успешна
     */
    public deserialize(serialized: string): boolean {
        try {
            const data = JSON.parse(serialized);

            // Восстанавливаем контакты
            this.contacts = new Map(data.contacts);

            // Восстанавливаем запланированные сообщения
            this.scheduledMessages = data.scheduledMessages.map((msg: any) => ({
                ...msg,
                scheduledTime: new Date(msg.scheduledTime),
                createdAt: new Date(msg.createdAt)
            }));

            this.nextMessageId = data.nextMessageId;
            this.isInitialized = data.isInitialized;

            return true;
        } catch (error) {
            console.error('Error deserializing contacts store:', error);
            return false;
        }
    }
}