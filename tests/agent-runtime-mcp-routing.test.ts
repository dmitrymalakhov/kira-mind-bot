import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyMessage } from '../orchestrator';
import * as completion from '../ai/chatCompletion';
import * as mcpConfig from '../services/mcp/config';
import { McpService } from '../services/mcp/client';
import { mcpTools } from '../orchestration/runtime/mcpTools';
import { ToolRegistry } from '../orchestration/runtime/registry';
import { runKiraRuntime } from '../orchestration/runtime/kernel';
import { tryFastDialogueResult } from '../orchestration/fastDialogue';
import { normalizeMcpSelection } from '../orchestration/mcpSelection';
import type { KiraRuntimeInput } from '../orchestration/runtime/types';

test('an unnamed request reaches discovery and composes two MCP services using actual upstream data', async t => {
    const configuration = mcpConfig.parseMcpConfig({ servers: {
        warehouse: { description: 'Остатки товаров и складские коды SKU', transport: 'jsonrpc', url: 'https://example.com/stock', tools: { list_low_stock: 'read', delete_product: 'external' } },
        supplies: { description: 'Ожидаемые поставки товаров по складским кодам SKU', transport: 'jsonrpc', url: 'https://example.com/delivery', tools: { find_deliveries: 'read' } },
    } });
    t.mock.method(mcpConfig, 'readMcpConfig', () => configuration);
    const stockSchema = { type: 'object' as const, properties: {}, additionalProperties: false };
    const deliverySchema = { type: 'object' as const, properties: { skus: { type: 'array' as const, items: { type: 'string' as const } } }, required: ['skus'], additionalProperties: false };
    const calls: Array<{ service: string; name: string; args: unknown }> = [];
    let phase = 0;
    const service = new McpService(() => configuration, async config => {
        const stock = config.url === 'https://example.com/stock';
        return { close: async () => {}, client: {
            listTools: async () => ({ tools: [{ name: stock ? 'list_low_stock' : 'find_deliveries', inputSchema: stock ? stockSchema : deliverySchema }] }),
            callTool: async (call: any) => {
                calls.push({ service: stock ? 'warehouse' : 'supplies', name: call.name, args: call.arguments });
                if (!stock) assert.deepEqual(call.arguments, { skus: ['SYNTH-17'] });
                return { content: [], structuredContent: stock ? { products: [{ sku: 'SYNTH-17', remaining: 2 }], server: 'untrusted-provider-label' }
                    : { deliveries: [{ sku: 'SYNTH-17', quantity: 12, expectedAt: '2026-11-01' }] } };
            },
        } as any };
    });
    t.mock.method(completion, 'createJsonChatCompletionForTask', async (task: string, options: any) => {
        const userText = options.messages.find((item: any) => item.role === 'user').content;
        if (task === 'fastDialogue') {
            assert.match(userText, /list_low_stock/); assert.match(userText, /find_deliveries/);
            assert.match(userText, /даже без|не обязан называть/);
            assert.doesNotMatch(userText, /https:\/\/example.com/);
            return { intent: 'РАЗГОВОР', confidenceLevel: 'ВЫСОКИЙ', details: { mcpAccess: 'read', mcpServers: ['warehouse','supplies','invented','warehouse'], memoryNeed: 'none', responseComplexity: 'routine' },
                fastReply: { mode: 'answer', answer: 'Unsupported synthetic guess' } } as any;
        }
        assert.equal(task, 'runtimePlanning');
        const body = JSON.parse(userText);
        switch (phase++) {
            case 0: {
                assert.deepEqual(body.classification.details.mcpServers, ['warehouse','supplies']);
                return { calls: [{ id: 'stock_schema', tool: 'mcp.listTools', args: { server: 'warehouse', query: 'list_low_stock' } },
                    { id: 'delivery_schema', tool: 'mcp.listTools', args: { server: 'supplies', query: 'find_deliveries' } }] } as any;
            }
            case 1: {
                assert.deepEqual(body.observations.find((item: any) => item.id === 'stock_schema').data.tools[0].inputSchema, stockSchema);
                assert.deepEqual(body.observations.find((item: any) => item.id === 'delivery_schema').data.tools[0].inputSchema, deliverySchema);
                return { calls: [{ id: 'stock', tool: 'mcp.callReadTool', args: { server: 'warehouse', tool: 'list_low_stock', argumentsJson: '{}' } }] } as any;
            }
            case 2: {
                const stock = body.observations.find((item: any) => item.id === 'stock');
                assert.equal(stock.mcpServer, 'warehouse');
                const products = JSON.parse(stock.summary).structuredContent.products;
                return { calls: [{ id: 'delivery', tool: 'mcp.callReadTool', args: { server: 'supplies', tool: 'find_deliveries',
                    argumentsJson: JSON.stringify({ skus: products.map((item: any) => item.sku) }) }, dependsOn: ['stock'] }] } as any;
            }
            default: return { finish: true } as any;
        }
    });
    const message = 'Найди товары с низким остатком и покажи ожидаемые поставки для каждого';
    const classification = await classifyMessage(message, false, '', [], [], {});
    assert.equal(classification.details.mcpAccess, 'read');
    assert.deepEqual(classification.details.mcpServers, ['warehouse','supplies']);
    assert.deepEqual(classification.fastReply, { mode: 'route' });
    const value: KiraRuntimeInput = { ctx: { from: { id: 101 }, chat: { id: 101, type: 'private' }, session: { messageHistory: [], reminders: [], domains: {} } } as any,
        message, isForwarded: false, forwardFrom: '', messageHistory: [], classification };
    assert.equal(await tryFastDialogueResult(value.ctx, { userText: message }, classification,
        { source: 'stable_general', requiresWeb: false, requestedFacets: [], reason: 'synthetic' }, []), undefined);
    const result = await runKiraRuntime(value, { registry: new ToolRegistry(mcpTools(service), () => true), persist: async () => {},
        respond: async (_input, evidence) => {
            assert.match(evidence, /MCP-сервис "warehouse"/); assert.match(evidence, /MCP-сервис "supplies"/);
            assert.match(evidence, /SYNTH-17/); assert.match(evidence, /2026-11-01/);
            return { responseText: 'По складу осталось 2 шт., по поставкам ожидается ещё 12 шт. 1 ноября.' };
        } });
    assert.equal(result.operationStatus, 'ok');
    assert.deepEqual(calls, [{ service: 'warehouse', name: 'list_low_stock', args: {} },
        { service: 'supplies', name: 'find_deliveries', args: { skus: ['SYNTH-17'] } }]);
    assert.equal(phase, 4);
    assert.deepEqual(value.ctx.session.agentRuntime!.observations!.filter(item => item.tool === 'mcp.callReadTool').map(item => item.mcpServer), ['warehouse', 'supplies']);
});

test('selection validates local IDs, merges compound sources and never derives mutation rights from a source list', () => {
    const base = { intent: 'РАЗГОВОР' as const,confidenceLevel: 'ВЫСОКИЙ' as const,details: {} };
    const read = normalizeMcpSelection({ ...base,details: { mcpServers: ['crm','unknown','crm'],mcpAllowWeb: true },fastReply: { mode: 'answer',answer: 'guess' } }, ['crm']);
    assert.deepEqual(read.details.mcpServers, ['crm']); assert.equal(read.details.mcpAccess,'read');
    assert.deepEqual(read.fastReply, { mode: 'route' });
    const invalid = normalizeMcpSelection({ ...base,details: { mcpServers: ['unknown'],mcpAllowWeb: true } }, ['crm']);
    assert.equal(invalid.details.mcpAccess,undefined); assert.equal(invalid.details.mcpAllowWeb,undefined);
    const compound = normalizeMcpSelection({ ...base,details: { mcpAccess: 'read',mcpServers: ['warehouse'] },
        subIntents: [{ intent: 'РАЗГОВОР',details: { mcpAccess: 'write',mcpServers: ['crm'] } }] }, ['warehouse','crm']);
    assert.equal(compound.details.mcpAccess,'write'); assert.deepEqual(compound.details.mcpServers,['warehouse','crm']);
    const catalog = normalizeMcpSelection({ ...base,details: { mcpAccess: 'read',mcpServers: [] } }, ['crm']);
    assert.equal(catalog.details.mcpAccess,'read'); assert.deepEqual(catalog.details.mcpServers,[]);
});

test('a large server capability catalog survives the actual planner observation packing', async t => {
    const configuration = mcpConfig.parseMcpConfig({ servers: Object.fromEntries(Array.from({ length: 16 }, (_, index) => [`synthetic-${index}`, {
        description: 'Синтетические возможности сервиса. '.repeat(30), transport: 'jsonrpc', url: 'https://example.com/mcp',
        tools: Object.fromEntries(Array.from({ length: 40 }, (_unused, tool) => [`lookup_${tool}`, 'read'])),
    }])) });
    const service = new McpService(() => configuration, async () => { throw new Error('A local catalog must not contact providers'); });
    const catalog = service.servers();
    assert.ok(JSON.stringify(catalog).length > 4000);
    let phase = 0;
    t.mock.method(completion, 'createJsonChatCompletionForTask', async (_task: string, options: any) => {
        const body = JSON.parse(options.messages.find((item: any) => item.role === 'user').content);
        if (phase++ === 0) return { calls: [{ id: 'servers', tool: 'mcp.listServers', args: {} }] } as any;
        assert.deepEqual(body.observations[0].data, catalog);
        assert.ok(JSON.stringify(body.observations).length <= 40_000);
        return { finish: true } as any;
    });
    const value: KiraRuntimeInput = { ctx: { from: { id: 101 }, chat: { id: 101, type: 'private' }, session: {} } as any,
        message: 'Какие источники данных подключены?', isForwarded: false, forwardFrom: '', messageHistory: [],
        classification: { intent: 'РАЗГОВОР', confidenceLevel: 'ВЫСОКИЙ', details: { mcpAccess: 'read' } } };
    const result = await runKiraRuntime(value, { registry: new ToolRegistry(mcpTools(service), () => true), persist: async () => {},
        respond: async () => ({ responseText: 'Каталог проверен' }) });
    assert.equal(result.operationStatus, 'ok'); assert.equal(phase, 2);
});
