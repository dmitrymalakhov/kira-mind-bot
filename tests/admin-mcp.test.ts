import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, stat, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const { createMcpSettingsStore, mcpSettingsFile, probeMoneyMaker, MONEY_MAKER_TOOLS } = require('../admin-panel/mcp');
const url = 'https://example.com/api/stocks/money-maker/mcp';

test('MCP admin masks credentials, retains unrelated servers and checks revisions before atomic writes', async t => {
    const root = await mkdtemp(path.join(tmpdir(), 'kira-mcp-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const file = path.join(root, 'mcp.json');
    await writeFile(file, JSON.stringify({ servers: { other: { description: 'synthetic other service' } } }));
    const store = createMcpSettingsStore(async () => file);
    const first = await store.get();
    const saved = await store.save({ revision: first.revision, url, token: 'synthetic-mcp-secret' });
    assert.equal(saved.configured, true); assert.equal(saved.tokenConfigured, true);
    assert.doesNotMatch(JSON.stringify(saved), /synthetic-mcp-secret|Authorization|Bearer/);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal(JSON.parse(await readFile(file, 'utf8')).servers.other.description, 'synthetic other service');
    await assert.rejects(() => store.save({ revision: first.revision, url, token: 'synthetic-new-secret' }), (error: any) => error.status === 409);
    await assert.rejects(() => store.save({ revision: saved.revision, url: url.replace('example.com', 'other.example.com') }), /вставь токен заново/);
    const unchanged = await store.save({ revision: saved.revision, url });
    assert.equal(JSON.parse(await readFile(file, 'utf8')).servers['money-maker'].headers.Authorization, 'Bearer synthetic-mcp-secret');
    const disconnected = await store.save({ revision: unchanged.revision }, true);
    assert.equal(disconnected.configured, false);
    assert.equal(JSON.parse(await readFile(file, 'utf8')).servers.other.description, 'synthetic other service');
});

test('MCP admin account mode writes only into the trusted imported account runtime and refuses missing bindings', async t => {
    const root = await mkdtemp(path.join(tmpdir(), 'kira-mcp-account-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await assert.rejects(() => mcpSettingsFile(root, true), /Не найдено/);
    await mkdir(path.join(root, 'accounts/import'), { recursive: true });
    const accountId = '11111111-2222-4333-8444-555555555555';
    await writeFile(path.join(root, 'accounts/import/current-account.json'), JSON.stringify({ accountId, phase: 'active', accessToken: 'synthetic-private-binding-secret' }));
    const file = await mcpSettingsFile(root, true);
    assert.equal(file, path.join(root, 'accounts/kira_u_11111111222243338444555555555555/data/mcp.json'));
    assert.equal(await mcpSettingsFile(root, false), path.join(root, 'mcp.json'));
});

test('admin connection probe uses only initialize/discovery and never reflects provider errors or credentials', async () => {
    const calls: any[] = [];
    const server = { url, headers: { Authorization: 'Bearer synthetic-test' } };
    const result = await probeMoneyMaker(server, async (_url: string, init: RequestInit) => {
        assert.equal(init.redirect, 'error');
        const request = JSON.parse(String(init.body)); calls.push(request);
        if (request.id === undefined) return new Response(null, { status: 204 });
        return Response.json({ jsonrpc: '2.0', id: request.id, result: request.method === 'initialize'
            ? { protocolVersion: '2024-11-05', capabilities: { tools: {} } }
            : { tools: [{ name: MONEY_MAKER_TOOLS[0] }, { name: 'trade_execute' }] } });
    });
    assert.deepEqual(result, { success: true, toolCount: 1 });
    assert.deepEqual(calls.map(item => item.method), ['initialize', 'notifications/initialized', 'tools/list']);
    await assert.rejects(() => probeMoneyMaker(server, async () => new Response('synthetic-private-token', { status: 403 })), (error: any) => /HTTP 403/.test(error.message) && !/synthetic-private/.test(error.message));
});

test('Money Maker admin policy matches the documented template and is accepted by runtime validation', async () => {
    const template = JSON.parse(await readFile(path.join(__dirname, '../docs/mcp.example.json'), 'utf8'));
    assert.deepEqual(Object.keys(template.servers['money-maker'].tools), MONEY_MAKER_TOOLS);
    const { parseMcpConfig } = await import('../services/mcp/config');
    assert.equal(Object.keys(parseMcpConfig(template)['money-maker'].tools).length, 12);
});
