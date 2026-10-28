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

function object(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
export function assertSafeMcpValue(value: unknown, depth = 0): void {
    if (depth > 12) throw new Error('MCP: слишком глубокий JSON');
    if (Array.isArray(value)) value.forEach(item => assertSafeMcpValue(item, depth + 1));
    else if (object(value)) for (const [key, item] of Object.entries(value)) {
        if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('MCP: запрещённый ключ');
        assertSafeMcpValue(item, depth + 1);
    }
}

/** Never include file contents, credentials or URLs in validation errors. */
export function parseMcpConfig(value: unknown): McpConfig {
    assertSafeMcpValue(value);
    if (!object(value) || Object.keys(value).some(key => key !== 'servers') || !object(value.servers) || Object.keys(value.servers).length > 16) throw new Error('MCP: ожидается объект servers (до 16 серверов)');
    const servers: McpConfig = {};
    for (const [id, raw] of Object.entries(value.servers)) {
        if (!/^[a-z][a-z0-9_-]{0,63}$/.test(id) || !object(raw)) throw new Error('MCP: некорректный сервер');
        const keys = ['description', 'transport', 'url', 'headers', 'oauth', 'command', 'args', 'env', 'tools', 'fixedArguments', 'timeoutMs'];
        if (Object.keys(raw).some(key => !keys.includes(key)) || !['http', 'jsonrpc', 'stdio'].includes(String(raw.transport)) ||
            typeof raw.description !== 'string' || raw.description.length > 1500 || !object(raw.tools) || Object.keys(raw.tools).length > 200 ||
            Object.entries(raw.tools).some(([name, effect]) => !/^[A-Za-z0-9_.:-]{1,128}$/.test(name) || !['read', 'external'].includes(String(effect)))) throw new Error('MCP: некорректная конфигурация сервера');
        for (const field of ['headers', 'env']) if (raw[field] !== undefined && (!object(raw[field]) || Object.values(raw[field]).some(v => typeof v !== 'string' || /[\r\n]/.test(v)))) throw new Error('MCP: некорректные headers/env');
        const timeoutMs = raw.timeoutMs ?? 30_000;
        if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) throw new Error('MCP: timeoutMs должен быть от 100 до 60000');
        if (raw.fixedArguments !== undefined && !object(raw.fixedArguments)) throw new Error('MCP: некорректные fixedArguments');
        if (raw.transport === 'http' || raw.transport === 'jsonrpc') {
            let url: URL;
            try { url = new URL(String(raw.url)); } catch { throw new Error('MCP: некорректный URL'); }
            if (url.username || url.password || url.search || url.hash || !(url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]', 'host.docker.internal'].includes(url.hostname)) || raw.command || raw.args || raw.env) throw new Error('MCP: требуется HTTPS (HTTP допустим только для локального сервера), без credentials/query в URL');
            if (raw.oauth !== undefined) {
                const auth = raw.oauth;
                if (!object(auth) || Object.keys(auth).some(key => !['tokenUrl', 'clientId', 'clientSecret', 'scope', 'audience'].includes(key)) ||
                    typeof auth.clientId !== 'string' || !auth.clientId || typeof auth.clientSecret !== 'string' || !auth.clientSecret ||
                    Object.values(auth).some(v => typeof v !== 'string' || !v || v.length > 8000) || Object.keys((raw.headers ?? {}) as object).some(key => key.toLowerCase() === 'authorization')) throw new Error('MCP: некорректный OAuth client_credentials');
                let tokenUrl: URL;
                try { tokenUrl = new URL(String(auth.tokenUrl)); } catch { throw new Error('MCP: некорректный OAuth token URL'); }
                if (tokenUrl.protocol !== 'https:' || tokenUrl.username || tokenUrl.password || tokenUrl.search || tokenUrl.hash) throw new Error('MCP: OAuth token endpoint требует HTTPS без credentials/query');
            }
        } else if (typeof raw.command !== 'string' || !raw.command.trim() || raw.command.length > 1000 || raw.url || raw.headers ||
            raw.oauth ||
            (raw.args !== undefined && (!Array.isArray(raw.args) || raw.args.length > 64 || raw.args.some(arg => typeof arg !== 'string' || arg.length > 4000)))) throw new Error('MCP: некорректный stdio transport');
        servers[id] = { ...raw, timeoutMs } as unknown as McpServerConfig;
    }
    return servers;
}

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
