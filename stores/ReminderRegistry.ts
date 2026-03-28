import { Reminder, ReminderStatus } from '../reminder';

function isActive(r: Reminder): boolean {
    return r.status !== ReminderStatus.Completed &&
        r.status !== ReminderStatus.Expired &&
        new Date(r.dueDate) > new Date();
}

/**
 * Глобальный реестр всех напоминаний — единственный источник правды для поиска
 * по ID и кросс-чатовой навигации.
 *
 * Сессия grammY хранит данные per-chat. Когда владелец создаёт напоминание
 * в групповом чате, оно попадает в сессию той группы и недоступно из приватной.
 * ReminderRegistry решает это: все напоминания регистрируются сюда при создании
 * и могут быть найдены из любого контекста.
 */
export class ReminderRegistry {
    private static _instance: ReminderRegistry;

    /** reminderId → Reminder */
    private byId = new Map<string, Reminder>();
    /** chatId → Set<reminderId> */
    private byChatId = new Map<number, Set<string>>();

    static getInstance(): ReminderRegistry {
        if (!this._instance) this._instance = new ReminderRegistry();
        return this._instance;
    }

    add(reminder: Reminder): void {
        // Если reminder уже был под другим chatId — убираем из старого индекса
        const existing = this.byId.get(reminder.id);
        if (existing && existing.chatId !== reminder.chatId) {
            this.byChatId.get(existing.chatId)?.delete(reminder.id);
        }
        this.byId.set(reminder.id, reminder);
        if (!this.byChatId.has(reminder.chatId)) {
            this.byChatId.set(reminder.chatId, new Set());
        }
        this.byChatId.get(reminder.chatId)!.add(reminder.id);
    }

    remove(id: string): void {
        const r = this.byId.get(id);
        if (!r) return;
        this.byId.delete(id);
        this.byChatId.get(r.chatId)?.delete(id);
    }

    get(id: string): Reminder | undefined {
        return this.byId.get(id);
    }

    getActiveByChatId(chatId: number): Reminder[] {
        const ids = this.byChatId.get(chatId);
        if (!ids) return [];
        return [...ids]
            .map(id => this.byId.get(id))
            .filter((r): r is Reminder => !!r && isActive(r));
    }

    /**
     * Все чаты с активными напоминаниями — для пикера в приватном чате.
     */
    getChatsWithActive(): Array<{ chatId: number; title: string; count: number }> {
        const result: Array<{ chatId: number; title: string; count: number }> = [];
        for (const [chatId, ids] of this.byChatId) {
            const active = [...ids]
                .map(id => this.byId.get(id))
                .filter((r): r is Reminder => !!r && isActive(r));
            if (active.length > 0) {
                const title = active[0].chatTitle ?? (chatId > 0 ? '🏠 Личный чат' : `Группа`);
                result.push({ chatId, title, count: active.length });
            }
        }
        // Личный чат первым
        return result.sort((a, b) => (b.chatId > 0 ? 1 : 0) - (a.chatId > 0 ? 1 : 0));
    }
}
