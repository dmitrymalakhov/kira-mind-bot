import { randomUUID } from 'node:crypto';
import type { Workout, WorkoutEvent, WorkoutScope } from '../../api/workouts/contracts';
import { WorkoutService } from '../../services/workouts/service';
import type { Stored, WorkoutStore, WorkoutTable, WorkoutTransaction } from '../../services/workouts/store';

/** Transactional test double; rollback and scope boundaries are observable, not mocked model decisions. */
export class MemoryWorkoutStore implements WorkoutStore {
    private data = new Map<string, Map<WorkoutTable, Map<string, Stored<any>>>>();
    readonly diary = new Map<string, Map<string, Workout>>();
    private lane: Promise<unknown> = Promise.resolve();
    transaction<T>(scope: WorkoutScope, work: (tx: WorkoutTransaction) => Promise<T>): Promise<T> {
        const task = this.lane.then(async () => {
            const key = scope.profile + ':' + scope.ownerId;
            const tables = structuredClone(this.data.get(key) ?? new Map());
            const diary = structuredClone(this.diary.get(key) ?? new Map());
            const table = (name: WorkoutTable) => { if (!tables.has(name)) tables.set(name, new Map()); return tables.get(name)!; };
            const tx: WorkoutTransaction = {
                get: async (name, id) => structuredClone(table(name).get(id)?.record ?? null),
                put: async (name, id, record, sortAt) => { table(name).set(id, structuredClone({ id, record, sortAt })); },
                remove: async (name, id) => { table(name).delete(id); },
                list: async (name, options = {}) => [...table(name).values()]
                    .filter(row => (!options.from || row.sortAt >= options.from) && (!options.to || row.sortAt < options.to))
                    .filter(row => !options.cursor || row.sortAt < options.cursor.at || row.sortAt === options.cursor.at && row.id < options.cursor.id)
                    .filter(row => Object.entries(options.filters ?? {}).every(([key, value]) => Array.isArray(value) ? value.includes(String(row.record[key])) : String(row.record[key]) === value))
                    .sort((a, b) => b.sortAt.localeCompare(a.sortAt) || b.id.localeCompare(a.id)).slice(0, options.limit ?? 100).map(row => structuredClone(row)),
                project: async w => { if (w.state === 'finished') diary.set(w.id, structuredClone(w)); },
                unproject: async id => { diary.delete(id); },
                eraseReceipts: async () => {},
            };
            const result = await work(tx);
            this.data.set(key, tables); this.diary.set(key, diary);
            return result;
        });
        this.lane = task.catch(() => {});
        return task;
    }
}
export const scope = { profile: 'SyntheticWorkouts', ownerId: 739501 };
export function fixture(store = new MemoryWorkoutStore(), owner = scope) {
    let clock = new Date('2030-04-02T12:00:00.000Z');
    const service = new WorkoutService(store, owner, () => clock);
    return { store, service, advance: (ms: number) => { clock = new Date(clock.getTime() + ms); } };
}
export async function registered(service: WorkoutService) { return (await service.registerDevice({ installationId: randomUUID(), platform: 'ios' })).device; }
export function evt(seq: number, type: WorkoutEvent['type'], elapsedMs: number, data: Record<string, unknown> = {}, commandId?: string): WorkoutEvent {
    return { eventId: randomUUID(), seq, type, elapsedMs, occurredAt: new Date(Date.parse('2030-04-02T12:00:00Z') + elapsedMs).toISOString(), data, ...(commandId ? { commandId } : {}) };
}
export function syncInput(d: { id: string; bindingId: string }, events: WorkoutEvent[] = [evt(1, 'started', 0)]) {
    return { deviceId: d.id, bindingId: d.bindingId, workoutId: randomUUID(), recordingId: randomUUID(),
        activityType: 'running', location: 'outdoor', mode: 'manual', timeZone: 'Europe/Amsterdam', events };
}
