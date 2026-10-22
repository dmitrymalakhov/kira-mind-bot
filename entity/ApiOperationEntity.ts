import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';
import type { ApiReply } from '../api/contracts';

/** Durable retry receipts. A pending/failed operation is never executed again automatically. */
@Entity('api_operations')
export class ApiOperationEntity {
    @PrimaryColumn({ type: 'varchar', length: 160 })
    key!: string;

    @Column({ type: 'text' })
    fingerprint!: string;

    @Column({ type: 'text' })
    status!: 'pending' | 'completed' | 'failed';

    @Column({ type: 'jsonb', nullable: true })
    result!: ApiReply | null;

    @CreateDateColumn({ type: 'timestamptz' })
    createdAt!: Date;
}
