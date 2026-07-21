import assert from 'assert';

process.env.KIRA_BOT_TOKEN = process.env.KIRA_BOT_TOKEN || 'test-token';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-openai-key';

async function main() {
    const { QdrantVectorService } = await import('../services/QdrantVectorService');
    const { resolveMemoryEmbeddingConfig } = await import('../ai/memoryEmbeddingResolver');
    const originalConsoleLog = console.log;
    const originalConsoleError = console.error;

    try {
        console.log = () => undefined;
        console.error = () => undefined;

        const service = new QdrantVectorService() as any;
        const { profileName, config } = resolveMemoryEmbeddingConfig();
        const expected = {
            size: config.outputDimension,
            distance: config.distance,
            provider: config.provider,
            model: config.model,
            profileName,
        };
        const validationKey = service.buildCollectionValidationKey(expected);

        let revalidated = false;
        service.validatedCollections.set('test_collection', 'stale-profile-key');
        service.checkCollectionExists = async () => {
            revalidated = true;
            return true;
        };
        service.getCollectionVectorConfig = async () => ({
            size: config.outputDimension,
            distance: config.distance,
        });

        const staleResult = await service.ensureCollectionCompatibility('test_collection');
        assert.strictEqual(staleResult, 'exists');
        assert.strictEqual(revalidated, true, 'stale validation key must trigger compatibility recheck');

        revalidated = false;
        service.validatedCollections.set('test_collection', validationKey);
        service.checkCollectionExists = async () => {
            revalidated = true;
            return true;
        };

        const cachedResult = await service.ensureCollectionCompatibility('test_collection');
        assert.strictEqual(cachedResult, 'exists');
        assert.strictEqual(revalidated, false, 'matching validation key should reuse compatibility cache');

        service.validatedCollections.delete('test_collection');
        service.checkCollectionExists = async () => true;
        service.getCollectionVectorConfig = async () => ({
            size: config.outputDimension * 2,
            distance: config.distance,
        });

        await assert.rejects(
            () => service.ensureCollectionCompatibility('test_collection'),
            /несовместима с memory profile/
        );

        console.log('Qdrant memory profile compatibility cache tests passed');
    } finally {
        console.log = originalConsoleLog;
        console.error = originalConsoleError;
    }
}

void main();
