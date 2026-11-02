import { randomUUID } from 'node:crypto';
import { EMPTY_METRICS, HealthChange, HealthSyncState, Workout, WorkoutDevice, HealthSyncStatusResponse } from '../../api/workouts/contracts';
import { activity, canonical, choice, date, digest, fail, measuredMetrics, number, object, rebuild, stableId, text, timeZone, uuid } from './domain';
import type { Stored, WorkoutTransaction } from './store';

interface SourceItem {
    sourceKey: string;
    kind: 'workout' | 'daily_steps';
    deleted: boolean;
    data: Record<string, any>;
    workoutId?: string;
    own?: boolean;
    updatedAt: string;
    localDate?: string;
    timeZone?: string;
}
const emptyState = (): HealthSyncState => ({ enabled: false, consentVersion: 1, generation: '00000000-0000-0000-0000-000000000000', deviceId: null, bindingId: null, lastSeq: 0, lastSyncedAt: null });
async function boundDevice(tx: WorkoutTransaction, id: string, bindingId: string): Promise<WorkoutDevice> {
    const d = await tx.get<WorkoutDevice>('workout_devices', id);
    if (!d) fail('not_found', 'Устройство не найдено.', 404);
    if (!d.enabled || d.bindingId !== bindingId) fail('device_binding_conflict', 'Подключение устройства отозвано.', 409);
    return d;
}
export async function requireHealthConsent(tx: WorkoutTransaction, id: string, bindingId: string, generation?: string): Promise<HealthSyncState> {
    const state = await tx.get<HealthSyncState>('workout_health_state', 'state') ?? emptyState();
    if (!state.enabled) fail('consent_required', 'Нужно согласие на передачу Apple Health в Киру.', 409);
    if (state.deviceId !== id || state.bindingId !== bindingId || state.generation !== generation) fail('sync_generation_conflict', 'Подключение Apple Health изменилось.', 409);
    return state;
}
export async function healthStatus(tx: WorkoutTransaction): Promise<HealthSyncStatusResponse> {
    const state = await tx.get<HealthSyncState>('workout_health_state', 'state') ?? emptyState();
    const rows = await tx.list<SourceItem>('workout_health_sources', { filters: { kind: 'daily_steps', deleted: 'false' }, limit: 100 });
    return { sync: state, dailySteps: rows.map(({ record: r }) => ({ localDate: r.data.localDate, timeZone: r.data.timeZone,
        intervalStart: r.data.intervalStart, intervalEnd: r.data.intervalEnd, steps: r.data.steps, updatedAt: r.updatedAt })) };
}
export async function healthConsent(tx: WorkoutTransaction, value: unknown, now: string) {
    const v = object(value, ['enabled', 'consentVersion', 'deviceId', 'bindingId']);
    if (typeof v.enabled !== 'boolean' || v.consentVersion !== 1) fail('invalid_workout', 'Нужно явное согласие версии 1.');
    const deviceId = uuid(v.deviceId), bindingId = uuid(v.bindingId);
    const old = await tx.get<HealthSyncState>('workout_health_state', 'state') ?? emptyState();
    if (v.enabled) {
        const d = await boundDevice(tx, deviceId, bindingId);
        if (d.platform !== 'ios') fail('invalid_workout', 'Обмен Apple Health выполняет iPhone.');
        if (old.enabled && old.deviceId === deviceId && old.bindingId === bindingId) return { sync: old };
    }
    const state: HealthSyncState = { enabled: v.enabled, consentVersion: 1, generation: randomUUID(),
        deviceId: v.enabled ? deviceId : null, bindingId: v.enabled ? bindingId : null, lastSeq: 0, lastSyncedAt: old.lastSyncedAt };
    await tx.put('workout_health_state', 'state', state, now);
    return { sync: state };
}
function parseChange(value: unknown): HealthChange {
    const v = object(value, ['changeId', 'seq', 'sourceKey', 'type'], ['data']);
    const type = choice(v.type, ['workout_upsert', 'workout_delete', 'daily_steps_upsert', 'daily_steps_delete'] as const);
    if (type.endsWith('_delete') && v.data !== undefined) object(v.data, []);
    if (type.endsWith('_upsert') && v.data === undefined) fail('invalid_workout', 'Нужны данные источника.');
    return { changeId: uuid(v.changeId), seq: number(v.seq, 1, Number.MAX_SAFE_INTEGER, true), sourceKey: text(v.sourceKey, 300), type, ...(v.data === undefined ? {} : { data: v.data }) };
}
export async function healthBatch(tx: WorkoutTransaction, value: unknown, now: string) {
    const v = object(value, ['deviceId', 'bindingId', 'generation', 'changes']);
    const deviceId = uuid(v.deviceId), bindingId = uuid(v.bindingId), generation = uuid(v.generation);
    await boundDevice(tx, deviceId, bindingId);
    const state = await requireHealthConsent(tx, deviceId, bindingId, generation);
    if (!Array.isArray(v.changes) || v.changes.length > 100) fail('invalid_workout', 'Передай до 100 изменений.');
    const changes = v.changes.map(parseChange);
    for (const change of changes) {
        const receiptId = 'change:' + generation + ':' + change.seq;
        const fingerprint = digest(change);
        if (change.seq <= state.lastSeq) {
            const receipt = await tx.get<{ changeId: string; fingerprint: string }>('workout_health_sources', receiptId);
            if (!receipt || receipt.changeId !== change.changeId || receipt.fingerprint !== fingerprint) fail('sync_sequence_conflict', 'Конфликт ранее принятого изменения.', 409);
            continue;
        }
        if (change.seq !== state.lastSeq + 1) fail('sync_sequence_conflict', 'Нарушена последовательность синхронизации.', 409);
        const key = stableId('source:' + change.sourceKey);
        const old = await tx.get<SourceItem>('workout_health_sources', key);
        if (old && old.sourceKey !== change.sourceKey) fail('source_identity_conflict', 'Конфликт идентификатора источника.', 409);
        if (change.type === 'workout_upsert') await upsertWorkout(tx, key, old, change, now);
        else if (change.type === 'daily_steps_upsert') await upsertSteps(tx, key, old, change, now);
        else {
            const kind = change.type === 'workout_delete' ? 'workout' : 'daily_steps';
            if (old && old.kind !== kind) fail('source_identity_conflict', 'Тип источника изменился.', 409);
            if (old?.workoutId) {
                const workout = await tx.get<Workout>('workout_records', old.workoutId);
                if (workout && old.own) {
                    if (workout.source.healthKitId === old.data.healthKitId) {
                        delete workout.source.healthKitId; workout.healthKitSave = 'not_requested'; workout.updatedAt = now; workout.revision++;
                        await tx.put('workout_records', workout.id, workout, workout.startedAt ?? now);
                    }
                } else if (workout?.source.kind === 'apple_health' && workout.source.sourceKey === change.sourceKey) {
                    await tx.remove('workout_records', workout.id); await tx.unproject(workout.id);
                }
            }
            await tx.put('workout_health_sources', key, { sourceKey: change.sourceKey, kind, deleted: true, data: {}, updatedAt: now } satisfies SourceItem, now);
        }
        await tx.put('workout_health_sources', receiptId, { kind: 'receipt', changeId: change.changeId, fingerprint }, now);
        state.lastSeq = change.seq;
    }
    state.lastSyncedAt = now;
    await tx.put('workout_health_state', 'state', state, now);
    return { sync: state, accepted: changes.length };
}
async function upsertWorkout(tx: WorkoutTransaction, key: string, old: SourceItem | null, change: HealthChange, now: string) {
    if (old && old.kind !== 'workout') fail('source_identity_conflict', 'Тип источника изменился.', 409);
    const d = object(change.data, ['healthKitId', 'sourceBundleId', 'activityType', 'location', 'startedAt', 'endedAt', 'timeZone', 'metrics'], ['syncIdentifier', 'syncVersion', 'kiraWorkoutId']);
    const healthKitId = uuid(d.healthKitId), sourceBundleId = text(d.sourceBundleId, 255);
    const startedAt = date(d.startedAt), endedAt = date(d.endedAt), zone = timeZone(d.timeZone);
    if (endedAt < startedAt) fail('invalid_workout', 'Окончание тренировки раньше начала.');
    const activityType = activity(d.activityType), location = choice(d.location, ['indoor', 'outdoor', 'unspecified'] as const);
    const metrics = { ...EMPTY_METRICS, ...measuredMetrics(d.metrics, true) };
    metrics.totalDurationMs = Date.parse(endedAt) - Date.parse(startedAt);
    if (metrics.activeDurationMs !== null && metrics.activeDurationMs > metrics.totalDurationMs) fail('invalid_workout', 'Активное время превышает общее.');
    metrics.pausedDurationMs = metrics.activeDurationMs === null ? null : metrics.totalDurationMs - metrics.activeDurationMs;
    metrics.meanPaceSecPerKm = ['running', 'walking'].includes(activityType) && metrics.distanceM !== null && metrics.distanceM > 0 && metrics.activeDurationMs !== null ? metrics.activeDurationMs / metrics.distanceM : null;
    const syncIdentifier = d.syncIdentifier === undefined ? undefined : text(d.syncIdentifier, 300);
    const syncVersion = d.syncVersion === undefined ? undefined : number(d.syncVersion, 0, Number.MAX_SAFE_INTEGER, true);
    if ((syncIdentifier === undefined) !== (syncVersion === undefined)) fail('invalid_workout', 'SyncIdentifier и syncVersion передаются вместе.');
    if (old && !old.deleted && old.data.syncIdentifier === syncIdentifier && typeof old.data.syncVersion === 'number' && syncVersion !== undefined) {
        if (syncVersion < old.data.syncVersion) fail('source_version_conflict', 'Версия источника устарела.', 409);
    }
    let workout: Workout;
    const own = d.kiraWorkoutId !== undefined;
    if (own) {
        const existing = await tx.get<Workout>('workout_records', uuid(d.kiraWorkoutId));
        if (!existing || existing.source.kind !== 'kira' || existing.source.healthKitId !== healthKitId) fail('source_identity_conflict', 'Экспорт Киры не подтверждён для этого аккаунта.', 409);
        workout = existing;
    } else {
        const id = stableId('healthkit:' + healthKitId);
        const existing = await tx.get<Workout>('workout_records', id);
        if (existing && (existing.source.kind !== 'apple_health' || existing.source.sourceKey !== change.sourceKey || existing.source.sourceBundleId !== sourceBundleId)) fail('source_identity_conflict', 'Изменился источник тренировки.', 409);
        workout = { id, activityType, location, mode: 'imported', state: 'finished', recorderDeviceId: null, recorderBindingId: null,
            recordingId: id, seq: 0, revision: (existing?.revision ?? 0) + 1, startedAt, endedAt, timeZone: zone, events: [], sets: [], notes: [],
            metrics, source: { kind: 'apple_health', healthKitId, sourceBundleId, sourceKey: change.sourceKey,
                ...(syncIdentifier === undefined ? {} : { syncIdentifier, syncVersion }) }, healthKitSave: 'saved', updatedAt: now };
        await tx.put('workout_records', id, workout, startedAt); await tx.project(workout);
    }
    await tx.put('workout_health_sources', key, { sourceKey: change.sourceKey, kind: 'workout', deleted: false, data: d,
        workoutId: workout.id, own, updatedAt: now } satisfies SourceItem, startedAt);
}
async function upsertSteps(tx: WorkoutTransaction, key: string, old: SourceItem | null, change: HealthChange, now: string) {
    if (old && old.kind !== 'daily_steps') fail('source_identity_conflict', 'Тип источника изменился.', 409);
    const d = object(change.data, ['localDate', 'timeZone', 'intervalStart', 'intervalEnd', 'steps']);
    const zone = timeZone(d.timeZone), start = date(d.intervalStart), end = date(d.intervalEnd);
    if (typeof d.localDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d.localDate) || end <= start || Date.parse(end) - Date.parse(start) > 26 * 3600000) fail('invalid_workout', 'Некорректный дневной интервал.');
    const startLocal = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(start));
    if (startLocal !== d.localDate) fail('invalid_workout', 'Дата не соответствует часовому поясу.');
    const data = { localDate: d.localDate, timeZone: zone, intervalStart: start, intervalEnd: end, steps: d.steps === null ? null : number(d.steps, 0, 10000000, true) };
    if (old && !old.deleted && ['localDate', 'timeZone', 'intervalStart', 'intervalEnd'].some(k => old.data[k] !== data[k as keyof typeof data])) fail('source_identity_conflict', 'Дневной источник должен сохранять свой интервал.', 409);
    const duplicates = await tx.list<SourceItem>('workout_health_sources', { filters: { kind: 'daily_steps', deleted: 'false', localDate: data.localDate, timeZone: zone }, limit: 2 });
    if (duplicates.some(row => row.id !== key && row.record.data.localDate === data.localDate && row.record.data.timeZone === data.timeZone)) fail('source_identity_conflict', 'Для этого дня уже есть объединённый источник.', 409);
    await tx.put('workout_health_sources', key, { sourceKey: change.sourceKey, kind: 'daily_steps', deleted: false, data, localDate: data.localDate, timeZone: zone, updatedAt: now } satisfies SourceItem, start);
}
export async function healthErase(tx: WorkoutTransaction, now: string) {
    const state: HealthSyncState = { ...emptyState(), generation: randomUUID() };
    await tx.put('workout_health_state', 'state', state, now);
    let cursor: { at: string; id: string } | undefined, deleted = 0;
    for (;;) {
        const rows = await tx.list<any>('workout_health_sources', { limit: 1000, cursor });
        for (const row of rows) { await tx.remove('workout_health_sources', row.id); if (row.record.kind !== 'receipt') deleted++; }
        if (rows.length < 1000) break;
        const last = rows[rows.length - 1]; cursor = { at: last.sortAt, id: last.id };
    }
    cursor = undefined;
    for (;;) {
        const rows: Array<Stored<Workout>> = await tx.list<Workout>('workout_records', { limit: 1000, cursor });
        for (const { record: w } of rows) {
            if (w.source.kind === 'apple_health') { await tx.remove('workout_records', w.id); await tx.unproject(w.id); }
            else if (w.mode === 'healthkit' || w.source.healthKitId) {
                if (w.mode === 'healthkit') w.events = w.events.map(e => e.type === 'metrics_updated' ? { ...e, data: { metrics: {} } } : e);
                w.source = { kind: 'kira' }; w.healthKitSave = 'not_requested'; rebuild(w); w.revision++; w.updatedAt = now;
                await tx.put('workout_records', w.id, w, w.startedAt ?? now); await tx.project(w);
            }
        }
        if (rows.length < 1000) break;
        const last: Stored<Workout> = rows[rows.length - 1]; cursor = { at: last.sortAt, id: last.id };
    }
    await tx.eraseReceipts();
    return { sync: state, deletedSources: deleted };
}
