import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('ai_usage_logs')
export class AiUsageLogEntity {
    @PrimaryGeneratedColumn('uuid')
    id!: string;

    @CreateDateColumn({ type: 'timestamptz' })
    createdAt!: Date;

    @Column({ type: 'text' })
    taskKey!: string;

    @Column({ type: 'text' })
    provider!: string;

    @Column({ type: 'text' })
    model!: string;

    @Column({ type: 'text' })
    preset!: string;

    @Column({ type: 'int', nullable: true })
    inputTokens?: number;

    @Column({ type: 'int', nullable: true })
    outputTokens?: number;

    @Column({ type: 'int', nullable: true })
    totalTokens?: number;

    @Column({ type: 'boolean' })
    success!: boolean;

    @Column({ type: 'boolean', default: false })
    fallbackUsed!: boolean;

    @Column({ type: 'text', nullable: true })
    errorMessage?: string;

    @Column({ type: 'int', nullable: true })
    latencyMs?: number;
}
