import { Entity, Column, PrimaryColumn, CreateDateColumn, UpdateDateColumn } from 'typeorm';

@Entity('chats')
export class ChatEntity {
    @PrimaryColumn({ type: 'bigint' })
    chatId!: string;

    @Column({ type: 'text' })
    title!: string;

    @Column({ type: 'text' })
    chatType!: string;

    @Column({ nullable: true, type: 'text' })
    username?: string;

    @Column({ type: 'text', default: 'KiraMindBot' })
    profile!: string;

    @Column({ type: 'boolean', default: false })
    publicMode!: boolean;

    @Column({ type: 'jsonb', default: [] })
    allowedDomains!: string[];

    @Column({ nullable: true, type: 'text' })
    forbiddenTopics?: string;

    @CreateDateColumn({ type: 'timestamptz' })
    firstSeenAt!: Date;

    @UpdateDateColumn({ type: 'timestamptz' })
    lastSeenAt!: Date;
}
