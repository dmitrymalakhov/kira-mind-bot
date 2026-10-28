import type { McpConfig } from '../services/mcp/config';
export function assertSafeMcpValue(value: unknown, depth?: number): void;
export function parseMcpConfig(value: unknown): McpConfig;
