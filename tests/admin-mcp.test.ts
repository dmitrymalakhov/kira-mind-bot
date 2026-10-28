import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, stat, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseMcpConfig, readMcpConfig } from '../services/mcp/config';
import { McpService } from '../services/mcp/client';
const { createMcpSettingsStore, mcpSettingsFile, probeMcp, MONEY_MAKER_TOOLS, registerMcpRoutes } = require('../admin-panel/mcp');
const server = (extra = {}) => ({ description: 'Synthetic notes service', transport: 'http', url: 'https://example.com/any/mcp/path', tools: { lookup: 'read', change: 'external' }, timeoutMs: 1000, ...extra });
async function fixture(t: any, servers = {}) {
    const root = await mkdtemp(path.join(tmpdir(), 'kira-mcp-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const file = path.join(root, 'mcp.json');
    await writeFile(file, JSON.stringify({ servers }));
    return { file, store: createMcpSettingsStore(async () => file) };
}

test('generic MCP admin adopts Money Maker, masks all secrets and preserves unrelated servers exactly', async t => {
    const template = JSON.parse(await readFile(path.join(__dirname, '../docs/mcp.example.json'), 'utf8')).servers['money-maker'];
    const other = server({ timeoutMs: undefined, headers: { 'X-Api-Key': 'synthetic-other-secret' } });
    const { file, store } = await fixture(t, { 'money-maker': template, other });
    const first = await store.get();
    assert.equal(first.servers.length, 2);
    assert.equal(first.servers[0].config.headers.Authorization, null);
    assert.equal(first.templates.find((item: any) => item.id === 'money-maker').config.fixedArguments.responseMode, 'full');
    const config = server({ headers: { Authorization: 'Bearer synthetic-mcp-secret' }, fixedArguments: { locale: 'ru' } });
    const saved = await store.save('notes', { revision: first.revision, config }, 'create');
    assert.equal(saved.servers.length, 3);
    assert.doesNotMatch(JSON.stringify(saved), /synthetic-mcp-secret|synthetic-other-secret|REPLACE_WITH_ACCESS_TOKEN/);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    const disk = JSON.parse(await readFile(file, 'utf8')).servers;
    assert.deepEqual(disk.other, JSON.parse(JSON.stringify(other)));
    assert.deepEqual(disk['money-maker'], template);
    assert.deepEqual(parseMcpConfig({ servers: disk }), readMcpConfig(file));
    await assert.rejects(() => store.save('notes', { revision: first.revision, config }), (error: any) => error.status === 409);
    await assert.rejects(() => store.save('notes', { revision: saved.revision, config }, 'create'), (error: any) => error.status === 409);
    const edited = { ...saved.servers.find((item: any) => item.id === 'notes').config, description: 'Changed synthetic description' };
    const next = await store.save('notes', { revision: saved.revision, config: edited });
    assert.equal(JSON.parse(await readFile(file, 'utf8')).servers.notes.headers.Authorization, 'Bearer synthetic-mcp-secret');
    const disconnected = await store.save('notes', { revision: next.revision }, 'delete');
    assert.deepEqual(disconnected.servers.map((item: any) => item.id), ['money-maker', 'other']);
});

test('retained headers, OAuth and env cannot be forwarded to changed targets', async t => {
    const configs = {
        notes: server({ headers: { Authorization: 'Bearer synthetic-header' } }),
        oauth: server({ oauth: { tokenUrl: 'https://example.com/token', clientId: 'synthetic-client', clientSecret: 'synthetic-oauth-secret' } }),
        local: server({ transport: 'stdio', url: undefined, command: '/synthetic/server', args: ['--demo'], env: { API_KEY: 'synthetic-env-secret' } }),
    };
    const { file, store } = await fixture(t, configs);
    const initial = await store.get();
    assert.doesNotMatch(JSON.stringify(initial), /synthetic-header|synthetic-oauth-secret|synthetic-env-secret/);
    for (const item of initial.servers) {
        assert.deepEqual(await store.draft(item.id, { revision: initial.revision, config: item.config }), parseMcpConfig(JSON.parse(JSON.stringify({ servers: { [item.id]: configs[item.id as keyof typeof configs] } })))[item.id]);
    }
    const headerConfig = initial.servers.find((item: any) => item.id === 'notes').config;
    await assert.rejects(() => store.draft('notes', { revision: initial.revision, config: { ...headerConfig, url: 'https://other.example.com/mcp' } }), /секреты заново/);
    await assert.rejects(() => store.draft('notes', { revision: initial.revision, config: { ...headerConfig, transport: 'jsonrpc' } }), /секреты заново/);
    const oauthConfig = initial.servers.find((item: any) => item.id === 'oauth').config;
    for (const patch of [{ url: 'https://other.example.com' }, { oauth: { ...oauthConfig.oauth, tokenUrl: 'https://other.example.com/token' } }, { oauth: { ...oauthConfig.oauth, clientId: 'other-client' } }]) {
        await assert.rejects(() => store.draft('oauth', { revision: initial.revision, config: { ...oauthConfig, ...patch } }), /secret заново/);
    }
    const local = initial.servers.find((item: any) => item.id === 'local').config;
    await assert.rejects(() => store.draft('local', { revision: initial.revision, config: { ...local, args: ['--other'] } }), /секреты заново/);
    assert.equal((await store.draft('notes', { revision: initial.revision, config: { ...headerConfig, url: 'https://other.example.com/mcp', headers: {} } })).url, 'https://other.example.com/mcp');
    assert.equal(await readFile(file, 'utf8'), JSON.stringify({ servers: configs }));
});

test('generic settings reject malformed configs, unknown fields, unsafe IDs and concurrent writes', async t => {
    const { file, store } = await fixture(t);
    const first = await store.get();
    for (const config of [server({ url: 'http://public.example.com/mcp' }), server({ url: 'https://example.com/mcp?token=synthetic-secret' }), server({ tools: { change: 'readOnlyHint' } }), server({ headers: { Authorization: 'synthetic', authorization: 'duplicate' } }), server({ accountId: 'synthetic' })]) {
        await assert.rejects(() => store.save('demo', { revision: first.revision, config }, 'create'));
    }
    for (const id of ['../other', '__proto__', 'constructor', 'UPPER']) await assert.rejects(() => store.save(id, { revision: first.revision, config: server() }, 'create'));
    const results = await Promise.allSettled(['one', 'two'].map(id => store.save(id, { revision: first.revision, config: server() }, 'create')));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(Object.keys(JSON.parse(await readFile(file, 'utf8')).servers).length, 1);
    await writeFile(file, 'broken synthetic private data');
    await assert.rejects(() => store.get(), /повреждён/);
    await assert.rejects(() => store.save('three', { revision: first.revision, config: server() }, 'create'), /повреждён/);
    assert.equal(await readFile(file, 'utf8'), 'broken synthetic private data');
});

test('MCP settings enforce the runtime server limit before changing the file', async t => {
    const { file, store } = await fixture(t, Object.fromEntries(Array.from({ length: 16 }, (_, index) => [`demo-${index}`, server()])));
    const before = await readFile(file, 'utf8');
    const revision = (await store.get()).revision;
    await assert.rejects(() => store.save('extra', { revision, config: server() }, 'create'), /16 серверов/);
    assert.equal(await readFile(file, 'utf8'), before);
});

test('account mode selects only the trusted imported account and refuses missing bindings', async t => {
    const root = await mkdtemp(path.join(tmpdir(), 'kira-mcp-account-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await assert.rejects(() => mcpSettingsFile(root, true), /Не найдено/);
    await mkdir(path.join(root, 'accounts/import'), { recursive: true });
    const accountId = '11111111-2222-4333-8444-555555555555';
    await writeFile(path.join(root, 'accounts/import/current-account.json'), JSON.stringify({ accountId, phase: 'active', accessToken: 'synthetic-private-binding-secret' }));
    assert.equal(await mcpSettingsFile(root, true), path.join(root, 'accounts/kira_u_11111111222243338444555555555555/data/mcp.json'));
    assert.equal(await mcpSettingsFile(root, false), path.join(root, 'mcp.json'));
});

test('admin probe discovers paginated tools without calling them or assigning permissions, redacts credentials and closes', async () => {
    const calls: any[] = []; let closed = 0;
    const config = server({ headers: { Authorization: 'Bearer synthetic-test' } });
    const result = await probeMcp(config, async () => ({ close: async () => { closed++; }, client: {
        getServerCapabilities: () => ({ tools: {}, resources: {} }),
        listTools: async (params: any) => { calls.push(params); return params.cursor ? { tools: [{ name: 'change', description: 'Echo synthetic-test', annotations: { readOnlyHint: true } }] } : { tools: [{ name: 'lookup' }], nextCursor: 'next' }; },
        callTool: () => { throw new Error('Must not call tools'); },
    } }));
    assert.equal(result.toolCount, 2); assert.equal(result.resources, true); assert.equal(result.truncated, false);
    assert.equal(closed, 1); assert.deepEqual(calls, [{}, { cursor: 'next' }]);
    assert.doesNotMatch(JSON.stringify(result), /synthetic-test|readOnlyHint|external/);
    assert.deepEqual(Object.keys(result.tools[0]), ['name', 'description']);
    await assert.rejects(() => probeMcp(config, async () => ({ close: async () => { closed++; }, client: { getServerCapabilities: () => ({ tools: {} }), listTools: async () => { throw new Error('synthetic-private-token'); } } })), (error: any) => !/synthetic-private/.test(error.message));
    assert.equal(closed, 2);
});

test('admin probe supports resource-only servers and reports bounded/cyclic catalogs', async () => {
    const probe = (capabilities: object, page: object) => probeMcp(server(), async () => ({ close: async () => {}, client: { getServerCapabilities: () => capabilities, listTools: async () => page } }));
    assert.deepEqual(await probe({ resources: {} }, {}), { success: true, tools: [], toolCount: 0, truncated: false, resources: true });
    assert.equal((await probe({ tools: {} }, { tools: [], nextCursor: 'same-cursor' })).truncated, true);
    const large = await probe({ tools: {} }, { tools: Array.from({ length: 201 }, (_, index) => ({ name: `tool-${index}` })) });
    assert.equal(large.toolCount, 200); assert.equal(large.truncated, true);
});

test('generic admin HTTP and POST probes use the same SDK handshake as runtime', async t => {
    const calls: string[] = [];
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
        assert.equal(init.redirect, 'error');
        if (init.method === 'GET') return new Response(null, { status: 405 });
        const body = JSON.parse(String(init.body)); calls.push(body.method);
        if (body.id === undefined) return new Response(null, { status: 204 });
        const result = body.method === 'initialize' ? { protocolVersion: '2024-11-05', serverInfo: { name: 'synthetic', version: '1' }, capabilities: { tools: {} } }
            : { tools: [{ name: 'lookup', inputSchema: { type: 'object' } }] };
        return Response.json({ jsonrpc: '2.0', id: body.id, result });
    });
    for (const transport of ['http', 'jsonrpc']) assert.equal((await probeMcp(server({ transport }))).tools[0].name, 'lookup');
    assert.deepEqual(calls, ['initialize', 'notifications/initialized', 'tools/list', 'initialize', 'notifications/initialized', 'tools/list']);
    t.mock.method(globalThis, 'fetch', async () => new Response('synthetic-private-token', { status: 403 }));
    await assert.rejects(() => probeMcp(server({ transport: 'jsonrpc' })), (error: any) => /HTTP 403/.test(error.message) && !/synthetic-private/.test(error.message));
});

test('a second MCP can be saved, discovered and called from the runtime independently of Money Maker', async t => {
    const { file, store } = await fixture(t);
    const first = await store.get();
    await store.save('notes', { revision: first.revision, config: server({ transport: 'jsonrpc', headers: { 'X-Api-Key': 'synthetic-new-secret' } }) }, 'create');
    let called = 0;
    const runtime = new McpService(() => readMcpConfig(file), async config => {
        assert.equal(config.headers!['X-Api-Key'], 'synthetic-new-secret');
        return { close: async () => {}, client: { listTools: async () => ({ tools: [{ name: 'lookup', inputSchema: { type: 'object' } }] }), callTool: async () => { called++; return { content: [] }; } } as any };
    });
    assert.equal(runtime.servers()[0].id, 'notes');
    await runtime.callTool('notes', 'lookup', {}, 'read'); assert.equal(called, 1);
    await assert.rejects(() => runtime.callTool('notes', 'unapproved', {}, 'read'));
});

test('admin can discover a real stdio child without invoking tools or inheriting provider credentials', async () => {
    const code = `const rl=require('node:readline').createInterface({input:process.stdin});
rl.on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;
if(m.method!=='initialize'&&m.method!=='tools/list')process.exit(2);
const result=m.method==='initialize'?{protocolVersion:'2024-11-05',serverInfo:{name:'synthetic',version:'1'},capabilities:{tools:{}}}:
{tools:[{name:process.env.OPENAI_API_KEY?'inherited-secret':'lookup',inputSchema:{type:'object'}}]};
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});`;
    const result = await probeMcp(server({ transport: 'stdio', url: undefined, command: process.execPath, args: ['-e', code] }));
    assert.deepEqual(result.tools, [{ name: 'lookup', description: '' }]);
});

test('all generic routes require auth and unexpected errors cannot expose credentials', async t => {
    const { file } = await fixture(t); const routes: any[] = []; const auth = () => {};
    const app = Object.fromEntries(['get', 'post', 'put', 'delete'].map(method => [method, (...args: any[]) => routes.push({ method, args })]));
    registerMcpRoutes(app, { requireAuth: auth, runtimeDir: path.dirname(file), probe: async () => { throw new Error('synthetic-secret-provider-error'); } });
    assert.equal(routes.length, 5);
    assert.ok(routes.every(route => route.args[1] === auth && !route.args[0].includes('money-maker')));
    const check = routes.find(route => route.args[0].endsWith('/check'));
    let code = 200; let body: any;
    const res = { set: () => {}, status: (next: number) => { code = next; return res; }, json: (next: any) => { body = next; } };
    const revision = (await createMcpSettingsStore(async () => file).get()).revision;
    await check.args[2]({ params: { id: 'notes' }, body: { revision, config: server() } }, res);
    assert.equal(code, 500); assert.doesNotMatch(JSON.stringify(body), /synthetic-secret/);
});

test('Money Maker remains an ordinary valid template with its established operator policy', async () => {
    const template = JSON.parse(await readFile(path.join(__dirname, '../docs/mcp.example.json'), 'utf8'));
    assert.deepEqual(Object.keys(template.servers['money-maker'].tools), MONEY_MAKER_TOOLS);
    assert.equal(Object.keys(parseMcpConfig(template)['money-maker'].tools).length, 12);
});
