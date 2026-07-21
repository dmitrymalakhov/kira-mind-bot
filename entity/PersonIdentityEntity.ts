import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export type PersonIdentityStatus = 'provisional' | 'resolved';

@Entity('person_identities')
@Index(['profile', 'ownerUserId', 'telegramContactId'], { unique: true })
@Index(['profile', 'ownerUserId', 'telegramUsername'])
export class PersonIdentityEntity {
    @PrimaryGeneratedColumn('uuid')
    id!: string;

    @Column({ type: 'text' })
    profile!: string;

    @Column({ type: 'bigint' })
    ownerUserId!: string;

    @Column({ type: 'text' })
    displayName!: string;

    @Column({ type: 'jsonb', default: [] })
    aliases!: string[];

    @Column({ type: 'varchar', length: 16, default: 'provisional' })
    status!: PersonIdentityStatus;

    @Column({ type: 'bigint', nullable: true })
    telegramContactId?: string;

    /** Явно создано через «Новый человек» и не может слиться с контактом автоматически. */
    @Column({ type: 'boolean', default: false })
    detachedFromContacts!: boolean;

    @Column({ type: 'text', nullable: true })
    telegramUsername?: string | null;

    @Column({ type: 'timestamptz', nullable: true })
    lastMentionedAt?: Date;

    @CreateDateColumn({ type: 'timestamptz' })
    createdAt!: Date;

    @UpdateDateColumn({ type: 'timestamptz' })
    updatedAt!: Date;
}
