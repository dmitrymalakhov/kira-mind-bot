import assert from 'assert';
import { AppDataSource } from '../data-source';
import { BotSettingEntity } from '../entity/BotSettingEntity';
import {
    getActiveAiPresetName,
    refreshActiveAiPresetName,
} from '../services/aiRuntimeConfigService';
import { resolveModelForTaskFreshAsync } from '../ai/modelResolver';

interface InMemorySettingsRepo {
    findOneBy(criteria: { key: string }): Promise<{ key: string; value: string } | null>;
}

async function main(): Promise<void> {
    let storedPreset = 'gemini-full';
    let reads = 0;
    let failReads = false;
    const originalConsoleWarn = console.warn;
    const originalGetRepository = Object.getOwnPropertyDescriptor(AppDataSource, 'getRepository');
    const originalIsInitialized = Object.getOwnPropertyDescriptor(AppDataSource, 'isInitialized');
    const repo: InMemorySettingsRepo = {
        async findOneBy(criteria) {
            assert.strictEqual(criteria.key, 'AI_MODEL_PRESET');
            reads += 1;
            if (failReads) throw new Error('database unavailable');
            return { key: criteria.key, value: storedPreset };
        },
    };

    Object.defineProperty(AppDataSource, 'isInitialized', {
        configurable: true,
        value: true,
    });
    Object.defineProperty(AppDataSource, 'getRepository', {
        configurable: true,
        value: (_entity: typeof BotSettingEntity) => repo,
    });
    console.warn = () => undefined;

    try {
        assert.strictEqual(await getActiveAiPresetName(), 'gemini-full');
        storedPreset = 'gpt-balanced';

        // Обычный путь сохраняет кеш, а retry должен обходить его.
        assert.strictEqual(await getActiveAiPresetName(), 'gemini-full');
        assert.strictEqual(await refreshActiveAiPresetName(), 'gpt-balanced');
        assert.strictEqual(reads, 2);

        // Проверяем именно production-путь через замокированный DB repository,
        // а не только ENV fallback из routing-тестов.
        storedPreset = 'gemini-full';
        assert.strictEqual((await resolveModelForTaskFreshAsync('conversation')).modelRef.provider, 'gemini');
        storedPreset = 'gpt-balanced';
        assert.strictEqual((await resolveModelForTaskFreshAsync('conversation')).modelRef.provider, 'openai');

        reads = 0;
        await Promise.all([
            refreshActiveAiPresetName(),
            refreshActiveAiPresetName(),
        ]);
        assert.strictEqual(reads, 1, 'Параллельные refresh должны использовать один запрос к БД');

        failReads = true;
        await assert.rejects(
            () => refreshActiveAiPresetName(),
            /database unavailable/,
            'При ошибке refresh нельзя возвращать устаревший preset',
        );
    } finally {
        console.warn = originalConsoleWarn;
        if (originalGetRepository) {
            Object.defineProperty(AppDataSource, 'getRepository', originalGetRepository);
        } else {
            delete (AppDataSource as { getRepository?: unknown }).getRepository;
        }
        if (originalIsInitialized) {
            Object.defineProperty(AppDataSource, 'isInitialized', originalIsInitialized);
        } else {
            delete (AppDataSource as { isInitialized?: unknown }).isInitialized;
        }
    }

    console.log('AI runtime config cache refresh tests passed');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
