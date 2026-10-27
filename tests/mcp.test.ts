import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { parseMcpConfig, readMcpConfig } from '../services/mcp/config';
import { McpService, McpInputError, mcpResultEvidence } from '../services/mcp/client';
import { JsonRpcHttpTransport } from '../services/mcp/jsonRpcTransport';
import { mcpTools, confirmedMcpCallKey } from '../orchestration/runtime/mcpTools';
import { ToolRegistry } from '../orchestration/runtime/registry';
import { availableRuntimeTools, canExecuteRuntimeCall, isDialogueReadTool, needsRuntimeTools } from '../orchestration/runtime/authorization';
import type { ToolContext } from '../orchestration/runtime/types';
import { mcpRequestHeaders } from '../services/mcp/auth';

const config = () => parseMcpConfig({ servers: { demo: { description: 'Синтетический сервис', transport: 'jsonrpc', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer synthetic-secret' }, tools: { lookup: 'read', change: 'external' }, fixedArguments: { requesterAgentId: 'kira-test' }, timeoutMs: 1000 } } });
const context = (): ToolContext => ({ ctx: { from: { id: 101 }, chat: { id: 101, type: 'private' }, session: {} } as any, message: 'Проверь MCP', classification: { intent: 'РАЗГОВОР', confidenceLevel: 'ВЫСОКИЙ', details: { mcpAccess: 'read' } }, isForwarded: false, forwardFrom: '', messageHistory: [], runId: 'synthetic', signal: new AbortController().signal, memoryContext: '', observations: [] });

test('MCP config validates transports, URLs and operator policy without revealing secrets', () => {
    assert.equal(config().demo.transport, 'jsonrpc');
    assert.throws(() => parseMcpConfig({ servers: { demo: { ...config().demo, url: 'https://' + ['synthetic', 'password'].join(':') + '@example.com/mcp' } } }));
    assert.throws(() => parseMcpConfig({ servers: { demo: { ...config().demo, url: 'http://example.com/mcp' } } }));
    assert.throws(() => parseMcpConfig({ servers: { demo: { ...config().demo, tools: { lookup: 'readOnlyHint' } } } }));
    assert.throws(() => parseMcpConfig(JSON.parse('{"servers":{"__proto__":{}}}')));
    assert.deepEqual(readMcpConfig('/tmp/kira-mcp-nonexistent-synthetic.json'), {});
});

test('POST-only transport negotiates the actual Money Maker protocol and accepts 204 notifications', async () => {
    const messages: any[] = [];
    const request = (async (_url: unknown, init: RequestInit) => {
        assert.equal(init.redirect, 'error');
        assert.equal((init.headers as any).Authorization, 'Bearer synthetic-secret');
        const body = JSON.parse(String(init.body)); messages.push(body);
        if (body.id === undefined) return new Response(null, { status: 204 });
        const result = body.method === 'initialize' ? { protocolVersion: '2024-11-05', serverInfo: { name: 'demo', version: '1' }, capabilities: { tools: {} } }
            : { tools: [{ name: 'lookup', inputSchema: { type: 'object' } }] };
        return Response.json({ jsonrpc: '2.0', id: body.id, result });
    }) as typeof fetch;
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(new JsonRpcHttpTransport('https://example.com/mcp', { Authorization: 'Bearer synthetic-secret' }, undefined, request));
    assert.equal((await client.listTools()).tools[0].name, 'lookup');
    assert.deepEqual(messages.map(item => item.method), ['initialize', 'notifications/initialized', 'tools/list']);
    await client.close();
});

test('POST transport rejects bad correlation IDs and HTTP errors without server payload disclosure', async () => {
    const transport = new JsonRpcHttpTransport('https://example.com', {}, undefined, (async () => Response.json({ jsonrpc: '2.0', id: 2, result: {} })) as typeof fetch);
    await assert.rejects(() => transport.send({ jsonrpc: '2.0', id: 1, method: 'ping' }), /неверный ID/);
    const denied = new JsonRpcHttpTransport('https://example.com', {}, undefined, (async () => new Response('private token secret', { status: 401 })) as typeof fetch);
    await assert.rejects(() => denied.send({ jsonrpc: '2.0', id: 1, method: 'ping' }), error => error instanceof Error && error.message === 'MCP HTTP 401');
});

test('discovery pages schemas, validates arguments, binds identity and closes connections', async () => {
    let calls = 0; let closed = 0; let connects = 0;
    const service = new McpService(config, async () => {
        connects++;
        return { close: async () => { closed++; }, client: { listTools: async ({ cursor }: { cursor?: string }) => cursor
            ? { tools: [{ name: 'lookup', inputSchema: { type: 'object', properties: { query: { type: 'string' }, requesterAgentId: { type: 'string' } }, required: ['query'], additionalProperties: false } }] }
            : { tools: [{ name: 'hidden', inputSchema: { type: 'object' } }], nextCursor: 'second' },
        callTool: async ({ arguments: args }: any) => { calls++; assert.equal(args.requesterAgentId, 'kira-test'); return { content: [{ type: 'text', text: 'ok' }] }; } } as any };
    });
    assert.deepEqual(await service.listTools('demo'), { tools: [], total: 0, nextOffset: undefined, nextCursor: 'second' });
    await assert.rejects(() => service.callTool('demo', 'hidden', {}, 'read'), McpInputError);
    await assert.rejects(() => service.callTool('demo', 'change', {}, 'read'), McpInputError);
    await assert.rejects(() => service.callTool('demo', 'lookup', { query: 12 }, 'read'), McpInputError);
    assert.equal(calls, 0);
    await service.callTool('demo', 'lookup', { query: 'demo', requesterAgentId: 'forged' }, 'read');
    assert.equal(calls, 1); assert.equal(connects, closed);
});

test('private owner access is checked at invocation and background work cannot invoke mutations', async () => {
    const definitions = mcpTools(new McpService(config));
    const registry = new ToolRegistry(definitions, ctx => ctx.ctx.from?.id === 101);
    const value = context();
    assert.equal((await registry.execute('mcp.listServers', {}, value)).status, 'ok');
    assert.doesNotMatch(JSON.stringify(await registry.execute('mcp.listServers', {}, value)), /synthetic-secret|Authorization|https:/);
    const denied = { ...value, ctx: { ...value.ctx, chat: { id: 101, type: 'group' } } as any };
    assert.equal((await registry.execute('mcp.listServers', {}, denied)).status, 'failed');
    assert.equal((await registry.execute('mcp.listServers', {}, { ...value, ctx: { ...value.ctx, from: { id: 202 } } as any })).status, 'failed');
    const mutation = definitions.find(item => item.name === 'mcp.callTool')!;
    assert.equal(isDialogueReadTool(mutation), false);
    assert.equal(availableRuntimeTools(definitions, value).some(item => item === mutation), false);
    assert.equal(canExecuteRuntimeCall(mutation, { id: 'x', tool: mutation.name, args: {} }, value), false);
    assert.equal((await registry.execute(mutation.name, { server: 'demo', tool: 'change', argumentsJson: '{}' }, { ...value, readOnly: true })).status, 'failed');
    assert.equal(needsRuntimeTools(value), true);
});

test('mutations require an affirmative continuation bound to exact arguments and never retry ambiguous calls', async () => {
    let calls = 0;
    const service = new McpService(config, async () => ({ close: async () => {}, client: { listTools: async () => ({ tools: [{ name: 'change', inputSchema: { type: 'object' } }] }), callTool: async () => { calls++; throw new Error('synthetic private provider failure'); } } as any }));
    const tool = mcpTools(service).find(item => item.name === 'mcp.callTool')!;
    const args = { server: 'demo', tool: 'change', argumentsJson: '{}' };
    const call = { tool: tool.name, args };
    const value = context(); value.classification.details.mcpAccess = 'write';
    assert.equal((await tool.execute(args, value)).status, 'needs_input'); assert.equal(calls, 0);
    assert.equal(confirmedMcpCallKey(call, 'нет'), undefined);
    value.confirmedMcpCall = confirmedMcpCallKey(call, 'да');
    assert.equal((await tool.execute({ ...args, argumentsJson: '{"changed":true}' }, value)).status, 'needs_input');
    const output = await tool.execute(args, value);
    assert.equal(output.status, 'unknown'); assert.equal(calls, 1); assert.doesNotMatch(output.summary, /private provider/);
});

test('full structured news content survives the evidence adapter and explicit errors remain errors', () => {
    const result = { content: [{ type: 'text' as const, text: 'summary' }], structuredContent: { ok: true, callResults: [{ capabilityId: 'search_news', result: { data: { links: [{ text: 'Synthetic article body', url: 'https://example.com/story' }] } } }] } };
    assert.match(mcpResultEvidence(result), /Synthetic article body/);
    assert.match(mcpResultEvidence(result, 50), /результат сокращён/);
});

test('stdio connects to a real child, does not inherit provider secrets and closes after the operation', async () => {
    const code = `const rl=require('node:readline').createInterface({input:process.stdin});
rl.on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;
const result=m.method==='initialize'?{protocolVersion:'2024-11-05',serverInfo:{name:'synthetic',version:'1'},capabilities:{tools:{}}}:
m.method==='tools/list'?{tools:[{name:'lookup',inputSchema:{type:'object'}}]}:
{content:[{type:'text',text:JSON.stringify({inheritedProviderSecret:!!process.env.OPENAI_API_KEY})}]};
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});`;
    const service = new McpService(() => parseMcpConfig({ servers: { demo: { description: 'Synthetic child', transport: 'stdio', command: process.execPath, args: ['-e', code], tools: { lookup: 'read' } } } }));
    const result = await service.callTool('demo', 'lookup', {}, 'read');
    assert.deepEqual(JSON.parse((result.content[0] as { text: string }).text), { inheritedProviderSecret: false });
});

test('standard Streamable HTTP uses the SDK without retrying a tool POST', async t => {
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
        if (init.method === 'GET') return new Response(null, { status: 405 });
        const m = JSON.parse(String(init.body));
        if (m.id === undefined) return new Response(null, { status: 202 });
        const result = m.method === 'initialize' ? { protocolVersion: '2024-11-05', serverInfo: { name: 'synthetic', version: '1' }, capabilities: { tools: {} } }
            : m.method === 'tools/list' ? { tools: [{ name: 'lookup', inputSchema: { type: 'object' } }] }
            : (calls++, { content: [{ type: 'text', text: 'synthetic HTTP evidence' }] });
        return Response.json({ jsonrpc: '2.0', id: m.id, result });
    });
    const service = new McpService(() => ({ demo: { ...config().demo, transport: 'http', fixedArguments: undefined } }));
    const result = await service.callTool('demo', 'lookup', {}, 'read');
    assert.match(mcpResultEvidence(result), /synthetic HTTP evidence/); assert.equal(calls, 1);
});

test('optional client_credentials refresh uses only dedicated config and caches an unexpired token', async t => {
    let requests = 0;
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
        requests++;
        assert.equal(init.redirect, 'error');
        const body = init.body as URLSearchParams;
        assert.equal(body.get('grant_type'), 'client_credentials'); assert.equal(body.get('client_id'), 'synthetic-kira-client');
        return Response.json({ access_token: 'synthetic-access-token', token_type: 'bearer', expires_in: 300 });
    });
    const server = { ...config().demo, headers: undefined, oauth: { tokenUrl: 'https://example.com/token', clientId: 'synthetic-kira-client', clientSecret: 'synthetic-dedicated-client-secret' } };
    const signal = new AbortController().signal;
    assert.equal((await mcpRequestHeaders(server, signal)).Authorization, 'Bearer synthetic-access-token');
    await mcpRequestHeaders(server, signal); assert.equal(requests, 1);
});

test('credentials echoed by an MCP server are redacted before they can enter evidence or session history', async () => {
    const service = new McpService(config, async () => ({ close: async () => {}, client: {
        listTools: async () => ({ tools: [{ name: 'lookup', inputSchema: { type: 'object' } }] }),
        callTool: async () => ({ content: [{ type: 'text', text: 'Echo: Bearer synthetic-secret' }], structuredContent: { echoedToken: 'synthetic-secret' } }),
    } as any }));
    const result = await service.callTool('demo', 'lookup', {}, 'read');
    assert.doesNotMatch(JSON.stringify(result), /synthetic-secret/);
    assert.match(mcpResultEvidence(result), /credential hidden/);
});

test('Money Maker personal-token schema accepts nested query and full mode without caller identity fields', async () => {
    let calls = 0;
    const server = { ...config().demo, fixedArguments: { responseMode: 'full' } };
    const service = new McpService(() => ({ demo: server }), async () => ({ close: async () => {}, client: {
        listTools: async () => ({ tools: [{ name: 'lookup', inputSchema: { type: 'object', additionalProperties: false,
            properties: { responseMode: { type: 'string', enum: ['full'] }, params: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } },
            anyOf: [{ required: ['params'] }] } }] }),
        callTool: async ({ arguments: args }: any) => { calls++; assert.deepEqual(args, { params: { query: 'synthetic issuer' }, responseMode: 'full' }); return { content: [] }; },
    } as any }));
    await service.callTool('demo', 'lookup', { params: { query: 'synthetic issuer' } }, 'read');
    await assert.rejects(() => service.callTool('demo', 'lookup', { requesterAgentId: 'forged', params: { query: 'synthetic issuer' } }, 'read'), McpInputError);
    assert.equal(calls, 1);
});
