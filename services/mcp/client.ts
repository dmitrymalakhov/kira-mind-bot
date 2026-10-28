import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv-provider.js';
import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { assertSafeMcpValue, McpConfig, McpEffect, McpServerConfig, readMcpConfig } from './config';
import { connectMcp, secretHeaderValues } from '../../utils/mcpConnection';
export { mcpResultEvidence } from './evidence';

export class McpInputError extends Error {}
export interface McpConnection {
    client: Client;
    close(): Promise<void>;
    secrets?: string[];
}
export type McpConnector = (config: McpServerConfig, signal: AbortSignal) => Promise<McpConnection>;

function redactCredentials<T>(value: T, config: McpServerConfig, connection: McpConnection): T {
    const secrets = [...secretHeaderValues(config.headers ?? {}), ...(connection.secrets ?? []), config.oauth?.clientSecret ?? '',
        ...Object.entries(config.env ?? {}).filter(([key]) => /TOKEN|SECRET|PASSWORD|KEY/i.test(key)).map(([, secret]) => secret)]
        .flatMap(secret => [secret, secret.replace(/^(?:Bearer|Basic)\s+/i, '')]).filter(secret => secret.length >= 8);
    const redact = (item: unknown, depth: number): unknown => {
        if (typeof item === 'string') return secrets.reduce((text, secret) => text.split(secret).join('[MCP credential hidden]'), item);
        if (depth > 24) return '[MCP: вложенные данные сокращены]';
        if (Array.isArray(item)) return item.map(child => redact(child, depth + 1));
        if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, redact(child, depth + 1)]));
        return item;
    };
    return redact(value, 0) as T;
}

/** Connections belong to one operation; no stale account credentials or surviving stdio children. */
export class McpService {
    constructor(private readonly configuration: () => McpConfig = readMcpConfig, private readonly connector: McpConnector = connectMcp) {}

    servers() { return Object.entries(this.configuration()).map(([id, config]) => ({ id, description: config.description, tools: Object.keys(config.tools).length })); }
    toolEffect(id: string, name: string): McpEffect | undefined {
        const config = this.configuration()[id];
        return config && Object.prototype.hasOwnProperty.call(config.tools, name) ? config.tools[name] : undefined;
    }

    private async withServer<T>(id: string, signal: AbortSignal | undefined, action: (connection: McpConnection, config: McpServerConfig, signal: AbortSignal) => Promise<T>, snapshot?: McpServerConfig): Promise<T> {
        const servers = snapshot ? { [id]: snapshot } : this.configuration();
        const config = servers[id];
        if (!config || !Object.prototype.hasOwnProperty.call(servers, id)) throw new McpInputError('MCP-сервер не настроен.');
        const bounded = AbortSignal.any([AbortSignal.timeout(config.timeoutMs), ...(signal ? [signal] : [])]);
        bounded.throwIfAborted();
        const connection = await this.connector(config, bounded);
        try { return redactCredentials(await action(connection, config, bounded), config, connection); }
        finally { await connection.close().catch(() => undefined); }
    }

    async listTools(id: string, cursor?: string, signal?: AbortSignal, offset = 0, query = '') {
        return this.withServer(id, signal, async ({ client }, config, bounded) => {
            const page = await client.listTools(cursor ? { cursor } : {}, { signal: bounded, timeout: config.timeoutMs });
            const tools = page.tools.filter(tool => Object.prototype.hasOwnProperty.call(config.tools, tool.name) &&
                (!query || `${tool.name} ${tool.description ?? ''} ${JSON.stringify(tool.inputSchema)}`.toLowerCase().includes(query.toLowerCase())));
            const selected: Array<{ name: string; description?: string; inputSchema: Tool['inputSchema']; effect: McpEffect }> = [];
            let size = 0;
            for (const tool of tools.slice(offset, offset + 3)) {
                const item = { name: tool.name, description: tool.description?.slice(0, 1200), inputSchema: tool.inputSchema, effect: config.tools[tool.name] };
                const length = JSON.stringify(item).length;
                if (size + length > 10_000) {
                    if (!selected.length) throw new McpInputError('MCP: схема инструмента превышает бюджет каталога.');
                    break;
                }
                selected.push(item); size += length;
            }
            return { tools: selected, total: tools.length, nextOffset: offset + selected.length < tools.length ? offset + selected.length : undefined, nextCursor: page.nextCursor };
        });
    }

    async callTool(id: string, name: string, args: Record<string, unknown>, effect: McpEffect, signal?: AbortSignal): Promise<CallToolResult> {
        const config = this.configuration()[id];
        // Effects are operator policy. Server annotations and model arguments cannot grant access.
        if (!config || !Object.prototype.hasOwnProperty.call(config.tools, name) || config.tools[name] !== effect) throw new McpInputError('MCP-инструмент не разрешён для этого типа операции.');
        assertSafeMcpValue(args);
        if (JSON.stringify(args).length > 20_000) throw new McpInputError('MCP: аргументы слишком велики.');
        const boundArgs = { ...args, ...config.fixedArguments };
        return this.withServer(id, signal, async ({ client }, current, bounded) => {
            let tool: Tool | undefined;
            let cursor: string | undefined;
            const cursors = new Set<string>();
            // Bounded discovery, including servers with paginated tool lists.
            for (let pageIndex = 0; pageIndex < 10; pageIndex++) {
                const page = await client.listTools(cursor ? { cursor } : {}, { signal: bounded, timeout: current.timeoutMs });
                tool = page.tools.find(item => item.name === name);
                if (tool || !page.nextCursor || cursors.has(page.nextCursor)) break;
                cursor = page.nextCursor; cursors.add(cursor);
            }
            if (!tool) throw new McpInputError('MCP-инструмент не найден в ограниченной выборке tools/list.');
            // A fresh validator avoids $id collisions between different MCP servers.
            let valid = false;
            try { valid = new AjvJsonSchemaValidator().getValidator(tool.inputSchema)(boundArgs).valid; } catch { /* Unsupported schemas fail closed. */ }
            if (!valid) throw new McpInputError('MCP: аргументы не соответствуют inputSchema инструмента.');
            // Deliberately no retry, transport fallback, session replay or reconnection here.
            return await client.callTool({ name, arguments: boundArgs }, undefined, { signal: bounded, timeout: current.timeoutMs }) as CallToolResult;
        }, config);
    }

    async listResources(id: string, cursor?: string, signal?: AbortSignal) {
        return this.withServer(id, signal, ({ client }, config, bounded) => client.listResources(cursor ? { cursor } : {}, { signal: bounded, timeout: config.timeoutMs }));
    }

    async readResource(id: string, uri: string, signal?: AbortSignal) {
        return this.withServer(id, signal, ({ client }, config, bounded) => client.readResource({ uri }, { signal: bounded, timeout: config.timeoutMs }));
    }
}

export const mcpService = new McpService();
