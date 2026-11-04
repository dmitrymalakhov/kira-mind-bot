export interface PublicWebConfig {
    origin: string;
    operatorEnabled: boolean;
    operatorBridgeSecret: string;
    operatorTarget: string;
}

/** Optional browser channel; native readiness is independent of operator access. */
export function loadPublicWebConfig(env: NodeJS.ProcessEnv = process.env): PublicWebConfig | undefined {
    const value = env.KIRA_PUBLIC_WEB_ORIGIN?.trim();
    if (!value) return undefined;
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
        throw new Error('Invalid account-console origin');
    }
    const secret = env.KIRA_OPERATOR_BRIDGE_SECRET?.trim() || '';
    if (secret && !/^[0-9a-f]{64}$/i.test(secret)) throw new Error('Invalid operator bridge configuration');
    const operatorEnabled = env.KIRA_PUBLIC_OPERATOR_ENABLED === 'true';
    if (operatorEnabled && !secret) throw new Error('Operator bridge is not configured');
    return { origin: url.origin, operatorEnabled, operatorBridgeSecret: secret, operatorTarget: 'http://admin-panel:3000' };
}
