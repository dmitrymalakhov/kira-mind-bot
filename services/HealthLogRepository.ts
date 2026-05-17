import { Between } from 'typeorm';
import { AppDataSource } from '../data-source';
import { HealthLogEntity } from '../entity/HealthLogEntity';

export type HealthLogKind = 'food' | 'drink' | 'symptom' | 'medication' | 'activity' | 'skin' | 'blood_pressure' | 'note';
export type HealthTimeOfDay = 'утро' | 'день' | 'вечер' | 'ночь';

export interface HealthLogRecord {
    id: string;
    userId: number;
    chatId?: number;
    kind: HealthLogKind;
    rawText: string;
    summary?: string;
    severity?: number;
    occurredAt: Date;
    timeOfDay?: HealthTimeOfDay;
    structured?: Record<string, unknown>;
    tags?: string[];
    photoFileId?: string;
    createdAt: Date;
}

function repo() {
    return AppDataSource.getRepository(HealthLogEntity);
}

function toEntity(record: HealthLogRecord): HealthLogEntity {
    const entity = new HealthLogEntity();
    entity.id = record.id;
    entity.userId = record.userId;
    entity.chatId = record.chatId;
    entity.kind = record.kind;
    entity.rawText = record.rawText;
    entity.summary = record.summary;
    entity.severity = record.severity;
    entity.occurredAt = new Date(record.occurredAt);
    entity.timeOfDay = record.timeOfDay;
    entity.structured = record.structured;
    entity.tags = record.tags;
    entity.photoFileId = record.photoFileId;
    entity.createdAt = new Date(record.createdAt);
    return entity;
}

function fromEntity(entity: HealthLogEntity): HealthLogRecord {
    return {
        id: entity.id,
        userId: Number(entity.userId),
        chatId: entity.chatId == null ? undefined : Number(entity.chatId),
        kind: entity.kind as HealthLogKind,
        rawText: entity.rawText,
        summary: entity.summary ?? undefined,
        severity: entity.severity ?? undefined,
        occurredAt: new Date(entity.occurredAt),
        timeOfDay: entity.timeOfDay as HealthTimeOfDay | undefined,
        structured: entity.structured ?? undefined,
        tags: Array.isArray(entity.tags) ? entity.tags : undefined,
        photoFileId: entity.photoFileId ?? undefined,
        createdAt: new Date(entity.createdAt),
    };
}

export const HealthLogRepository = {
    async save(record: HealthLogRecord): Promise<HealthLogRecord> {
        const saved = await repo().save(toEntity(record));
        return fromEntity(saved);
    },

    async findById(id: string): Promise<HealthLogRecord | null> {
        const entity = await repo().findOne({ where: { id } });
        return entity ? fromEntity(entity) : null;
    },

    async update(record: HealthLogRecord): Promise<HealthLogRecord> {
        const saved = await repo().save(toEntity(record));
        return fromEntity(saved);
    },

    async findRecent(userId: number, limit = 10): Promise<HealthLogRecord[]> {
        const entities = await repo().find({
            where: { userId },
            order: { occurredAt: 'DESC' },
            take: limit,
        });
        return entities.map(fromEntity);
    },

    async findByPeriod(userId: number, from: Date, to: Date): Promise<HealthLogRecord[]> {
        const entities = await repo().find({
            where: {
                userId,
                occurredAt: Between(from, to),
            },
            order: { occurredAt: 'ASC' },
        });
        return entities.map(fromEntity);
    },
};
