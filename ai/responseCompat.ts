import type OpenAI from 'openai';
import type { ChatCompletionParamsWithoutModel, ResponseCreateParams } from './providers/types';

type ResponseInputItem = OpenAI.Responses.ResponseInputItem;

function extractContentText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';

    return content
        .map((item) => {
            if (!item || typeof item !== 'object') return '';
            const record = item as Record<string, unknown>;
            const text = record.text;
            return typeof text === 'string' ? text : '';
        })
        .filter(Boolean)
        .join('\n');
}

export function convertResponsesInputToChatMessages(
    params: ResponseCreateParams,
): ChatCompletionParamsWithoutModel['messages'] {
    const rawInput = params.input;
    if (typeof rawInput === 'string') {
        return [{ role: 'user', content: rawInput } as OpenAI.Chat.Completions.ChatCompletionMessageParam];
    }

    if (!Array.isArray(rawInput)) {
        return [];
    }

    return rawInput.map((item) => {
        const typedItem = item as ResponseInputItem & { role?: string; content?: unknown };
        const role = typedItem.role === 'assistant' || typedItem.role === 'system' || typedItem.role === 'developer'
            ? typedItem.role
            : 'user';

        return {
            role,
            content: extractContentText(typedItem.content),
        } as OpenAI.Chat.Completions.ChatCompletionMessageParam;
    }).filter((item) => typeof item.content === 'string' && item.content.trim().length > 0);
}

export function buildFlattenedPromptFromResponsesInput(params: ResponseCreateParams): string {
    return convertResponsesInputToChatMessages(params)
        .map((message) => `${message.role.toUpperCase()}:\n${typeof message.content === 'string' ? message.content : ''}`)
        .join('\n\n')
        .trim();
}

export function extractSystemInstructionFromResponsesInput(params: ResponseCreateParams): string {
    return convertResponsesInputToChatMessages(params)
        .filter((message) => message.role === 'system' || message.role === 'developer')
        .map((message) => typeof message.content === 'string' ? message.content : '')
        .filter(Boolean)
        .join('\n\n')
        .trim();
}

export function hasWebSearchPreviewTool(params: ResponseCreateParams): boolean {
    return Array.isArray(params.tools)
        && params.tools.some((tool) => Boolean(tool && typeof tool === 'object' && ((tool as unknown as Record<string, unknown>).type === 'web_search_preview')));
}

export function buildZaiWebSearchTool(systemInstruction: string): Array<Record<string, unknown>> {
    const searchPrompt = [
        systemInstruction,
        'Use {{search_result}} from web search as the grounding source.',
        'Summarize the results, keep links/citations when possible, and do not invent unsupported facts.',
    ].filter(Boolean).join('\n\n');

    return [{
        type: 'web_search',
        web_search: {
            enable: 'True',
            search_engine: 'search-prime',
            search_result: 'True',
            content_size: 'high',
            count: '8',
            ...(searchPrompt ? { search_prompt: searchPrompt } : {}),
        },
    }];
}
