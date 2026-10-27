/** Run only against a disposable PostgreSQL database named kira_dialogue_test. */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { AppDataSource } from '../data-source';
import { DialogueJobEntity } from '../entity/DialogueJobEntity';
import { BotSettingEntity } from '../entity/BotSettingEntity';
import { SessionEntity } from '../entity/SessionEntity';
import { DialogueJobRepository as jobs, DIALOGUE_JOB_LEASE_MS } from '../services/DialogueJobRepository';
import { scopedBotKey } from '../utils/botIdentity';
import type { DialogueJobInput } from '../types/dialogueJobTypes';

before(async () => {
    assert.equal(process.env.DIALOGUE_JOB_DB_TEST, 'true');
    assert.equal(process.env.DB_NAME, 'kira_dialogue_test');
    assert.equal(process.env.DB_HOST, '127.0.0.1');
    AppDataSource.setOptions({ entities: [DialogueJobEntity, BotSettingEntity, SessionEntity], synchronize: false });
    await AppDataSource.initialize();
    const migration = await readFile(path.join(__dirname, '../scripts/migrations/2026-10-26-dialogue-jobs.sql'), 'utf8');
    await AppDataSource.query(migration);
    await AppDataSource.query(migration); // Reapplying the operator migration is harmless.
    await AppDataSource.synchronize();
});
after(async () => { if (AppDataSource.isInitialized) await AppDataSource.destroy(); });

const input: DialogueJobInput = { message: 'Синтетический вопрос', initialAnswer: '', required: true, history: [], preset: 'gpt-balanced',
    classification: { intent: 'РАЗГОВОР', confidenceLevel: 'ВЫСОКИЙ', details: { memoryNeed: 'full', responseComplexity: 'complex' } } };
const stage = (channel: string, turnId: string) => jobs.stage({ channel, turnId, userId: 740001, chatId: 740001, input });
const stale = () => new Date(Date.now() - DIALOGUE_JOB_LEASE_MS - 1000);

test('migration matches entity metadata', async () => {
    const changes = await AppDataSource.driver.createSchemaBuilder().log();
    assert.equal(changes.upQueries.length, 0, changes.upQueries.map(query => query.query).join('\n'));
});

test('staging is unique per turn and cannot run before initial response activation', async () => {
    await jobs.beginTurn('740001', 'first');
    const first = await stage('740001', 'first'); assert.ok(first);
    assert.equal((await stage('740001', 'first'))!.id, first.id);
    assert.equal((await jobs.claim(2)).length, 0);
    await jobs.activate(first.id, 'api:740001'); assert.equal((await jobs.claim(2)).length, 0);
    await jobs.activate(first.id, '740001');
    const batches = await Promise.all([jobs.claim(1), jobs.claim(1)]);
    const claimed = batches.flat(); assert.equal(claimed.length, 1); assert.equal(claimed[0].attempts, 1);
    assert.ok(await jobs.update(claimed[0], { status: 'completed' }));
});

test('new turn and cancel fence late enqueues; channels and profiles stay isolated', async () => {
    await jobs.beginTurn('740001', 'older');
    await jobs.beginTurn('740001', 'newer');
    assert.equal(await stage('740001', 'older'), undefined);
    const current = await stage('740001', 'newer'); assert.ok(current);
    await jobs.beginTurn('api:740001', 'app-turn'); const app = await stage('api:740001', 'app-turn'); assert.ok(app);
    await jobs.cancel('740001');
    assert.equal(await stage('740001', 'newer'), undefined);
    assert.equal((await jobs.find(current.id, '740001'))!.status, 'cancelled');
    assert.equal((await jobs.find(app.id, 'api:740001'))!.status, 'staged');
    assert.equal(await jobs.find(app.id, '740001'), undefined);
    assert.equal(await jobs.cancel('740001', app.id), false);
    assert.ok((await jobs.list('740001')).every(row => row.channel === '740001'));
    await jobs.cancel('api:740001');
});

test('only read computation recovers with a new lease, and stale workers cannot write results', async () => {
    await jobs.beginTurn('740001', 'restart'); const value = await stage('740001', 'restart'); assert.ok(value);
    await jobs.activate(value.id, '740001'); const first = (await jobs.claim(1))[0]; assert.ok(first);
    await jobs.update(first, { lockedAt: stale() });
    const second = (await jobs.claim(1))[0]; assert.equal(second.id, first.id); assert.equal(second.attempts, 2); assert.notEqual(second.lease, first.lease);
    assert.equal(await jobs.update(first, { status: 'ready', resultText: 'stale' }), false);
    assert.equal(await jobs.isActive(first), false);
    await jobs.update(second, { lockedAt: stale() });
    assert.equal((await jobs.claim(1)).length, 0); assert.equal((await jobs.find(first.id, '740001'))!.status, 'failed');
});

test('uncertain Telegram delivery never becomes runnable again after a process crash', async () => {
    await jobs.beginTurn('740001', 'delivery'); const value = await stage('740001', 'delivery'); assert.ok(value);
    await jobs.activate(value.id, '740001'); const work = (await jobs.claim(1))[0];
    await jobs.update(work, { status: 'ready', resultText: 'Синтетический результат' });
    const delivery = (await jobs.claim(1))[0]; assert.equal(delivery.status, 'delivering');
    await jobs.update(delivery, { lockedAt: stale() });
    assert.equal((await jobs.claim(1)).length, 0); assert.equal((await jobs.find(value.id, '740001'))!.status, 'unknown');
});

test('superseded computation cannot publish, and cleanup removes its isolated runtime ledger', async () => {
    await jobs.beginTurn('740001', 'before-cancel'); const value = await stage('740001', 'before-cancel'); assert.ok(value);
    await jobs.activate(value.id, '740001'); const work = (await jobs.claim(1))[0];
    await jobs.beginTurn('740001', 'after-cancel');
    assert.equal(await jobs.isActive(work), false); assert.equal(await jobs.update(work, { status: 'ready', resultText: 'stale' }), false);
    await AppDataSource.query('UPDATE dialogue_jobs SET "updatedAt" = $1 WHERE id = $2', [new Date(Date.now() - 8 * 24 * 60 * 60_000), value.id]);
    await AppDataSource.getRepository(SessionEntity).save({ key: scopedBotKey(`dialogue:${value.id}`), data: {} });
    await jobs.cleanup();
    assert.equal(await jobs.find(value.id, '740001'), undefined);
    assert.equal(await AppDataSource.getRepository(SessionEntity).countBy({ key: scopedBotKey(`dialogue:${value.id}`) }), 0);
});
