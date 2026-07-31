import assert from 'assert';
import { getAiProviderAdapter } from '../ai/providers/registry';
import {
    DEFAULT_RETRY_POLICY,
    resolveRetryPolicy,
    resolveDegradationChain,
    resolveErrorIdentities,
} from '../ai/providers/policyDefaults';
import { getSameProviderDegradedModel } from '../ai/runtimeSupport';

/**
 * Регрессионная защита архитектуры «провайдер-инкапсуляция политики».
 *
 * Контракт:
 * - OpenAI / OpenRouter / Z.ai НЕ реализуют policy-методы → получают дефолтную
 *   политику (retry disabled, нет same-provider degradation chain, нет
 *   провайдерного парсинга идентичности ошибки). Это гарантирует, что поведение
 *   этих провайдеров не меняется при рефакторинге.
 * - Gemini реализует все три метода: retry-политика включена, есть цепочка
 *   same-provider degradation, есть парсинг x-goog-request-id.
 * - resolveRetryPolicy/resolveDegradationChain/resolveErrorIdentities безопасно
 *   обрабатывают undefined-методы и исключения, возвращая дефолты.
 */

function main(): void {
    const openaiAdapter = getAiProviderAdapter('openai');
    const openrouterAdapter = getAiProviderAdapter('openrouter');
    const zaiAdapter = getAiProviderAdapter('zai');
    const geminiAdapter = getAiProviderAdapter('gemini');

    // 1. OpenAI/OpenRouter/Z.ai не предоставляют retry-политику → дефолт (disabled).
    for (const [name, adapter] of Object.entries({
        openai: openaiAdapter,
        openrouter: openrouterAdapter,
        zai: zaiAdapter,
    })) {
        const policy = resolveRetryPolicy(adapter.getRetryPolicy, adapter);
        assert.strictEqual(
            policy.enabled,
            false,
            `${name} не должен включать провайдерную retry-политику (сохраняем текущее поведение)`,
        );
        assert.strictEqual(policy.maxAttempts, 0, `${name} должен иметь 0 retry по дефолту`);
    }

    // 2. Gemini предоставляет включённую retry-политику.
    const geminiPolicy = resolveRetryPolicy(geminiAdapter.getRetryPolicy, geminiAdapter);
    assert.strictEqual(geminiPolicy.enabled, true, 'Gemini должен включать retry-политику');
    assert.ok(geminiPolicy.maxAttempts >= 1, 'Gemini должен разрешать минимум 1 retry');
    const delayAttempt1 = geminiPolicy.getDelayMs(1);
    const delayAttempt2 = geminiPolicy.getDelayMs(2);
    assert.ok(delayAttempt1 >= 1, 'Gemini getDelayMs должен возвращать положительное число');
    assert.ok(delayAttempt2 >= delayAttempt1, 'Gemini backoff должен расти с попыткой');

    // 3. OpenAI/OpenRouter/Z.ai не имеют same-provider degradation chain.
    for (const [name, adapter] of Object.entries({
        openai: openaiAdapter,
        openrouter: openrouterAdapter,
        zai: zaiAdapter,
    })) {
        const chain = resolveDegradationChain(adapter.getSameProviderDegradationChain, {
            currentModel: 'any',
            retryable: true,
        }, adapter);
        assert.strictEqual(chain.length, 0, `${name} не должен иметь degradation chain`);
    }

    // 4. Gemini предоставляет цепочку same-provider degradation, исключая текущую модель.
    const geminiChainFromHeavy = resolveDegradationChain(geminiAdapter.getSameProviderDegradationChain, {
        currentModel: 'gemini-3.6-flash',
        retryable: true,
    }, geminiAdapter);
    assert.ok(geminiChainFromHeavy.length >= 1, 'Gemini должен иметь минимум одну degraded-модель для heavy');
    assert.ok(
        geminiChainFromHeavy.every((entry) => entry.provider === 'gemini'),
        'Gemini degradation chain должна содержать только Gemini-модели',
    );
    assert.ok(
        geminiChainFromHeavy.every((entry) => entry.model !== 'gemini-3.6-flash'),
        'Gemini degradation chain не должна возвращать текущую модель',
    );

    // Когда текущая модель — lite, цепочка должна исключать её и давать следующее дно.
    const geminiChainFromLite = resolveDegradationChain(geminiAdapter.getSameProviderDegradationChain, {
        currentModel: 'gemini-3.5-flash-lite',
        retryable: true,
    }, geminiAdapter);
    assert.ok(geminiChainFromLite.length >= 1, 'Gemini должен иметь degraded-модель даже для lite (третье дно)');
    assert.ok(
        geminiChainFromLite.every((entry) => entry.model !== 'gemini-3.5-flash-lite'),
        'Gemini degradation chain для lite не должна возвращать саму lite',
    );
    assert.deepStrictEqual(
        geminiChainFromLite.map((entry) => entry.model),
        ['gemini-3.1-flash-lite', 'gemini-2.5-flash-lite'],
        'Degradation от lite должна идти только вниз и не возвращать более дорогую модель',
    );

    // 5. parseErrorIdentities: дефолт для провайдеров без реализации — пустой объект.
    for (const [name, adapter] of Object.entries({
        openai: openaiAdapter,
        openrouter: openrouterAdapter,
        zai: zaiAdapter,
    })) {
        const identities = resolveErrorIdentities(adapter.parseErrorIdentities, new Error('test'), adapter);
        assert.deepStrictEqual(identities, {}, `${name} не должен извлекать провайдерную идентичность без реализации`);
    }

    // 6. resolveRetryPolicy безопасно обрабатывает undefined и исключения.
    assert.strictEqual(resolveRetryPolicy(undefined).enabled, false);
    assert.strictEqual(
        resolveRetryPolicy(() => { throw new Error('boom'); }).enabled,
        false,
        'resolveRetryPolicy должен возвращать дефолт при исключении в адаптере',
    );

    const receiverAwareAdapter = {
        retryEnabled: true,
        chainModel: 'receiver-lite',
        requestId: 'receiver-request-id',
        getRetryPolicy() {
            return {
                enabled: this.retryEnabled,
                maxAttempts: 2,
                delayMs: 7,
                getDelayMs() { return this.delayMs; },
            };
        },
        getSameProviderDegradationChain() {
            return [{ provider: 'gemini' as const, model: this.chainModel }];
        },
        parseErrorIdentities() {
            return { providerRequestId: this.requestId };
        },
    };
    assert.strictEqual(
        resolveRetryPolicy(receiverAwareAdapter.getRetryPolicy, receiverAwareAdapter).enabled,
        true,
        'Policy-методы должны вызываться с receiver адаптера',
    );
    assert.strictEqual(
        resolveRetryPolicy(receiverAwareAdapter.getRetryPolicy, receiverAwareAdapter).getDelayMs(1),
        7,
        'getDelayMs должен сохранять receiver объекта policy',
    );
    assert.strictEqual(
        resolveDegradationChain(
            receiverAwareAdapter.getSameProviderDegradationChain,
            { currentModel: 'receiver-heavy', retryable: true },
            receiverAwareAdapter,
        )[0]?.model,
        'receiver-lite',
    );
    assert.strictEqual(
        resolveErrorIdentities(
            receiverAwareAdapter.parseErrorIdentities,
            new Error('test'),
            receiverAwareAdapter,
        ).providerRequestId,
        'receiver-request-id',
    );
    assert.strictEqual(
        resolveRetryPolicy(() => ({ enabled: true, maxAttempts: Number.NaN, getDelayMs: () => 1 })).enabled,
        false,
        'Некорректная policy должна безопасно откатываться к disabled-дефолту',
    );
    assert.strictEqual(
        resolveRetryPolicy(() => ({
            enabled: true,
            maxAttempts: 1,
            getDelayMs: () => { throw new Error('delay boom'); },
        })).getDelayMs(1),
        0,
        'Исключение в отложенном getDelayMs не должно ломать execution-flow',
    );

    // 7. Runtime пропускает уже опробованные модели и не допускает cross-provider entry.
    const originalGeminiChain = geminiAdapter.getSameProviderDegradationChain;
    try {
        geminiAdapter.getSameProviderDegradationChain = () => [
            { provider: 'gemini', model: 'already-tried-a' },
            { provider: 'gemini', model: 'already-tried-b' },
            { provider: 'gemini', model: 'next-valid' },
        ];
        assert.deepStrictEqual(
            getSameProviderDegradedModel(
                'gemini-full',
                { provider: 'gemini', model: 'current' },
                true,
                new Set(['already-tried-a', 'already-tried-b']),
            ),
            { provider: 'gemini', model: 'next-valid' },
            'Runtime должен сканировать цепочку дальше первого уже опробованного кандидата',
        );

        geminiAdapter.getSameProviderDegradationChain = () => [
            { provider: 'openai', model: 'cross-provider-model' },
        ];
        assert.strictEqual(
            getSameProviderDegradedModel(
                'gemini-full',
                { provider: 'gemini', model: 'current' },
                true,
            ),
            null,
            'Same-provider runtime не должен принимать модель другого провайдера',
        );

        geminiAdapter.getSameProviderDegradationChain = () => [];
        assert.strictEqual(
            getSameProviderDegradedModel(
                'gemini-full',
                { provider: 'gemini', model: 'current' },
                true,
            ),
            null,
            'Без provider policy runtime не должен искать второй registry деградации',
        );
    } finally {
        geminiAdapter.getSameProviderDegradationChain = originalGeminiChain;
    }

    // 8. DEFAULT_RETRY_POLICY — это disabled-политика.
    assert.strictEqual(DEFAULT_RETRY_POLICY.enabled, false);
    assert.strictEqual(DEFAULT_RETRY_POLICY.maxAttempts, 0);

    console.log('Provider policy contract checks passed');
}

main();
