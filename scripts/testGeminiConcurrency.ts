import assert from 'assert';
import fs from 'fs';
import path from 'path';
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
            'gemini-3.6-flash',
            { messages: [{ role: 'user', content: 'test' }] },
        )));
        assert.strictEqual(maxActive, 2, 'Gemini limiter должен ограничивать chat concurrency');
    } finally {
        client.chat.completions.create = originalCreate;
    }

    const originalFetch = globalThis.fetch;
    let activeFetches = 0;
    let maxActiveFetches = 0;
    const audioPath = path.join(process.cwd(), '.tmp-gemini-concurrency-audio.ogg');
    fs.writeFileSync(audioPath, 'test audio');
    fs.truncateSync(audioPath, 12 * 1024 * 1024 + 1);
    globalThis.fetch = async (input, init) => {
        activeFetches += 1;
        maxActiveFetches = Math.max(maxActiveFetches, activeFetches);
        await new Promise((resolve) => setTimeout(resolve, 10));
        activeFetches -= 1;
        const url = String(input);
        if (url.endsWith('/upload/v1beta/files')) {
            return new Response('{}', {
                status: 200,
                headers: { 'x-goog-upload-url': 'https://upload.test/gemini-file' },
            });
        }
        if (url === 'https://upload.test/gemini-file') {
            return new Response(JSON.stringify({ file: { name: 'files/test-file', uri: 'gs://test/file', mimeType: 'audio/ogg' } }), {
                status: 200,
            });
        }
        if (url.endsWith('/v1/interactions')) {
            const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
            assert.strictEqual(body?.store, false, 'Gemini Interactions must disable provider-side storage');
        }
        const payload = url.includes('embedContent')
            ? { embedding: { values: [0.1, 0.2] }, usage_metadata: { prompt_token_count: 1 } }
            : { output_text: 'ok', usage_metadata: { prompt_token_count: 1, candidates_token_count: 1, total_token_count: 2 } };
        return new Response(JSON.stringify(payload), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        });
    };
    try {
        await Promise.all([
            ...Array.from({ length: 3 }, () => geminiProviderAdapter.createResponse(
                'gemini-3.6-flash',
                { input: 'test' } as any,
            )),
            ...Array.from({ length: 3 }, () => geminiProviderAdapter.createEmbedding!(
                'gemini-embedding-2',
                { input: 'test' } as any,
            )),
            geminiProviderAdapter.createTranscription!('gemini-3.6-flash', { file: { path: audioPath } } as any),
        ]);
        assert.strictEqual(maxActiveFetches, 2, 'Gemini limiter должен защищать responses, embeddings и transcription');
    } finally {
        globalThis.fetch = originalFetch;
        fs.unlinkSync(audioPath);
    }

    const originalMaxConcurrent = process.env.AI_GEMINI_MAX_CONCURRENT;
    const originalMaxQueue = process.env.AI_GEMINI_MAX_QUEUE;
    process.env.AI_GEMINI_MAX_CONCURRENT = '1';
    process.env.AI_GEMINI_MAX_QUEUE = '1';
    let unblockFirstRequest: (() => void) | undefined;
    let blockedRequestCount = 0;
    client.chat.completions.create = async () => {
        blockedRequestCount += 1;
        if (blockedRequestCount === 1) {
            await new Promise<void>((resolve) => {
                unblockFirstRequest = resolve;
            });
        }
        return { id: 'queued-test', object: 'chat.completion', choices: [] };
    };
    try {
        const first = geminiProviderAdapter.createChatCompletion('gemini-3.6-flash', { messages: [] });
        await new Promise((resolve) => setTimeout(resolve, 0));
        const second = geminiProviderAdapter.createChatCompletion('gemini-3.6-flash', { messages: [] });
        await new Promise((resolve) => setTimeout(resolve, 0));
        await assert.rejects(
            geminiProviderAdapter.createChatCompletion('gemini-3.6-flash', { messages: [] }),
            /queue is full/,
        );
        unblockFirstRequest?.();
        await Promise.all([first, second]);
    } finally {
        client.chat.completions.create = originalCreate;
        if (originalMaxConcurrent === undefined) delete process.env.AI_GEMINI_MAX_CONCURRENT;
        else process.env.AI_GEMINI_MAX_CONCURRENT = originalMaxConcurrent;
        if (originalMaxQueue === undefined) delete process.env.AI_GEMINI_MAX_QUEUE;
        else process.env.AI_GEMINI_MAX_QUEUE = originalMaxQueue;
    }

    const previousQueueTimeout = process.env.AI_GEMINI_QUEUE_TIMEOUT_MS;
    process.env.AI_GEMINI_MAX_CONCURRENT = '1';
    process.env.AI_GEMINI_MAX_QUEUE = '2';
    process.env.AI_GEMINI_QUEUE_TIMEOUT_MS = '20';
    let releaseTimedBlocker: (() => void) | undefined;
    let timeoutTestCalls = 0;
    client.chat.completions.create = async () => {
        timeoutTestCalls += 1;
        if (timeoutTestCalls === 1) {
            await new Promise<void>((resolve) => {
                releaseTimedBlocker = resolve;
            });
        }
        return { id: 'queue-timeout-test', object: 'chat.completion', choices: [] };
    };
    try {
        const blocker = geminiProviderAdapter.createChatCompletion('gemini-3.6-flash', { messages: [] });
        await new Promise((resolve) => setTimeout(resolve, 0));
        await assert.rejects(
            geminiProviderAdapter.createChatCompletion('gemini-3.6-flash', { messages: [] }),
            (error: unknown) => {
                const typedError = error as { code?: string; status?: number };
                return typedError.code === 'AI_GEMINI_QUEUE_TIMEOUT' && typedError.status === 503;
            },
        );

        const afterTimeout = geminiProviderAdapter.createChatCompletion('gemini-3.6-flash', { messages: [] });
        await new Promise((resolve) => setTimeout(resolve, 0));
        releaseTimedBlocker?.();
        await Promise.all([blocker, afterTimeout]);
        assert.strictEqual(timeoutTestCalls, 2, 'Просроченный waiter должен удаляться и освобождать место в очереди');
    } finally {
        client.chat.completions.create = originalCreate;
        if (originalMaxConcurrent === undefined) delete process.env.AI_GEMINI_MAX_CONCURRENT;
        else process.env.AI_GEMINI_MAX_CONCURRENT = originalMaxConcurrent;
        if (originalMaxQueue === undefined) delete process.env.AI_GEMINI_MAX_QUEUE;
        else process.env.AI_GEMINI_MAX_QUEUE = originalMaxQueue;
        if (previousQueueTimeout === undefined) delete process.env.AI_GEMINI_QUEUE_TIMEOUT_MS;
        else process.env.AI_GEMINI_QUEUE_TIMEOUT_MS = previousQueueTimeout;
    }

    // Единый file deadline должен включать ожидание semaphore slot. Иначе
    // transcription/cleanup могли сначала ждать длинный queue timeout, а уже
    // затем обнаруживать истёкший AbortSignal.
    const previousFileTimeout = process.env.AI_GEMINI_FILE_TIMEOUT_MS;
    const previousQueueTimeoutForFile = process.env.AI_GEMINI_QUEUE_TIMEOUT_MS;
    const previousMaxConcurrentForFile = process.env.AI_GEMINI_MAX_CONCURRENT;
    const previousMaxQueueForFile = process.env.AI_GEMINI_MAX_QUEUE;
    const queueAudioPath = path.join(process.cwd(), '.tmp-gemini-file-queue-timeout.ogg');
    fs.writeFileSync(queueAudioPath, 'test audio');
    process.env.AI_GEMINI_FILE_TIMEOUT_MS = '1000';
    process.env.AI_GEMINI_QUEUE_TIMEOUT_MS = '5000';
    process.env.AI_GEMINI_MAX_CONCURRENT = '1';
    process.env.AI_GEMINI_MAX_QUEUE = '2';
    let releaseFileQueueBlocker: (() => void) | undefined;
    let queuedFileFetches = 0;
    client.chat.completions.create = async () => {
        await new Promise<void>((resolve) => {
            releaseFileQueueBlocker = resolve;
        });
        return { id: 'file-queue-blocker', object: 'chat.completion', choices: [] };
    };
    globalThis.fetch = async () => {
        queuedFileFetches += 1;
        throw new Error('File fetch не должен начаться после истечения deadline в очереди');
    };
    try {
        const blocker = geminiProviderAdapter.createChatCompletion('gemini-3.6-flash', { messages: [] });
        await new Promise((resolve) => setTimeout(resolve, 0));
        await assert.rejects(
            geminiProviderAdapter.createTranscription!(
                'gemini-3.6-flash',
                { file: { path: queueAudioPath } } as any,
            ),
            (error: unknown) => error instanceof Error
                && (error.name === 'TimeoutError' || error.name === 'AbortError'),
        );
        assert.strictEqual(queuedFileFetches, 0, 'File-flow не должен начинать I/O после deadline в очереди');
        releaseFileQueueBlocker?.();
        await blocker;
    } finally {
        globalThis.fetch = originalFetch;
        client.chat.completions.create = originalCreate;
        fs.unlinkSync(queueAudioPath);
        if (previousFileTimeout === undefined) delete process.env.AI_GEMINI_FILE_TIMEOUT_MS;
        else process.env.AI_GEMINI_FILE_TIMEOUT_MS = previousFileTimeout;
        if (previousQueueTimeoutForFile === undefined) delete process.env.AI_GEMINI_QUEUE_TIMEOUT_MS;
        else process.env.AI_GEMINI_QUEUE_TIMEOUT_MS = previousQueueTimeoutForFile;
        if (previousMaxConcurrentForFile === undefined) delete process.env.AI_GEMINI_MAX_CONCURRENT;
        else process.env.AI_GEMINI_MAX_CONCURRENT = previousMaxConcurrentForFile;
        if (previousMaxQueueForFile === undefined) delete process.env.AI_GEMINI_MAX_QUEUE;
        else process.env.AI_GEMINI_MAX_QUEUE = previousMaxQueueForFile;
    }

    console.log('gemini concurrency checks passed');
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
