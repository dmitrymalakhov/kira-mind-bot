import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MemoryEntry } from '../types';
import { QdrantVectorService } from '../services/QdrantVectorService';
import * as factory from '../services/VectorServiceFactory';
import * as completion from '../ai/chatCompletion';
import { inferMemoryRetention } from '../utils/memoryRetention';
import { saveMemory, deleteMemoryById } from '../utils/enhancedDomainMemory';
import { quickFactCheck } from '../utils/enhancedFactExtraction';
import { reconsolidateAfterResponse } from '../services/MemoryReconsolidationService';
import { auditMemoryRetentionLifecycle } from '../utils/memoryAudit';
import { addToHistory } from '../utils/history';
import { factAnalysisManager } from '../utils/factAnalysisTimer';

const owner = '900000051';
const fact = (extra: Partial<MemoryEntry> = {}): MemoryEntry => ({
    id: 'synthetic-family', content: 'Дочь пользователя — Вера Учебная.', domain: 'family', timestamp: new Date('2020-01-01'),
    userId: owner, botId: 'synthetic', subject: 'user', predicate: 'parent_of', object: 'Вера Учебная',
    confidence: .9, importance: .4, tags: ['subject:user', 'temporal_scope:relationship', 'inference:direct'],
    sourceContext: 'Мою дочь зовут Вера Учебная.', sourceMessageIds: ['tg:900000051:1'], extractionMethod: 'quick', status: 'active', ...extra,
});
const response = (data: unknown) => ({ choices: [{ message: { content: JSON.stringify(data) } }] } as any);

function storage(records: MemoryEntry[] = [fact()]) {
    const writes: any[] = [], deletions: any[] = [], reads: any[] = [];
    const service: any = new QdrantVectorService({
        retrieve: async (_collection: string, options: any) => records.filter(record => options.ids.includes(record.id)).map(record => ({ id: record.id, payload: record })),
        upsert: async (_collection: string, options: any) => { writes.push(options.points[0].payload); },
        overwritePayload: async (_collection: string, options: any) => { writes.push(options.payload); },
        delete: async (_collection: string, options: any) => { deletions.push(...options.points); },
        scroll: async (collection: string, options: any) => { reads.push(options); return { points: collection.endsWith('_family') ? records.map(record => ({ id: record.id, payload: record })) : [] }; },
    } as any);
    records.forEach(record => { record.botId = service.botId; });
    service.ensureCollectionCompatibility = async () => 'exists';
    service.embed = async () => [1, 0];
    return { service: service as QdrantVectorService, writes, deletions, reads };
}

test('grounded lasting assertions are durable across subjects and themes; plans, inferences and summaries are not', () => {
    for (const scope of ['stable', 'relationship', 'preference', 'routine', 'past_event']) {
        assert.equal(inferMemoryRetention(fact({ tags: ['subject:user', `temporal_scope:${scope}`] })), 'durable');
    }
    assert.equal(inferMemoryRetention(fact({ subject: 'contact', tags: ['subject:contact', 'person_id:synthetic-person', 'temporal_scope:stable'] })), 'durable');
    for (const changes of [
        { tags: ['temporal_scope:future_plan'] }, { tags: ['temporal_scope:current_state'] },
        { tags: ['temporal_scope:stable', 'temporal_scope:future_plan'] }, { status: 'planned' as const },
        { sourceContext: '' }, { sourceMessageIds: [], sourceMemoryIds: [] }, { confidence: .4 },
        { tags: ['temporal_scope:stable', 'inference:inferred'] }, { subject: 'unknown' as const },
        { subject: 'contact' as const, tags: ['subject:contact', 'temporal_scope:stable'] },
        { tags: ['subject:contact', 'temporal_scope:stable'] }, { memoryKind: 'chapter' as const },
        { content: 'Дочь пользователя — Вера Учебная; завтра поездка.' },
    ]) assert.equal(inferMemoryRetention(fact(changes)), 'standard', JSON.stringify(changes));
});

test('Qdrant persists retention without a TTL and does not promote unsupported flags or temporary anchors', async () => {
    const { service, writes } = storage([]);
    await service.saveMemory(fact({ expiresAt: new Date('2021-01-01') }));
    assert.equal(writes[0].retentionPolicy, 'durable'); assert.equal(writes[0].expiresAt, undefined);
    await service.saveMemory(fact({ retentionPolicy: 'durable', sourceContext: '', isAnchor: true }));
    assert.equal(writes[1].retentionPolicy, undefined);
    await service.saveMemory(fact({ status: 'planned', tags: ['temporal_scope:future_plan'], isAnchor: true, expiresAt: new Date('2030-01-01') }));
    assert.equal(writes[2].retentionPolicy, undefined); assert.equal(writes[2].expiresAt, '2030-01-01T00:00:00.000Z');
});

test('automatic updates cannot expire, overwrite, demote or reassign protected knowledge', async () => {
    const original = fact({ retentionPolicy: 'durable' });
    const { service, writes } = storage([original]);
    for (const changes of [
        { expiresAt: new Date() }, { status: 'expired' as const }, { status: 'superseded' as const },
        { content: 'Дочь пользователя — Ольга Учебная.' }, { object: 'другой ребёнок' }, { negated: true },
        { predicate: 'works_with' }, { subject: 'contact' as const }, { retentionPolicy: 'standard' as const },
        { confidence: .3 },
        { tags: ['person_id:other-synthetic-person'] }, { userId: 'other-owner' },
    ]) await assert.rejects(service.updateMemory(original.id, original.domain, { ...original, ...changes }));
    assert.equal(writes.length, 0);
    await service.updateMemory(original.id, original.domain, { ...original, confidence: .95, importance: .5 });
    assert.equal(writes.length, 1); assert.equal(writes[0].retentionPolicy, 'durable');
});

test('evidenced owner corrections remain possible with the previous assertion and source in a lifecycle journal', async () => {
    const original = fact({ retentionPolicy: 'durable' });
    const { service, writes } = storage([original]);
    const patch = { ...original, status: 'superseded' as const, expiresAt: new Date() };
    await assert.rejects(service.updateMemory(original.id, original.domain, patch, { userCorrection: { userId: 'other-owner', sourceText: 'Это была ошибка.', sourceMessageIds: ['tg:other:2'] } }));
    await assert.rejects(service.updateMemory(original.id, original.domain, patch, { userCorrection: { userId: owner, sourceText: 'Это была ошибка.', sourceMessageIds: [] } }));
    await service.updateMemory(original.id, original.domain, patch, { userCorrection: { userId: owner, sourceText: 'Это была ошибка.', sourceMessageIds: ['tg:900000051:2'] } });
    assert.equal(writes.length, 1); assert.equal(writes[0].status, 'superseded'); assert.equal(writes[0].retentionPolicy, 'durable');
    assert.equal(writes[0].lifecycleHistory[0].previous.content, original.content);
    assert.deepEqual(writes[0].lifecycleHistory[0].sourceMessageIds, ['tg:900000051:2']);
});

test('legacy protection becomes persistent during metadata updates and corrections cannot introduce a composite', async () => {
    const original = fact();
    const { service, writes } = storage([original]);
    await service.updateMemory(original.id, original.domain, { ...original, tags: ['subject:user'], confidence: .95 });
    assert.equal(writes[0].retentionPolicy, 'durable');
    await assert.rejects(service.updateMemory(original.id, original.domain,
        { ...original, content: 'Дочь пользователя — Ольга Учебная; завтра поездка.' },
        { userCorrection: { userId: owner, sourceText: 'Поправь имя и запомни поездку.', sourceMessageIds: ['tg:900000051:2'] } }));
    assert.equal(writes.length, 1);
});

test('cleanup preserves durable history and mixed legacy rows while removing old low-value temporary facts', async () => {
    const records = [fact(), fact({ id: 'durable-history', retentionPolicy: 'durable', status: 'superseded', expiresAt: new Date('2020-02-01') }),
        fact({ id: 'mixed', content: 'Пользователь любит горы; завтра поездка.', tags: [], importance: .1 }),
        fact({ id: 'unclassified-primary', content: 'Пользователь умеет играть на гитаре.', tags: [], importance: .1 }),
        fact({ id: 'open-ended-state', content: 'Пользователь живёт в Учебногорске.', tags: ['temporal_scope:current_state'], importance: .1 }),
        fact({ id: 'unknown-expiry', content: 'Пользователь умеет играть на флейте.', tags: [], importance: .1, expiresAt: new Date('2020-02-01') }),
        fact({ id: 'temporary', content: 'Жду посылку.', tags: ['temporal_scope:future_plan'], status: 'planned', importance: .1, expiresAt: new Date('2020-02-01') }),
    ];
    const { service, deletions } = storage(records);
    assert.equal(await service.cleanupOldMemories(owner), 1);
    assert.deepEqual(deletions, ['temporary']);
});

test('automatic deletion is blocked but the explicit owner deletion entry point still works', async t => {
    const original = fact({ retentionPolicy: 'durable' });
    const unclassified = fact({ id: 'unclassified', tags: [], sourceContext: '' });
    const derived = fact({ id: 'derived', memoryKind: 'chapter' });
    const { service, deletions } = storage([original, unclassified, derived]);
    await assert.rejects(service.deleteMemory(original.id, original.domain));
    await assert.rejects(service.deleteMemory(unclassified.id, unclassified.domain));
    await assert.rejects(service.deleteMemory(original.id, original.domain, { userDeletion: { userId: 'other-owner' } }));
    t.mock.method(factory, 'getVectorService', () => service as any);
    await deleteMemoryById({ from: { id: Number(owner) } } as any, original.id, original.domain);
    await service.deleteMemory(derived.id, derived.domain);
    assert.deepEqual(deletions, [original.id, derived.id]);
});

test('archive-inclusive audits retain terminal facts without admitting them to ordinary recall', async () => {
    const records = [fact(), fact({ id: 'superseded-without-ttl', status: 'superseded' }), fact({ id: 'expired', expiresAt: new Date('2020-02-01') })];
    const { service, reads } = storage(records);
    assert.deepEqual((await service.getAllMemories(owner)).map(record => record.id), ['synthetic-family']);
    assert.equal((await service.getAllMemories(owner, { includeArchived: true })).length, 3);
    assert.ok(reads.every(read => read.filter.must.some((item: any) => item.key === 'userId' && item.match.value === owner)));
    assert.equal(await service.fetchMemoryById('superseded-without-ttl', 'family', owner), null);
});

test('archive reconciliation records source coverage and accepts only confirmed atomic replacements', () => {
    const old = fact({ id: 'old-composite', content: 'Дочь пользователя — Вера Учебная; завтра поездка.',
        expiresAt: new Date('2020-02-01'), tags: ['planning-superseded'], sourceMessageIds: ['tg:900000051:1', 'tg:900000051:2'] });
    const replacement = fact({ id: 'confirmed-atomic', extractionMethod: 'manual', sourceMemoryIds: [old.id] });
    const messages = [{ ref: 'tg:900000051:1', text: 'Мою дочь зовут Вера Учебная.', senderId: owner }];
    let audit = auditMemoryRetentionLifecycle([old], messages);
    assert.equal(audit.planningSuspects, 1); assert.equal(audit.reviewed[0].state, 'source_review_required');
    assert.equal(audit.reviewed[0].ownerMessages, 1); assert.deepEqual(audit.reviewed[0].missingSourceRefs, ['tg:900000051:2']);
    for (const invalid of [fact({ id: 'model-repeat', sourceMemoryIds: [old.id] }),
        { ...replacement, userId: 'other-owner' }, { ...replacement, memoryKind: 'chapter' as const },
    ]) assert.equal(auditMemoryRetentionLifecycle([old, invalid], messages).reviewed[0].state, 'source_review_required');
    audit = auditMemoryRetentionLifecycle([old, replacement], messages);
    assert.equal(audit.reviewed[0].state, 'confirmed_replacement'); assert.deepEqual(audit.reviewed[0].replacementIds, [replacement.id]);
    assert.equal(old.expiresAt!.getTime(), new Date('2020-02-01').getTime());
});

test('durable retrieval ranking does not demote an established fact solely because it is old', () => {
    const { service } = storage([]);
    const records = [fact({ id: 'old', retentionPolicy: 'durable' }), fact({ id: 'recent', timestamp: new Date(), retentionPolicy: 'durable' })]
        .map(record => ({ ...record, score: .9 }));
    assert.deepEqual((service as any).applyImportanceRecencyRanking(records).map((record: any) => record.id), ['old', 'recent']);
});

test('the public save path stores a lasting assertion and preserves its wording on semantic confirmation', async t => {
    const original = fact({ retentionPolicy: 'durable' });
    const { service, writes } = storage([original]);
    t.mock.method(service, 'searchMemories', async () => [{ ...original, score: .99 }]);
    t.mock.method(service, 'searchAllDomains', async () => [{ ...original, score: .99 }]);
    t.mock.method(factory, 'getVectorService', () => service as any);
    t.mock.method(completion, 'createChatCompletionForTask', async () => response({ state_change: false }));
    assert.equal(await saveMemory({ from: { id: Number(owner) }, session: {} } as any, original.domain, 'Мою дочь зовут Вера Учебная.', .4,
        original.tags, false, { subject: 'user', predicate: original.predicate, object: original.object, sourceContext: 'Мою дочь зовут Вера Учебная.', sourceMessageIds: ['tg:900000051:3'], extractionMethod: 'quick' }), true);
    assert.equal(writes.length, 1); assert.equal(writes[0].content, original.content); assert.equal(writes[0].retentionPolicy, 'durable');
});

test('quick extraction carries the existing temporal contract and rejects arbitrary model tag overrides', async t => {
    t.mock.method(completion, 'createChatCompletionForTask', async () => response({ facts: [
        { content: 'Дочь пользователя — Вера Учебная.', subject: 'user', predicate: 'parent_of', object: 'Вера Учебная', domain: 'family', temporalScope: 'relationship', tags: ['temporal_scope:future_plan'] },
        { content: 'Завтра поездка.', subject: 'user', predicate: 'trip', object: 'учебный слёт', domain: 'travel', temporalScope: 'invented', tags: ['temporal_scope:stable'] },
    ] }));
    const results = await quickFactCheck('Мою дочь зовут Вера Учебная. Завтра поездка.');
    assert.deepEqual(results.map(result => result.tags), [['temporal_scope:relationship'], ['temporal_scope:unknown']]);
});

test('Telegram and app history entry points persist durable facts with their current user evidence', async t => {
    const { service, writes } = storage([]);
    t.mock.method(service, 'searchMemories', async () => []);
    t.mock.method(service, 'searchAllDomains', async () => []);
    t.mock.method(factory, 'getVectorService', () => service as any);
    t.mock.method(factAnalysisManager, 'scheduleAnalysis', () => {});
    t.mock.method(completion, 'createChatCompletionForTask', async (task: string) => response(task === 'memoryExtraction'
        ? { facts: [{ content: 'Дочь пользователя — Вера Учебная.', domain: 'family', subject: 'user', predicate: 'parent_of', object: 'Вера Учебная', temporalScope: 'relationship', importance: .4 }] }
        : { state_change: false }));
    for (const channel of ['telegram', 'api']) {
        const ctx = { from: { id: Number(owner) }, chat: { id: Number(owner), type: 'private' },
            sessionStorageKey: `${channel}:${owner}`, session: { messageHistory: [], domains: {}, reminders: [], dialogueSummary: '', lastSummarizedIndex: -1 } } as any;
        await addToHistory(ctx, 'user', 'Мою дочь зовут Вера Учебная.');
        assert.equal(ctx.session.messageHistory.length, 1);
        assert.equal(ctx.session.recentlySavedFacts.length, 1);
    }
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(writes.length, 2);
    for (const written of writes) {
        assert.equal(written.userId, owner); assert.equal(written.retentionPolicy, 'durable'); assert.equal(written.expiresAt, undefined);
        assert.equal(written.sourceContext, 'Мою дочь зовут Вера Учебная.'); assert.ok(written.sourceMessageIds[0].startsWith('history:user:'));
    }
});

test('reconsolidation requires a verbatim current owner correction for a durable assertion', async t => {
    const original = fact({ retentionPolicy: 'durable' });
    const patches: any[] = [];
    let correctionEvidence = 'выдуманная поправка', explicitCorrection = true;
    t.mock.method(factory, 'getVectorService', () => ({ fetchMemoryById: async () => original,
        updateMemory: async (...args: any[]) => { patches.push(args); } } as any));
    t.mock.method(completion, 'createChatCompletionForTask', async () => response({ decisions: [{ index: 0, action: 'supersede', explicitCorrection, correctionEvidence }] }));
    const text = 'Это была ошибка, прежнее утверждение неверно.';
    const ctx = { from: { id: Number(owner) }, chat: { id: Number(owner), type: 'private' }, message: { message_id: 7 } } as any;
    const run = () => reconsolidateAfterResponse(ctx, text, 'Поняла.', [{ ...original, score: .9 }]);
    await run(); assert.equal(patches.length, 0);
    correctionEvidence = text; explicitCorrection = false;
    await run(); assert.equal(patches.length, 0);
    explicitCorrection = true;
    await run(); assert.equal(patches.length, 1);
    assert.equal(patches[0][3].userCorrection.sourceText, text);
    assert.deepEqual(patches[0][3].userCorrection.sourceMessageIds, ['tg:900000051:7']);
});

test('a durable correction keeps semantic polarity consistent and records the previous polarity', async t => {
    const original = fact({ content: 'У пользователя есть собака.', predicate: 'has_pet', object: 'собака', negated: false, retentionPolicy: 'durable', sourceContext: 'У меня есть собака.' });
    const { service, writes } = storage([original]);
    t.mock.method(factory, 'getVectorService', () => service as any);
    const message = 'Исправь: у меня больше нет собаки.';
    t.mock.method(completion, 'createChatCompletionForTask', async () => response({ decisions: [{ index: 0, action: 'update',
        content: 'У пользователя больше нет собаки.', subject: 'user', predicate: 'has_pet', object: 'собаки', negated: true,
        explicitCorrection: true, correctionEvidence: message }] }));
    await reconsolidateAfterResponse({ from: { id: Number(owner) }, chat: { id: Number(owner), type: 'private' }, message: { message_id: 9 } } as any,
        message, 'Поняла.', [{ ...original, score: .9 }]);
    assert.equal(writes.length, 1); assert.equal(writes[0].negated, true);
    assert.equal(writes[0].lifecycleHistory[0].previous.negated, false);
});
