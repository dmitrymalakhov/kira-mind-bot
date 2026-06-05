import { LessThan, Not } from 'typeorm';
import { AppDataSource } from '../data-source';
import { GroupChatMessageEntity } from '../entity/GroupChatMessageEntity';
import { GroupChatMessage, RecentGroupMessagesOptions } from '../stores/GroupChatBuffer';
import { getActiveBotProfile } from '../utils/botIdentity';

const DEFAULT_TTL_MS = 48 * 60 * 60 * 1000;
const DEFAULT_LIMIT = 15;
const PRUNE_INTERVAL_MS = 15 * 60 * 1000;

let lastPruneAt = 0;

function ttlMs(): number {
    const parsed = Number(process.env.GROUP_CHAT_CONTEXT_TTL_HOURS);
    if (Number.isFinite(parsed) && parsed > 0) return parsed * 60 * 60 * 1000;
    return DEFAULT_TTL_MS;
}

function repo() {
    return AppDataSource.getRepository(GroupChatMessageEntity);
}

function canUseDb(): boolean {
    return AppDataSource.isInitialized;
}

function toEntity(chatId: number, msg: GroupChatMessage): GroupChatMessageEntity | null {
    if (msg.messageId == null) return null;
    const entity = new GroupChatMessageEntity();
    entity.profile = getActiveBotProfile();
    entity.chatId = String(chatId);
    entity.messageId = msg.messageId;
    entity.senderId = msg.senderId != null ? String(msg.senderId) : undefined;
    entity.senderName = msg.senderName;
    entity.text = msg.text;
    entity.isBot = Boolean(msg.isBot);
    entity.messageDate = new Date(msg.date);
    return entity;
}

function fromEntity(entity: GroupChatMessageEntity): GroupChatMessage {
    return {
        senderName: entity.senderName,
        text: entity.text,
        date: new Date(entity.messageDate),
        messageId: entity.messageId,
        senderId: entity.senderId != null ? Number(entity.senderId) : undefined,
        isBot: entity.isBot,
    };
}

async function pruneOldMessages(): Promise<void> {
    if (!canUseDb()) return;
    const now = Date.now();
    if (now - lastPruneAt < PRUNE_INTERVAL_MS) return;
    lastPruneAt = now;

    const threshold = new Date(now - ttlMs());
    try {
        await repo().delete({
            profile: getActiveBotProfile(),
            messageDate: LessThan(threshold),
        });
    } catch (error) {
        console.error('[GroupChatMessageRepository] prune error:', error);
    }
}

export const GroupChatMessageRepository = {
    async save(chatId: number, msg: GroupChatMessage): Promise<void> {
        if (!canUseDb()) return;
        const entity = toEntity(chatId, msg);
        if (!entity) return;

        try {
            await repo().upsert(entity, ['profile', 'chatId', 'messageId']);
            void pruneOldMessages();
        } catch (error) {
            console.error('[GroupChatMessageRepository] save error:', error);
        }
    },

    async loadRecent(chatId: number, options: RecentGroupMessagesOptions = {}): Promise<GroupChatMessage[]> {
        if (!canUseDb()) return [];

        const limit = Math.max(1, options.limit ?? DEFAULT_LIMIT);
        const threshold = new Date(Date.now() - ttlMs());

        try {
            const rows = await repo().find({
                where: {
                    profile: getActiveBotProfile(),
                    chatId: String(chatId),
                    messageDate: Not(LessThan(threshold)),
                },
                order: { messageDate: 'DESC', messageId: 'DESC' },
                take: limit * 3,
            });

            return rows
                .map(fromEntity)
                .filter(m => {
                    if (options.excludeMessageId != null && m.messageId === options.excludeMessageId) return false;
                    if (options.excludeText != null && m.text === options.excludeText) return false;
                    return true;
                })
                .slice(0, limit)
                .reverse();
        } catch (error) {
            console.error('[GroupChatMessageRepository] loadRecent error:', error);
            return [];
        }
    },
};
