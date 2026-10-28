import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

const NOTICE = 'MCP: результат сокращён; полнота данных не гарантирована';
type JsonObject = Record<string, unknown>;
function object(value: unknown): JsonObject | undefined {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;
}
function pick(value: JsonObject, keys: string[]): JsonObject {
    return Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, value[key]]));
}

function marketTimes(body: JsonObject | undefined): JsonObject[] {
    if (object(body?.mcp)?.version !== 'money_maker_mcp_tool_result_v1' || !Array.isArray(body?.callResults)) return [];
    return body.callResults.flatMap(call => {
        const item = object(call);
        const data = object(object(item?.result)?.data);
        const market = object(data?.marketData);
        if (!market) return [];
        const times = Object.fromEntries(['lastCandleAt', 'asOf', 'fetchedAt'].flatMap(key => {
            const raw = market[key];
            if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(raw)) return [];
            const date = new Date(raw);
            if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 19) !== raw.slice(0, 19)) return [];
            return [[key + 'UTC', raw.replace('T', ' ').replace(/Z$/, ' UTC')]];
        }));
        return Object.keys(times).length ? [{ capabilityId: item?.capabilityId, ...pick(market, ['ticker', 'interval']), ...times }] : [];
    });
}

/** Remove duplicated presentation wrappers before touching source evidence. */
function compactMoneyMaker(body: JsonObject): JsonObject {
    if (object(body.mcp)?.version !== 'money_maker_mcp_tool_result_v1' || !Array.isArray(body.callResults)) return body;
    const role = object(body.rolePayload);
    return { ...pick(body, ['ok', 'resolution', 'responseMode', 'payloadPolicy']),
        callResults: body.callResults.map(call => {
            const item = object(call);
            return item ? pick(item, ['capabilityId', 'result']) : call;
        }),
        ...(role ? { rolePayload: pick(role, ['answer', 'marketData', 'dataQuality', 'gaps', 'nextChecks']) } : {}),
        ...pick(body, ['sourcesUsed', 'webSearchUsed', 'durationMs', 'llmCallCount']) };
}

/** Always return valid JSON. Shrink individual leaves/arrays, never cut through metadata. */
function bounded(value: unknown, textLimit: number, itemLimit: number, depth = 0, key = ''): unknown {
    if (typeof value === 'string') {
        const limit = /^(?:url|uri|source|ticker|figi|interval|resolution|status|freshness|from|to|startDate|endDate|asOf|provider|timezone)$|At$/i.test(key) ? Math.max(2048, textLimit) : textLimit;
        if (value.length <= limit) return value;
        return `${value.slice(0, limit)} [MCP: текст сокращён; исходных символов ${value.length}]`;
    }
    if (!value || typeof value !== 'object') return value;
    if (depth > 24) return '[MCP: вложенные данные сокращены]';
    if (Array.isArray(value)) {
        if (value.length <= itemLimit) return value.map(item => bounded(item, textLimit, itemLimit, depth + 1));
        // Keep both ends: cutting only the prefix loses current indicator values
        // and can turn a complete source into an unnecessary refusal.
        const head = Math.floor(itemLimit / 2);
        const tail = itemLimit - head;
        return [...value.slice(0, head).map(item => bounded(item, textLimit, itemLimit, depth + 1)),
            { mcpOmittedItems: value.length - itemLimit, location: 'middle' },
            ...value.slice(-tail).map(item => bounded(item, textLimit, itemLimit, depth + 1))];
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, bounded(item, textLimit, itemLimit, depth + 1, key)]));
}

export function mcpResultEvidence(result: CallToolResult, maxChars = 10_000): string {
    const content = result.content.filter(item => item.type === 'text' || item.type === 'resource_link');
    const body = object(result.structuredContent);
    const times = marketTimes(body);
    const clock = times.length ? { marketTimesUTC: times } : {};
    const full = { isError: result.isError === true, ...clock, structuredContent: result.structuredContent, content };
    const serialized = JSON.stringify(full);
    if (serialized.length <= maxChars) return serialized;
    const moneyMaker = object(body?.mcp)?.version === 'money_maker_mcp_tool_result_v1' && Array.isArray(body?.callResults);
    const compact = { isError: result.isError === true, ...clock,
        ...(body ? { structuredContent: compactMoneyMaker(body) } : {}),
        ...(!moneyMaker ? { content } : {}) };
    const clean = JSON.stringify(compact);
    if (clean.length <= maxChars) return clean;
    for (const [textLimit, itemLimit] of [[4000, 100], [2000, 40], [1000, 20], [500, 10], [240, 5], [120, 2], [60, 1]]) {
        const trimmed = bounded(compact, textLimit, itemLimit) as JsonObject;
        const text = JSON.stringify({ ...trimmed, truncated: true, notice: NOTICE });
        if (text.length <= maxChars) return text;
    }
    // Unusually wide objects or tiny caller budgets must not masquerade as complete evidence.
    return JSON.stringify({ isError: result.isError === true, truncated: true, notice: NOTICE });
}
