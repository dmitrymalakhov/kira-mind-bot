import assert from 'node:assert/strict';
import { PREDEFINED_DOMAINS } from '../constants/domains';

async function main() {
    const { QdrantVectorService } = await import('../services/QdrantVectorService');
    const indexCalls: Array<{ collection: string; args: any }> = [];
    const scrollCalls: Array<{ collection: string; args: any }> = [];
    const fakeClient = {
        createPayloadIndex: async (collection: string, args: any) => {
            indexCalls.push({ collection, args });
            return { status: 'completed' };
        },
        scroll: async (collection: string, args: any) => {
            scrollCalls.push({ collection, args });
            if (!collection.endsWith(`_${PREDEFINED_DOMAINS.TRAVEL}`)) {
                return { points: [] };
            }
            return {
                points: [{
                    id: 'flight',
                    payload: {
                        content: 'Рейс S7-104 вылетает в 09:15 из Домодедово',
                        timestamp: '2026-08-16T06:15:00.000Z',
                        importance: 0.8,
                        tags: ['entity:рейс_s7-104'],
                        domain: PREDEFINED_DOMAINS.TRAVEL,
                        userId: 'user-1',
                    },
                }],
            };
        },
    };

    const originalLog = console.log;
    try {
        console.log = () => undefined;
        const service = new QdrantVectorService(fakeClient as any) as any;
        service.ensureCollectionCompatibility = async () => 'exists';

        const results = await service.searchLexicalAllDomains('Когда рейс S7-104?', 'user-1', 5);
        assert.equal(results[0].id, 'flight');
        assert.ok(results[0].score >= 0.8);

        const travelCall = scrollCalls.find(call => call.collection.endsWith('_travel'));
        assert.ok(travelCall);
        assert.deepEqual(
            travelCall!.args.filter.min_should.conditions.map((condition: any) => condition.match.text),
            ['рейс', 's7-104']
        );
        assert.equal(travelCall!.args.filter.min_should.min_count, 1);
        assert.ok(travelCall!.args.filter.must.some((condition: any) => condition.key === 'userId'));
        assert.ok(travelCall!.args.filter.must_not.some((condition: any) => condition.key === 'expiresAt'));
        assert.ok(indexCalls.every(call => call.args.field_schema.type === 'text'));

        const domainCount = Object.values(PREDEFINED_DOMAINS).length;
        assert.equal(indexCalls.length, domainCount);
        await service.searchLexicalAllDomains('Когда рейс S7-104?', 'user-1', 5);
        assert.equal(indexCalls.length, domainCount, 'full-text index readiness must be cached');
    } finally {
        console.log = originalLog;
    }

    console.log('Qdrant hybrid lexical candidate tests passed');
}

void main();
