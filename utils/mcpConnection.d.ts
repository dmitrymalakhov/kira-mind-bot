import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { McpServerConfig } from '../services/mcp/config';
import type { McpConnection } from '../services/mcp/client';
export class McpHttpError extends Error {
    readonly status: number;
    readonly retryAfterSeconds?: number;
    constructor(status: number, retryAfterSeconds?: number);
}
export class JsonRpcHttpTransport implements Transport {
    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: JSONRPCMessage) => void;
    constructor(url: string, headers?: Record<string, string>, signal?: AbortSignal, request?: typeof fetch);
    start(): Promise<void>;
    send(message: JSONRPCMessage): Promise<void>;
    close(): Promise<void>;
}
export function mcpRequestHeaders(config: McpServerConfig, signal: AbortSignal): Promise<Record<string, string>>;
export function secretHeaderValues(headers: Record<string, string>): string[];
export function connectMcp(config: McpServerConfig, signal: AbortSignal): Promise<McpConnection>;
