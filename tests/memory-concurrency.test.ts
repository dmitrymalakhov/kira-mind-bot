import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MemoryEntry } from '../types';
import { QdrantVectorService } from '../services/QdrantVectorService';
import * as factory from '../services/VectorServiceFactory';
import * as completion from '../ai/chatCompletion';
import { saveMemory } from '../utils/enhancedDomainMemory';
import { reconsolidateAfterResponse } from '../services/MemoryReconsolidationService';
import { memoryAssertionVersion } from '../utils/memoryProvenance';
import { runMemorySleepCycleForUser } from '../services/MemorySleepCycleService';
import { createOrRefreshReminderMemoryForUserId } from '../services/ReminderMemorySync';

const owner = '900000061';
const fact = (extra: Partial<MemoryEntry> = {}): MemoryEntry => ({ id: 'synthetic-source', content: 'Пользователь изучает геометрию.',
    domain: 'education', userId: owner, botId: 'synthetic', timestamp: new Date('2020-01-01'), importance: .3,
    confidence: .6, subject: 'user', predicate: 'studies', object: 'геометрию', status: 'active', tags: ['subject:user'],
    sourceContext: 'Я изучаю геометрию.', sourceMessageIds: [`tg:${owner}:1`], confirmationCount: 1, ...extra });
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const response = (data: unknown) => ({ choices: [{ message: { content: JSON.stringify(data) } }] } as any);
const deferred = <T = void>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };

function storage(initial = fact()) {
    const records = new Map<string, any>(), writes: any[] = [], deletes: string[] = [];
    const client = {
        retrieve: async (_collection: string, options: any) => options.ids.filter((id: string) => records.has(id)).map((id: string) => ({ id, payload: clone(records.get(id)) })),
        overwritePayload: async (_collection: string, options: any) => { writes.push(clone(options.payload)); records.set(options.points[0], clone(options.payload)); },
        upsert: async (_collection: string, options: any) => { for (const point of options.points) { writes.push(clone(point.payload)); records.set(point.id, clone(point.payload)); } },
        setPayload: async (_collection: string, options: any) => { for (const id of options.points) { if (records.has(id)) records.set(id, { ...records.get(id), ...clone(options.payload) }); } },
        delete: async (_collection: string, options: any) => { for (const id of options.points) { deletes.push(id); records.delete(id); } },
        scroll: async (collection: string, _options: any) => ({ points: collection.endsWith('_education') ? [...records].map(([id, payload]) => ({ id, payload: clone(payload) })) : [] }),
    };
    const service: any = new QdrantVectorService(client as any);
    initial.botId = service.botId; records.set(initial.id, clone(initial));
    service.ensureCollectionCompatibility = async () => 'exists'; service.embed = async () => [1, 0];
    return { service: service as QdrantVectorService, client, records, writes, deletes, original: initial };
}

test('a missing or unreadable point is never recreated by an update or blindly deleted', async t => {
    const { service, client, records, writes, deletes, original } = storage();
    records.clear();
    await assert.rejects(service.updateMemory(original.id, original.domain, original), /no longer exists/);
    assert.equal(writes.length, 0);
    t.mock.method(client, 'retrieve', async () => { throw Error('synthetic read outage'); });
    await assert.rejects(service.updateMemory(original.id, original.domain, original), /read outage/);
    await assert.rejects(service.deleteMemory(original.id, original.domain), /read outage/);
    assert.equal(writes.length, 0); assert.equal(deletes.length, 0);
});

test('deletion wins over a pending update and a later stale updater cannot resurrect the fact', async () => {
    const { service, records, original } = storage();
    const entered = deferred(), finish = deferred<number[]>();
    (service as any).embed = async () => { entered.resolve(); return finish.promise; };
    const update = service.updateMemory(original.id, original.domain, { ...original, content: 'Пользователь изучает алгебру.', object: 'алгебру' });
    await entered.promise;
    const deletion = service.deleteMemory(original.id, original.domain, { userDeletion: { userId: owner } });
    finish.resolve([1, 0]);
    await Promise.all([update, deletion]);
    assert.equal(records.has(original.id), false);
    await assert.rejects(service.updateMemory(original.id, original.domain, original), /no longer exists/);
    assert.equal(records.has(original.id), false);
    assert.equal((service as any).mutationLocks.size, 0);
});

test('an update cancelled while embedding cannot dispatch a late write', async () => {
    const { service, records, writes, original } = storage();
    const entered = deferred(), finish = deferred<number[]>(); let active = true;
    (service as any).embed = async () => { entered.resolve(); return finish.promise; };
    const update = service.updateMemory(original.id, original.domain, { ...original, content: 'Пользователь изучает алгебру.' }, { isActive: () => active });
    await entered.promise; active = false; finish.resolve([1, 0]);
    await assert.rejects(update, /cancelled/);
    assert.equal(writes.length, 0); assert.equal(records.get(original.id).content, original.content);
    assert.equal((service as any).mutationLocks.size, 0);
});

test('a stale assertion cannot roll back a newer state even with valid owner evidence', async () => {
    const { service, records, original } = storage();
    const expectedAssertion = memoryAssertionVersion(original);
    await service.updateMemory(original.id, original.domain, { ...original, content: 'Пользователь изучает алгебру.', object: 'алгебру' });
    await assert.rejects(service.updateMemory(original.id, original.domain, original,
        { expectedAssertion, userCorrection: { userId: owner, sourceText: 'Я изучаю геометрию.', sourceMessageIds: [`tg:${owner}:2`] } }), /changed during processing/);
    assert.equal(records.get(original.id).object, 'алгебру');
});

test('cleanup rechecks a candidate and cannot delete a revised or unreadable record', async t => {
    const { service, client, records, deletes, original } = storage(fact({ tags: ['temporal_scope:future_plan'], status: 'planned', expiresAt: new Date('2020-02-01') }));
    const scan = client.scroll;
    t.mock.method(client, 'scroll', async (...args: Parameters<typeof scan>) => {
        const result = await scan(...args);
        records.set(original.id, { ...records.get(original.id), expiresAt: undefined, status: 'active', timestamp: new Date().toISOString() });
        return result;
    });
    assert.equal(await service.cleanupOldMemories(owner), 0);
    assert.deepEqual(deletes, []); assert.equal(records.has(original.id), true);
});

test('parallel retrievals retain every access and never modify truth confidence', async () => {
    const { service, records, original } = storage(fact({ confidence: .4, retrievalCount: 0 }));
    await Promise.all(Array.from({ length: 10 }, (_, index) => service.updateMemoryAccess(original.id, original.domain, index % 2 ? 1 : 0, `тестовый контекст ${index}`)));
    assert.equal(records.get(original.id).retrievalCount, 10); assert.equal(records.get(original.id).confidence, .4);
    await service.updateMemory(original.id, original.domain, { ...original, retrievalCount: 0 });
    assert.equal(records.get(original.id).retrievalCount, 10);
    assert.equal(records.get(original.id).retrievalCues.length, 8);
});

test('parallel confirmations keep both new sources and count each once; imports cannot inflate confidence', async t => {
    const { service, records, original } = storage();
    t.mock.method(factory, 'getVectorService', () => service as any);
    t.mock.method(service, 'searchMemories', async () => [{ ...clone(original), score: .99 }]);
    t.mock.method(service, 'searchAllDomains', async () => []);
    const save = (id: number, confidence = .6) => saveMemory({ from: { id: Number(owner) }, session: {} } as any, original.domain, original.content, .3, original.tags, false,
        { subject: 'user', predicate: original.predicate, object: original.object, confidence, sourceContext: 'Я изучаю геометрию.', sourceMessageIds: [`tg:${owner}:${id}`], extractionMethod: 'quick' });
    assert.deepEqual(await Promise.all([save(2), save(3)]), [true, true]);
    assert.equal(records.get(original.id).confirmationCount, 3);
    assert.ok(Math.abs(records.get(original.id).confidence - .74) < 1e-9);
    assert.deepEqual(new Set(records.get(original.id).sourceMessageIds), new Set([1, 2, 3].map(id => `tg:${owner}:${id}`)));
    for (let i = 0; i < 5; i++) assert.equal(await save(2), true);
    assert.equal(await save(2, .99), true);
    assert.equal(records.get(original.id).confirmationCount, 3);
    assert.ok(Math.abs(records.get(original.id).confidence - .74) < 1e-9);
});

test('an owner correction keeps fresh evidence and the complete former provenance in history', async () => {
    const original = fact({ retentionPolicy: 'durable', sourceEpisodeId: 'old-episode', sourceMemoryIds: ['old-source'] });
    const { service, records } = storage(original);
    const sourceText = 'Я ошибся: изучаю алгебру.';
    await service.updateMemory(original.id, original.domain, { ...original, content: 'Пользователь изучает алгебру.', object: 'алгебру' },
        { userCorrection: { userId: owner, sourceText, sourceMessageIds: [`api:${owner}:2`] } });
    const updated = records.get(original.id);
    assert.equal(updated.sourceContext, sourceText); assert.deepEqual(updated.sourceMessageIds, [`api:${owner}:2`]);
    assert.equal(updated.sourceEpisodeId, undefined); assert.equal(updated.sourceMemoryIds, undefined);
    assert.deepEqual(updated.lifecycleHistory[0].previous.sourceMemoryIds, ['old-source']);
    assert.equal(updated.lifecycleHistory[0].previous.sourceEpisodeId, 'old-episode');
});

test('a text correction cannot transfer a fact between people or leave a bound relation label inconsistent', async () => {
    const original = fact({ tags: ['subject:user', 'person_id:user', 'person_relation', 'relation_subject:user', 'relation_object:synthetic-person', 'relation_object_name:Вера Учебная'],
        predicate: 'parent_of', object: 'Вера Учебная', content: 'Дочь пользователя — Вера Учебная.' });
    const { service, writes } = storage(original);
    const evidence = { userCorrection: { userId: owner, sourceText: 'Это был другой человек.', sourceMessageIds: [`tg:${owner}:2`] } };
    await assert.rejects(service.updateMemory(original.id, original.domain, { ...original, subject: 'contact' }, evidence), /subject/);
    await assert.rejects(service.updateMemory(original.id, original.domain, { ...original, tags: [...original.tags, 'subject:contact'] }, evidence), /subject tag/);
    await assert.rejects(service.updateMemory(original.id, original.domain, { ...original, tags: original.tags.map(tag => tag.replace('relation_object:synthetic-person', 'relation_object:another-person')) }, evidence), /binding/);
    await assert.rejects(service.updateMemory(original.id, original.domain, { ...original, object: 'Ольга Учебная', content: 'Дочь пользователя — Ольга Учебная.' }, evidence), /label/);
    assert.equal(writes.length, 0);
    const contact = storage(fact({ subject: 'contact', tags: ['subject:contact', 'contact_username:synthetic_contact'] }));
    await assert.rejects(contact.service.updateMemory(original.id, original.domain, { ...contact.original, tags: ['subject:contact', 'contact_username:another_contact'] }, evidence), /binding/);
});

test('a delayed model decision bound to older recalled content is ignored', async t => {
    const original = fact(); const current = { ...original, content: 'Пользователь изучает алгебру.', object: 'алгебру' };
    let writes = 0;
    t.mock.method(factory, 'getVectorService', () => ({ fetchMemoryById: async () => current, updateMemory: async () => { writes++; } } as any));
    t.mock.method(completion, 'createChatCompletionForTask', async () => response({ decisions: [{ index: 0, action: 'update', subject: 'user', predicate: 'studies', object: 'геометрию', content: original.content }] }));
    await reconsolidateAfterResponse({ from: { id: Number(owner) }, chat: { type: 'private' } } as any, 'Я изучаю геометрию.', 'Помню.', [{ ...original, score: .9 }]);
    assert.equal(writes, 0);
});

test('background sleep cannot overwrite a fact revised after its scan', async t => {
    const { service, records, writes, original } = storage(fact({ tags: ['subject:user', 'temporal_scope:current_state'] }));
    t.mock.method(factory, 'getVectorService', () => service as any);
    t.mock.method(service, 'getRecentMemories', async () => {
        const snapshot = { ...clone(original), timestamp: original.timestamp };
        records.set(original.id, { ...records.get(original.id), content: 'Пользователь изучает алгебру.', object: 'алгебру' });
        return [snapshot];
    });
    const result = await runMemorySleepCycleForUser(owner);
    assert.equal(result.staleFactsSoftened, 0);
    assert.equal(writes.length, 0); assert.equal(records.get(original.id).object, 'алгебру');
});

test('a stale reminder refresh cannot undo a newer completion', async t => {
    const { service, records, writes, original } = storage(fact({ content: 'Напомнить о синтетической встрече.', status: 'planned', tags: ['subject:user', 'reminder-memory'] }));
    t.mock.method(factory, 'getVectorService', () => service as any);
    t.mock.method(service, 'getMemoriesByTag', async () => {
        const snapshot = clone(original);
        records.set(original.id, { ...records.get(original.id), status: 'done' });
        return [snapshot];
    });
    await createOrRefreshReminderMemoryForUserId(owner, { id: 'synthetic-reminder', text: 'Учебная встреча', time: new Date('2027-01-01') } as any);
    assert.equal(writes.length, 0); assert.equal(records.get(original.id).status, 'done');
});
