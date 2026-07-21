import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Index('IDX_ai_usage_logs_created_at', ['createdAt'])
@Index('IDX_ai_usage_logs_provider_created_at', ['provider', 'createdAt'])
@Index('IDX_ai_usage_logs_model_created_at', ['model', 'createdAt'])
@Index('IDX_ai_usage_logs_task_key_created_at', ['taskKey', 'createdAt'])
@Index('IDX_ai_usage_logs_operation_created_at', ['operation', 'createdAt'])
@Index('IDX_ai_usage_logs_trace_id_created_at', ['traceId', 'createdAt'])
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

    @Column({ type: 'text', default: 'unknown' })
    operation!: string;

    @Column({ type: 'text', nullable: true })
    traceId?: string;

    @Column({ type: 'int', nullable: true })
    attempt?: number;

    @Column({ type: 'text', nullable: true })
    stage?: string;

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
    errorStatus?: number;

    @Column({ type: 'text', nullable: true })
    errorCode?: string;

    @Column({ type: 'text', nullable: true })
    errorType?: string;

    @Column({ type: 'text', nullable: true })
    errorCategory?: string;

    @Column({ type: 'text', nullable: true })
    providerRequestId?: string;

    @Column({ type: 'boolean', nullable: true })
    retryable?: boolean;

    @Column({ type: 'int', nullable: true })
    latencyMs?: number;
}
