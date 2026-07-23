import { LessThanOrEqual } from "typeorm";
import { AppDataSource } from "../data-source";
import { RecurringTaskEntity } from "../entity/RecurringTaskEntity";
import type { RecurringTask, RecurringTaskStatus } from "../types/recurringTaskTypes";
import { getActiveBotProfile } from "../utils/botIdentity";
import { computeNextRecurringRun } from "../utils/recurringTaskSchedule";

export const RECURRING_TASK_STALE_LOCK_MS = 30 * 60 * 1000;

function repo() {
    return AppDataSource.getRepository(RecurringTaskEntity);
}

function normalize(entity: RecurringTaskEntity): RecurringTask {
    return {
        ...entity,
        chatId: Number(entity.chatId),
        userId: Number(entity.userId),
        nextRunAt: new Date(entity.nextRunAt),
        lastRunAt: entity.lastRunAt ? new Date(entity.lastRunAt) : undefined,
        lastCompletedAt: entity.lastCompletedAt ? new Date(entity.lastCompletedAt) : undefined,
        lockedAt: entity.lockedAt ? new Date(entity.lockedAt) : undefined,
        createdAt: new Date(entity.createdAt),
        updatedAt: new Date(entity.updatedAt),
    };
}

export const RecurringTaskRepository = {
    async create(task: RecurringTask): Promise<RecurringTask> {
        return normalize(await repo().save(task));
    },

    async findById(id: string, chatId?: number): Promise<RecurringTask | undefined> {
        const entity = await repo().findOne({
            where: {
                id,
                profile: getActiveBotProfile(),
                ...(chatId == null ? {} : { chatId }),
            },
        });
        return entity ? normalize(entity) : undefined;
    },

    async listByChatId(chatId: number): Promise<RecurringTask[]> {
        const entities = await repo().find({
            where: { profile: getActiveBotProfile(), chatId },
            order: { createdAt: "DESC" },
        });
        return entities.map(normalize);
    },

    async update(
        id: string,
        patch: Partial<Pick<
            RecurringTask,
            "title" | "prompt" | "contextHistory" | "schedule" | "timezone" | "status" | "nextRunAt" |
            "lastRunAt" | "lastCompletedAt" | "lockedAt" | "lastResult" | "lastError" |
            "consecutiveFailures" | "runCount"
        >>,
        chatId?: number,
    ): Promise<RecurringTask | undefined> {
        const staleBefore = new Date(Date.now() - RECURRING_TASK_STALE_LOCK_MS);
        const builder = repo().createQueryBuilder()
            .update(RecurringTaskEntity)
            .set(patch)
            .where('"id" = :id AND "profile" = :profile', {
                id,
                profile: getActiveBotProfile(),
            })
            .andWhere('("lockedAt" IS NULL OR "lockedAt" <= :staleBefore)', { staleBefore });
        if (chatId != null) {
            builder.andWhere('"chatId" = :chatId', { chatId });
        }
        const result = await builder.execute();
        return result.affected ? this.findById(id, chatId) : undefined;
    },

    async completeRun(id: string, values: {
        scheduledFor: Date;
        completedAt: Date;
        nextRunAt: Date;
        lastResult: string;
        runCount: number;
    }): Promise<void> {
        await repo().createQueryBuilder()
            .update(RecurringTaskEntity)
            .set({
                lastRunAt: values.scheduledFor,
                lastCompletedAt: values.completedAt,
                nextRunAt: values.nextRunAt,
                lastResult: values.lastResult,
                lastError: null as any,
                consecutiveFailures: 0,
                runCount: values.runCount,
                lockedAt: null as any,
            })
            .where("id = :id AND profile = :profile", { id, profile: getActiveBotProfile() })
            .execute();
    },

    async failRun(id: string, values: {
        scheduledFor: Date;
        nextRunAt: Date;
        error: string;
        consecutiveFailures: number;
        pauseAfterFailure: boolean;
    }): Promise<RecurringTask | undefined> {
        await repo().createQueryBuilder()
            .update(RecurringTaskEntity)
            .set({
                lastRunAt: values.scheduledFor,
                nextRunAt: values.nextRunAt,
                lastError: values.error,
                consecutiveFailures: values.consecutiveFailures,
                ...(values.pauseAfterFailure ? { status: "paused" as RecurringTaskStatus } : {}),
                lockedAt: null as any,
            })
            .where("id = :id AND profile = :profile", { id, profile: getActiveBotProfile() })
            .execute();
        return this.findById(id);
    },

    async refreshLock(id: string, lockedAt = new Date()): Promise<void> {
        await repo().createQueryBuilder()
            .update(RecurringTaskEntity)
            .set({ lockedAt })
            .where('"id" = :id AND "profile" = :profile AND "lockedAt" IS NOT NULL', {
                id,
                profile: getActiveBotProfile(),
            })
            .execute();
    },

    async setStatus(id: string, status: RecurringTaskStatus, chatId?: number): Promise<RecurringTask | undefined> {
        const task = await this.findById(id, chatId);
        if (!task) return undefined;
        const nextRunAt = status === "active" && task.nextRunAt.getTime() <= Date.now()
            ? computeNextRecurringRun(task.schedule, new Date(), task.timezone)
            : task.nextRunAt;
        await repo().createQueryBuilder()
            .update(RecurringTaskEntity)
            .set({ status, nextRunAt })
            .where("id = :id AND profile = :profile", { id, profile: getActiveBotProfile() })
            .execute();
        return this.findById(id);
    },

    async delete(id: string, chatId?: number): Promise<boolean> {
        const staleBefore = new Date(Date.now() - RECURRING_TASK_STALE_LOCK_MS);
        const builder = repo().createQueryBuilder()
            .delete()
            .from(RecurringTaskEntity)
            .where('"id" = :id AND "profile" = :profile', {
                id,
                profile: getActiveBotProfile(),
            })
            .andWhere('("lockedAt" IS NULL OR "lockedAt" <= :staleBefore)', { staleBefore });
        if (chatId != null) {
            builder.andWhere('"chatId" = :chatId', { chatId });
        }
        const result = await builder.execute();
        return Boolean(result.affected);
    },

    async requestRunNow(id: string, chatId?: number): Promise<RecurringTask | undefined> {
        const staleBefore = new Date(Date.now() - RECURRING_TASK_STALE_LOCK_MS);
        const builder = repo().createQueryBuilder()
            .update(RecurringTaskEntity)
            .set({ status: "active", nextRunAt: new Date(), lockedAt: null as any })
            .where('"id" = :id AND "profile" = :profile', {
                id,
                profile: getActiveBotProfile(),
            })
            .andWhere('("lockedAt" IS NULL OR "lockedAt" <= :staleBefore)', { staleBefore });
        if (chatId != null) {
            builder.andWhere('"chatId" = :chatId', { chatId });
        }
        const result = await builder.execute();
        return result.affected ? this.findById(id, chatId) : undefined;
    },

    async claimDue(now = new Date(), limit = 3): Promise<RecurringTask[]> {
        return AppDataSource.transaction(async (manager) => {
            const repository = manager.getRepository(RecurringTaskEntity);
            const staleBefore = new Date(now.getTime() - RECURRING_TASK_STALE_LOCK_MS);
            const tasks = await repository.createQueryBuilder("task")
                .setLock("pessimistic_write")
                .setOnLocked("skip_locked")
                .where("task.profile = :profile", { profile: getActiveBotProfile() })
                .andWhere("task.status = :status", { status: "active" })
                .andWhere("task.nextRunAt <= :now", { now })
                .andWhere("(task.lockedAt IS NULL OR task.lockedAt <= :staleBefore)", { staleBefore })
                .orderBy("task.nextRunAt", "ASC")
                .limit(limit)
                .getMany();

            if (tasks.length === 0) return [];
            for (const task of tasks) task.lockedAt = now;
            await repository.save(tasks);
            return tasks.map(normalize);
        });
    },

    async loadDueWithoutLock(now = new Date()): Promise<RecurringTask[]> {
        const entities = await repo().find({
            where: {
                profile: getActiveBotProfile(),
                status: "active",
                nextRunAt: LessThanOrEqual(now),
            },
        });
        return entities.map(normalize);
    },
};
