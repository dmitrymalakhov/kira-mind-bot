import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { parseMcpConfig, readMcpConfig, mcpServerCatalog, mcpClassifierContext, MCP_SERVER_CATALOG_CHARS } from '../services/mcp/config';
import { McpService, McpInputError, mcpResultEvidence } from '../services/mcp/client';
import { JsonRpcHttpTransport, McpHttpError } from '../services/mcp/jsonRpcTransport';
import { mcpTools, confirmedMcpCallKey } from '../orchestration/runtime/mcpTools';
import { ToolRegistry } from '../orchestration/runtime/registry';
import { availableRuntimeTools, canExecuteRuntimeCall, isDialogueReadTool, needsRuntimeTools } from '../orchestration/runtime/authorization';
import type { ToolContext } from '../orchestration/runtime/types';
import { mcpRequestHeaders } from '../services/mcp/auth';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

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

test('local routing catalog exposes only permitted capabilities without connecting to providers', () => {
    const service = new McpService(config, async () => { throw new Error('Discovery must remain local'); });
    const catalog = service.servers();
    assert.deepEqual(catalog, [{ id: 'demo', description: 'Синтетический сервис', tools: 2,
        readTools: ['lookup'], actionTools: ['change'], omittedTools: 0 }]);
    const prompt = mcpClassifierContext(config);
    assert.ok(prompt.includes(JSON.stringify(catalog)));
    assert.doesNotMatch(prompt, /synthetic-secret|Authorization|https:|requesterAgentId/);
    const changed = config(); changed.demo.tools.lookup = 'external';
    assert.notEqual(mcpClassifierContext(() => changed), prompt, 'permission changes must invalidate the routing context/cache');
    assert.equal(mcpClassifierContext(() => ({})), '');
    assert.equal(mcpClassifierContext(() => { throw new Error('synthetic private config error'); }), '');
});

test('routing catalog keeps every server within a shared JSON budget and marks omitted tool names', () => {
    const servers = Object.fromEntries(Array.from({ length: 16 }, (_, index) => [`synthetic-${index}`, {
        ...config().demo, description: '\n"\\'.repeat(500), tools: Object.fromEntries(Array.from({ length: 200 }, (_unused, tool) =>
            [`tool_${tool}_${'x'.repeat(112)}`, tool % 2 ? 'external' : 'read'])),
    }]));
    const catalog = mcpServerCatalog(parseMcpConfig({ servers }));
    assert.equal(catalog.length, 16);
    assert.ok(JSON.stringify(catalog).length <= MCP_SERVER_CATALOG_CHARS);
    for (const server of catalog) {
        assert.ok(server.readTools.length > 0); assert.ok(server.actionTools.length > 0);
        assert.equal(server.tools, 200);
        assert.equal(server.omittedTools, 200 - server.readTools.length - server.actionTools.length);
        assert.ok(server.omittedTools > 0);
    }
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

test('HTTP throttling survives initialization with a safe retry delay and no automatic replay', async t => {
    let requests = 0; let cancelled = false;
    t.mock.method(globalThis, 'fetch', async () => {
        requests++;
        return new Response(new ReadableStream({ cancel: () => { cancelled = true; } }), {
            status: 429, headers: { 'Retry-After': '37', 'X-Private-Value': 'synthetic-secret' },
        });
    });
    const service = new McpService(config);
    await assert.rejects(() => service.listTools('demo'), error => error instanceof McpHttpError && error.status === 429 && error.retryAfterSeconds === 37);
    assert.equal(requests, 1); assert.equal(cancelled, true);
    const tools = mcpTools(service);
    const catalog = await tools.find(tool => tool.name === 'mcp.listTools')!.execute({ server: 'demo' }, context());
    const read = await tools.find(tool => tool.name === 'mcp.callReadTool')!.execute({ server: 'demo', tool: 'lookup', argumentsJson: '{}' }, context());
    for (const result of [catalog, read]) {
        assert.equal(result.status, 'failed'); assert.match(result.summary, /лимит[\s\S]*37 сек/);
        assert.doesNotMatch(JSON.stringify(result), /synthetic-secret|Authorization|example.com/);
    }
    assert.equal(requests, 3);
});

test('server parameter rejection is reported as input failure without provider diagnostics', async () => {
    const service = new McpService(config, async () => ({ close: async () => {}, client: {
        listTools: async () => ({ tools: [{ name: 'lookup', inputSchema: { type: 'object' } }] }),
        callTool: async () => { throw new McpError(ErrorCode.InvalidParams, 'synthetic private provider diagnostics'); },
    } as any }));
    const result = await mcpTools(service).find(tool => tool.name === 'mcp.callReadTool')!.execute({ server: 'demo', tool: 'lookup', argumentsJson: '{}' }, context());
    assert.equal(result.status, 'failed'); assert.match(result.summary, /отклонил параметры/);
    assert.doesNotMatch(result.summary, /private provider|авторизац/);
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

test('tool discovery searches schema terms and does not mistake an empty filter for a complete catalog', async () => {
    const service = new McpService(config, async () => ({ close: async () => {}, client: { listTools: async () => ({ tools: [{ name: 'lookup',
        inputSchema: { type: 'object', properties: { indicator: { type: 'string', description: 'RSI and other synthetic indicators' } } } }] }) } as any }));
    assert.equal((await service.listTools('demo', undefined, undefined, 0, 'RSI')).tools[0].name, 'lookup');
    const output = await mcpTools(service).find(tool => tool.name === 'mcp.listTools')!.execute({ server: 'demo', query: 'missing-term' }, context());
    assert.equal(output.status, 'ok'); assert.match(output.summary, /не доказывает отсутствия/);
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

test('large Money Maker presentation wrappers do not displace source text, report coverage or freshness', () => {
    const article = 'Synthetic source article. '.repeat(90);
    const result = { content: [{ type: 'text' as const, text: 'Duplicated summary. '.repeat(2000) }], structuredContent: {
        mcp: { version: 'money_maker_mcp_tool_result_v1' }, ok: true, resolution: 'partial',
        rolePayload: { facts: ['Duplicated fact. '.repeat(2000)], answer: 'Partial report', dataQuality: { status: 'partial' } },
        callResults: [{ capabilityId: 'report', result: { resolution: 'partial', data: {
            links: [{ text: article, url: 'https://example.com/report', publishedAt: '2026-01-01T12:00:00Z' }],
            coverage: { complete: false }, sources: [{ status: 'error' }],
            marketData: { asOf: '2026-01-01T11:00:00Z', freshness: 'stale', calendarVerified: false },
        } } }],
    } };
    const text = mcpResultEvidence(result);
    assert.ok(text.length <= 10_000);
    const body = JSON.parse(text).structuredContent;
    assert.equal(body.callResults[0].result.data.links[0].text, article);
    assert.equal(body.callResults[0].result.data.marketData.asOf, '2026-01-01T11:00:00Z');
    assert.equal(body.callResults[0].result.data.sources[0].status, 'error');
    assert.equal(body.rolePayload.dataQuality.status, 'partial');
    assert.equal(result.structuredContent.rolePayload.facts.length, 1);
});

test('oversized evidence remains valid JSON and explicitly marks shortening while retaining source metadata', () => {
    const links = Array.from({ length: 8 }, (_, index) => ({ text: 'Synthetic article content. '.repeat(500),
        url: `https://example.com/news/${index}`, publishedAt: '2026-01-01T12:00:00Z' }));
    const result = { content: [], structuredContent: { mcp: { version: 'money_maker_mcp_tool_result_v1' }, ok: true, resolution: 'partial',
        callResults: [{ capabilityId: 'search_news', result: { data: { links, sourceStatus: 'partial', asOf: '2026-01-01T12:00:00Z' } } }] } };
    const text = mcpResultEvidence(result);
    assert.ok(text.length <= 10_000);
    const evidence = JSON.parse(text);
    assert.equal(evidence.truncated, true);
    assert.match(evidence.notice, /полнота данных не гарантирована/);
    const data = evidence.structuredContent.callResults[0].result.data;
    assert.equal(data.links.length, 8);
    assert.equal(data.links[7].url, links[7].url);
    assert.equal(data.links[7].publishedAt, links[7].publishedAt);
    assert.equal(data.sourceStatus, 'partial');
    assert.equal(data.asOf, '2026-01-01T12:00:00Z');
    assert.equal(links[0].text.length, 13_500);
});

test('generic MCP results retain unique text alongside structured content when bounded', () => {
    const result = { content: [{ type: 'text' as const, text: 'Unique source evidence. '.repeat(1000) }],
        structuredContent: { resolution: 'partial', source: 'https://example.com/source' } };
    const evidence = JSON.parse(mcpResultEvidence(result));
    assert.match(evidence.content[0].text, /Unique source evidence/);
    assert.equal(evidence.structuredContent.source, 'https://example.com/source');
});

test('market evidence supplies UTC labels without confusing candle and fetch times or changing offsets', () => {
    const result = { content: [], structuredContent: { mcp: { version: 'money_maker_mcp_tool_result_v1' }, callResults: [
        { capabilityId: 'price', result: { data: { marketData: { ticker: 'SYNTH', interval: '1h',
            lastCandleAt: '2026-01-01T06:00:00Z', fetchedAt: '2026-01-01T07:20:59.888Z', asOf: '2026-02-30T07:00:00Z' } } } },
    ] } };
    const evidence = JSON.parse(mcpResultEvidence(result));
    assert.equal(evidence.marketTimesUTC[0].lastCandleAtUTC, '2026-01-01 06:00:00 UTC');
    assert.equal(evidence.marketTimesUTC[0].fetchedAtUTC, '2026-01-01 07:20:59.888 UTC');
    assert.equal(evidence.marketTimesUTC[0].asOfUTC, undefined);
    assert.equal(evidence.structuredContent.callResults[0].result.data.marketData.fetchedAt, '2026-01-01T07:20:59.888Z');
});

test('long indicator series retain the newest value alongside explicit omitted-middle metadata', () => {
    const values = Array.from({ length: 850 }, (_, index) => ({ time: `synthetic-${index}`, value: index / 10 }));
    const result = { content: [], structuredContent: { mcp: { version: 'money_maker_mcp_tool_result_v1' }, callResults: [
        { capabilityId: 'get_indicator', result: { data: { full: { values }, marketData: { freshness: 'recent_for_requested_window' } } } },
    ] } };
    const text = mcpResultEvidence(result);
    assert.ok(text.length <= 10_000);
    const evidence = JSON.parse(text);
    const kept = evidence.structuredContent.callResults[0].result.data.full.values;
    assert.deepEqual(kept[0], values[0]); assert.deepEqual(kept[kept.length - 1], values[values.length - 1]);
    assert.ok(kept.some((item: any) => item.mcpOmittedItems > 0 && item.location === 'middle'));
    assert.equal(evidence.truncated, true);
});

test('MCP source selection blocks automatic web substitution while preserving explicitly requested cross-checks', () => {
    const value = context();
    const web = { name: 'web.search', skill: 'web-research', effect: 'read', inputSchema: { type: 'object' }, description: '' } as any;
    const research = { ...web, name: 'agents.start', effect: 'external' } as any;
    const definitions = [web, research];
    assert.equal(availableRuntimeTools(definitions, value).some(tool => tool.name === 'web.search'), false);
    assert.equal(canExecuteRuntimeCall(web, { id: 'web', tool: web.name, args: {} }, value), false);
    assert.equal(canExecuteRuntimeCall(research, { id: 'agent', tool: research.name, args: { kind: 'research' } }, value), false);
    assert.equal(canExecuteRuntimeCall(research, { id: 'browser', tool: research.name, args: { kind: 'browser' } }, value), false);
    value.readOnly = true;
    assert.equal(canExecuteRuntimeCall(web, { id: 'web', tool: web.name, args: {} }, value), false);
    value.classification.details.mcpAllowWeb = true;
    assert.equal(availableRuntimeTools(definitions, value).some(tool => tool.name === 'web.search'), true);
    assert.equal(canExecuteRuntimeCall(web, { id: 'web', tool: web.name, args: {} }, value), true);
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
