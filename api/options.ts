export interface ExternalApiOptions {
    token: string;
    ownerId: number;
    host: string;
    port: number;
}

export function readExternalApiOptions(env: NodeJS.ProcessEnv, ownerId: number): ExternalApiOptions | undefined {
    if (env.KIRA_API_ENABLED !== 'true') return undefined;
    const token = env.KIRA_API_TOKEN?.trim() ?? '';
    if (token.length < 32 || /\s/.test(token)) {
        throw new Error('KIRA_API_TOKEN must contain at least 32 characters without whitespace');
    }
    if (!Number.isSafeInteger(ownerId) || ownerId <= 0) {
        throw new Error('External API requires a valid KIRA_ALLOWED_USER_ID');
    }
    const port = Number(env.KIRA_API_PORT || 3200);
    const minimumPort = env.KIRA_TENANT_ID && process.send ? 0 : 1;
    if (!Number.isInteger(port) || port < minimumPort || port > 65535) throw new Error('Invalid KIRA_API_PORT');
    return { token, ownerId, host: env.KIRA_API_HOST?.trim() || '127.0.0.1', port };
}
