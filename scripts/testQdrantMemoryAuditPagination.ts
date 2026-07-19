import assert from 'node:assert/strict';

process.env.KIRA_BOT_TOKEN = process.env.KIRA_BOT_TOKEN || 'synthetic-test-token';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'synthetic-test-key';

async function main(): Promise<void> {
    const { QdrantVectorService } = await import('../services/QdrantVectorService');
    const workOffsets: Array<string | number | undefined> = [];
    const timestamp = new Date('2026-01-01T00:00:00.000Z').toISOString();

    const fakeClient = {
        scroll: async (collection: string, options: { offset?: string | number }) => {
            if (!collection.endsWith('_work')) return { points: [] };
            workOffsets.push(options.offset);
            if (options.offset === undefined) {
                return {
                    points: [{
                        id: 101,
                        payload: { content: 'Синтетический факт 1', timestamp, domain: 'work' },
                    }],
                    next_page_offset: 101,
                };
            }
            return {
                points: [{
                    id: 202,
                    payload: { content: 'Синтетический факт 2', timestamp, domain: 'work' },
                }],
            };
        },
    };
    const service = new QdrantVectorService(
        fakeClient as unknown as ConstructorParameters<typeof QdrantVectorService>[0],
    );

    const entries = await service.getAllMemories('900000011');
    assert.deepEqual(workOffsets, [undefined, 101]);
    assert.deepEqual(entries.map(entry => entry.id), ['101', '202']);

    const repeatingClient = {
        scroll: async (collection: string) => collection.endsWith('_work')
            ? { points: [], next_page_offset: 777 }
            : { points: [] },
    };
    const repeatingService = new QdrantVectorService(
        repeatingClient as unknown as ConstructorParameters<typeof QdrantVectorService>[0],
    );
    await assert.rejects(
        () => repeatingService.getAllMemories('900000012'),
        /Qdrant pagination repeated offset/u,
    );
    console.log('qdrant memory audit pagination checks passed');
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
