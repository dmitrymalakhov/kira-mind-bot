import type { KnowledgeSourceDecision, MessageHistory } from "../types";
import { decideKnowledgeSource } from "./knowledgeSource";

const CONTEXTUAL_EXPANSION_RE = /^(?:(?:давай|можно|хочу|расскажи|раскрой|разверни|покажи)\s+)?(?:ещ[её]\s+)?(?:подробнее|детальнее|полнее|больше\s+деталей)(?:\s+(?:об\s+этом|про\s+это|по\s+этой\s+теме))?[.!?]*$/iu;
const SELF_DELIVERY_REFERENCE_RE = /^(?:(?:давай|пожалуйста)[,\s]+)?(?:пришли|отправь|покажи|дай|выведи)\s+(?:мне\s+)?(?:е[её]|это|их|его)(?:\s+(?:сюда|здесь|в\s+этот\s+чат))?[.!?]*$/iu;
const EXTERNAL_RESULT_MARKER_RE = /(?:свеж\w*\s+новост|новостн\w*\s+сводк|подборк\w*\s+по\s+интернет|источник\w*\s*:|https?:\/\/|поиск\w*\s+в\s+интернет)/iu;
const RECENT_CONTEXT_TURNS = 8;

export interface ContextualFollowUpDecision {
    intent: "РАЗГОВОР" | "ВЕБ_ПОИСК";
    knowledgeSource: "stable_general" | "external_current";
    requestedFacets: KnowledgeSourceDecision["requestedFacets"];
    reason: string;
}

function withoutCurrentDuplicate(message: string, messageHistory: MessageHistory[]): MessageHistory[] {
    const normalizedMessage = message.trim().toLocaleLowerCase("ru-RU");
    const history = messageHistory.slice();
    const last = history.at(-1);
    if (
        last?.role === "user" &&
        last.content.trim().toLocaleLowerCase("ru-RU") === normalizedMessage
    ) {
        history.pop();
    }
    return history;
}

function findRecentExternalDecision(history: MessageHistory[]): KnowledgeSourceDecision | null {
    const recent = history.slice(-RECENT_CONTEXT_TURNS);
    for (let index = recent.length - 1; index >= 0; index -= 1) {
        const item = recent[index];
        if (item.role === "user") {
            const decision = decideKnowledgeSource(item.content);
            if (decision.requiresWeb) return decision;
        }
        if (item.role === "bot" && EXTERNAL_RESULT_MARKER_RE.test(item.content)) {
            return {
                source: "external_current",
                requiresWeb: true,
                requestedFacets: ["facts", "sources"],
                reason: "recent assistant response contains an external-search result",
            };
        }
    }
    return null;
}

export function decideContextualFollowUp(
    message: string,
    messageHistory: MessageHistory[],
): ContextualFollowUpDecision | null {
    const isExpansion = CONTEXTUAL_EXPANSION_RE.test(message.trim());
    const isSelfDelivery = SELF_DELIVERY_REFERENCE_RE.test(message.trim());
    if (!isExpansion && !isSelfDelivery) return null;

    const priorHistory = withoutCurrentDuplicate(message, messageHistory);
    if (isExpansion && priorHistory.length === 0) return null;

    const externalDecision = findRecentExternalDecision(priorHistory);
    if (externalDecision) {
        return {
            intent: "ВЕБ_ПОИСК",
            knowledgeSource: "external_current",
            requestedFacets: externalDecision.requestedFacets,
            reason: "contextual follow-up to current external knowledge",
        };
    }

    return {
        intent: "РАЗГОВОР",
        knowledgeSource: "stable_general",
        requestedFacets: [],
        reason: "contextual in-chat follow-up",
    };
}
