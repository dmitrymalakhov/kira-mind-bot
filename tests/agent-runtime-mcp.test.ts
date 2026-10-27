import assert from 'node:assert/strict';
import { test } from 'node:test';
import { McpService } from '../services/mcp/client';
import { parseMcpConfig } from '../services/mcp/config';
import { mcpTools } from '../orchestration/runtime/mcpTools';
import { ToolRegistry } from '../orchestration/runtime/registry';
import { runKiraRuntime, continueQuestionRuntime } from '../orchestration/runtime/kernel';
import type { KiraRuntimeInput, RuntimeDecision } from '../orchestration/runtime/types';
import { tryFastDialogueResult } from '../orchestration/fastDialogue';
import * as completion from '../ai/chatCompletion';

function input(write = false): KiraRuntimeInput {
    return { ctx: { from: { id: 101 }, chat: { id: 101, type: 'private' }, session: { messageHistory: [], reminders: [], domains: {} } } as any,
        message: write ? 'Выполни изменение через MCP' : 'Получи актуальные данные через MCP', isForwarded: false, forwardFrom: '', messageHistory: [],
        classification: { intent: write ? 'РАЗГОВОР' : 'ВЕБ_ПОИСК', confidenceLevel: 'ВЫСОКИЙ', details: { mcpAccess: write ? 'write' : 'read', ...(write ? {} : { knowledgeSource: 'external_current' }) } } };
}
function scripted(decisions: RuntimeDecision[]) { let i = 0; return async () => decisions[i++] ?? { finish: true }; }
function service(execute: () => void) {
    return new McpService(() => parseMcpConfig({ servers: { demo: { description: 'Synthetic', transport: 'jsonrpc', url: 'https://example.com/mcp', tools: { lookup: 'read', change: 'external' } } } }),
        async () => ({ close: async () => {}, client: { listTools: async () => ({ tools: ['lookup', 'change'].map(name => ({ name, inputSchema: { type: 'object' } })) }),
            callTool: async () => { execute(); return { content: [{ type: 'text', text: 'Synthetic verified data' }] }; } } as any }));
}

test('MCP current-data requests use the adaptive loop and real MCP evidence instead of the web fast path', async () => {
    let reads = 0;
    const value = input();
    const result = await runKiraRuntime(value, { registry: new ToolRegistry(mcpTools(service(() => { reads++; })), () => true), persist: async () => {},
        decide: scripted([{ calls: [{ id: 'read', tool: 'mcp.callReadTool', args: { server: 'demo', tool: 'lookup', argumentsJson: '{}' } }] }, { finish: true }]),
        respond: async (_input, evidence) => { assert.match(evidence, /Synthetic verified data/); return { responseText: 'Проверенные данные MCP' }; } });
    assert.equal(reads, 1); assert.equal(result.operationStatus, 'ok');
    assert.deepEqual(value.ctx.session.agentRuntime?.toolNames, ['mcp.callReadTool']);
});

test('an MCP mutation waits for a human reply, journals before dispatch and resumes exactly once', async () => {
    let writes = 0;
    const value = input(true);
    const registry = new ToolRegistry(mcpTools(service(() => {
        writes++;
        assert.ok(value.ctx.session.agentRuntime?.receipts.some(item => item.status === 'running'));
    })), () => true);
    const dependencies = { registry, persist: async () => {}, respond: async () => ({ responseText: 'Состояние по квитанциям' }),
        decide: scripted([{ calls: [{ id: 'write', tool: 'mcp.callTool', args: { server: 'demo', tool: 'change', argumentsJson: '{}' } }] }, { finish: true }]) };
    assert.equal((await runKiraRuntime(value, dependencies)).operationStatus, 'needs_input');
    assert.equal(writes, 0);
    const result = await continueQuestionRuntime(value.ctx, 'да', dependencies);
    assert.equal(result?.operationStatus, 'ok'); assert.equal(writes, 1);
    assert.equal(value.ctx.session.agentRuntime?.receipts.filter(item => item.status === 'ok').length, 2);
});

test('MCP requests cannot receive a fast answer without calling the service', async () => {
    const value = input(); value.classification.fastReply = { mode: 'answer', answer: 'Unsupported guess' };
    const result = await tryFastDialogueResult(value.ctx, { userText: value.message } as any, value.classification,
        { source: 'stable_general', requiresWeb: false, requestedFacets: [], reason: 'synthetic' }, []);
    assert.equal(result, undefined);
});

test('the default planner receives MCP schemas over 2000 characters and uses them to read data', async t => {
    let reads = 0;
    let phase = 0;
    let plannedSchema: unknown;
    const schema = { type: 'object' as const, properties: { topic: { type: 'string' as const, description: 'Synthetic indicator lookup parameter. '.repeat(100) } }, required: ['topic'], additionalProperties: false };
    const mcp = new McpService(() => parseMcpConfig({ servers: { demo: { description: 'Synthetic analytics', transport: 'jsonrpc', url: 'https://example.com/mcp', tools: { lookup: 'read' } } } }),
        async () => ({ close: async () => {}, client: { listTools: async () => ({ tools: [{ name: 'lookup', inputSchema: schema }] }),
            callTool: async (call: any) => { reads++; assert.deepEqual(call.arguments, { topic: 'synthetic' }); return { content: [{ type: 'text', text: 'Verified synthetic indicator data' }] }; } } as any }));
    t.mock.method(completion, 'createJsonChatCompletionForTask', async (task: string, options: any) => {
        assert.equal(task, 'runtimePlanning');
        const body = JSON.parse(options.messages.find((message: any) => message.role === 'user').content);
        assert.ok(JSON.stringify(body.observations).length <= 40_000);
        switch (phase++) {
            case 0: return { calls: [{ id: 'servers', tool: 'mcp.listServers', args: {} }] } as any;
            case 1: return { calls: [{ id: 'catalog', tool: 'mcp.listTools', args: { server: 'demo' } }] } as any;
            case 2: {
                const catalog = body.observations.find((item: any) => item.tool === 'mcp.listTools');
                plannedSchema = catalog?.data?.tools?.[0]?.inputSchema;
                return { calls: [{ id: 'read', tool: 'mcp.callReadTool', args: { server: 'demo', tool: 'lookup', argumentsJson: '{"topic":"synthetic"}' } }] } as any;
            }
            default: return { finish: true } as any;
        }
    });
    const result = await runKiraRuntime(input(), { registry: new ToolRegistry(mcpTools(mcp), () => true), persist: async () => {},
        respond: async (_input, evidence) => { assert.match(evidence, /Verified synthetic indicator data/); return { responseText: 'Verified result' }; } });
    assert.ok(JSON.stringify(plannedSchema)?.length > 2000, 'the schema must reach the actual planner prompt');
    assert.deepEqual(plannedSchema, schema);
    assert.equal(result.operationStatus, 'ok'); assert.equal(reads, 1); assert.equal(phase, 4);
});

test('duplicate call IDs are repaired before dispatch without repeating a committed state change', async () => {
    let writes = 0;
    const value = input(true);
    const registry = new ToolRegistry([{ name: 'mcp.syntheticChange', description: 'Synthetic state change', skill: 'mcp', ownerOnly: true, effect: 'state', inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        execute: async () => { writes++; assert.equal(value.ctx.session.agentRuntime?.receipts.at(-1)?.status, 'running'); return { status: 'ok', summary: 'Saved synthetic state' }; } }], () => true);
    const result = await runKiraRuntime(value, { registry, persist: async () => {}, respond: async () => ({ responseText: 'Saved once' }),
        decide: scripted([{ calls: [{ id: 'change', tool: 'mcp.syntheticChange', args: {} }] },
            { calls: [{ id: 'change', tool: 'mcp.syntheticChange', args: {} }] },
            { calls: [{ id: 'checked', tool: 'mcp.syntheticChange', args: {} }] }, { finish: true }]) });
    assert.equal(result.operationStatus, 'ok'); assert.equal(writes, 1);
    assert.equal(value.ctx.session.agentRuntime?.receipts.length, 1);
    assert.ok(!value.ctx.session.agentRuntime?.observations?.some(item => item.tool === 'kernel.plan'));
});

test('catalog schemas keep the newest evidence within the planner observation budget', async t => {
    const value = input(true);
    const data = { tools: [{ name: 'lookup', inputSchema: { type: 'object', properties: { topic: { type: 'string', description: 'x'.repeat(9000) } } } }] };
    const observations = Array.from({ length: 50 }, (_, index) => ({ id: `catalog_${index}`, tool: 'mcp.listTools', status: 'ok' as const, summary: 'Catalog', data }));
    const continuation = { version: 1 as const, runId: 'synthetic-catalog-run', status: 'running' as const, startedAt: 1, updatedAt: 1,
        goal: value.message, classification: value.classification, receipts: [], agents: [], skills: ['mcp'], toolNames: [], observations };
    let inspected = false;
    t.mock.method(completion, 'createJsonChatCompletionForTask', async (_task: string, options: any) => {
        const body = JSON.parse(options.messages.find((message: any) => message.role === 'user').content);
        assert.ok(JSON.stringify(body.observations).length <= 40_000);
        assert.deepEqual(body.observations.at(-1).data, data);
        inspected = true;
        return { finish: true } as any;
    });
    await runKiraRuntime(value, { registry: new ToolRegistry([], () => true), continuation, persist: async () => {}, respond: async () => ({ responseText: 'Catalog inspected' }) });
    assert.equal(inspected, true);
    assert.equal(observations.length, 50);
});
