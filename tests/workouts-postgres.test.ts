import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { DataSource } from 'typeorm';
import { provisionTenantWorkouts } from '../platform/workouts';
import { tenantName } from '../platform/store';
import { PgWorkoutStore } from '../services/workouts/store';
import { WorkoutService } from '../services/workouts/service';
import { evt, syncInput, scope } from './helpers/workouts';
import { ApiOperationEntity } from '../entity/ApiOperationEntity';
import { PersistentApiOperations } from '../api/operations';
import { ApiError } from '../api/contracts';

test('actual PostgreSQL: repeatable privileged migration, limited imported role, durable projection and transaction rollback', {
    skip: !process.env.KIRA_PLATFORM_TEST_PG_PORT,
}, async () => {
    const port = Number(process.env.KIRA_PLATFORM_TEST_PG_PORT);
    assert.ok(Number.isSafeInteger(port) && port > 0);
    const options = { type: 'postgres' as const, host: '127.0.0.1', port, username: 'postgres', password: 'synthetic-platform-test', logging: false as const };
    const admin = await new DataSource({ ...options, database: 'postgres' }).initialize();
    const database = 'kira_workout_test_' + randomUUID().replace(/-/g, ''), account = randomUUID(), role = tenantName(account);
    let db: DataSource | undefined, limited: DataSource | undefined;
    const testScope = { ...scope, profile: 'KiraMindBot' };
    try {
        await admin.query('CREATE DATABASE "' + database + '"');
        await admin.query('CREATE ROLE "' + role + '" LOGIN PASSWORD \'synthetic-workout-role\'');
        db = await new DataSource({ ...options, database }).initialize();
        await db.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
        await db.query('GRANT CONNECT ON DATABASE "' + database + '" TO "' + role + '"');
        await db.query('GRANT USAGE ON SCHEMA public TO "' + role + '"');
        await db.query('CREATE TABLE health_logs (id text PRIMARY KEY,profile text NOT NULL,"userId" bigint NOT NULL,kind text NOT NULL,"rawText" text NOT NULL,summary text,"occurredAt" timestamptz NOT NULL,structured jsonb,tags jsonb,"createdAt" timestamptz NOT NULL)');
        await db.query('CREATE TABLE api_operations (key varchar(160) PRIMARY KEY,fingerprint text NOT NULL,status text NOT NULL,result jsonb,"createdAt" timestamptz NOT NULL DEFAULT now())');
        await db.query('GRANT SELECT,INSERT,UPDATE,DELETE ON health_logs TO "' + role + '"');
        await db.query('GRANT SELECT,INSERT,UPDATE,DELETE ON api_operations TO "' + role + '"');
        await db.query('INSERT INTO health_logs VALUES($1,$2,$3,$4,$5,$5,now(),$6,$7,now())', [randomUUID(), scope.profile, scope.ownerId, 'note', 'Synthetic existing diary', {}, []]);
        await provisionTenantWorkouts(admin, account, database);
        await provisionTenantWorkouts(admin, account, database);
        limited = await new DataSource({ ...options, database, username: role, password: 'synthetic-workout-role', entities: [ApiOperationEntity] }).initialize();
        await assert.rejects(limited.query('CREATE TABLE forbidden_schema_change (id text)'), /permission denied/i);
        const service = new WorkoutService(new PgWorkoutStore(limited), testScope);
        const { device } = await service.registerDevice({ installationId: randomUUID(), platform: 'ios' });
        const input = syncInput(device, [evt(1, 'started', 0), evt(2, 'paused', 30000), evt(3, 'resumed', 45000), evt(4, 'finished', 90000)]);
        await service.syncWorkout(input); await service.syncWorkout(input);
        const reloaded = new WorkoutService(new PgWorkoutStore(limited), testScope);
        assert.equal((await reloaded.detail(input.workoutId)).workout.metrics.activeDurationMs, 75000);
        assert.equal((await limited.query('SELECT COUNT(*)::int AS count FROM health_logs'))[0].count, 2);
        assert.equal((await reloaded.history({})).workouts.length, 1);
        const other = new WorkoutService(new PgWorkoutStore(limited), { ...testScope, ownerId: scope.ownerId + 1 });
        assert.equal((await other.history({})).workouts.length, 0);
        await assert.rejects(other.detail(input.workoutId), /не найдена/);
        const bad = syncInput(device, [evt(1, 'started', 0), evt(3, 'finished', 1000)]);
        await assert.rejects(reloaded.syncWorkout(bad));
        assert.equal((await limited.query('SELECT COUNT(*)::int AS count FROM workout_records'))[0].count, 1);
        await provisionTenantWorkouts(admin, account, database);
        assert.equal((await reloaded.detail(input.workoutId)).workout.state, 'finished');
        const receipts = new PersistentApiOperations(limited);
        let calls = 0;
        const key = 'workouts:' + testScope.ownerId + ':synthetic-receipt';
        const result = await receipts.runJson(key, 'synthetic-fingerprint', async () => { calls++; return reloaded.detail(input.workoutId); });
        assert.equal(result.workout.state, 'finished');
        await receipts.runJson(key, 'synthetic-fingerprint', async () => { calls++; return {}; });
        assert.equal(calls, 1);
        await assert.rejects(receipts.runJson(key, 'changed-fingerprint', async () => ({})), (e: unknown) => e instanceof ApiError && e.code === 'idempotency_conflict');
        await reloaded.healthErase();
        await assert.rejects(receipts.runJson(key, 'synthetic-fingerprint', async () => { calls++; return {}; }), (e: unknown) => e instanceof ApiError && e.code === 'operation_result_erased');
        assert.equal(calls, 1);
        assert.equal((await reloaded.detail(input.workoutId)).workout.state, 'finished');
    } finally {
        if (limited?.isInitialized) await limited.destroy();
        if (db?.isInitialized) await db.destroy();
        await admin.query('DROP DATABASE IF EXISTS "' + database + '" WITH (FORCE)');
        await admin.query('DROP ROLE IF EXISTS "' + role + '"');
        await admin.destroy();
    }
});
