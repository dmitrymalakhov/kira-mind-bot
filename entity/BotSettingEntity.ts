import { Entity, Column, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity('bot_settings')
export class BotSettingEntity {
    @PrimaryColumn({ type: 'text' })
    key!: string;

    @Column({ type: 'text' })
    value!: string;

    @UpdateDateColumn({ type: 'timestamptz' })
    updatedAt!: Date;
}
