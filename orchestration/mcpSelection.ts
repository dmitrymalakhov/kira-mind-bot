import type { MessageClassification } from '../orchestrator';

/** Classification supplies hints, never server permissions or tool arguments. */
export function normalizeMcpSelection(classification: MessageClassification, configuredIds: readonly string[]): MessageClassification {
    const configured = new Set(configuredIds);
    const normalize = (raw: MessageClassification['details'] = {}) => {
        const { mcpAccess: access, mcpServers: selected, mcpAllowWeb: web, ...rest } = raw;
        const servers = Array.isArray(selected) ? [...new Set(selected.filter(id => typeof id === 'string' && configured.has(id)))] : undefined;
        // A selected source can imply reading, but can never authorize a write.
        const mcpAccess = access === 'write' ? 'write' : access === 'read' || servers?.length ? 'read' : undefined;
        return { ...rest, ...(mcpAccess ? { mcpAccess, mcpAllowWeb: web === true, ...(servers ? { mcpServers: servers } : {}) } : {}) } as MessageClassification['details'];
    };
    const subIntents = classification.subIntents?.map(item => ({ ...item, ...(item.details ? { details: normalize(item.details) } : {}) }));
    const details = normalize(classification.details);
    const parts = [details, ...(subIntents?.map(item => item.details).filter((item): item is MessageClassification['details'] => Boolean(item)) ?? [])];
    const mcpParts = parts.filter(item => item.mcpAccess);
    if (mcpParts.length) {
        details.mcpAccess = mcpParts.some(item => item.mcpAccess === 'write') ? 'write' : 'read';
        details.mcpAllowWeb = mcpParts.some(item => item.mcpAllowWeb === true);
        if (mcpParts.some(item => item.mcpServers)) details.mcpServers = [...new Set(mcpParts.flatMap(item => item.mcpServers ?? []))];
    }
    return { ...classification, details, ...(subIntents ? { subIntents } : {}),
        ...(details.mcpAccess && classification.fastReply ? { fastReply: { mode: 'route' as const } } : {}) };
}
