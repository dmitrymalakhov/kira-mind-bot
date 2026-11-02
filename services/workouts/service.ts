import { randomUUID } from 'node:crypto';
import type { Workout, WorkoutCommand, WorkoutDevice, WorkoutPlan, WorkoutScope } from '../../api/workouts/contracts';
import { activity, analyze, applyEvents, canonical, choice, date, fail, newWorkout, number, object, parseSync, set, summary, text, timeZone, uuid } from './domain';
import type { ListOptions, WorkoutStore, WorkoutTransaction } from './store';
import { healthBatch, healthConsent, healthErase, healthStatus, requireHealthConsent } from './sync';

const TERMINAL = ['finished', 'cancelled'];
export async function device(tx: WorkoutTransaction, id: string, bindingId: string): Promise<WorkoutDevice> {
    const d = await tx.get<WorkoutDevice>('workout_devices', id);
    if (!d) fail('not_found', 'Устройство не найдено.', 404);
    if (!d.enabled || d.bindingId !== bindingId) fail('device_binding_conflict', 'Подключение устройства отозвано.', 409);
    return d;
}
export function effectiveCommand(c: WorkoutCommand, now: string): WorkoutCommand {
    if (['queued', 'claimed'].includes(c.status) && c.expiresAt <= now) return { ...c, status: c.status === 'claimed' ? 'unknown' : 'expired' };
    return c;
}
export class WorkoutService {
    constructor(readonly store: WorkoutStore, readonly scope: WorkoutScope, private clock = () => new Date()) {}
    private now() { return this.clock().toISOString(); }
    transaction<T>(work: (tx: WorkoutTransaction) => Promise<T>): Promise<T> { return this.store.transaction(this.scope, work); }
    async registerDevice(value: unknown) {
        const v = object(value, ['installationId', 'platform']);
        const installationId = uuid(v.installationId), platform = choice(v.platform, ['ios', 'watchos'] as const), now = this.now();
        return this.transaction(async tx => {
            const existing = (await tx.list<WorkoutDevice>('workout_devices', { filters: { installationId }, limit: 1 }))[0]?.record;
            const d: WorkoutDevice = { id: existing?.id ?? randomUUID(), installationId, bindingId: existing?.enabled ? existing.bindingId : randomUUID(), platform, enabled: true, lastSeenAt: now };
            await tx.put('workout_devices', d.id, d, now);
            return { device: d };
        });
    }
    async revokeDevice(id: string) {
        uuid(id);
        return this.transaction(async tx => {
            const d = await tx.get<WorkoutDevice>('workout_devices', id);
            if (!d) fail('not_found', 'Устройство не найдено.', 404);
            d.enabled = false;
            await tx.put('workout_devices', id, d, this.now());
            return { revoked: true };
        });
    }
    async detail(id: string) {
        uuid(id);
        return this.transaction(async tx => ({ workout: await this.requireWorkout(tx, id) }));
    }
    private async requireWorkout(tx: WorkoutTransaction, id: string): Promise<Workout> {
        const w = await tx.get<Workout>('workout_records', id);
        if (!w) fail('not_found', 'Тренировка не найдена.', 404);
        return w;
    }
    private async findActive(tx: WorkoutTransaction): Promise<Workout | null> {
        const rows = await tx.list<Workout>('workout_records', { filters: { state: ['running', 'paused', 'requested'] }, limit: 100 });
        for (const { record: w } of rows) {
            if (w.state !== 'requested') return w;
            const commands = await tx.list<WorkoutCommand>('workout_commands', { filters: { workoutId: w.id, status: ['queued', 'claimed'] }, limit: 100 });
            if (commands.some(c => ['queued', 'claimed', 'unknown'].includes(effectiveCommand(c.record, this.now()).status))) return w;
        }
        return null;
    }
    async active() { return this.transaction(async tx => ({ workout: await this.findActive(tx) })); }
    async context() {
        return this.transaction(async tx => {
            const active = await this.findActive(tx);
            const devices = await tx.list<WorkoutDevice>('workout_devices', { filters: { enabled: 'true', platform: 'ios' }, limit: 20 });
            const health = await healthStatus(tx);
            return { active: active ? summary(active) : null, devices: devices.map(row => row.record), healthSync: health.sync, latestDailySteps: health.dailySteps[0] ?? null };
        });
    }
    private historyOptions(query: Record<string, string>): ListOptions {
        if (Object.keys(query).some(key => !['from', 'to', 'activityType', 'cursor', 'limit'].includes(key))) fail('invalid_workout', 'Неизвестный фильтр.');
        const options: ListOptions = { limit: query.limit === undefined ? 20 : number(Number(query.limit), 1, 100, true) };
        if (query.from) options.from = date(query.from);
        if (query.to) options.to = date(query.to);
        if (options.from && options.to && options.from >= options.to) fail('invalid_workout', 'Начало периода должно быть раньше конца.');
        if (query.activityType) options.filters = { activityType: activity(query.activityType) };
        if (query.cursor) {
            let cursor: unknown;
            try { cursor = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')); } catch { fail('invalid_workout', 'Некорректный cursor.'); }
            const c = object(cursor, ['at', 'id']);
            options.cursor = { at: date(c.at), id: uuid(c.id) };
        }
        return options;
    }
    async history(query: Record<string, string>) {
        const options = this.historyOptions(query), limit = options.limit!;
        return this.transaction(async tx => {
            const rows = await tx.list<Workout>('workout_records', { ...options, limit: limit + 1 });
            const page = rows.slice(0, limit), last = page[page.length - 1];
            return { workouts: page.map(row => summary(row.record)), nextCursor: rows.length > limit && last ? Buffer.from(JSON.stringify({ at: last.sortAt, id: last.id })).toString('base64url') : null };
        });
    }
    async syncWorkout(value: unknown) {
        const input = parseSync(value), now = this.now();
        return this.transaction(async tx => {
            const d = await device(tx, input.deviceId, input.bindingId);
            let previous = await tx.get<Workout>('workout_records', input.workoutId);
            let recoveredBinding: string | undefined;
            if (input.previousBindingId !== undefined) {
                if (!previous || previous.recorderDeviceId !== input.deviceId || previous.recordingId !== input.recordingId || input.previousBindingId === input.bindingId ||
                    previous.recorderBindingId !== input.bindingId && (previous.recorderBindingId !== input.previousBindingId || previous.seq !== input.expectedSeq)) fail('workout_conflict', 'Состояние восстановления изменилось. Перечитай тренировку.', 409);
                recoveredBinding = input.previousBindingId;
                previous = { ...previous, recorderBindingId: input.bindingId };
            }
            if (!previous) {
                const active = await this.findActive(tx);
                if (active) fail('active_workout_conflict', 'У аккаунта уже есть другая активная тренировка. Локальная запись сохранена на устройстве.', 409);
                if (!input.events.length || input.events[0].type !== 'started' || input.events[0].seq !== 1) fail('event_conflict', 'Нужен стартовый event seq=1.', 409);
            }
            const healthPayload = input.healthKitId !== undefined || input.mode === 'healthkit' && input.events.some(e => e.type === 'metrics_updated');
            if (healthPayload) await requireHealthConsent(tx, input.deviceId, input.bindingId, input.healthSyncGeneration);
            for (const e of input.events.filter(item => item.commandId)) {
                const c = await tx.get<WorkoutCommand>('workout_commands', e.commandId!);
                if (!c || !['claimed', 'applied'].includes(c.status) || c.workoutId !== input.workoutId || c.recordingId !== input.recordingId ||
                    c.deviceId !== input.deviceId || ![input.bindingId, recoveredBinding].includes(c.bindingId) || e.seq !== c.expectedSeq + 1 || !matches(c, e)) {
                    fail('command_stale', 'Событие не соответствует подтверждённой команде.', 409);
                }
            }
            const workout = applyEvents(previous, input, now);
            await tx.put('workout_records', workout.id, workout, workout.startedAt ?? now);
            await tx.project(workout);
            d.lastSeenAt = now; await tx.put('workout_devices', d.id, d, now);
            return { workout };
        });
    }
    async requestCommand(value: unknown) {
        const base = object(value, ['deviceId', 'bindingId', 'action', 'args'], ['workoutId', 'expectedSeq']);
        const deviceId = uuid(base.deviceId), bindingId = uuid(base.bindingId);
        const action = choice(base.action, ['start', 'pause', 'resume', 'finish', 'record_set', 'set_rest', 'add_note'] as const);
        const now = this.now();
        return this.transaction(async tx => {
            await device(tx, deviceId, bindingId);
            let w: Workout, args: Record<string, unknown>, expectedSeq: number;
            if (action === 'start') {
                if (base.workoutId !== undefined || base.expectedSeq !== undefined) fail('invalid_workout', 'Удалённый старт не принимает workoutId/expectedSeq.');
                const a = object(base.args, ['activityType', 'location', 'mode', 'timeZone']);
                const input = parseSync({ deviceId, bindingId, workoutId: randomUUID(), recordingId: randomUUID(), activityType: activity(a.activityType),
                    location: a.location, mode: a.mode, timeZone: timeZone(a.timeZone), events: [] });
                if (input.activityType === 'other') fail('invalid_workout', 'Выбери поддерживаемый вид тренировки.');
                if (await this.findActive(tx)) fail('active_workout_conflict', 'Сначала заверши активную тренировку.', 409);
                w = newWorkout(input, now); expectedSeq = 0;
                args = { activityType: w.activityType, location: w.location, mode: w.mode, timeZone: w.timeZone };
                await tx.put('workout_records', w.id, w, now);
            } else {
                const workoutId = uuid(base.workoutId); expectedSeq = number(base.expectedSeq, 0, 100000, true);
                w = await this.requireWorkout(tx, workoutId);
                if (w.recorderDeviceId !== deviceId || w.recorderBindingId !== bindingId || w.seq !== expectedSeq || TERMINAL.includes(w.state)) fail('command_stale', 'Состояние тренировки изменилось.', 409);
                if (action === 'pause' && w.state !== 'running' || action === 'resume' && w.state !== 'paused' || action === 'finish' && !['running', 'paused'].includes(w.state)) fail('command_stale', 'Действие не подходит текущему состоянию.', 409);
                if (action === 'record_set') { const a = object(base.args, ['set']); args = { set: set(a.set) }; }
                else if (action === 'set_rest') { const a = object(base.args, ['durationMs']); args = { durationMs: number(a.durationMs, 1000, 86400000, true) }; }
                else if (action === 'add_note') { const a = object(base.args, ['text']); args = { text: text(a.text) }; }
                else { object(base.args, []); args = {}; }
                const pending = await tx.list<WorkoutCommand>('workout_commands', { filters: { workoutId: w.id, status: ['queued', 'claimed'] }, limit: 100 });
                if (pending.some(row => ['queued', 'claimed', 'unknown'].includes(effectiveCommand(row.record, now).status) && row.record.expectedSeq === w.seq)) fail('command_pending', 'Предыдущая команда ещё не подтверждена.', 409);
            }
            const command: WorkoutCommand = { id: randomUUID(), workoutId: w.id, recordingId: w.recordingId, deviceId, bindingId, expectedSeq,
                action, args, status: 'queued', createdAt: now, expiresAt: new Date(Date.parse(now) + 30000).toISOString() };
            await tx.put('workout_commands', command.id, command, now);
            return { command };
        });
    }
    async pollCommands(query: Record<string, string>) {
        object(query, ['deviceId', 'bindingId']);
        const id = uuid(query.deviceId), bindingId = uuid(query.bindingId), now = this.now();
        return this.transaction(async tx => {
            await device(tx, id, bindingId);
            const rows = await tx.list<WorkoutCommand>('workout_commands', { filters: { deviceId: id, bindingId, status: ['queued', 'claimed'] }, limit: 100 });
            return { commands: rows.map(row => effectiveCommand(row.record, now)).filter(c => c.status === 'queued' || c.status === 'claimed'), serverTime: now };
        });
    }
    async claimCommand(id: string, value: unknown) {
        uuid(id);
        const v = object(value, ['deviceId', 'bindingId']), deviceId = uuid(v.deviceId), bindingId = uuid(v.bindingId), now = this.now();
        return this.transaction(async tx => {
            await device(tx, deviceId, bindingId);
            const c = await this.requireCommand(tx, id, deviceId, bindingId);
            const effective = effectiveCommand(c, now);
            if (effective.status !== 'queued' && effective.status !== 'claimed') fail('command_stale', 'Команда уже исполнена или её срок истёк.', 409);
            const w = await this.requireWorkout(tx, c.workoutId);
            if (w.seq !== c.expectedSeq || TERMINAL.includes(w.state)) fail('command_stale', 'Состояние тренировки изменилось.', 409);
            c.status = 'claimed'; await tx.put('workout_commands', c.id, c, c.createdAt);
            return { command: c };
        });
    }
    private async requireCommand(tx: WorkoutTransaction, id: string, deviceId: string, bindingId: string, recoveredResult = false) {
        const c = await tx.get<WorkoutCommand>('workout_commands', id);
        if (!c) fail('not_found', 'Команда не найдена.', 404);
        if (c.deviceId !== deviceId) fail('device_binding_conflict', 'Команда принадлежит другому подключению.', 409);
        if (c.bindingId !== bindingId) {
            const workout = recoveredResult ? await tx.get<Workout>('workout_records', c.workoutId) : null;
            if (!workout || workout.recorderDeviceId !== deviceId || workout.recorderBindingId !== bindingId) fail('device_binding_conflict', 'Команда принадлежит другому подключению.', 409);
        }
        return c;
    }
    async commandResult(id: string, value: unknown) {
        uuid(id);
        const v = object(value, ['deviceId', 'bindingId', 'status'], ['eventId', 'seq', 'code']);
        const deviceId = uuid(v.deviceId), bindingId = uuid(v.bindingId), status = choice(v.status, ['applied', 'rejected', 'failed'] as const);
        const result: NonNullable<WorkoutCommand['result']> = { status, ...(v.eventId === undefined ? {} : { eventId: uuid(v.eventId) }),
            ...(v.seq === undefined ? {} : { seq: number(v.seq, 1, 100000, true) }), ...(v.code === undefined ? {} : { code: text(v.code, 100) }) };
        return this.transaction(async tx => {
            await device(tx, deviceId, bindingId);
            const c = await this.requireCommand(tx, id, deviceId, bindingId, true);
            if (c.result) {
                if (canonical(c.result) !== canonical(result)) fail('command_stale', 'Для команды уже сохранён другой результат.', 409);
                return { command: c };
            }
            const w = await this.requireWorkout(tx, c.workoutId);
            if (status === 'applied') {
                const e = w.events.find(e => e.eventId === result.eventId && e.seq === result.seq && e.commandId === c.id);
                if (c.status !== 'claimed' || !e || !matches(c, e)) fail('command_unconfirmed', 'Сначала синхронизируй событие фактического выполнения.', 409);
            } else if (c.status !== 'queued' && c.status !== 'claimed') fail('command_stale', 'Команда больше не ожидает результата.', 409);
            c.status = status; c.result = result; await tx.put('workout_commands', c.id, c, c.createdAt);
            if (c.action === 'start' && status !== 'applied' && w.state === 'requested' && w.seq === 0) {
                w.state = 'cancelled'; w.endedAt = this.now(); w.updatedAt = this.now(); w.revision++;
                await tx.put('workout_records', w.id, w, w.updatedAt);
            }
            return { command: c };
        });
    }
    async plans() { return this.transaction(async tx => ({ plans: (await tx.list<WorkoutPlan>('workout_plans', { limit: 100 })).map(row => row.record) })); }
    async savePlan(id: string | null, value: unknown) {
        const v = object(value, id ? ['expectedRevision', 'title', 'activityType', 'kind', 'steps'] : ['id', 'title', 'activityType', 'kind', 'steps']);
        const planId = uuid(id ?? v.id);
        if (!Array.isArray(v.steps) || v.steps.length > 100) fail('invalid_workout', 'Передай до 100 шагов плана.');
        const steps = v.steps.map((raw: unknown) => {
            const s = object(raw, ['title'], ['durationMs', 'distanceM', 'sets', 'repetitions', 'weightKg', 'restMs']);
            const clean: any = { title: text(s.title, 200) };
            for (const key of Object.keys(s).filter(key => key !== 'title')) clean[key] = number(s[key], 0, 100000000, ['sets', 'repetitions', 'durationMs', 'restMs'].includes(key));
            return clean;
        });
        const title = text(v.title, 200), activityType = activity(v.activityType), kind = choice(v.kind, ['plan', 'template'] as const);
        if (id) number(v.expectedRevision, 1, Number.MAX_SAFE_INTEGER, true);
        return this.transaction(async tx => {
            const old = await tx.get<WorkoutPlan>('workout_plans', planId);
            if (id ? !old || old.revision !== v.expectedRevision : Boolean(old)) fail('plan_conflict', 'План уже существует или изменился.', 409);
            const plan: WorkoutPlan = { id: planId, revision: (old?.revision ?? 0) + 1, title, activityType, kind, steps, updatedAt: this.now() };
            await tx.put('workout_plans', plan.id, plan, plan.updatedAt);
            return { plan };
        });
    }
    async deletePlan(id: string, revision: unknown) {
        uuid(id); const expected = number(Number(revision), 1, Number.MAX_SAFE_INTEGER, true);
        return this.transaction(async tx => {
            const plan = await tx.get<WorkoutPlan>('workout_plans', id);
            if (!plan) fail('not_found', 'План не найден.', 404);
            if (plan.revision !== expected) fail('plan_conflict', 'План изменился.', 409);
            await tx.remove('workout_plans', id); return { deleted: true };
        });
    }
    async analysis(query: Record<string, string>) {
        const { ids, ...filters } = query;
        const options = this.historyOptions({ ...filters, limit: '100' });
        let requested: string[] | undefined;
        if (ids !== undefined) {
            requested = ids.split(',').map(uuid);
            if (requested.length < 2 || requested.length > 10 || new Set(requested).size !== requested.length) fail('invalid_workout', 'Выбери от 2 до 10 разных тренировок.');
        }
        return this.transaction(async tx => {
            if (requested) return { ...analyze(await Promise.all(requested.map(id => this.requireWorkout(tx, id)))), hasMore: false };
            const rows = await tx.list<Workout>('workout_records', { ...options, limit: 1001 });
            return { ...analyze(rows.slice(0, 1000).map(row => row.record)), hasMore: rows.length > 1000 };
        });
    }
    healthStatus() { return this.transaction(tx => healthStatus(tx)); }
    healthConsent(value: unknown) { return this.transaction(tx => healthConsent(tx, value, this.now())); }
    healthBatch(value: unknown) { return this.transaction(tx => healthBatch(tx, value, this.now())); }
    healthErase() { return this.transaction(tx => healthErase(tx, this.now())); }
}
function matches(c: WorkoutCommand, e: import('../../api/workouts/contracts').WorkoutEvent): boolean {
    const types: Record<WorkoutCommand['action'], string> = { start: 'started', pause: 'paused', resume: 'resumed', finish: 'finished', record_set: 'set_upserted', set_rest: 'rest_started', add_note: 'note_added' };
    if (e.type !== types[c.action]) return false;
    return c.action === 'record_set' || c.action === 'set_rest' || c.action === 'add_note' ? canonical(c.args) === canonical(e.data) : true;
}
