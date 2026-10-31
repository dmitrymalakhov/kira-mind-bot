import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { BotSettingEntity } from '../entity/BotSettingEntity';
import { AppDataSource } from '../data-source';
import { config } from '../config';
import * as ai from '../ai/chatCompletion';
import { getBehaviorMemoryContext, learnBehaviorFromFeedback } from '../services/behaviorMemoryService';

const owner = 740501;
const ctx = (channel = 'telegram') => ({ from: { id: owner }, chat: { id: owner, type: 'private' }, session: {},
    ...(channel === 'api' ? { sessionStorageKey: `api:${owner}` } : {}) }) as any;
const candidate = { safeToLearn: true, trigger: 'При рекомендации места для посещения',
    check: 'Сверить действующий адрес, статус работы и часы на нужную дату по актуальным независимым источникам.',
    reason: 'Старая подборка может содержать уже закрывшееся место.' };
const message = 'Мы приехали по твоему совету, но заведение давно закрылось.';

test('feedback becomes a bounded procedural lesson shared across channels and fresh reads', async t => {
    const oldOwner = config.allowedUserId; config.allowedUserId = owner; t.after(() => { config.allowedUserId = oldOwner; });
    const rows = new Map<string, string>();
    let writes = 0;
    t.mock.method(AppDataSource, 'getRepository', () => ({ findOneBy: async ({ key }: any) => rows.has(key) ? { value: rows.get(key) } : null,
        upsert: async ({ key, value }: any) => { writes++; rows.set(key, value); } }) as any);
    const reflect = t.mock.method(ai, 'createJsonChatCompletionForTask', async (task: string, params: any) => {
        assert.equal(task, 'memoryExtraction'); assert.match(JSON.stringify(params.messages), /дослов|прямой обратной|данных/);
        return candidate as any;
    });
    assert.equal(await getBehaviorMemoryContext(ctx()), '');
    const input = { ctx: ctx(), message, evidence: message, history: [] };
    assert.deepEqual(await Promise.all([learnBehaviorFromFeedback(input), learnBehaviorFromFeedback({ ...input, ctx: ctx('api') })]), ['saved', 'unchanged']);
    assert.equal(writes, 1); assert.equal(reflect.mock.callCount(), 1);
    const memory = await getBehaviorMemoryContext(ctx('api'));
    assert.match(memory, /нужную дату/); assert.doesNotMatch(memory, /Мы приехали|заведение давно закрылось/);
    assert.equal(memory, await getBehaviorMemoryContext(ctx()));
    config.allowedUserId = owner + 1;
    assert.equal(await getBehaviorMemoryContext({ ...ctx(), from: { id: owner + 1 } }), '');
    config.allowedUserId = owner;
    const state = JSON.parse([...rows.values()][0]);
    assert.equal(state.version, 1); assert.equal(state.lessons.length, 1);
    assert.match(state.lessons[0].evidenceHash, /^[a-f0-9]{64}$/);
    assert.ok(!JSON.stringify(state).includes(message));
    const newMessage = 'Снова проблема: ты перепутала часы пятницы и субботы.';
    reflect.mock.mockImplementation(async () => ({ ...candidate, check: candidate.check + ' Сохранять день недели.', existingLessonId: state.lessons[0].id }) as any);
    assert.equal(await learnBehaviorFromFeedback({ ...input, message: newMessage, evidence: newMessage }), 'saved');
    assert.equal(JSON.parse([...rows.values()][0]).lessons.length, 1);
    assert.match(await getBehaviorMemoryContext(ctx()), /Сохранять день недели/);
});

test('foreign users, public chats, ungrounded evidence and invalid model output cannot teach', async t => {
    const oldOwner = config.allowedUserId; config.allowedUserId = owner; t.after(() => { config.allowedUserId = oldOwner; });
    let writes = 0;
    const repo = t.mock.method(AppDataSource, 'getRepository', () => ({ findOneBy: async () => null, upsert: async () => { writes++; } }) as any);
    const reflect = t.mock.method(ai, 'createJsonChatCompletionForTask', async () => candidate as any);
    const input = { ctx: ctx(), message, evidence: message, history: [] };
    for (const value of [{ ...ctx(), from: { id: owner + 1 } }, { ...ctx(), chat: { type: 'group' } }]) {
        assert.equal(await getBehaviorMemoryContext(value), '');
        assert.equal(await learnBehaviorFromFeedback({ ...input, ctx: value }), 'rejected');
    }
    assert.equal(repo.mock.callCount(), 0);
    assert.equal(await learnBehaviorFromFeedback({ ...input, evidence: 'Не существующая в реплике цитата' }), 'rejected');
    assert.equal(reflect.mock.callCount(), 0);
    for (const value of [null, {}, { ...candidate, safeToLearn: false }, { ...candidate, check: 'a'.repeat(321) }, { ...candidate, trigger: [] }]) {
        reflect.mock.mockImplementation(async () => value as any);
        assert.equal(await learnBehaviorFromFeedback(input), 'rejected');
    }
    assert.equal(writes, 0);
});

test('failed reads, corrupt state and failed writes never claim persistence or erase lessons', async t => {
    const oldOwner = config.allowedUserId; config.allowedUserId = owner; t.after(() => { config.allowedUserId = oldOwner; });
    let raw: string | undefined; let readFails = true; let writeFails = false; let writes = 0;
    t.mock.method(AppDataSource, 'getRepository', () => ({ findOneBy: async () => { if (readFails) throw Error('offline'); return raw === undefined ? null : { value: raw }; },
        upsert: async () => { writes++; if (writeFails) throw Error('offline'); } }) as any);
    const reflect = t.mock.method(ai, 'createJsonChatCompletionForTask', async () => candidate as any);
    const input = { ctx: ctx(), message, evidence: message, history: [] };
    assert.equal(await learnBehaviorFromFeedback(input), 'unavailable');
    assert.equal(await getBehaviorMemoryContext(ctx()), '');
    assert.equal(reflect.mock.callCount(), 0); assert.equal(writes, 0);
    readFails = false; raw = '{broken';
    assert.equal(await learnBehaviorFromFeedback(input), 'unavailable'); assert.equal(writes, 0);
    raw = undefined; writeFails = true;
    assert.equal(await learnBehaviorFromFeedback(input), 'unavailable');
    assert.equal(await getBehaviorMemoryContext(ctx()), '');
    writeFails = false;
    assert.equal(await learnBehaviorFromFeedback(input), 'saved');
    assert.equal(reflect.mock.callCount(), 2);
});

test('concurrent independent feedback survives and memory has a fixed size', async t => {
    const oldOwner = config.allowedUserId; config.allowedUserId = owner; t.after(() => { config.allowedUserId = oldOwner; });
    let raw: string | undefined;
    t.mock.method(AppDataSource, 'getRepository', () => ({ findOneBy: async () => raw ? { value: raw } : null, upsert: async ({ value }: any) => { raw = value; } }) as any);
    let n = 0;
    t.mock.method(ai, 'createJsonChatCompletionForTask', async () => ({ ...candidate, trigger: candidate.trigger + ` вариант ${n++}` }) as any);
    const results = await Promise.all(Array.from({ length: 70 }, (_, i) => learnBehaviorFromFeedback({ ctx: ctx(i % 2 ? 'api' : 'telegram'),
        message: message + ` ${i}`, evidence: message, history: [] })));
    assert.ok(results.every(r => r === 'saved'));
    const state = JSON.parse(raw!);
    assert.equal(state.lessons.length, 16); assert.equal(state.processed.length, 64);
    assert.equal(new Set(state.lessons.map((item: any) => item.id)).size, 16);
});

test('PostgreSQL retains behavioral lessons across a new connection and deduplicates replay', { skip: !process.env.KIRA_PLATFORM_TEST_PG_PORT }, async t => {
    const oldOwner = config.allowedUserId; config.allowedUserId = owner; t.after(() => { config.allowedUserId = oldOwner; });
    const connection = { type: 'postgres' as const, host: '127.0.0.1', port: Number(process.env.KIRA_PLATFORM_TEST_PG_PORT), username: 'postgres', password: 'synthetic-platform-test' };
    const admin = await new DataSource({ ...connection, database: 'postgres' }).initialize();
    const database = `kira_behavior_test_${randomUUID().replace(/-/g, '')}`;
    await admin.query(`CREATE DATABASE "${database}"`);
    let db: DataSource | undefined;
    const open = () => new DataSource({ ...connection, database, entities: [BotSettingEntity], synchronize: true }).initialize();
    try {
        db = await open();
        t.mock.method(AppDataSource, 'getRepository', () => db!.getRepository(BotSettingEntity) as any);
        const reflect = t.mock.method(ai, 'createJsonChatCompletionForTask', async () => candidate as any);
        const input = { ctx: ctx(), message, evidence: message, history: [] };
        assert.equal(await learnBehaviorFromFeedback(input), 'saved');
        await db.destroy(); db = await open();
        assert.match(await getBehaviorMemoryContext(ctx('api')), /нужную дату/);
        assert.equal(await learnBehaviorFromFeedback({ ...input, ctx: ctx('api') }), 'unchanged');
        assert.equal(reflect.mock.callCount(), 1);
        assert.equal(await db.getRepository(BotSettingEntity).count(), 1);
    } finally {
        if (db?.isInitialized) await db.destroy();
        await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
        await admin.destroy();
    }
});
