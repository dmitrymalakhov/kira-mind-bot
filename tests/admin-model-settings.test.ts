import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KEY_SECTIONS, CONFIG_SCHEMA, LOCAL_MODEL_CONNECTION_SECTION, VOICE_MODEL_SECTION, IMAGE_CONNECTION_SECTION } from '../admin-panel/src/schema';
const { mergeEditableDefaults, isValidProxyUrl } = require('../admin-panel/configValues');
const { registerMemoryDetailRoute } = require('../admin-panel/memoryDetail');

test('credentials, model choices and system parameters each have a single editor', () => {
    const sections = [...KEY_SECTIONS, ...CONFIG_SCHEMA, LOCAL_MODEL_CONNECTION_SECTION, VOICE_MODEL_SECTION, IMAGE_CONNECTION_SECTION];
    const keys = sections.flatMap(section => section.fields.map(field => field.key));
    assert.equal(keys.length, new Set(keys).size);
    assert.ok(KEY_SECTIONS.flatMap(section => section.fields).every(field => !/MODEL|VOICE_ID|BASE_URL/.test(field.key) || field.type === 'proxy'));
    assert.ok(VOICE_MODEL_SECTION.fields.some(field => field.key === 'ELEVENLABS_MODEL_ID'));
    assert.ok(!CONFIG_SCHEMA.some(section => ['api', 'elevenlabs', 'telegram', 'bots'].includes(section.id)));
});

test('proxy settings preserve existing inherited URLs and explicit direct-connection overrides', () => {
    const inherited = { OPENAI_BASE_URL: 'http://synthetic-proxy:8080/v1', INTERNAL_MASTER_KEY: 'synthetic-do-not-expose' };
    assert.deepEqual(mergeEditableDefaults({}, inherited, ['OPENAI_BASE_URL']), { OPENAI_BASE_URL: inherited.OPENAI_BASE_URL });
    assert.deepEqual(mergeEditableDefaults({ OPENAI_BASE_URL: '' }, inherited, ['OPENAI_BASE_URL']), { OPENAI_BASE_URL: '' });
    assert.equal(isValidProxyUrl('http://host.docker.internal:8080/v1'), true);
    assert.equal(isValidProxyUrl(''), true);
    const authenticatedUrl = new URL('https://synthetic.test/v1');
    authenticatedUrl.username = 'synthetic-user'; authenticatedUrl.password = 'synthetic-password';
    for (const invalid of [null, 'https://synthetic.test/v1\nINJECTED=value', 'proxy', 'file:///private/test', authenticatedUrl.toString(), 'https://synthetic.test/v1?key=secret', 'https://synthetic.test/v1#fragment']) assert.equal(isValidProxyUrl(invalid), false);
});

test('full memory detail is read-only, authenticated, scoped and never returns another owner record', async () => {
    let handler: any, authHandler: unknown;
    const auth = () => {};
    const payload = { userId: 'synthetic-owner', content: 'Synthetic full text '.repeat(100) };
    registerMemoryDetailRoute({ get: (path: string, middleware: unknown, callback: unknown) => {
        assert.equal(path, '/api/memory/:domain/:id'); authHandler = middleware; handler = callback;
    } }, {
        requireAuth: auth, getMemoryProfile: () => 'KiraMindBot', getMemoryUserId: (_profile: string, owner: string) => owner,
        normalizeMemoryDomain: (domain: string) => domain, fetchExistingMemoryPayload: async () => payload,
        normalizeMemoryPoint: ({ id, payload: value }: any) => ({ id, content: value.content }),
    });
    assert.equal(authHandler, auth);
    let status = 200, result: any, cache = '';
    const response = { status: (value: number) => { status = value; return response; }, json: (value: unknown) => { result = value; }, set: (_key: string, value: string) => { cache = value; } };
    await handler({ params: { domain: 'general', id: 'synthetic-record' }, query: { userId: 'other-owner' } }, response);
    assert.equal(status, 404); assert.equal(result.record, undefined);
    status = 200;
    await handler({ params: { domain: 'general', id: 'synthetic-record' }, query: { userId: 'synthetic-owner' } }, response);
    assert.equal(status, 200); assert.equal(result.record.content, payload.content); assert.equal(cache, 'private, no-store');
});
