import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    PrimaryColumn,
    UpdateDateColumn,
} from "typeorm";
import type { RecurringTaskSchedule, RecurringTaskStatus } from "../types/recurringTaskTypes";

@Entity("recurring_tasks")
@Index(["profile", "status", "nextRunAt"])
export class RecurringTaskEntity {
    @PrimaryColumn({ type: "uuid" })
    id!: string;

    @Column({ type: "text", default: "KiraMindBot" })
    profile!: string;

    @Column({ type: "bigint" })
    chatId!: number;

    @Column({ type: "text", default: "private" })
    chatType!: "private" | "group" | "supergroup";

    @Column({ type: "text", nullable: true })
    chatTitle?: string;

    @Column({ type: "bigint" })
    userId!: number;

    @Column({ type: "text" })
    title!: string;

    @Column({ type: "text" })
    prompt!: string;

    @Column({ type: "jsonb", nullable: true })
    contextHistory?: Array<{
        role: string;
        content: string;
    }>;

    @Column({ type: "int", nullable: true })
    originalMessageId?: number;

    @Column({ type: "jsonb" })
    schedule!: RecurringTaskSchedule;

    @Column({ type: "text" })
    timezone!: string;

    @Column({ type: "text", default: "active" })
    status!: RecurringTaskStatus;

    @Column({ type: "timestamptz" })
    nextRunAt!: Date;

    @Column({ type: "timestamptz", nullable: true })
    lastRunAt?: Date;

    @Column({ type: "timestamptz", nullable: true })
    lastCompletedAt?: Date;

    @Column({ type: "timestamptz", nullable: true })
    lockedAt?: Date;

    @Column({ type: "text", nullable: true })
    lastResult?: string;

    @Column({ type: "text", nullable: true })
    lastError?: string;

    @Column({ type: "int", default: 0 })
    consecutiveFailures!: number;

    @Column({ type: "int", default: 0 })
    runCount!: number;

    @CreateDateColumn({ type: "timestamptz" })
    createdAt!: Date;

    @UpdateDateColumn({ type: "timestamptz" })
    updatedAt!: Date;
}
