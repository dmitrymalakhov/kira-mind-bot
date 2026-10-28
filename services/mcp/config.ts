import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { RUNTIME_DATA_DIR } from '../../utils/runtimeData';

export type McpEffect = 'read' | 'external';
export interface McpServerConfig {
    description: string;
    transport: 'http' | 'jsonrpc' | 'stdio';
    url?: string;
    headers?: Record<string, string>;
    oauth?: { tokenUrl: string; clientId: string; clientSecret: string; scope?: string; audience?: string };
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    tools: Record<string, McpEffect>;
    /** Operator-bound arguments, e.g. service role. The model cannot override them. */
    fixedArguments?: Record<string, unknown>;
    timeoutMs: number;
}
export type McpConfig = Record<string, McpServerConfig>;
export const MCP_CONFIG_FILE = path.join(RUNTIME_DATA_DIR, 'mcp.json');

export { assertSafeMcpValue } from '../../utils/mcpConfig';
import { parseMcpConfig } from '../../utils/mcpConfig';
export { parseMcpConfig };

let cache: { stamp: string; servers: McpConfig } | undefined;
export function readMcpConfig(file = MCP_CONFIG_FILE): McpConfig {
    try {
        const stat = statSync(file);
        if (stat.size > 128_000) throw new Error('MCP: конфигурация слишком велика');
        const stamp = `${file}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
        if (cache?.stamp === stamp) return cache.servers;
        const servers = parseMcpConfig(JSON.parse(readFileSync(file, 'utf8')));
        cache = { stamp, servers };
        return servers;
    } catch (error) {
        cache = undefined;
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
        throw new Error('Не удалось прочитать конфигурацию MCP. Проверь mcp.json в каталоге runtime.');
    }
}

export function mcpClassifierContext(): string {
    try {
        const servers = Object.entries(readMcpConfig()).map(([id, { description }]) => ({ id, description }));
        return servers.length ? `Подключённые MCP-сервисы: ${JSON.stringify(servers)}. Если новая просьба требует их данных или действий, добавь details.mcpAccess="read" либо "write" (только явное изменение). Выбери fastReply.mode="route". MCP не является личной памятью или публичным веб-поиском. details.mcpAllowWeb=true допустимо только если сама новая просьба явно требует ДОПОЛНИТЕЛЬНО проверить публичный веб наряду с MCP; иначе false. Актуальность вопроса или ошибка MCP не разрешают подменить источник вебом.` : '';
    } catch { return ''; }
}

export function isExplicitMcpRequest(message: string): boolean {
    if (/(?:\bmcp\b|мсп)/iu.test(message)) return true;
    try { return Object.keys(readMcpConfig()).some(id => message.toLowerCase().includes(id.toLowerCase())); } catch { return false; }
}
