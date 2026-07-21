import assert from 'assert';
import { canContinueAfterWebSearchFailure } from '../orchestration/webSearchFailurePolicy';

process.env.KIRA_BOT_TOKEN = process.env.KIRA_BOT_TOKEN || 'test-token';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-openai-key';

async function main(): Promise<void> {
    assert.strictEqual(canContinueAfterWebSearchFailure({ agentId: 'conversation' }), true);
    for (const agentId of ['sendMessage', 'negotiateOnBehalf', 'reminder', 'browserTask', 'imageGeneration'] as const) {
        assert.strictEqual(
            canContinueAfterWebSearchFailure({ agentId }),
            false,
            `${agentId} не должен выполняться без обязательных результатов поиска`,
        );
    }
    assert.strictEqual(canContinueAfterWebSearchFailure(undefined), false);

    const responseModule = require('../ai/responseCompletion') as {
        createResponseForTask: (...args: unknown[]) => Promise<unknown>;
    };
    const originalCreateResponse = responseModule.createResponseForTask;
    const consoleError = console.error;
    console.error = () => undefined;

    try {
        responseModule.createResponseForTask = async () => {
            throw Object.assign(new Error('{"secret_provider_payload":"must-not-leak"}'), {
                status: 503,
                request_id: 'gemini-test-request',
            });
        };
        const { webSearchAgent } = require('../agents/webSearchAgent') as typeof import('../agents/webSearchAgent');
        const failed = await webSearchAgent('найди свежие новости');
        assert.strictEqual(failed.webSearchSucceeded, false);
        assert.match(failed.responseText, /временно недоступен/i);
        assert.doesNotMatch(failed.responseText, /secret_provider_payload|gemini-test-request/);

        responseModule.createResponseForTask = async () => ({ output_text: 'Найден безопасный результат' });
        const succeeded = await webSearchAgent('найди свежие новости');
        assert.strictEqual(succeeded.webSearchSucceeded, true);
        assert.strictEqual(succeeded.responseText, 'Найден безопасный результат');
    } finally {
        responseModule.createResponseForTask = originalCreateResponse;
        console.error = consoleError;
    }

    console.log('web search failure flow checks passed');
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
