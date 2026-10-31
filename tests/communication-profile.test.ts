import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { CommunicationProfileService, CommunicationProfileConflict, BotSettingsCommunicationStore,
    explicitCommunicationPreference, parseCommunicationPatch, communicationProfileContext, type CommunicationProfileStore } from '../services/communicationProfileService';
import * as vector from '../services/VectorServiceFactory';
import { recordMemoryReadFailure } from '../utils/memoryReadCoverage';
import { AppDataSource } from '../data-source';
import { config } from '../config';
import { conversationAgent } from '../agents/conversationAgent';
import * as completion from '../ai/chatCompletion';
import * as selfMemory from '../utils/kiraSelfMemory';
import * as evolution from '../services/kiraSelfEvolutionService';
import * as residence from '../services/kiraResidenceService';
import * as groups from '../services/groupChatFeatureSettings';
import type { SearchResult } from '../types';

const owner = 741900;
class Store implements CommunicationProfileStore {
    rows = new Map<string, string>();
    failRead = false; failWrite = false; writes = 0;
    async read(key: string) { if (this.failRead) throw Error('synthetic private database error'); return this.rows.get(key); }
    async insert(key: string, value: string) { if (this.failWrite) throw Error('synthetic database write error'); if (this.rows.has(key)) return false; this.rows.set(key, value); this.writes++; return true; }
    async replace(key: string, previous: string, value: string) { if (this.failWrite) throw Error('synthetic database write error'); if (this.rows.get(key) !== previous) return false; this.rows.set(key, value); this.writes++; return true; }
}
const record = (patch: Partial<SearchResult> = {}): SearchResult => ({ id: 'synthetic-memory', content: 'Предпочтительное имя пользователя: Лис.',
    subject: 'user', predicate: 'preferred_name', object: 'Лис', timestamp: new Date('2026-01-01T00:00:00Z'), score: 1, importance: .8,
    domain: 'personal', tags: ['subject:user'], memoryKind: 'fact', confidence: .95, ...patch });
function memories(t: TestContext, records: SearchResult[] = [record()]) {
    return t.mock.method(vector, 'getVectorService', () => ({ getOwnerMemories: async (id: string, _domains: string[], _limit: number, options: any) => {
        assert.equal(id, String(owner)); return records.filter(r => options.acceptCandidate(r));
    } }) as any);
}

test('only explicit scoped, active atomic communication preferences can migrate; no identity or display-name guessing', () => {
    assert.equal(explicitCommunicationPreference(record())?.value, 'Лис');
    assert.equal(explicitCommunicationPreference(record({ predicate: 'preferredName' }))?.value, 'Лис');
    for (const patch of [
        { subject: 'contact' }, { subject: 'bot' }, { subject: 'unknown' }, { subject: undefined, tags: [] },
        { tags: ['subject:contact'] }, { tags: ['source_chat:synthetic'] }, { tags: ['source_contact:synthetic'] },
        { predicate: 'name' }, { predicate: 'email' }, { object: 'Неподтверждённое имя' }, { negated: true },
        { status: 'superseded' }, { status: 'expired' }, { memoryKind: 'chapter' }, { memoryKind: 'episode' },
        { sourceMemoryIds: ['synthetic-parent'] }, { confidence: .5 }, { timestamp: new Date('bad') },
        { validFrom: new Date(Date.now() + 100000) }, { expiresAt: new Date(0) }, { validTo: new Date(0) }, { expiresAt: new Date('bad') },
    ]) assert.equal(explicitCommunicationPreference(record(patch as Partial<SearchResult>)), undefined, JSON.stringify(patch));
    assert.deepEqual(explicitCommunicationPreference(record({ predicate: 'preferred_address', content: 'Обращение: вы', object: 'вы' }))?.value, 'formal');
    assert.equal(explicitCommunicationPreference(record({ predicate: 'reply_length', content: 'Предпочитает подробно', object: 'подробно' }))?.value, 'detailed');
});

test('migration persists explicit memory once; null clears permanently and omitted fields preserve value, source and time', async t => {
    const read = memories(t, [record(), record({ id: 'reply', predicate: 'reply_length', content: 'Ответы: кратко', object: 'кратко' })]);
    const store = new Store(), service = new CommunicationProfileService(owner, store);
    const initial = await service.read();
    assert.deepEqual(initial.name, { value: 'Лис', state: 'known', source: 'memory', updatedAt: '2026-01-01T00:00:00.000Z' });
    assert.deepEqual(initial.address, { value: null, state: 'unknown', source: null, updatedAt: null });
    const cleared = await service.patch({ expectedRevision: initial.revision, name: null });
    assert.deepEqual(cleared.replyLength, initial.replyLength);
    assert.deepEqual(cleared.name.value, null); assert.equal(cleared.name.state, 'unknown'); assert.equal(cleared.name.source, 'setting');
    assert.ok(cleared.name.updatedAt); assert.notEqual(cleared.revision, initial.revision);
    const restarted = new CommunicationProfileService(owner, store, async () => { throw Error('must not remigrate'); });
    assert.deepEqual(await restarted.read(), cleared);
    assert.equal(read.mock.callCount(), 1);
    const changed = await restarted.patch({ expectedRevision: cleared.revision, address: 'formal' });
    assert.deepEqual(changed.name, cleared.name); assert.equal(changed.address.value, 'formal');
});

test('same-time conflicting memory preferences stay unknown; newest explicit preference wins over older active evidence', async t => {
    memories(t, [record(), record({ id: 'second', content: 'Предпочтительное имя: Сокол', object: 'Сокол' })]);
    const store = new Store();
    assert.equal((await new CommunicationProfileService(owner, store).read()).name.state, 'unknown');
    memories(t, [record(), record({ id: 'latest', timestamp: new Date('2026-02-02T00:00:00Z'), content: 'Предпочтительное имя: Сокол', object: 'Сокол' })]);
    assert.equal((await new CommunicationProfileService(owner, new Store()).read()).name.value, 'Сокол');
});

test('owner keys, concurrent initialization, revisions and competing edits remain isolated', async () => {
    const store = new Store(), migrate = async () => ({});
    const a = new CommunicationProfileService(owner, store, migrate), b = new CommunicationProfileService(owner + 1, store, migrate);
    const [first, same] = await Promise.all([a.read(), new CommunicationProfileService(owner, store, migrate).read()]);
    assert.deepEqual(first, same); assert.equal(store.rows.size, 1);
    const other = await b.read();
    const results = await Promise.allSettled([a.patch({ expectedRevision: first.revision, name: 'Лис' }), a.patch({ expectedRevision: first.revision, name: 'Сокол' })]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    const conflict = (results.find(r => r.status === 'rejected') as PromiseRejectedResult).reason;
    assert.ok(conflict instanceof CommunicationProfileConflict); assert.deepEqual(conflict.profile, await a.read());
    assert.deepEqual(await b.read(), other); assert.equal(store.rows.size, 2);
});

test('invalid patch, database failure, corrupt saved state and partial memory reads never erase or claim an empty profile', async t => {
    for (const patch of [{}, { name: 'Лис' }, { expectedRevision: 'x' }, { expectedRevision: 'x', name: '' },
        { expectedRevision: 'x', name: ' Лис' }, { expectedRevision: 'x', name: 'a\nb' }, { expectedRevision: 'x', name: 'x'.repeat(81) },
        { expectedRevision: 'x', name: 'Лис', ownerId: owner + 1 }, { expectedRevision: 'x', address: 'ты' }, { expectedRevision: 'x', replyLength: 'medium' }])
        assert.throws(() => parseCommunicationPatch(patch), (e: any) => e.code === 'invalid_communication_profile');
    const store = new Store(), service = new CommunicationProfileService(owner, store, async () => ({}));
    store.failRead = true;
    await assert.rejects(service.read(), (e: any) => e.status === 503 && !e.message.includes('synthetic private'));
    assert.equal(store.writes, 0); store.failRead = false;
    const first = await service.read(); store.failWrite = true;
    await assert.rejects(service.patch({ expectedRevision: first.revision, name: 'Лис' }), (e: any) => e.status === 503);
    assert.deepEqual(await service.read(), first); store.failWrite = false;
    store.rows.set([...store.rows.keys()][0], '{corrupt');
    await assert.rejects(service.read(), (e: any) => e.status === 503);
    const partial = new Store();
    t.mock.method(vector, 'getVectorService', () => ({ getOwnerMemories: async () => { recordMemoryReadFailure(Error('synthetic failure')); return []; } }) as any);
    await assert.rejects(new CommunicationProfileService(owner, partial).read(), (e: any) => e.status === 503);
    assert.equal(partial.writes, 0);
    if (!AppDataSource.isInitialized) await assert.rejects(new BotSettingsCommunicationStore().read('synthetic'), (e: any) => e.status === 503);
});

function defaultRepository(t: TestContext, store: Store) {
    const initialized = AppDataSource.isInitialized; (AppDataSource as any).isInitialized = true;
    t.after(() => { (AppDataSource as any).isInitialized = initialized; });
    t.mock.method(AppDataSource, 'getRepository', () => ({
        findOneBy: async ({ key }: any) => { const value = await store.read(key); return value === undefined ? null : { key, value }; },
        createQueryBuilder: () => { let row: any, clause: any, update = false;
            const b: any = { insert: () => b, update: () => { update = true; return b; }, values: (v: any) => { row = v; return b; }, set: (v: any) => { row = v; return b; },
                orIgnore: () => b, returning: () => b, where: (_: any, params: any) => { clause = params; return b; },
                execute: async () => update ? { affected: await store.replace(clause.key, clause.previous, row.value) ? 1 : 0 } : { raw: await store.insert(row.key, row.value) ? [row.key] : [] } };
            return b;
        },
    }) as any);
}

test('a saved preference reaches the actual next conversation system prompt in both account channels, with fresh values and nulls', async t => {
    const previous = config.allowedUserId; config.allowedUserId = owner; t.after(() => { config.allowedUserId = previous; });
    const store = new Store(); defaultRepository(t, store);
    const service = new CommunicationProfileService(owner, store, async () => ({}));
    const initial = await service.read();
    const first = await service.patch({ expectedRevision: initial.revision, name: 'Лис', address: 'formal', replyLength: 'detailed' });
    t.mock.method(groups, 'isGroupChatContextEnabled', async () => false);
    t.mock.method(selfMemory, 'getRecentKiraSelfEvents', async () => []); t.mock.method(selfMemory, 'searchKiraSelfEventsByQuery', async () => []);
    t.mock.method(selfMemory, 'getKiraSelfMemoryState', async () => null as any);
    t.mock.method(residence, 'getKiraResidence', async () => ({ city: 'Синтетический город' }) as any);
    t.mock.method(residence, 'detectKiraRelocationIntent', async () => null);
    t.mock.method(evolution, 'maybeEvolveKiraSelfFromConversation', async () => undefined);
    const prompts: string[] = [];
    t.mock.method(completion, 'createChatCompletionForTask', async (_task: any, args: any) => { prompts.push(args.messages[0].content); return { choices: [{ message: { content: 'Синтетический ответ.' } }] } as any; });
    for (const channel of ['api', 'telegram']) {
        const ctx = { from: { id: owner }, chat: { id: owner, type: 'private' }, session: { messageHistory: [] }, ...(channel === 'api' ? { sessionStorageKey: `api:${owner}` } : {}) } as any;
        await conversationAgent(ctx, 'Объясни устройство маятника.', false, '', [], undefined, { domain: 'personal', context: '', allowSideEffects: false } as any);
        assert.ok(prompts.at(-1)?.includes('"name":"Лис","address":"formal","replyLength":"detailed"'));
    }
    await service.patch({ expectedRevision: first.revision, name: null, replyLength: 'short' });
    const ctx = { from: { id: owner }, chat: { type: 'private' } } as any;
    assert.match(await communicationProfileContext(ctx), /"name":null,"address":"formal","replyLength":"short"/);
    assert.equal(await communicationProfileContext({ ...ctx, from: { id: owner + 1 } }), '');
    assert.equal(await communicationProfileContext({ ...ctx, chat: { type: 'group' } }), '');
});
