import { createHash } from "node:crypto";
import type { MessageHistory } from "../types";

const CACHE_HISTORY_TURNS = 6;
const CACHE_HISTORY_TEXT_LIMIT = 320;

export function buildClassificationCacheKey(
    message: string,
    messageHistory: MessageHistory[],
    knownChatGroups: { name: string; chatNames: string[] }[] = [],
): string {
    const groupsKey = knownChatGroups
        .map((group) => group.name)
        .sort((left, right) => left.localeCompare(right, "ru"))
        .join("|");
    const recentContext = messageHistory
        .slice(-CACHE_HISTORY_TURNS)
        .map((item) => `${item.role}:${item.content.slice(0, CACHE_HISTORY_TEXT_LIMIT)}`)
        .join("\n");
    const contextHash = createHash("sha256")
        .update(recentContext)
        .digest("hex")
        .slice(0, 16);

    return `classify:${message.slice(0, 200)}:${groupsKey.slice(0, 60)}:${contextHash}`;
}
