import { randomUUID } from 'node:crypto';
import { In, LessThan } from 'typeorm';
import { AppDataSource } from '../data-source';
import { DialogueJobEntity } from '../entity/DialogueJobEntity';
import { BotSettingEntity } from '../entity/BotSettingEntity';
import { SessionEntity } from '../entity/SessionEntity';
import { getActiveBotProfile, scopedBotKey } from '../utils/botIdentity';
import type { DialogueJob, DialogueJobInput, DialogueJobStatus } from '../types/dialogueJobTypes';

export const DIALOGUE_JOB_TTL_MS = 15 * 60_000;
export const DIALOGUE_JOB_LEASE_MS = 90_000;
const ACTIVE: DialogueJobStatus[] = ['staged', 'queued', 'running', 'ready'];
const CANCELLABLE: DialogueJobStatus[] = [...ACTIVE, 'delivering'];
const repo = () => AppDataSource.getRepository(DialogueJobEntity);
const marker = (channel: string) => scopedBotKey(`dialogue:${channel}`);
const normalize = (row: DialogueJobEntity): DialogueJob => ({ ...row, userId: Number(row.userId), chatId: Number(row.chatId), messageId: row.messageId == null ? undefined : Number(row.messageId) });

/** Every operation is tenant/profile + channel scoped. Only server code supplies these keys. */
export const DialogueJobRepository = {
    async beginTurn(channel: string, turnId: string): Promise<void> {
        await AppDataSource.transaction(async manager => {
            await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [marker(channel)]);
            const settings = manager.getRepository(BotSettingEntity);
            const current = await settings.findOneBy({ key: marker(channel) });
            if (current?.value === turnId) return;
            await settings.upsert({ key: marker(channel), value: turnId }, ['key']);
            await manager.getRepository(DialogueJobEntity).update({ profile: getActiveBotProfile(), channel, status: In(CANCELLABLE) }, { status: 'superseded', lease: null });
        });
    },

    async stage(values: { channel: string; turnId: string; userId: number; chatId: number; messageId?: number; input: DialogueJobInput }): Promise<DialogueJob | undefined> {
        return AppDataSource.transaction(async manager => {
            await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [marker(values.channel)]);
            const current = await manager.getRepository(BotSettingEntity).findOneBy({ key: marker(values.channel) });
            if (current?.value !== values.turnId) return undefined;
            const repository = manager.getRepository(DialogueJobEntity);
            const old = await repository.findOneBy({ profile: getActiveBotProfile(), channel: values.channel, turnId: values.turnId });
            if (old) return normalize(old);
            return normalize(await repository.save({ ...values, id: randomUUID(), profile: getActiveBotProfile(),
                status: 'staged', phase: values.input.required ? 'deep' : 'review', attempts: 0, announced: values.input.required,
                expiresAt: new Date(Date.now() + DIALOGUE_JOB_TTL_MS) }));
        });
    },

    async activate(id: string, channel: string): Promise<void> {
        await repo().update({ id, profile: getActiveBotProfile(), channel, status: 'staged' }, { status: 'queued' });
    },

    async find(id: string, channel: string): Promise<DialogueJob | undefined> {
        const row = await repo().findOneBy({ id, profile: getActiveBotProfile(), channel });
        return row ? normalize(row) : undefined;
    },

    async list(channel: string): Promise<DialogueJob[]> {
        return (await repo().find({ where: { profile: getActiveBotProfile(), channel }, order: { createdAt: 'DESC' }, take: 20 })).map(normalize);
    },

    async cancel(channel: string, id?: string): Promise<boolean> {
        return AppDataSource.transaction(async manager => {
            await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [marker(channel)]);
            // Invalidate even an in-flight first response that has not staged its job yet.
            if (!id) await manager.getRepository(BotSettingEntity).upsert({ key: marker(channel), value: `cancel:${randomUUID()}` }, ['key']);
            return Boolean((await manager.getRepository(DialogueJobEntity).update({ profile: getActiveBotProfile(), channel, ...(id ? { id } : {}), status: In(CANCELLABLE) }, { status: 'cancelled', lease: null })).affected);
        });
    },

    async claim(limit: number): Promise<DialogueJob[]> {
        return AppDataSource.transaction(async manager => {
            const repository = manager.getRepository(DialogueJobEntity);
            const now = new Date();
            const stale = new Date(now.getTime() - DIALOGUE_JOB_LEASE_MS);
            const profile = getActiveBotProfile();
            // Sending has no transactional acknowledgement from Telegram. Never blindly resend after a crash.
            await repository.update({ profile, status: 'delivering', lockedAt: LessThan(stale) }, { status: 'unknown', lease: null, error: 'delivery_unknown' });
            await repository.createQueryBuilder().update().set({ status: 'failed', lease: null, error: 'expired' })
                .where('profile = :profile AND status IN (:...statuses) AND "expiresAt" <= :now', { profile, statuses: ACTIVE, now }).execute();
            await repository.createQueryBuilder().update().set({ status: 'failed', lease: null, error: 'attempts_exhausted' })
                .where('profile = :profile AND status = :status AND "lockedAt" < :stale AND attempts >= 2', { profile, status: 'running', stale }).execute();
            const rows = await repository.createQueryBuilder('job').setLock('pessimistic_write').setOnLocked('skip_locked')
                .where('job.profile = :profile', { profile })
                .andWhere('(job.status IN (:...ready) OR (job.status = :running AND job.lockedAt < :stale AND job.attempts < 2))', { ready: ['queued', 'ready'], running: 'running', stale })
                .andWhere('job.expiresAt > :now', { now }).orderBy('job.createdAt', 'ASC').take(limit).getMany();
            for (const row of rows) {
                row.lease = randomUUID(); row.lockedAt = now;
                if (row.status !== 'ready') { row.status = 'running'; row.attempts += 1; }
                else row.status = 'delivering';
                await repository.save(row);
            }
            return rows.map(normalize);
        });
    },

    async update(job: DialogueJob, patch: Partial<Pick<DialogueJob, 'status' | 'phase' | 'announced' | 'notice' | 'resultText' | 'error' | 'lockedAt' | 'input'>>): Promise<boolean> {
        if (!job.lease) return false;
        return Boolean((await repo().update({ id: job.id, profile: getActiveBotProfile(), channel: job.channel, lease: job.lease, status: In(['running', 'delivering']) }, patch)).affected);
    },

    async isActive(job: DialogueJob): Promise<boolean> {
        if (!job.lease) return false;
        return Boolean(await repo().countBy({ id: job.id, profile: getActiveBotProfile(), channel: job.channel, lease: job.lease, status: In(['running', 'delivering']) }));
    },

    async cleanup(): Promise<void> {
        await AppDataSource.transaction(async manager => {
            const repository = manager.getRepository(DialogueJobEntity);
            const old = await repository.find({ where: { profile: getActiveBotProfile(), updatedAt: LessThan(new Date(Date.now() - 7 * 24 * 60 * 60_000)), status: In(['completed', 'cancelled', 'superseded', 'failed', 'unknown']) }, take: 500 });
            if (!old.length) return;
            await manager.getRepository(SessionEntity).delete({ key: In(old.map(job => scopedBotKey(`dialogue:${job.id}`))) });
            await repository.delete({ id: In(old.map(job => job.id)), profile: getActiveBotProfile() });
        });
    },
};
