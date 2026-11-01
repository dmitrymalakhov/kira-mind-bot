import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runKiraRuntime } from '../orchestration/runtime/kernel';
import { ToolRegistry, objectSchema, textSchema } from '../orchestration/runtime/registry';
import type { KiraRuntimeInput, RuntimeDecision } from '../orchestration/runtime/types';
import { shouldCancelBrowserTask } from '../utils/browserTaskCancellation';

test('website action limits do not cancel a task; only a full semantic refusal or standalone stop does', () => {
    for (const text of ['Не бронируй, только осмотри страницу.', 'Не оформляй заявку, я сам заполню форму.', 'Кнопка «отмена» находится справа.', 'Останови всё и открой другую страницу.']) {
        assert.equal(shouldCancelBrowserTask(text), false);
        assert.equal(shouldCancelBrowserTask(text, 'continue'), false);
    }
    assert.equal(shouldCancelBrowserTask('Я передумал, задача больше не нужна.', 'cancel'), true);
    assert.equal(shouldCancelBrowserTask('стоп', 'continue'), true);
});

for (const scenario of ['browser', 'question', 'conversation', 'read-only', 'failure', 'mcp-plus-browser', 'mcp-only'] as const) test(`runtime browser evidence before completion: ${scenario}`, async () => {
    let executions = 0;
    const mcp = scenario.startsWith('mcp-');
    const input: KiraRuntimeInput = {
        ctx: { from: { id: 94102 }, chat: { id: 94102, type: 'private' }, session: { messageHistory: [] } } as any,
        message: 'Открой страницу и покажи форму. Ничего не отправляй.', messageHistory: [], isForwarded: false, forwardFrom: '',
        classification: { intent: scenario === 'conversation' ? 'РАЗГОВОР' : 'БРАУЗЕР_ЗАДАЧА', confidenceLevel: 'ВЫСОКИЙ', details: {} },
        ...(scenario === 'read-only' ? { readOnly: true } : {}),
    };
    if (mcp) { input.classification.intent = 'ВЕБ_ПОИСК'; input.classification.subIntents = [{ intent:'БРАУЗЕР_ЗАДАЧА' }];
        input.classification.details = { mcpAccess:'read', mcpAllowWeb:scenario === 'mcp-plus-browser', knowledgeSource:'external_current' }; }
    let reads = 0, plans = 0;
    const registry = new ToolRegistry([{ name: 'mcp.callReadTool', skill:'mcp', effect:'read', ownerOnly:false,
        description:'Synthetic source', inputSchema:objectSchema({}), async execute() { reads++; return {status:'ok',summary:'Synthetic MCP evidence'}; } },
        { name: 'agents.start', skill: 'browser-workflows', effect: 'external', ownerOnly: false,
        description: 'Synthetic browser', inputSchema: objectSchema({ kind: { type: 'string', enum: ['browser'] }, task: textSchema('Task') }, ['kind','task']),
        async execute(args) { executions++; assert.equal(args.task, input.message);
            return { status: scenario === 'failure' ? 'failed' : 'needs_input', summary: 'Synthetic browser observation',
                result: { responseText: 'Synthetic browser observation', operationStatus: scenario === 'failure' ? 'failed' : 'needs_input' } };
        } }], () => true);
    const result = await runKiraRuntime(input, { registry, forceLoop: true, persist: async () => {},
        decide: async (): Promise<RuntimeDecision> => mcp && plans++ === 0 ? { calls:[{id:'source',tool:'mcp.callReadTool',args:{}}] }
            : scenario === 'question' ? { question: 'Какую страницу открыть?' } : { finish: true },
        respond: async () => ({ responseText: 'Synthetic conversation' }) });
    assert.equal(executions, ['browser','failure','mcp-plus-browser'].includes(scenario) ? 1 : 0);
    assert.equal(reads, mcp ? 1 : 0);
    if (scenario === 'browser' || scenario === 'question') assert.equal(result.operationStatus, 'needs_input');
    if (scenario === 'failure') assert.equal(result.operationStatus, 'failed');
});
