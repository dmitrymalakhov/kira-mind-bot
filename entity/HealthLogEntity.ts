import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

@Entity('health_logs')
export class HealthLogEntity {
    @PrimaryColumn()
    id!: string;

    @Column({ type: 'bigint' })
    userId!: number;

    @Column({ type: 'text', default: 'KiraMindBot' })
    profile!: string;

    @Column({ type: 'bigint', nullable: true })
    chatId?: number;

    @Column({ type: 'varchar', length: 32 })
    kind!: string;

    @Column({ type: 'text' })
    rawText!: string;

    @Column({ type: 'text', nullable: true })
    summary?: string;

    @Column({ type: 'int', nullable: true })
    severity?: number;

    @Column({ type: 'timestamptz' })
    occurredAt!: Date;

    @Column({ type: 'varchar', length: 16, nullable: true })
    timeOfDay?: string;

    @Column({ type: 'jsonb', nullable: true })
    structured?: Record<string, unknown>;

    @Column({ type: 'jsonb', nullable: true })
    tags?: string[];

    @Column({ type: 'text', nullable: true })
    photoFileId?: string;

    @CreateDateColumn({ type: 'timestamptz' })
    createdAt!: Date;
}
