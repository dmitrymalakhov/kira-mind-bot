import { Entity, Column, PrimaryColumn, CreateDateColumn } from 'typeorm';
import { ReminderStatus, ReminderTargetChat, RecurrenceRule } from '../types/reminderTypes';

@Entity('reminders')
export class ReminderEntity {
    @PrimaryColumn()
    id!: string;

    @Column()
    text!: string;

    @Column({ nullable: true, type: 'text' })
    displayText?: string;

    @Column({ type: 'timestamptz' })
    dueDate!: Date;

    @Column({ type: 'bigint' })
    chatId!: number;

    @Column({ default: ReminderStatus.Pending })
    status!: string;

    @Column({ nullable: true, type: 'int' })
    messageId?: number;

    @Column({ nullable: true, type: 'timestamptz' })
    remindAgainAt?: Date;

    @CreateDateColumn({ type: 'timestamptz' })
    createdAt!: Date;

    @Column({ nullable: true, type: 'jsonb' })
    targetChat?: ReminderTargetChat;

    @Column({ nullable: true, type: 'text' })
    chatTitle?: string;

    @Column({ nullable: true, type: 'jsonb' })
    recurrence?: RecurrenceRule;

    @Column({ default: 0 })
    postponeCount!: number;
}
