import assert from 'assert';
import { geminiProviderAdapter } from '../ai/providers/gemini';

process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-gemini-key';
process.env.AI_GEMINI_MAX_CONCURRENT = '2';

async function main(): Promise<void> {
    const client = geminiProviderAdapter.client as unknown as {
        chat: { completions: { create: (body: Record<string, unknown>) => Promise<unknown> } };
    };
    const originalCreate = client.chat.completions.create;
    let active = 0;
    let maxActive = 0;

    client.chat.completions.create = async (body) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        return {
            id: `test-${String(body.model)}`,
            object: 'chat.completion',
            created: 0,
            model: body.model,
            choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
        };
    };

    try {
        await Promise.all(Array.from({ length: 6 }, () => geminiProviderAdapter.createChatCompletion(
            'gemini-3.5-flash',
            { messages: [{ role: 'user', content: 'test' }] },
        )));
        assert.strictEqual(maxActive, 2, 'Gemini limiter должен ограничивать chat concurrency');
    } finally {
        client.chat.completions.create = originalCreate;
    }

    console.log('gemini concurrency checks passed');
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
