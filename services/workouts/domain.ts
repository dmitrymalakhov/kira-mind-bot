import { createHash } from 'node:crypto';
import { ApiError } from '../../api/contracts';
import { ActivityType, EMPTY_METRICS, Workout, WorkoutAnalysis, WorkoutEvent, WorkoutMetrics, WorkoutSet, WorkoutSyncInput } from '../../api/workouts/contracts';

export function fail(code: string, message: string, status = 400): never { throw new ApiError(status, code, message); }
export function object(value: unknown, required: string[], optional: string[] = []): Record<string, any> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid_workout', 'Ожидается объект.');
    const v = value as Record<string, any>;
    if (required.some(key => !Object.prototype.hasOwnProperty.call(v, key)) || Object.keys(v).some(key => !required.includes(key) && !optional.includes(key))) {
        fail('invalid_workout', 'Некорректные поля запроса.');
    }
    return v;
}
export function uuid(value: unknown): string {
    if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) fail('invalid_workout', 'Нужен UUID.');
    return value;
}
export function text(value: unknown, max = 4000): string {
    if (typeof value !== 'string' || !value.trim() || value.length > max) fail('invalid_workout', 'Некорректный текст.');
    return value.trim();
}
export function number(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER, integer = false): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || integer && !Number.isSafeInteger(value)) fail('invalid_workout', 'Некорректное число.');
    return value;
}
export function choice<T extends string>(value: unknown, choices: readonly T[]): T {
    if (typeof value !== 'string' || !choices.includes(value as T)) fail('invalid_workout', 'Недопустимое значение.');
    return value as T;
}
export function date(value: unknown): string {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) fail('invalid_workout', 'Нужна дата RFC3339 UTC.');
    const canonical = new Date(value).toISOString();
    if (canonical.replace('.000Z', 'Z') !== value && canonical !== value) fail('invalid_workout', 'Некорректная дата.');
    return canonical;
}
export function timeZone(value: unknown): string {
    const zone = text(value, 100);
    try { new Intl.DateTimeFormat('en', { timeZone: zone }); } catch { fail('invalid_workout', 'Нужен часовой пояс IANA.'); }
    return zone;
}
export function canonical(value: any): string {
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
    return JSON.stringify(value);
}
export function digest(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
export function stableId(value: string): string {
    const h = createHash('sha256').update(value).digest('hex');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-5' + h.slice(13, 16) + '-a' + h.slice(17, 20) + '-' + h.slice(20, 32);
}
export function activity(value: unknown): ActivityType { return choice(value, ['running', 'walking', 'cycling', 'strength', 'other']); }
export function set(value: unknown): WorkoutSet {
    const v = object(value, ['id', 'exercise', 'repetitions', 'weightKg']);
    return { id: uuid(v.id), exercise: text(v.exercise, 200), repetitions: number(v.repetitions, 1, 10000, true), weightKg: v.weightKg === null ? null : number(v.weightKg, 0, 10000) };
}
export function measuredMetrics(value: unknown, imported = false): Partial<WorkoutMetrics> {
    const keys = ['distanceM', 'meanHeartRateBpm', 'maxHeartRateBpm', 'activeEnergyKcal'];
    if (imported) keys.push('activeDurationMs');
    const v = object(value, [], keys);
    const result: Record<string, number | null> = {};
    for (const key of Object.keys(v)) {
        result[key] = v[key] === null ? null : number(v[key], key.includes('HeartRate') ? 1 : 0, key.includes('HeartRate') ? 1000 : Number.MAX_SAFE_INTEGER);
    }
    if (typeof result.meanHeartRateBpm === 'number' && typeof result.maxHeartRateBpm === 'number' && result.meanHeartRateBpm > result.maxHeartRateBpm) fail('invalid_workout', 'Средний пульс превышает максимальный.');
    return result;
}
export function event(value: unknown): WorkoutEvent {
    const v = object(value, ['eventId', 'seq', 'type', 'occurredAt', 'elapsedMs'], ['commandId', 'data']);
    const type = choice(v.type, ['started', 'paused', 'resumed', 'finished', 'cancelled', 'set_upserted', 'set_deleted', 'rest_started', 'note_added', 'metrics_updated'] as const);
    const d = v.data ?? {};
    let data: Record<string, unknown> = {};
    if (type === 'set_upserted') { object(d, ['set']); data = { set: set(d.set) }; }
    else if (type === 'set_deleted') { object(d, ['setId']); data = { setId: uuid(d.setId) }; }
    else if (type === 'rest_started') { object(d, ['durationMs']); data = { durationMs: number(d.durationMs, 1000, 86400000, true) }; }
    else if (type === 'note_added') { object(d, ['text']); data = { text: text(d.text) }; }
    else if (type === 'metrics_updated') { object(d, ['metrics']); data = { metrics: measuredMetrics(d.metrics) }; }
    else object(d, []);
    return { eventId: uuid(v.eventId), seq: number(v.seq, 1, 100000, true), type, occurredAt: date(v.occurredAt),
        elapsedMs: number(v.elapsedMs, 0, 365 * 86400000, true), ...(v.commandId ? { commandId: uuid(v.commandId) } : {}), data };
}
export function parseSync(value: unknown): WorkoutSyncInput {
    const v = object(value, ['deviceId', 'bindingId', 'workoutId', 'recordingId', 'activityType', 'location', 'mode', 'timeZone', 'events'], ['healthKitSave', 'healthKitId', 'healthSyncGeneration', 'previousBindingId', 'expectedSeq']);
    if ((v.previousBindingId === undefined) !== (v.expectedSeq === undefined)) fail('invalid_workout', 'Для восстановления нужны previousBindingId и expectedSeq.');
    if (!Array.isArray(v.events) || v.events.length > 100) fail('invalid_workout', 'Передай не более 100 событий.');
    return {
        deviceId: uuid(v.deviceId), bindingId: uuid(v.bindingId), workoutId: uuid(v.workoutId), recordingId: uuid(v.recordingId),
        activityType: activity(v.activityType), location: choice(v.location, ['indoor', 'outdoor', 'unspecified']),
        mode: choice(v.mode, ['manual', 'healthkit']), timeZone: timeZone(v.timeZone), events: v.events.map(event),
        ...(v.healthKitSave === undefined ? {} : { healthKitSave: choice(v.healthKitSave, ['not_requested', 'pending', 'saved', 'failed'] as const) }),
        ...(v.healthKitId === undefined ? {} : { healthKitId: uuid(v.healthKitId) }),
        ...(v.healthSyncGeneration === undefined ? {} : { healthSyncGeneration: uuid(v.healthSyncGeneration) }),
        ...(v.previousBindingId === undefined ? {} : { previousBindingId: uuid(v.previousBindingId), expectedSeq: number(v.expectedSeq, 0, 100000, true) }),
    };
}
export function newWorkout(input: WorkoutSyncInput, now: string): Workout {
    return { id: input.workoutId, activityType: input.activityType, location: input.location, mode: input.mode,
        state: 'requested', recorderDeviceId: input.deviceId, recorderBindingId: input.bindingId, recordingId: input.recordingId,
        seq: 0, revision: 0, startedAt: null, endedAt: null, timeZone: input.timeZone, events: [], sets: [], notes: [],
        metrics: { ...EMPTY_METRICS }, source: { kind: 'kira' }, healthKitSave: 'not_requested', updatedAt: now };
}
export function applyEvents(previous: Workout | null, input: WorkoutSyncInput, now: string): Workout {
    const w: Workout = structuredClone(previous ?? newWorkout(input, now));
    if (w.mode === 'imported' || w.recordingId !== input.recordingId || w.recorderDeviceId !== input.deviceId || w.recorderBindingId !== input.bindingId ||
        w.activityType !== input.activityType || w.location !== input.location || w.timeZone !== input.timeZone || w.mode !== input.mode) {
        fail('workout_conflict', 'Параметры или исполнитель тренировки изменились.', 409);
    }
    for (const e of input.events) {
        const existing = w.events.find(item => item.seq === e.seq || item.eventId === e.eventId);
        if (existing) {
            if (canonical(existing) !== canonical(e)) fail('event_conflict', 'Конфликт сохранённого события.', 409);
            continue;
        }
        if (e.seq !== w.seq + 1 || e.elapsedMs < (w.events.at(-1)?.elapsedMs ?? 0)) fail('event_conflict', 'Нарушена последовательность событий.', 409);
        const terminal = w.state === 'finished' || w.state === 'cancelled';
        if (terminal && !['note_added', 'metrics_updated', 'set_upserted', 'set_deleted'].includes(e.type)) fail('workout_conflict', 'Тренировка уже завершена.', 409);
        if (e.type === 'started') {
            if (w.state !== 'requested' || e.elapsedMs !== 0) fail('workout_conflict', 'Тренировка уже начата.', 409);
            w.state = 'running'; w.startedAt = e.occurredAt;
        } else if (e.type === 'paused') {
            if (w.state !== 'running') fail('workout_conflict', 'Тренировка сейчас не выполняется.', 409);
            w.state = 'paused';
        } else if (e.type === 'resumed') {
            if (w.state !== 'paused') fail('workout_conflict', 'Тренировка не на паузе.', 409);
            w.state = 'running';
        } else if (e.type === 'finished') {
            if (!['running', 'paused'].includes(w.state)) fail('workout_conflict', 'Нет выполняемой тренировки.', 409);
            w.state = 'finished'; w.endedAt = e.occurredAt;
        } else if (e.type === 'cancelled') { w.state = 'cancelled'; w.endedAt = e.occurredAt; }
        else if (w.state === 'requested') fail('workout_conflict', 'Сначала начни тренировку.', 409);
        w.events.push(e); w.seq = e.seq; w.revision++;
    }
    if (w.events.length > 10000) fail('invalid_workout', 'Превышен лимит событий тренировки.');
    if (input.healthKitSave !== undefined) w.healthKitSave = input.healthKitSave;
    if (input.healthKitId !== undefined) w.source.healthKitId = input.healthKitId;
    rebuild(w);
    if (w.metrics.meanHeartRateBpm !== null && w.metrics.maxHeartRateBpm !== null && w.metrics.meanHeartRateBpm > w.metrics.maxHeartRateBpm) fail('invalid_workout', 'Средний пульс превышает максимальный.');
    w.updatedAt = now;
    return w;
}
export function rebuild(w: Workout): void {
    let active = 0, segment: number | null = null, durationKnown = false, terminalElapsed: number | null = null;
    const sets = new Map<string, WorkoutSet>(), notes: string[] = [];
    const metrics = { ...EMPTY_METRICS };
    for (const e of w.events) {
        if (e.type === 'started' || e.type === 'resumed') { segment = e.elapsedMs; durationKnown = true; }
        else if (['paused', 'finished', 'cancelled'].includes(e.type)) {
            if (segment !== null) active += e.elapsedMs - segment;
            segment = null;
            if (e.type !== 'paused') terminalElapsed = e.elapsedMs;
        }
        else if (e.type === 'set_upserted') { const s = (e.data as any).set as WorkoutSet; sets.set(s.id, s); }
        else if (e.type === 'set_deleted') sets.delete(String(e.data?.setId));
        else if (e.type === 'note_added') notes.push(String(e.data?.text));
        else if (e.type === 'metrics_updated') Object.assign(metrics, e.data?.metrics);
    }
    if (segment !== null) active += (w.events.at(-1)?.elapsedMs ?? segment) - segment;
    metrics.activeDurationMs = durationKnown ? active : null;
    metrics.totalDurationMs = durationKnown ? terminalElapsed ?? w.events.at(-1)!.elapsedMs : null;
    metrics.pausedDurationMs = durationKnown ? metrics.totalDurationMs! - active : null;
    w.sets = [...sets.values()]; w.notes = notes;
    metrics.completedSets = w.sets.length;
    const known = w.sets.filter(s => s.weightKg !== null);
    metrics.strengthVolumeKg = known.length && known.length === w.sets.length ? known.reduce((sum, s) => sum + s.repetitions * s.weightKg!, 0) : null;
    metrics.meanPaceSecPerKm = ['running', 'walking'].includes(w.activityType) && metrics.distanceM !== null && metrics.distanceM > 0 && metrics.activeDurationMs !== null
        ? metrics.activeDurationMs / metrics.distanceM : null;
    w.metrics = metrics;
}
export function summary(w: Workout): Omit<Workout, 'events' | 'notes' | 'sets'> { const { events, notes, sets, ...rest } = w; return rest; }
export function analyze(workouts: Workout[]): WorkoutAnalysis {
    const groups = new Map<string, Workout[]>();
    for (const w of workouts.filter(w => w.state === 'finished')) {
        const key = w.activityType + ':' + w.location;
        groups.set(key, [...(groups.get(key) ?? []), w]);
    }
    return { groups: [...groups].map(([group, rows]) => ({ group, count: rows.length, workouts: rows.map(summary),
        totals: { activeDurationMs: total(rows.map(w => w.metrics.activeDurationMs)), distanceM: total(rows.map(w => w.metrics.distanceM)),
            strengthVolumeKg: total(rows.map(w => w.metrics.strengthVolumeKg)) } })) };
}
function total(values: Array<number | null>): { value: number | null; measured: number; missing: number } {
    const measured = values.filter((value): value is number => value !== null);
    return { value: measured.length ? measured.reduce((a, b) => a + b, 0) : null, measured: measured.length, missing: values.length - measured.length };
}
