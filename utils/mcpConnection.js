'use strict';
const { createHash } = require('node:crypto');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { JSONRPCMessageSchema } = require('@modelcontextprotocol/sdk/types.js');

/** Safe diagnostics: no response payloads, URLs or credential headers. */
class McpHttpError extends Error {
    constructor(status, retryAfterSeconds) {
        super(`MCP HTTP ${status}`);
        this.name = 'McpHttpError'; this.status = status; this.retryAfterSeconds = retryAfterSeconds;
    }
}

/** POST-only gateways: no SSE, session headers or replay. */
class JsonRpcHttpTransport {
    constructor(url, headers = {}, signal, request = fetch) {
        this.url = url; this.headers = headers; this.signal = signal; this.request = request;
        this.controller = new AbortController();
    }
    async start() { this.controller.signal.throwIfAborted(); }
    async send(message) {
        const signal = AbortSignal.any([this.controller.signal, ...(this.signal ? [this.signal] : [])]);
        const response = await this.request(this.url, { method: 'POST', redirect: 'error', signal,
            headers: { ...this.headers, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(message) });
        if (!response.ok) {
            const retry = response.headers.get('retry-after') ?? '';
            await response.body?.cancel();
            throw new McpHttpError(response.status, /^\d{1,4}$/.test(retry) ? Math.min(3600, Number(retry)) : undefined);
        }
        if (!('id' in message)) {
            await response.body?.cancel();
            if (![200, 202, 204].includes(response.status)) throw new Error('MCP: неверный ответ на уведомление');
            return;
        }
        if (!response.body) throw new Error('MCP: пустой JSON-RPC ответ');
        const reader = response.body.getReader(); const chunks = []; let size = 0;
        try {
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                size += value.length;
                if (size > 2_000_000) throw new Error('MCP: ответ слишком велик');
                chunks.push(value);
            }
            const parsed = JSONRPCMessageSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            if (!('id' in parsed) || parsed.id !== message.id || !('result' in parsed || 'error' in parsed)) throw new Error('MCP: неверный ID/тип ответа');
            this.onmessage?.(parsed);
        } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    }
    async close() { this.controller.abort(); this.onclose?.(); }
}

const tokens = new Map();
/** Dedicated config only; never borrow the operator's provider credentials or browser login. */
async function mcpRequestHeaders(config, signal) {
    if (!config.oauth) return config.headers ?? {};
    const auth = config.oauth;
    const key = createHash('sha256').update(JSON.stringify(auth)).digest('hex');
    const cached = tokens.get(key);
    if (cached && cached.expiresAt > Date.now() + 30_000) return { ...config.headers, Authorization: `Bearer ${cached.value}` };
    const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: auth.clientId, client_secret: auth.clientSecret });
    if (auth.scope) body.set('scope', auth.scope);
    if (auth.audience) body.set('audience', auth.audience);
    const response = await fetch(auth.tokenUrl, { method: 'POST', redirect: 'error', signal,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body });
    if (!response.ok) { await response.body?.cancel(); throw new Error('MCP: OAuth token request failed'); }
    const result = await response.json();
    if (typeof result.access_token !== 'string' || !result.access_token || result.access_token.length > 32_000 || typeof result.expires_in !== 'number' || result.expires_in <= 0 ||
        result.token_type !== undefined && String(result.token_type).toLowerCase() !== 'bearer') throw new Error('MCP: invalid OAuth token response');
    for (const [entry, token] of tokens) if (token.expiresAt <= Date.now()) tokens.delete(entry);
    if (tokens.size >= 16) tokens.delete(tokens.keys().next().value);
    tokens.set(key, { value: result.access_token, expiresAt: Date.now() + Math.min(result.expires_in, 3600) * 1000 });
    return { ...config.headers, Authorization: `Bearer ${result.access_token}` };
}

function secretHeaderValues(headers) {
    return Object.entries(headers).filter(([key]) => !['content-type', 'accept', 'user-agent', 'mcp-protocol-version'].includes(key.toLowerCase())).map(([, value]) => value);
}

/** Used by runtime operations and admin discovery, with the same transport/auth policy. */
async function connectMcp(config, signal) {
    const client = new Client({ name: 'kira-mind-bot', version: '1.0.0' }, { capabilities: {} });
    const headers = config.transport === 'stdio' ? {} : await mcpRequestHeaders(config, signal);
    const transport = config.transport === 'http'
        ? new StreamableHTTPClientTransport(new URL(config.url), {
            requestInit: { headers, redirect: 'error' },
            fetch: (url, init) => fetch(url, { ...init, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs), ...(init?.signal ? [init.signal] : [])]) }),
            reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
        })
        : config.transport === 'jsonrpc' ? new JsonRpcHttpTransport(config.url, headers, signal)
        : new StdioClientTransport({ command: config.command, args: config.args, env: config.env, stderr: 'ignore', maxBufferSize: 2_000_000 });
    try { await client.connect(transport, { signal, timeout: config.timeoutMs }); }
    catch (error) { await transport.close().catch(() => undefined); if (error instanceof McpHttpError) throw error; throw new Error('MCP: соединение не установлено'); }
    return { client, close: () => client.close(), secrets: secretHeaderValues(headers) };
}

module.exports = { McpHttpError, JsonRpcHttpTransport, mcpRequestHeaders, secretHeaderValues, connectMcp };
