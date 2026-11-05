import assert from 'node:assert/strict';
import { after, test } from 'node:test';

// Synthetic only. All HTTP boundaries below are replaced before a request can run.
const originalEnv = { ...process.env };
const projectKey = 'sk-proj-synthetic-kira-fixture';
process.env.OPENAI_API_KEY = projectKey;
process.env.OPENAI_BASE_URL = 'https://gateway.invalid/v1';
delete process.env.KIRA_TENANT_ID;
delete process.env.OPENAI_ORG_ID;
delete process.env.OPENAI_PROJECT_ID;
after(() => { process.env = originalEnv; });

const { openai } = require('../openai');
const { openaiProviderAdapter: adapter } = require('../ai/providers/openai');
const { createMemoryEmbeddingHttp } = require('../ai/memoryEmbeddingHttp');
const { imageConnection, requestImage, defaultImageSettings } = require('../ai/imageGeneration');
const { moderateAccountInputs } = require('../ai/accountModeration');

test('both OpenAI SDK clients send a project key to the configured gateway', async t => {
    const paths: string[] = [];
    for (const client of [openai, adapter.client]) {
        assert.equal(client.apiKey, projectKey);
        t.mock.method(client, 'fetch', async (url: string, init: any) => {
            assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${projectKey}`);
            assert.equal(new URL(url).origin, 'https://gateway.invalid');
            paths.push(new URL(url).pathname);
            return new Response(JSON.stringify({ choices: [{ message: { content: 'Synthetic' } }],
                output: [], data: [{ embedding: Buffer.from(new Float32Array([0.5, 0.25]).buffer).toString('base64') }], usage: {} }), {
                status: 200, headers: { 'content-type': 'application/json' },
            });
        });
    }
    await openai.chat.completions.create({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'Synthetic' }] });
    await adapter.createChatCompletion('gpt-4o-mini', { messages: [{ role: 'user', content: 'Synthetic' }] });
    await adapter.createResponse('gpt-4o-mini', { input: 'Synthetic', tools: [{ type: 'web_search_preview' }] });
    assert.deepEqual((await adapter.createEmbedding('text-embedding-3-small', { input: 'Synthetic', outputDimension: 2 })).embedding, [0.5, 0.25]);
    const { toFile } = require('openai/uploads');
    await adapter.createTranscription('whisper-1', { file: await toFile(Buffer.from('Synthetic audio'), 'synthetic.wav') });
    await adapter.createDecision({ input: 'Synthetic' });
    assert.deepEqual(paths, ['/v1/chat/completions', '/v1/chat/completions', '/v1/responses',
        '/v1/embeddings', '/v1/audio/transcriptions', '/v1/decisions']);
});

test('an authentication error from the SDK remains a failure', async t => {
    t.mock.method(adapter.client, 'fetch', async () => new Response(JSON.stringify({ error: { message: 'Synthetic denied' } }), {
        status: 401, headers: { 'content-type': 'application/json' },
    }));
    await assert.rejects(adapter.createChatCompletion('gpt-4o-mini', { messages: [] }), (error: any) => error.status === 401);
});

test('admin embeddings preserve a project key and the gateway', async () => {
    const result = await createMemoryEmbeddingHttp('Synthetic', {
        provider: 'openai', model: 'text-embedding-3-small', outputDimension: 2,
    }, { env: process.env, fetchImpl: async (url: string, init: any) => {
        assert.equal(url, 'https://gateway.invalid/v1/embeddings');
        assert.equal(init.headers.Authorization, `Bearer ${projectKey}`);
        return { ok: true, json: async () => ({ data: [{ embedding: [0.1, 0.2] }] }) };
    } });
    assert.deepEqual(result, [0.1, 0.2]);
});

test('images preserve project-key inheritance and independent key/base URL overrides', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=', 'base64');
    const main = { OPENAI_API_KEY: projectKey, OPENAI_BASE_URL: 'https://gateway.invalid/v1' };
    const environments: NodeJS.ProcessEnv[] = [main, { ...main, OPENAI_IMAGE_API_KEY: 'sk-proj-synthetic-images', OPENAI_IMAGE_BASE_URL: 'https://images.invalid/v1' }];
    for (const env of environments) {
        const connection = imageConnection(env);
        for (const reference of [null, { data: png, mime: 'image/png' }]) {
            await requestImage({ env, settings: defaultImageSettings({}), prompt: 'Synthetic', reference,
                fetchImpl: async (url: string, init: any) => {
                    assert.equal(url, `${connection.baseURL}/images/${reference ? 'edits' : 'generations'}`);
                    assert.equal(init.headers.Authorization, `Bearer ${env.OPENAI_IMAGE_API_KEY || projectKey}`);
                    return { ok: true, json: async () => ({ data: [{ b64_json: png.toString('base64') }] }) };
                } });
        }
    }
    assert.throws(() => imageConnection({}), /ключ/);
});

test('public moderation supports an independent project key and fails closed on revoked keys', async () => {
    const before = { ...process.env };
    try {
        for (const separate of [false, true]) {
            if (separate) {
                process.env.KIRA_PUBLIC_MODERATION_API_KEY = 'sk-proj-synthetic-moderation';
                process.env.KIRA_PUBLIC_MODERATION_BASE_URL = 'https://moderation.invalid/v1';
            } else {
                delete process.env.KIRA_PUBLIC_MODERATION_API_KEY;
                delete process.env.KIRA_PUBLIC_MODERATION_BASE_URL;
            }
            await moderateAccountInputs([{ type: 'text', text: 'Synthetic' }], async (url: string, init: any) => {
                assert.equal(url, `${separate ? 'https://moderation.invalid/v1' : process.env.OPENAI_BASE_URL}/moderations`);
                assert.equal(init.headers.authorization, `Bearer ${separate ? process.env.KIRA_PUBLIC_MODERATION_API_KEY : projectKey}`);
                return { ok: true, text: async () => JSON.stringify({ results: [{ flagged: false, categories: {} }] }) };
            });
        }
        await assert.rejects(moderateAccountInputs([{ type: 'text', text: 'Synthetic' }], async () => ({ ok: false, status: 401 })),
            (error: any) => error.code === 'moderation_unavailable');
    } finally { process.env = before; }
});

test('account workers inherit workload project keys without inheriting the platform master key', () => {
    const { tenantEnvironment } = require('../platform/runtime');
    const { PlatformSecrets } = require('../platform/crypto');
    const keys = { OPENAI_API_KEY: projectKey, OPENAI_IMAGE_API_KEY: 'sk-proj-synthetic-images',
        KIRA_PUBLIC_MODERATION_API_KEY: 'sk-proj-synthetic-moderation',
        OPENAI_BASE_URL: 'https://gateway.invalid/v1', KIRA_PLATFORM_MASTER_KEY: '12'.repeat(32) };
    const child = tenantEnvironment(keys, { id: '00000000-0000-4000-8000-000000000001', owner_id: '10001',
        bot_username: 'synthetic_bot', update_offset: 0 }, { botToken: 'synthetic-bot-token' },
    '/synthetic/runtime', new PlatformSecrets('12'.repeat(32)));
    for (const key of ['OPENAI_API_KEY', 'OPENAI_IMAGE_API_KEY', 'KIRA_PUBLIC_MODERATION_API_KEY', 'OPENAI_BASE_URL']) {
        assert.equal(child[key], keys[key as keyof typeof keys]);
    }
    assert.equal(child.KIRA_PLATFORM_MASTER_KEY, undefined);
});
