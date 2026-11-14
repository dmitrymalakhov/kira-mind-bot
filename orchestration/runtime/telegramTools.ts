import { listTelegramConversations, readTelegramConversation } from '../../services/telegramConversationHistory';
import { objectSchema, textSchema } from './registry';
import type { ToolDefinition, ToolObservation } from './types';

/** Counts come from unique source message IDs, not an estimate by the model. */
export function telegramHistoryStatistics(observations: readonly ToolObservation[]) {
    const chats = new Map<string, { chatId: string; title?: string; since: string; until: string; incoming: number; outgoing: number; total: number }>();
    const seen = new Set<string>();
    for (const observation of observations) {
        if (observation.tool !== 'telegram.getHistory' || observation.status !== 'ok') continue;
        const data = observation.data as { chatId: string; chatTitle?: string; since: string; until: string; items?: Array<{ messageId: number; isOwn: boolean }> };
        if (!data?.chatId) continue;
        const key = JSON.stringify([data.chatId, data.since, data.until]);
        const chat = chats.get(key) ?? { chatId: data.chatId, title: data.chatTitle, since: data.since, until: data.until, incoming: 0, outgoing: 0, total: 0 };
        chats.set(key, chat);
        for (const message of data.items ?? []) {
            if (!Number.isSafeInteger(message.messageId)) continue;
            const id = `${key}:${message.messageId}`;
            if (seen.has(id)) continue;
            seen.add(id); chat.total++;
            if (message.isOwn) chat.outgoing++; else chat.incoming++;
        }
    }
    return [...chats.values()].sort((a, b) => b.outgoing - a.outgoing || b.total - a.total);
}

/** Coverage comes from actual pages, independently of the model's finish decision. */
export function telegramHistoryCoverage(observations: readonly ToolObservation[]): string | undefined {
    const pages = observations.filter(o => ['telegram.listConversations', 'telegram.getHistory'].includes(o.tool) && o.status === 'ok')
        .map(o => ({ tool: o.tool, data: o.data as { items?: Array<{ chatId?: string; textTruncated?: boolean }>; chatId?: string; cursor?: string; nextCursor?: string; scanLimitReached?: boolean } }));
    if (!pages.length) return undefined;
    const consumed = new Set(pages.map(p => p.data?.cursor).filter(Boolean));
    const pending = pages.filter(p => p.data?.nextCursor && !consumed.has(p.data.nextCursor));
    const found = new Set(pages.filter(p => p.tool === 'telegram.listConversations').flatMap(p => p.data?.items?.map(item => item.chatId) ?? []));
    const read = new Set(pages.filter(p => p.tool === 'telegram.getHistory').map(p => p.data?.chatId));
    const unread = [...found].filter(id => !read.has(id)).length;
    const truncated = pages.some(p => p.data?.items?.some(item => item.textTruncated));
    const capped = pages.some(p => p.data?.scanLimitReached);
    if (!pending.length && !unread && !truncated && !capped) return undefined;
    return `Обзор частичный: ${[
        unread ? `не прочитано найденных чатов: ${unread}` : '',
        pending.length ? `остались страницы: ${pending.length}` : '',
        truncated ? 'длинные сообщения показаны с сокращением' : '',
        capped ? 'достигнут предел поиска чатов' : '',
    ].filter(Boolean).join('; ')}.`;
}

const page = {
    since: textSchema('Начало включительно: ISO 8601 с offset. Без обеих границ — с начала сегодняшнего дня в часовом поясе владельца.', 60),
    until: textSchema('Конец исключительно: ISO 8601 с offset. Передай обе границы вместе.', 60),
    cursor: textSchema('nextCursor предыдущей страницы без изменений; сохраняет период и фильтр.', 2000),
    limit: { type: 'integer' as const, minimum: 1, maximum: 20 },
};

export function telegramTools(): ToolDefinition[] {
    return [
        {
            name: 'telegram.listConversations', skill: 'telegram-reading', effect: 'read', ownerOnly: true, privateOnly: true,
            description: 'Найти активные Telegram-переписки за период в живом аккаунте, включая прочитанные и исходящие. По умолчанию сегодня, личные и группы, без ботов/каналов. Это каталог: содержание читай через telegram.getHistory. Продолжай nextCursor, даже если items пуст.',
            inputSchema: objectSchema({ ...page, query: textSchema('Фильтр имени чата или username; роль сначала разреши через people.resolve.', 200),
                chatType: { type: 'string', enum: ['conversations', 'private', 'group', 'channel', 'all'] } }, []),
            async execute(args, context) {
                const data = await listTelegramConversations(args, context.signal);
                return { status: 'ok', summary: `Найдены переписки: ${data.items.length}. ${data.complete ? 'Поиск завершён.' : 'Поиск неполный; продолжи nextCursor.'}`, data };
            },
        },
        {
            name: 'telegram.getHistory', skill: 'telegram-reading', effect: 'read', ownerOnly: true, privateOnly: true,
            description: 'Прочитать страницу переписки по chatId из telegram.listConversations. Используй тот же since/until. Сохраняет ID, время, направление и пересылку. Не отмечает прочитанным, не сохраняет факты. Продолжай nextCursor для полной выжимки.',
            inputSchema: objectSchema({ ...page, chatId: textSchema('Точный chatId из результата каталога переписок.', 20) }, ['chatId']),
            async execute(args, context) {
                const source = context.observations.filter(o => o.status === 'ok').flatMap<{ chatId?: string; title?: string; since?: string; until?: string }>(o => o.tool === 'telegram.listConversations'
                    ? ((o.data as { items?: Array<{ chatId: string; title?: string }> })?.items ?? []).map(item => ({ ...item, since: (o.data as { since?: string }).since, until: (o.data as { until?: string }).until }))
                    : o.tool === 'telegram.getHistory' ? [{ chatId: (o.data as { chatId?: string })?.chatId, title: (o.data as { chatTitle?: string })?.chatTitle, since: (o.data as { since?: string })?.since, until: (o.data as { until?: string })?.until }] : [])
                    .find(item => item.chatId === args.chatId);
                if (!source) return { status: 'failed', summary: 'Сначала найди точный chatId через telegram.listConversations. Не угадывай ID или имя.' };
                const inherited = !args.cursor && args.since === undefined && args.until === undefined && source.since && source.until
                    ? { ...args, since: source.since, until: source.until } : args;
                const data = await readTelegramConversation(inherited, context.signal);
                return { status: 'ok', summary: `Прочитано сообщений: ${data.items.length}. ${data.complete ? 'Период прочитан полностью.' : 'Период прочитан частично; продолжи nextCursor.'}`, data: { ...data, chatTitle: source.title } };
            },
        },
    ];
}
