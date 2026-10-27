import { createHash } from 'node:crypto';
import type { McpServerConfig } from './config';

const tokens = new Map<string, { value: string; expiresAt: number }>();
/** Dedicated machine credentials only; never borrow the operator's env or personal browser login. */
export async function mcpRequestHeaders(config: McpServerConfig, signal: AbortSignal): Promise<Record<string, string>> {
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
    const result = await response.json() as { access_token?: unknown; expires_in?: unknown; token_type?: unknown };
    if (typeof result.access_token !== 'string' || !result.access_token || result.access_token.length > 32_000 || typeof result.expires_in !== 'number' || result.expires_in <= 0 ||
        result.token_type !== undefined && String(result.token_type).toLowerCase() !== 'bearer') throw new Error('MCP: invalid OAuth token response');
    // Bound retention; removed/rotated configs do not leave an unbounded token cache.
    for (const [entry, token] of tokens) if (token.expiresAt <= Date.now()) tokens.delete(entry);
    if (tokens.size >= 16) tokens.delete(tokens.keys().next().value!);
    tokens.set(key, { value: result.access_token, expiresAt: Date.now() + Math.min(result.expires_in, 3600) * 1000 });
    return { ...config.headers, Authorization: `Bearer ${result.access_token}` };
}
