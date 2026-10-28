'use strict';

// Shared by the bot runtime and authenticated admin settings.
function object(value) {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
function assertSafeMcpValue(value, depth = 0) {
    if (depth > 12) throw new Error('MCP: слишком глубокий JSON');
    if (Array.isArray(value)) value.forEach(item => assertSafeMcpValue(item, depth + 1));
    else if (object(value)) for (const [key, item] of Object.entries(value)) {
        if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('MCP: запрещённый ключ');
        assertSafeMcpValue(item, depth + 1);
    }
}

/** Never include file contents, credentials or URLs in validation errors. */
function parseMcpConfig(value) {
    assertSafeMcpValue(value);
    if (!object(value) || Object.keys(value).some(key => key !== 'servers') || !object(value.servers) || Object.keys(value.servers).length > 16) throw new Error('MCP: ожидается объект servers (до 16 серверов)');
    const servers = {};
    for (const [id, raw] of Object.entries(value.servers)) {
        if (!/^[a-z][a-z0-9_-]{0,63}$/.test(id) || !object(raw)) throw new Error('MCP: некорректный сервер');
        const keys = ['description', 'transport', 'url', 'headers', 'oauth', 'command', 'args', 'env', 'tools', 'fixedArguments', 'timeoutMs'];
        if (Object.keys(raw).some(key => !keys.includes(key)) || !['http', 'jsonrpc', 'stdio'].includes(String(raw.transport)) ||
            typeof raw.description !== 'string' || raw.description.length > 1500 || !object(raw.tools) || Object.keys(raw.tools).length > 200 ||
            Object.entries(raw.tools).some(([name, effect]) => !/^[A-Za-z0-9_.:-]{1,128}$/.test(name) || !['read', 'external'].includes(String(effect)))) throw new Error('MCP: некорректная конфигурация сервера');
        for (const field of ['headers', 'env']) if (raw[field] !== undefined && (!object(raw[field]) || Object.values(raw[field]).some(v => typeof v !== 'string' || /[\r\n]/.test(v)))) throw new Error('MCP: некорректные headers/env');
        if (raw.headers) {
            const names = Object.keys(raw.headers).map(key => key.toLowerCase());
            if (names.some(key => !/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(key)) || new Set(names).size !== names.length) throw new Error('MCP: некорректные или повторные имена headers');
        }
        const timeoutMs = raw.timeoutMs ?? 30_000;
        if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) throw new Error('MCP: timeoutMs должен быть от 100 до 60000');
        if (raw.fixedArguments !== undefined && !object(raw.fixedArguments)) throw new Error('MCP: некорректные fixedArguments');
        if (raw.transport === 'http' || raw.transport === 'jsonrpc') {
            let url;
            try { url = new URL(String(raw.url)); } catch { throw new Error('MCP: некорректный URL'); }
            if (url.username || url.password || url.search || url.hash || !(url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]', 'host.docker.internal'].includes(url.hostname)) || raw.command || raw.args || raw.env) throw new Error('MCP: требуется HTTPS (HTTP допустим только для локального сервера), без credentials/query в URL');
            if (raw.oauth !== undefined) {
                const auth = raw.oauth;
                if (!object(auth) || Object.keys(auth).some(key => !['tokenUrl', 'clientId', 'clientSecret', 'scope', 'audience'].includes(key)) ||
                    typeof auth.clientId !== 'string' || !auth.clientId || typeof auth.clientSecret !== 'string' || !auth.clientSecret ||
                    Object.values(auth).some(v => typeof v !== 'string' || !v || v.length > 8000) || Object.keys((raw.headers ?? {})).some(key => key.toLowerCase() === 'authorization')) throw new Error('MCP: некорректный OAuth client_credentials');
                let tokenUrl;
                try { tokenUrl = new URL(String(auth.tokenUrl)); } catch { throw new Error('MCP: некорректный OAuth token URL'); }
                if (tokenUrl.protocol !== 'https:' || tokenUrl.username || tokenUrl.password || tokenUrl.search || tokenUrl.hash) throw new Error('MCP: OAuth token endpoint требует HTTPS без credentials/query');
            }
        } else if (typeof raw.command !== 'string' || !raw.command.trim() || raw.command.length > 1000 || raw.url || raw.headers ||
            raw.oauth ||
            (raw.args !== undefined && (!Array.isArray(raw.args) || raw.args.length > 64 || raw.args.some(arg => typeof arg !== 'string' || arg.length > 4000)))) throw new Error('MCP: некорректный stdio transport');
        servers[id] = { ...raw, timeoutMs };
    }
    return servers;
}

module.exports = { assertSafeMcpValue, parseMcpConfig };
