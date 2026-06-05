import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn } from 'typeorm';

@Entity('chat_groups')
export class ChatGroupEntity {
    @PrimaryGeneratedColumn()
    id!: number;

    /** Пользовательское название группы, например "рабочие чаты" */
    @Column()
    name!: string;

    /** Telegram chat ID пользователя-владельца */
    @Column({ type: 'bigint' })
    ownerChatId!: number;

    @Column({ type: 'text', default: 'KiraMindBot' })
    profile!: string;

    /** Список названий Telegram-групп/каналов */
    @Column({ type: 'jsonb' })
    chatNames!: string[];

    /** Включён ли режим умного отслеживания для этой группы */
    @Column({ default: false })
    isTracking!: boolean;

    @CreateDateColumn({ type: 'timestamptz' })
    createdAt!: Date;
}
