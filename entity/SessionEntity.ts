import { Entity, PrimaryColumn, Column, UpdateDateColumn } from 'typeorm';

/**
 * Персистентное хранилище сессий Grammy.
 * Ключ = `${ASSISTANT_PROFILE}:${chatId}`. Данные — JSONB с подмножеством SessionData:
 * messageHistory (последние 20), dialogueSummary, domains, recentlySavedFacts.
 */
@Entity('bot_sessions')
export class SessionEntity {
    @PrimaryColumn({ type: 'varchar', length: 64 })
    key!: string;

    @Column({ type: 'jsonb' })
    data!: Record<string, any> | string;

    @UpdateDateColumn()
    updatedAt!: Date;
}
