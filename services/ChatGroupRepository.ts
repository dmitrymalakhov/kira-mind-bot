import { AppDataSource } from '../data-source';
import { ChatGroupEntity } from '../entity/ChatGroupEntity';
import { getActiveBotProfile } from '../utils/botIdentity';

function repo() {
    return AppDataSource.getRepository(ChatGroupEntity);
}

export const ChatGroupRepository = {
    async save(ownerChatId: number, name: string, chatNames: string[]): Promise<ChatGroupEntity> {
        const profile = getActiveBotProfile();
        const existing = await repo().findOne({ where: { ownerChatId: ownerChatId as any, name, profile } });
        if (existing) {
            existing.chatNames = chatNames;
            return repo().save(existing);
        }
        const entity = new ChatGroupEntity();
        entity.ownerChatId = ownerChatId;
        entity.profile = profile;
        entity.name = name;
        entity.chatNames = chatNames;
        return repo().save(entity);
    },

    async findAll(ownerChatId: number): Promise<ChatGroupEntity[]> {
        return repo().find({ where: { ownerChatId: ownerChatId as any, profile: getActiveBotProfile() }, order: { name: 'ASC' } });
    },

    /** Точный поиск по имени (case-insensitive) */
    async findByName(ownerChatId: number, name: string): Promise<ChatGroupEntity | null> {
        const all = await repo().find({ where: { ownerChatId: ownerChatId as any, profile: getActiveBotProfile() } });
        const lower = name.toLowerCase().trim();
        return all.find(g => g.name.toLowerCase() === lower) ?? null;
    },

    /**
     * Нечёткий поиск: точный → содержит → пересечение слов.
     * Используется когда пользователь пишет "рабочие" вместо "Рабочие чаты".
     */
    async findBestMatch(ownerChatId: number, query: string): Promise<ChatGroupEntity | null> {
        const all = await repo().find({ where: { ownerChatId: ownerChatId as any, profile: getActiveBotProfile() } });
        if (all.length === 0) return null;

        const q = query.toLowerCase().trim();

        // 1. Точное совпадение
        const exact = all.find(g => g.name.toLowerCase() === q);
        if (exact) return exact;

        // 2. Запрос содержит имя группы или имя группы содержит запрос
        const contains = all.find(g => {
            const gn = g.name.toLowerCase();
            return gn.includes(q) || q.includes(gn);
        });
        if (contains) return contains;

        // 3. Пересечение слов (≥50% слов группы присутствуют в запросе)
        const qWords = new Set(q.split(/\s+/).filter(w => w.length > 2));
        let bestGroup: ChatGroupEntity | null = null;
        let bestScore = 0;
        for (const g of all) {
            const gWords = g.name.toLowerCase().split(/\s+/).filter(w => w.length > 2);
            if (gWords.length === 0) continue;
            const matched = gWords.filter(w => qWords.has(w)).length;
            const score = matched / gWords.length;
            if (score > bestScore) { bestScore = score; bestGroup = g; }
        }
        return bestScore >= 0.5 ? bestGroup : null;
    },

    async delete(id: number): Promise<void> {
        await repo().delete({ id, profile: getActiveBotProfile() });
    },

    async updateChatNames(id: number, chatNames: string[]): Promise<void> {
        await repo().update({ id, profile: getActiveBotProfile() }, { chatNames });
    },

    async toggleTracking(id: number): Promise<boolean> {
        const entity = await repo().findOne({ where: { id, profile: getActiveBotProfile() } });
        if (!entity) return false;
        const next = !entity.isTracking;
        await repo().update({ id, profile: getActiveBotProfile() }, { isTracking: next });
        return next;
    },

    async findAllTracking(): Promise<ChatGroupEntity[]> {
        return repo().find({ where: { isTracking: true, profile: getActiveBotProfile() } });
    },
};
