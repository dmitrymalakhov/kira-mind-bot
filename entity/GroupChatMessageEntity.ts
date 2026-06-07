import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('group_chat_messages')
@Index(['profile', 'chatId', 'messageId'], { unique: true })
@Index(['profile', 'chatId', 'messageDate'])
export class GroupChatMessageEntity {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column({ type: 'text', default: 'KiraMindBot' })
    profile!: string;

    @Column({ type: 'bigint' })
    chatId!: string;

    @Column({ type: 'int' })
    messageId!: number;

    @Column({ nullable: true, type: 'bigint' })
    senderId?: string;

    @Column({ type: 'text' })
    senderName!: string;

    @Column({ type: 'text' })
    text!: string;

    @Column({ type: 'boolean', default: false })
    isBot!: boolean;

    @Column({ type: 'timestamptz' })
    messageDate!: Date;

    @CreateDateColumn({ type: 'timestamptz' })
    createdAt!: Date;
}
