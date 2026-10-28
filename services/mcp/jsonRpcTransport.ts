import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { JSONRPCMessageSchema, type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

/** Safe transport diagnostics: no response payloads, URLs or credential headers. */
export class McpHttpError extends Error {
    constructor(readonly status: number, readonly retryAfterSeconds?: number) {
        super(`MCP HTTP ${status}`);
        this.name = 'McpHttpError';
    }
}

/** POST-only MCP gateways such as Money Maker: no SSE, session headers or replay. */
export class JsonRpcHttpTransport implements Transport {
    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: JSONRPCMessage) => void;
    private readonly controller = new AbortController();
    constructor(private readonly url: string, private readonly headers: Record<string, string> = {},
        private readonly signal?: AbortSignal, private readonly request: typeof fetch = fetch) {}

    async start(): Promise<void> { this.controller.signal.throwIfAborted(); }
    async send(message: JSONRPCMessage): Promise<void> {
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
            if (response.status !== 204 && response.status !== 202 && response.status !== 200) throw new Error('MCP: неверный ответ на уведомление');
            return;
        }
        if (!response.body) throw new Error('MCP: пустой JSON-RPC ответ');
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = []; let size = 0;
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
    async close(): Promise<void> { this.controller.abort(); this.onclose?.(); }
}
