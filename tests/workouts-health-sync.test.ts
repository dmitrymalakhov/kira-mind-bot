import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { ApiError } from '../api/contracts';
import { fixture, registered, syncInput, evt, scope } from './helpers/workouts';
const code = (expected: string) => (error: unknown) => error instanceof ApiError && error.code === expected;

async function connected() {
    const f = fixture(), d = await registered(f.service), binding = { deviceId: d.id, bindingId: d.bindingId };
    const { sync } = await f.service.healthConsent({ ...binding, enabled: true, consentVersion: 1 });
    return { ...f, d, binding, generation: sync.generation };
}
function imported() {
    return { healthKitId: randomUUID(), sourceBundleId: 'com.example.synthetic.sport', activityType: 'running', location: 'outdoor',
        startedAt: '2030-04-01T12:00:00Z', endedAt: '2030-04-01T12:30:00Z', timeZone: 'Europe/Amsterdam',
        metrics: { activeDurationMs: 1500000, distanceM: 5000, meanHeartRateBpm: 135, maxHeartRateBpm: 155 }, syncIdentifier: 'synthetic-workout-one', syncVersion: 1 };
}
function change(seq: number, sourceKey: string, type: string, data?: unknown) {
    return { changeId: randomUUID(), seq, sourceKey, type, ...(data === undefined ? {} : { data }) };
}

test('HealthKit access does not imply server consent; metrics require the current device and generation', async () => {
    const { service } = fixture(), d = await registered(service), binding = { deviceId: d.id, bindingId: d.bindingId };
    const input = { ...syncInput(d), mode: 'healthkit', events: [evt(1, 'started', 0), evt(2, 'metrics_updated', 1000, { metrics: { meanHeartRateBpm: 120 } })] };
    await assert.rejects(service.syncWorkout(input), code('consent_required'));
    assert.equal((await service.history({})).workouts.length, 0);
    const { sync } = await service.healthConsent({ ...binding, enabled: true, consentVersion: 1 });
    await assert.rejects(service.syncWorkout({ ...input, healthSyncGeneration: randomUUID() }), code('sync_generation_conflict'));
    await service.syncWorkout({ ...input, healthSyncGeneration: sync.generation });
    await service.healthConsent({ ...binding, enabled: false, consentVersion: 1 });
    await service.syncWorkout({ ...input, events: [evt(3, 'finished', 2000)] });
    await assert.rejects(service.syncWorkout({ ...input, events: [evt(4, 'metrics_updated', 2000, { metrics: { meanHeartRateBpm: 130 } })], healthSyncGeneration: sync.generation }), code('consent_required'));
});

test('imports, correction versions and explicit tombstones maintain one diary projection; empty batches never delete', async () => {
    const f = await connected(), data = imported(), sourceKey = 'synthetic-source';
    const batch = (changes: unknown[]) => f.service.healthBatch({ ...f.binding, generation: f.generation, changes });
    const first = change(1, sourceKey, 'workout_upsert', data);
    await batch([first]); await batch([first]);
    let rows = (await f.service.history({})).workouts;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].metrics.totalDurationMs, 1800000);
    assert.equal(rows[0].metrics.pausedDurationMs, 300000);
    assert.equal(rows[0].metrics.meanPaceSecPerKm, 300);
    await batch([]);
    assert.equal((await f.service.history({})).workouts.length, 1);
    await batch([change(2, sourceKey, 'workout_upsert', { ...data, syncVersion: 2, metrics: { ...data.metrics, distanceM: 5200 } })]);
    assert.equal((await f.service.history({})).workouts[0].metrics.distanceM, 5200);
    assert.equal(f.store.diary.get(scope.profile + ':' + scope.ownerId)?.size, 1);
    await assert.rejects(batch([change(3, sourceKey, 'workout_upsert', data)]), code('source_version_conflict'));
    assert.equal((await f.service.healthStatus()).sync.lastSeq, 2);
    await batch([change(3, sourceKey, 'workout_delete')]);
    assert.equal((await f.service.history({})).workouts.length, 0);
    assert.equal(f.store.diary.get(scope.profile + ':' + scope.ownerId)?.size, 0);
    await assert.rejects(batch([{ ...first, data: { ...data, sourceBundleId: 'forged' } }]), code('sync_sequence_conflict'));
});

test('own export echo dedupes only the verified HealthKit ID; foreign account references do not link', async () => {
    const f = await connected(), healthKitId = randomUUID();
    const input = { ...syncInput(f.d, [evt(1, 'started', 0), evt(2, 'finished', 2000)]), healthKitId, healthSyncGeneration: f.generation, healthKitSave: 'saved' };
    await f.service.syncWorkout(input);
    const own = { ...imported(), healthKitId, kiraWorkoutId: input.workoutId };
    await f.service.healthBatch({ ...f.binding, generation: f.generation, changes: [change(1, 'own-echo', 'workout_upsert', own)] });
    assert.equal((await f.service.history({})).workouts.length, 1);
    assert.equal((await f.service.detail(input.workoutId)).workout.mode, 'manual');
    await assert.rejects(f.service.healthBatch({ ...f.binding, generation: f.generation, changes: [change(2, 'forged', 'workout_upsert', { ...own, kiraWorkoutId: randomUUID() })] }), code('source_identity_conflict'));
    await f.service.healthBatch({ ...f.binding, generation: f.generation, changes: [change(2, 'own-echo', 'workout_delete')] });
    assert.equal((await f.service.history({})).workouts.length, 1);
    assert.equal((await f.service.detail(input.workoutId)).workout.source.healthKitId, undefined);
});

test('daily steps are replacement aggregates, preserve null, and respect local DST intervals', async () => {
    const f = await connected();
    const data = { localDate: '2030-03-31', timeZone: 'Europe/Amsterdam', intervalStart: '2030-03-30T23:00:00Z', intervalEnd: '2030-03-31T22:00:00Z', steps: 7000 };
    const batch = (changes: unknown[]) => f.service.healthBatch({ ...f.binding, generation: f.generation, changes });
    await batch([change(1, 'daily-one', 'daily_steps_upsert', data)]);
    await batch([change(2, 'daily-one', 'daily_steps_upsert', { ...data, steps: 7500 })]);
    assert.equal((await f.service.healthStatus()).dailySteps[0].steps, 7500);
    await assert.rejects(batch([change(3, 'duplicate-phone-samples', 'daily_steps_upsert', data)]), code('source_identity_conflict'));
    await batch([change(3, 'daily-one', 'daily_steps_upsert', { ...data, steps: null })]);
    assert.equal((await f.service.healthStatus()).dailySteps[0].steps, null);
    await assert.rejects(batch([change(4, 'bad-zone-day', 'daily_steps_upsert', { ...data, localDate: '2030-04-01' })]), code('invalid_workout'));
    await batch([change(4, 'daily-one', 'daily_steps_delete')]);
    assert.equal((await f.service.healthStatus()).dailySteps.length, 0);
});

test('bad multi-item batch rolls back, generation revocation fences queued data, and erase preserves manual sessions', async () => {
    const f = await connected();
    const manual = syncInput(f.d, [evt(1, 'started', 0), evt(2, 'finished', 5000)]);
    await f.service.syncWorkout(manual);
    const batch = (changes: unknown[]) => f.service.healthBatch({ ...f.binding, generation: f.generation, changes });
    await assert.rejects(batch([change(1, 'import', 'workout_upsert', imported()), change(3, 'gap', 'workout_delete')]), code('sync_sequence_conflict'));
    assert.equal((await f.service.history({})).workouts.length, 1);
    await batch([change(1, 'import', 'workout_upsert', imported())]);
    await f.service.healthErase();
    const status = await f.service.healthStatus();
    assert.equal(status.sync.enabled, false);
    assert.notEqual(status.sync.generation, f.generation);
    assert.equal((await f.service.history({})).workouts.length, 1);
    assert.equal((await f.service.detail(manual.workoutId)).workout.metrics.activeDurationMs, 5000);
    await assert.rejects(batch([change(2, 'late', 'workout_upsert', imported())]), code('consent_required'));
    const again = await f.service.healthConsent({ ...f.binding, enabled: true, consentVersion: 1 });
    await assert.rejects(batch([]), code('sync_generation_conflict'));
    assert.notEqual(again.sync.generation, f.generation);
});
