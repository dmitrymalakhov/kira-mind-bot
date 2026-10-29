import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QdrantVectorService } from '../services/QdrantVectorService';
import { PREDEFINED_DOMAINS } from '../constants/domains';

const owner = '900000051';
const point = (id: string, timestamp: string, domain = 'work') => ({ id, payload: {
    content: `Синтетический факт ${id}`, timestamp, domain, userId: owner, subject: 'user',
} });

test('recent recall orders before limiting, including records outside the first thousand IDs', async () => {
    const work = [
        ...Array.from({ length: 1100 }, (_, index) => point(`old-${index}`, '2020-01-01T00:00:00Z')),
        point('newest-work', '2026-10-29T12:00:00Z'), point('second-work', '2026-10-28T12:00:00Z'),
    ];
    const calls: any[] = [];
    let schemaWrites = 0, metadataReads = 0;
    const service = new QdrantVectorService({
        getCollection: async () => { metadataReads++; return { payload_schema: { timestamp: { data_type: 'datetime' } } }; },
        createPayloadIndex: async () => { schemaWrites++; throw Error('read-only role'); },
        scroll: async (collection: string, request: any) => {
            calls.push(request);
            const records = collection.endsWith('_work') ? work : collection.endsWith('_family')
                ? [point('newest-family', '2026-10-29T13:00:00Z', 'family')] : [];
            return { points: request.order_by?.key === 'timestamp'
                ? records.slice().sort((a, b) => b.payload.timestamp.localeCompare(a.payload.timestamp)).slice(0, request.limit)
                : records.slice(0, request.limit) };
        },
    } as any);
    assert.deepEqual((await service.getRecentMemories(owner, 3)).map(record => record.id), ['newest-family', 'newest-work', 'second-work']);
    assert.equal(calls.length, Object.values(PREDEFINED_DOMAINS).length);
    for (const request of calls) {
        assert.deepEqual(request.order_by, { key: 'timestamp', direction: 'desc' });
        assert.equal(request.limit, 3); assert.equal(request.with_vector, false);
        assert.ok(request.filter.must.some((condition: any) => condition.key === 'userId' && condition.match.value === owner));
        assert.ok(request.filter.must.some((condition: any) => condition.key === 'botId'));
        assert.ok(request.filter.must_not.some((condition: any) => condition.key === 'status'));
        assert.ok(request.filter.must_not.some((condition: any) => condition.key === 'expiresAt'));
    }
    await service.getRecentMemories(owner, 1);
    assert.equal(metadataReads, Object.values(PREDEFINED_DOMAINS).length, 'index readiness is cached for repeated reads');
    assert.equal(schemaWrites, 0, 'an existing timestamp index is usable without write permission');
});

test('concurrent recent reads share one timestamp index setup per collection', async () => {
    const writes: any[] = [];
    const service = new QdrantVectorService({
        getCollection: async () => ({ payload_schema: {} }),
        createPayloadIndex: async (collection: string, request: any) => { writes.push({ collection, ...request }); },
        scroll: async () => ({ points: [] }),
    } as any);
    await Promise.all([service.getRecentMemories(owner, 2), service.getRecentMemories(owner, 3)]);
    assert.equal(writes.length, Object.values(PREDEFINED_DOMAINS).length);
    assert.ok(writes.every(request => request.wait === true && request.field_name === 'timestamp' && request.field_schema === 'datetime'));
});

test('missing index permission reports unavailable recent recall rather than a misleading unordered page', async () => {
    let reads = 0, writes = 0, permitted = false;
    const service = new QdrantVectorService({
        getCollection: async () => ({ payload_schema: {} }),
        createPayloadIndex: async () => { writes++; if (!permitted) throw Error('synthetic index permission denied'); },
        scroll: async () => { reads++; return { points: [] }; },
    } as any);
    await assert.rejects(service.getRecentMemories(owner), /synthetic index permission denied/);
    assert.equal(reads, 0); assert.equal(writes, 1);
    permitted = true;
    assert.deepEqual(await service.getRecentMemories(owner), []);
    assert.equal(reads, Object.values(PREDEFINED_DOMAINS).length);
});

test('zero recent limit does no work and large limits stay bounded', async () => {
    const limits: number[] = [];
    const service = new QdrantVectorService({
        getCollection: async () => ({ payload_schema: { timestamp: { data_type: 'datetime' } } }),
        scroll: async (_collection: string, request: any) => { limits.push(request.limit); return { points: [] }; },
    } as any);
    assert.deepEqual(await service.getRecentMemories(owner, 0), []);
    assert.deepEqual(await service.getRecentMemories(owner, -10), []);
    assert.deepEqual(limits, []);
    await service.getRecentMemories(owner, 100_000);
    assert.ok(limits.every(limit => limit === 1000));
});
