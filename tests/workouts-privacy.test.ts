import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WorkoutPrivacyLogger } from '../services/workouts/privacyLogger';

test('query, slow-query, receipt and error logging never print synthetic health values', t => {
    const outputs: string[] = [];
    for (const method of ['log', 'info', 'warn', 'error'] as const) t.mock.method(console, method, (...args: unknown[]) => { outputs.push(JSON.stringify(args)); });
    const logger = new WorkoutPrivacyLogger(true);
    for (const sql of ['INSERT INTO workout_records VALUES ($1)', '/* workout-private */ INSERT INTO health_logs VALUES ($1)', 'UPDATE api_operations SET result=$1']) {
        logger.logQuery(sql, [{ privateHealthMeasurement: 137, rawNote: 'synthetic private note' }]);
        logger.logQueryError('synthetic private note', sql, [137]);
        logger.logQuerySlow(1000, sql, [137]);
    }
    assert.equal(outputs.length, 0);
    logger.logQuery('SELECT 1');
    assert.ok(outputs.length > 0);
});
