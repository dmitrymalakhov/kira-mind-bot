import type { DataSource, EntityManager } from 'typeorm';
import type { Workout, WorkoutScope } from '../../api/workouts/contracts';
import { stableId } from './domain';
import { ApiError } from '../../api/contracts';

export const WORKOUT_TABLES = ['workout_records', 'workout_devices', 'workout_commands', 'workout_plans', 'workout_health_state', 'workout_health_sources'] as const;
export type WorkoutTable = typeof WORKOUT_TABLES[number];
export interface ListOptions {
    limit?: number;
    from?: string;
    to?: string;
    cursor?: { at: string; id: string };
    filters?: Record<string, string | string[]>;
}
export interface Stored<T> { id: string; record: T; sortAt: string }
export interface WorkoutTransaction {
    get<T>(table: WorkoutTable, id: string): Promise<T | null>;
    put<T>(table: WorkoutTable, id: string, record: T, sortAt: string): Promise<void>;
    remove(table: WorkoutTable, id: string): Promise<void>;
    list<T>(table: WorkoutTable, options?: ListOptions): Promise<Array<Stored<T>>>;
    project(workout: Workout): Promise<void>;
    unproject(workoutId: string): Promise<void>;
    eraseReceipts(): Promise<void>;
}
export interface WorkoutStore {
    transaction<T>(scope: WorkoutScope, work: (tx: WorkoutTransaction) => Promise<T>): Promise<T>;
}
export interface Queryable { query(sql: string, parameters?: any[]): Promise<any> }

/** Additive, transaction-safe schema; called with operator privileges before starting a limited tenant worker. */
export async function ensureWorkoutSchema(db: Queryable): Promise<void> {
    await db.query("SELECT pg_advisory_xact_lock(hashtext('kira-workout-schema-v1'))");
    for (const table of WORKOUT_TABLES) {
        await db.query('CREATE TABLE IF NOT EXISTS ' + table + ' (profile text NOT NULL, owner_id bigint NOT NULL, id text NOT NULL, record jsonb NOT NULL, sort_at timestamptz NOT NULL, PRIMARY KEY(profile,owner_id,id))');
        await db.query('CREATE INDEX IF NOT EXISTS ' + table + '_scope_time ON ' + table + ' (profile,owner_id,sort_at DESC,id DESC)');
    }
    await db.query("CREATE INDEX IF NOT EXISTS workout_records_scope_state ON workout_records (profile,owner_id,(record->>'state'),sort_at DESC)");
    await db.query("CREATE INDEX IF NOT EXISTS workout_commands_scope_device ON workout_commands (profile,owner_id,(record->>'deviceId'),(record->>'status'),sort_at DESC)");
}

class PgTransaction implements WorkoutTransaction {
    constructor(private db: Queryable, private scope: WorkoutScope) {}
    private table(table: WorkoutTable): string {
        if (!WORKOUT_TABLES.includes(table)) throw new Error('Invalid workout table');
        return table;
    }
    async get<T>(table: WorkoutTable, id: string): Promise<T | null> {
        const rows = await this.db.query('SELECT record FROM ' + this.table(table) + ' WHERE profile=$1 AND owner_id=$2 AND id=$3', [this.scope.profile, this.scope.ownerId, id]);
        return rows[0]?.record ?? null;
    }
    async put<T>(table: WorkoutTable, id: string, record: T, sortAt: string): Promise<void> {
        await this.db.query('INSERT INTO ' + this.table(table) + ' (profile,owner_id,id,record,sort_at) VALUES($1,$2,$3,$4::jsonb,$5) ON CONFLICT(profile,owner_id,id) DO UPDATE SET record=excluded.record,sort_at=excluded.sort_at',
            [this.scope.profile, this.scope.ownerId, id, JSON.stringify(record), sortAt]);
    }
    async remove(table: WorkoutTable, id: string): Promise<void> {
        await this.db.query('DELETE FROM ' + this.table(table) + ' WHERE profile=$1 AND owner_id=$2 AND id=$3', [this.scope.profile, this.scope.ownerId, id]);
    }
    async list<T>(table: WorkoutTable, options: ListOptions = {}): Promise<Array<Stored<T>>> {
        const params: any[] = [this.scope.profile, this.scope.ownerId];
        const clauses = ['profile=$1', 'owner_id=$2'];
        const param = (value: unknown) => { params.push(value); return '$' + params.length; };
        if (options.from) clauses.push('sort_at>=' + param(options.from));
        if (options.to) clauses.push('sort_at<' + param(options.to));
        if (options.cursor) clauses.push('(sort_at,id)<(' + param(options.cursor.at) + '::timestamptz,' + param(options.cursor.id) + ')');
        for (const [key, value] of Object.entries(options.filters ?? {})) {
            const field = '(record->>' + param(key) + ')';
            clauses.push(Array.isArray(value) ? field + '=ANY(' + param(value) + '::text[])' : field + '=' + param(value));
        }
        const rows = await this.db.query('SELECT id,record,sort_at FROM ' + this.table(table) + ' WHERE ' + clauses.join(' AND ') + ' ORDER BY sort_at DESC,id DESC LIMIT ' + param(Math.min(options.limit ?? 100, 1001)), params);
        return rows.map((row: any) => ({ id: row.id, record: row.record, sortAt: new Date(row.sort_at).toISOString() }));
    }
    async project(workout: Workout): Promise<void> {
        if (workout.state !== 'finished') return;
        const id = stableId('workout-health:' + this.scope.profile + ':' + this.scope.ownerId + ':' + workout.id);
        const names: Record<string, string> = { running: 'Бег', walking: 'Ходьба', cycling: 'Велосипед', strength: 'Силовая тренировка', other: 'Тренировка' };
        const title = names[workout.activityType];
        await this.db.query('/* workout-private */ INSERT INTO health_logs (id,profile,"userId",kind,"rawText",summary,"occurredAt",structured,tags,"createdAt") VALUES($1,$2,$3,$4,$5,$5,$6,$7::jsonb,$8::jsonb,$9) ON CONFLICT(id) DO UPDATE SET summary=excluded.summary,"occurredAt"=excluded."occurredAt",structured=excluded.structured WHERE health_logs.profile=$2 AND health_logs."userId"=$3 AND health_logs.structured->>\'workoutId\'=$10 AND health_logs.structured->>\'source\'=\'workout_module\'',
            [id, this.scope.profile, this.scope.ownerId, 'activity', title, workout.startedAt ?? workout.updatedAt,
                JSON.stringify({ source: 'workout_module', workoutId: workout.id, activities: [title], metrics: workout.metrics }),
                JSON.stringify(['workout']), workout.updatedAt, workout.id]);
    }
    async unproject(workoutId: string): Promise<void> {
        const id = stableId('workout-health:' + this.scope.profile + ':' + this.scope.ownerId + ':' + workoutId);
        await this.db.query('/* workout-private */ DELETE FROM health_logs WHERE id=$1 AND profile=$2 AND "userId"=$3 AND structured->>\'workoutId\'=$4 AND structured->>\'source\'=\'workout_module\'',
            [id, this.scope.profile, this.scope.ownerId, workoutId]);
    }
    async eraseReceipts(): Promise<void> {
        const prefix = this.scope.profile + ':workouts:' + this.scope.ownerId + ':';
        await this.db.query('UPDATE api_operations SET result=$1::jsonb WHERE left(key,length($2))=$2 AND status=$3 AND result IS NOT NULL',
            [JSON.stringify({ workoutDataErased: true }), prefix, 'completed']);
    }
}
export class PgWorkoutStore implements WorkoutStore {
    constructor(private source: DataSource) {}
    transaction<T>(scope: WorkoutScope, work: (tx: WorkoutTransaction) => Promise<T>): Promise<T> {
        return this.source.transaction(async (manager: EntityManager) => {
            await manager.query("SELECT pg_advisory_xact_lock(hashtext($1))", ['workouts:' + scope.profile + ':' + scope.ownerId]);
            return work(new PgTransaction(manager, scope));
        }).catch(error => {
            if (error instanceof ApiError) throw error;
            throw new ApiError(503, 'workout_storage_unavailable', 'Хранилище тренировок временно недоступно.');
        });
    }
}
