import assert from 'node:assert/strict';
import { test } from 'node:test';
import { McpService } from '../services/mcp/client';
import { parseMcpConfig } from '../services/mcp/config';
import { mcpTools } from '../orchestration/runtime/mcpTools';
import { ToolRegistry } from '../orchestration/runtime/registry';
import { runKiraRuntime, continueQuestionRuntime } from '../orchestration/runtime/kernel';
import type { KiraRuntimeInput, RuntimeDecision } from '../orchestration/runtime/types';
import { tryFastDialogueResult } from '../orchestration/fastDialogue';

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
