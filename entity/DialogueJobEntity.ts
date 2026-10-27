import { Entity, Column, PrimaryColumn, Index, CreateDateColumn, UpdateDateColumn } from 'typeorm';
import type { DialogueJobInput, DialogueJobStatus } from '../types/dialogueJobTypes';

@Entity('dialogue_jobs')
@Index('IDX_dialogue_jobs_channel_turn', ['profile', 'channel', 'turnId'], { unique: true })
@Index('IDX_dialogue_jobs_pending', ['profile', 'status', 'createdAt'])
export class DialogueJobEntity {
    @PrimaryColumn({ type: 'uuid' }) id!: string;
    @Column({ type: 'text' }) profile!: string;
    @Column({ type: 'text' }) channel!: string;
    @Column({ type: 'text' }) turnId!: string;
    @Column({ type: 'bigint' }) userId!: number;
    @Column({ type: 'bigint' }) chatId!: number;
    @Column({ type: 'bigint', nullable: true }) messageId?: number;
    @Column({ type: 'jsonb' }) input!: DialogueJobInput;
    @Column({ type: 'text' }) status!: DialogueJobStatus;
    @Column({ type: 'text' }) phase!: 'review' | 'deep';
    @Column({ type: 'int', default: 0 }) attempts!: number;
    @Column({ type: 'uuid', nullable: true }) lease?: string | null;
    @Column({ type: 'timestamptz', nullable: true }) lockedAt?: Date | null;
    @Column({ type: 'boolean', default: false }) announced!: boolean;
    @Column({ type: 'text', nullable: true }) notice?: string | null;
    @Column({ type: 'text', nullable: true }) resultText?: string | null;
    @Column({ type: 'text', nullable: true }) error?: string | null;
    @CreateDateColumn({ type: 'timestamptz' }) createdAt!: Date;
    @Column({ type: 'timestamptz' }) expiresAt!: Date;
    @UpdateDateColumn({ type: 'timestamptz' }) updatedAt!: Date;
}
