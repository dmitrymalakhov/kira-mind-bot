import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { ApiError } from '../api/contracts';
import { fixture, registered, syncInput, evt, scope } from './helpers/workouts';
const code = (expected: string) => (error: unknown) => error instanceof ApiError && error.code === expected;

test('first manual workout needs no Health permission; pauses, corrections and terminal annotations retain exact results', async () => {
    const { service, store } = fixture(), d = await registered(service);
    const setId = randomUUID();
    const input = syncInput(d, [evt(1, 'started', 0), evt(2, 'set_upserted', 1000, { set: { id: setId, exercise: 'Синтетический присед', repetitions: 8, weightKg: 60 } }),
        evt(3, 'paused', 100000), evt(4, 'resumed', 150000), evt(5, 'metrics_updated', 190000, { metrics: { distanceM: 1000 } }), evt(6, 'finished', 200000)]);
    const w = (await service.syncWorkout(input)).workout;
    assert.equal(w.metrics.totalDurationMs, 200000);
    assert.equal(w.metrics.activeDurationMs, 150000);
    assert.equal(w.metrics.pausedDurationMs, 50000);
    assert.equal(w.metrics.meanPaceSecPerKm, 150);
    assert.equal(w.metrics.strengthVolumeKg, 480);
    assert.equal(w.metrics.meanHeartRateBpm, null);
    const updated = (await service.syncWorkout({ ...input, events: [evt(7, 'note_added', 220000, { text: 'Синтетическая заметка' })] })).workout;
    assert.equal(updated.metrics.totalDurationMs, 200000);
    assert.equal(store.diary.get(scope.profile + ':' + scope.ownerId)?.size, 1);
    assert.equal((await service.healthStatus()).sync.enabled, false);
    const list = await service.history({});
    assert.equal(list.nextCursor, null);
    assert.equal('events' in list.workouts[0], false);
    assert.equal('notes' in list.workouts[0], false);
    assert.equal('sets' in list.workouts[0], false);
});

test('event replay is idempotent, conflicting/reordered batches roll back, terminal sessions never revive', async () => {
    const { service } = fixture(), d = await registered(service), input = syncInput(d);
    const first = (await service.syncWorkout(input)).workout;
    assert.equal((await service.syncWorkout(input)).workout.revision, first.revision);
    await assert.rejects(service.syncWorkout({ ...input, events: [{ ...input.events[0], elapsedMs: 1 }] }), code('event_conflict'));
    await assert.rejects(service.syncWorkout({ ...input, events: [evt(2, 'paused', 20), evt(4, 'finished', 30)] }), code('event_conflict'));
    assert.equal((await service.detail(input.workoutId)).workout.state, 'running');
    await service.syncWorkout({ ...input, events: [evt(2, 'finished', 1000)] });
    await assert.rejects(service.syncWorkout({ ...input, events: [evt(3, 'resumed', 1100)] }), code('workout_conflict'));
    assert.equal((await service.detail(input.workoutId)).workout.state, 'finished');
});

test('monotonic duration survives clock changes and zero measured strength differs from unavailable weight', async () => {
    const { service } = fixture(), d = await registered(service);
    const id = randomUUID(), start = evt(1, 'started', 0), finish = evt(4, 'finished', 60000);
    finish.occurredAt = start.occurredAt;
    const input = syncInput(d, [start, evt(2, 'set_upserted', 1000, { set: { id, exercise: 'Тест', repetitions: 10, weightKg: 0 } }),
        evt(3, 'set_upserted', 2000, { set: { id: randomUUID(), exercise: 'Тест без веса', repetitions: 5, weightKg: null } }), finish]);
    const w = (await service.syncWorkout(input)).workout;
    assert.equal(w.metrics.activeDurationMs, 60000);
    assert.equal(w.metrics.strengthVolumeKg, null);
    assert.equal(w.metrics.completedSets, 2);
    const result = await service.analysis({});
    assert.equal((result.groups as any[])[0].totals.distanceM.value, null);
});

test('account and profile isolation, binding revocation and simultaneous starts preserve existing workout', async () => {
    const f = fixture(), d = await registered(f.service), input = syncInput(d);
    await f.service.syncWorkout(input);
    for (const other of [{ ...scope, ownerId: scope.ownerId + 1 }, { ...scope, profile: 'AnotherSyntheticProfile' }]) {
        const service = fixture(f.store, other).service;
        await assert.rejects(service.detail(input.workoutId), code('not_found'));
        await assert.rejects(service.syncWorkout(input), code('not_found'));
        assert.equal((await service.history({})).workouts.length, 0);
    }
    await assert.rejects(f.service.syncWorkout(syncInput(d)), code('active_workout_conflict'));
    await f.service.revokeDevice(d.id);
    await assert.rejects(f.service.syncWorkout({ ...input, events: [evt(2, 'finished', 3000)] }), code('device_binding_conflict'));
    const replacement = (await f.service.registerDevice({ installationId: d.installationId, platform: 'ios' })).device;
    assert.notEqual(replacement.bindingId, d.bindingId);
    assert.equal((await f.service.detail(input.workoutId)).workout.state, 'running');
    await assert.rejects(f.service.syncWorkout({ ...input, bindingId: replacement.bindingId, previousBindingId: d.bindingId, expectedSeq: 0, events: [evt(2, 'finished', 3000)] }), code('workout_conflict'));
    const recovered = await f.service.syncWorkout({ ...input, bindingId: replacement.bindingId, previousBindingId: d.bindingId, expectedSeq: 1, events: [evt(2, 'finished', 3000)] });
    assert.equal(recovered.workout.id, input.workoutId);
    assert.equal(recovered.workout.state, 'finished');
    assert.equal(recovered.workout.recorderBindingId, replacement.bindingId);
});

test('remote start allocates stable adoption IDs; applied ACK requires the persisted device event', async () => {
    const { service } = fixture(), d = await registered(service), binding = { deviceId: d.id, bindingId: d.bindingId };
    const { command } = await service.requestCommand({ ...binding, action: 'start', args: { activityType: 'cycling', location: 'indoor', mode: 'manual', timeZone: 'Europe/Amsterdam' } });
    assert.equal(command.expectedSeq, 0);
    assert.equal((await service.active()).workout?.state, 'requested');
    await assert.rejects(service.requestCommand({ ...binding, action: 'start', args: command.args }), code('active_workout_conflict'));
    await service.claimCommand(command.id, binding);
    const start = evt(1, 'started', 0, {}, command.id);
    await assert.rejects(service.commandResult(command.id, { ...binding, status: 'applied', eventId: start.eventId, seq: 1 }), code('command_unconfirmed'));
    const input = { ...syncInput(d, [start]), workoutId: command.workoutId, recordingId: command.recordingId, ...command.args };
    await service.syncWorkout(input);
    const result = await service.commandResult(command.id, { ...binding, status: 'applied', eventId: start.eventId, seq: 1 });
    assert.equal(result.command.status, 'applied');
    assert.equal((await service.detail(command.workoutId)).workout.recordingId, command.recordingId);
    assert.equal((await service.commandResult(command.id, { ...binding, status: 'applied', eventId: start.eventId, seq: 1 })).command.status, 'applied');
});

test('finish intent does not finish a session; local finish fences delayed commands and expiry prevents replay', async () => {
    const f = fixture(), d = await registered(f.service), input = syncInput(d), binding = { deviceId: d.id, bindingId: d.bindingId };
    await f.service.syncWorkout(input);
    const { command } = await f.service.requestCommand({ ...binding, workoutId: input.workoutId, expectedSeq: 1, action: 'finish', args: {} });
    assert.equal((await f.service.detail(input.workoutId)).workout.state, 'running');
    await f.service.claimCommand(command.id, binding);
    f.advance(31000);
    assert.equal((await f.service.pollCommands(binding)).commands.length, 0);
    await assert.rejects(f.service.claimCommand(command.id, binding), code('command_stale'));
    await f.service.syncWorkout({ ...input, events: [evt(2, 'finished', 10000)] });
    await assert.rejects(f.service.commandResult(command.id, { ...binding, status: 'applied', eventId: randomUUID(), seq: 2 }), code('command_unconfirmed'));
    await assert.rejects(f.service.requestCommand({ ...binding, workoutId: input.workoutId, expectedSeq: 1, action: 'resume', args: {} }), code('command_stale'));
});

test('device rejection cancels only the unstarted requested session, preserving local IDs', async () => {
    const { service } = fixture(), d = await registered(service), binding = { deviceId: d.id, bindingId: d.bindingId };
    const { command } = await service.requestCommand({ ...binding, action: 'start', args: { activityType: 'walking', location: 'outdoor', mode: 'manual', timeZone: 'UTC' } });
    await service.commandResult(command.id, { ...binding, status: 'rejected', code: 'active_workout_conflict' });
    assert.equal((await service.active()).workout, null);
    const input = syncInput(d);
    assert.equal((await service.syncWorkout(input)).workout.id, input.workoutId);
    assert.equal((await service.detail(command.workoutId)).workout.state, 'cancelled');
});

test('plans use revision checks, and comparisons keep different sports in separate groups', async () => {
    const { service } = fixture(), d = await registered(service), planId = randomUUID();
    const plan = { id: planId, title: 'Синтетический план', kind: 'template', activityType: 'strength', steps: [{ title: 'Синтетическое упражнение', sets: 3, repetitions: 8, restMs: 90000 }] };
    await service.savePlan(null, plan);
    const { id, ...fields } = plan;
    await service.savePlan(id, { ...fields, expectedRevision: 1 });
    await assert.rejects(service.savePlan(id, { ...fields, expectedRevision: 1 }), code('plan_conflict'));
    await service.deletePlan(id, '2');
    assert.equal((await service.plans()).plans.length, 0);
    for (const activityType of ['running', 'strength']) await service.syncWorkout({ ...syncInput(d, [evt(1, 'started', 0), evt(2, 'finished', 30000)]), activityType });
    assert.equal(((await service.analysis({})).groups as any[]).length, 2);
});
